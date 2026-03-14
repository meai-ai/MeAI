/**
 * Telegram Group channel for MeAI researcher multi-agent system.
 *
 * Unlike the 1:1 TelegramChannel, this channel:
 * - Operates in a group chat with multiple bots + Allen
 * - Uses message claiming (O_CREAT|O_EXCL) to prevent duplicate replies
 * - Prefixes outgoing messages with [BotName]
 * - Supports @mention override (always respond when mentioned)
 * - Anti-oscillation: bot-to-bot same-topic cap, hourly message limit
 * - Omega does not participate in claim competition
 */

import { Telegraf } from "telegraf";
import type { AppConfig } from "../types.js";
import type { Channel, MessageHandler } from "./types.js";
import { claimMessage } from "../researcher/store.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("telegram-group");

export class TelegramGroupChannel implements Channel {
  readonly id = "telegram-group";
  readonly name = "Telegram Group";

  private bot: Telegraf;
  private config: AppConfig;
  private handler: MessageHandler | null = null;
  private messageQueue: Promise<void> = Promise.resolve();

  // Anti-oscillation state
  private botMessageCounts = new Map<string, number>(); // bot-to-bot topic rounds
  private hourlyMessageCount = 0;
  private hourlyResetTimer: ReturnType<typeof setInterval> | null = null;
  private processedMessages = new Set<number>(); // dedup by message_id

  // Limits
  private static readonly MAX_BOT_ROUNDS = 5; // same topic bot-to-bot cap
  private static readonly HOURLY_LIMIT_RESEARCHER = 30;
  private static readonly HOURLY_LIMIT_SUPERVISOR = 15;

  private botSelfId: number | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 0 });
    this.setupHandlers();

    // Reset hourly counter
    this.hourlyResetTimer = setInterval(() => {
      this.hourlyMessageCount = 0;
      this.botMessageCounts.clear();
    }, 60 * 60 * 1000);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  getBot(): Telegraf {
    return this.bot;
  }

  private get botName(): string {
    return this.config.botName ?? "MeAI";
  }

  private get isSupervisor(): boolean {
    // Omega doesn't compete for claims and has lower message limits
    return this.botName.toLowerCase() === "omega";
  }

  private get hourlyLimit(): number {
    return this.isSupervisor
      ? TelegramGroupChannel.HOURLY_LIMIT_SUPERVISOR
      : TelegramGroupChannel.HOURLY_LIMIT_RESEARCHER;
  }

  /**
   * Check if we should respond to this message.
   * Returns the reason we should respond, or null if we should stay silent.
   */
  private shouldRespond(text: string, fromId: number, msgId: number): string | null {
    // Already processed
    if (this.processedMessages.has(msgId)) return null;

    // Don't respond to self
    if (fromId === this.botSelfId) return null;

    // Hourly limit
    if (this.hourlyMessageCount >= this.hourlyLimit) return null;

    // @mention always triggers response
    const username = this.config.botUsername;
    if (username && text.includes(`@${username}`)) {
      return "mentioned";
    }

    // Supervisor doesn't compete for claims — responds proactively on its own schedule
    if (this.isSupervisor) return null;

    // Try to claim the message
    if (claimMessage(String(msgId), this.botName)) {
      return "claimed";
    }

    return null;
  }

  private setupHandlers(): void {
    this.bot.catch((err: unknown) => {
      log.error("Telegraf unhandled error:", err);
    });

    this.bot.on("text", async (ctx) => {
      if (!this.handler) return;

      const chatId = ctx.chat.id;
      const fromId = ctx.from.id;
      const msgId = ctx.message.message_id;
      const text = ctx.message.text;

      // Track that we've seen this message
      this.processedMessages.add(msgId);
      // Limit memory — keep last 1000 message IDs
      if (this.processedMessages.size > 1000) {
        const arr = [...this.processedMessages];
        this.processedMessages = new Set(arr.slice(-500));
      }

      // Determine sender label for context
      const fromUsername = ctx.from.username ?? "";
      const fromFirstName = ctx.from.first_name ?? "";
      const senderLabel = fromUsername || fromFirstName || String(fromId);

      const responseReason = this.shouldRespond(text, fromId, msgId);
      if (!responseReason) return;

      log.info(`Responding to msg ${msgId} (${responseReason}) from ${senderLabel}`);

      // Prefix incoming message with sender name for the agent
      const prefixedText = `[${senderLabel}] ${text}`;

      const sendTyping = async () => {
        await ctx.sendChatAction("typing");
      };

      const sendReply = async (replyText: string): Promise<{ messageId: number | string }> => {
        // Prefix outgoing messages with bot name
        const labeled = `[${this.botName}] ${replyText}`;
        try {
          const m = await ctx.reply(labeled, { parse_mode: "Markdown" });
          this.hourlyMessageCount++;
          return { messageId: m.message_id };
        } catch {
          const m = await ctx.reply(labeled);
          this.hourlyMessageCount++;
          return { messageId: m.message_id };
        }
      };

      const editReply = async (messageId: number | string, replyText: string) => {
        const labeled = `[${this.botName}] ${replyText}`;
        try {
          await ctx.telegram.editMessageText(chatId, Number(messageId), undefined, labeled);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("message is not modified")) throw err;
        }
      };

      // Sequential processing
      sendTyping().catch(() => {});
      this.messageQueue = this.messageQueue
        .then(() => this.handler!(prefixedText, chatId, sendReply, editReply, sendTyping))
        .catch(async (err) => {
          log.error("Error handling message:", err);
          try {
            await ctx.reply(`[${this.botName}] Something went wrong. Check the logs.`);
          } catch { /* ignore */ }
        });
    });
  }

  /**
   * Send a message to the group chat (proactive, not in response to a message).
   * Used by heartbeat, Omega summaries, etc.
   */
  async sendMessage(text: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const labeled = `[${this.botName}] ${text}`;
    try {
      const msg = await this.bot.telegram.sendMessage(chatId, labeled, { parse_mode: "Markdown" });
      this.hourlyMessageCount++;
      return { messageId: msg.message_id };
    } catch {
      const msg = await this.bot.telegram.sendMessage(chatId, labeled);
      this.hourlyMessageCount++;
      return { messageId: msg.message_id };
    }
  }

  async sendPhoto(photo: Buffer | string, caption?: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const labeled = caption ? `[${this.botName}] ${caption}` : `[${this.botName}]`;
    const source = typeof photo === "string" ? { source: photo } : { source: photo };
    const msg = await this.bot.telegram.sendPhoto(chatId, source, { caption: labeled });
    return { messageId: msg.message_id };
  }

  async start(): Promise<void> {
    log.info(`${this.botName} starting Telegram group channel...`);

    const stop = () => {
      log.info(`Stopping ${this.botName} Telegram group channel...`);
      this.bot.stop("SIGINT");
      if (this.hourlyResetTimer) clearInterval(this.hourlyResetTimer);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    await this.bot.launch();

    // Get our own bot user ID to filter self-messages
    const me = await this.bot.telegram.getMe();
    this.botSelfId = me.id;

    log.info(`${this.botName} Telegram group channel running (bot ID: ${this.botSelfId})`);
  }

  async stop(): Promise<void> {
    this.bot.stop("SIGINT");
    if (this.hourlyResetTimer) clearInterval(this.hourlyResetTimer);
  }
}
