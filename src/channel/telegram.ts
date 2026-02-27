/**
 * Telegram channel for MeAI.
 *
 * Sets up a Telegraf bot that:
 * - Filters messages to only the allowed chat ID
 * - Shows a typing indicator while processing
 * - Delegates message handling to a callback (agent loop)
 * - Supports inline keyboard callbacks for Tier 3/4 approval gates
 */

import fs from "node:fs";
import { Telegraf, Markup } from "telegraf";
import type { Message } from "telegraf/types";
import type { AppConfig } from "../types.js";
import https from "https";
import http from "http";
import { getCharacter } from "../character.js";
import type { Channel, ImageData, MessageHandler, TranscribeHandler } from "./types.js";

export type { ImageData, MessageHandler, TranscribeHandler };

export class TelegramChannel implements Channel {
  readonly id = "telegram";
  readonly name = "Telegram Bot";

  private bot: Telegraf;
  private config: AppConfig;
  private handler: MessageHandler | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private transcriber: TranscribeHandler | null = null;

  // ── Debounce state ──────────────────────────────────────────────────
  // When the user sends multiple messages in quick succession (e.g., "haha"
  // then "I was just talking about global state"), we batch them into a single handler call.
  // This prevents duplicate/contradictory responses from racing LLM calls.
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceBuffer: string[] = [];
  private debounceCtx: any = null; // last Telegraf context (for reply helpers)
  private static readonly DEBOUNCE_MS = 3000; // 3 seconds

  constructor(config: AppConfig) {
    this.config = config;
    // handlerTimeout: 0 disables Telegraf's built-in 90s middleware timeout.
    // Claude Opus responses can take 2-3 minutes; we manage our own streaming
    // feedback via editReply so there is no need for a hard cutoff here.
    this.bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 0 });
    this.setupHandlers();
  }

  /**
   * Register the message handler (called by the agent loop).
   */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onTranscribe(handler: TranscribeHandler): void {
    this.transcriber = handler;
  }

  /**
   * Get the underlying Telegraf bot instance (for inline keyboard callbacks, etc.)
   */
  getBot(): Telegraf {
    return this.bot;
  }

  /**
   * Send a tool proposal message with inline keyboard for approval.
   */
  async sendToolProposal(
    name: string,
    description: string,
    code: string,
  ): Promise<void> {
    const chatId = this.config.allowedChatId;

    // Build a summary message
    const preview = code.length > 200 ? code.slice(0, 200) + "..." : code;
    const text =
      `🔧 **Tool Proposal: ${name}**\n\n` +
      `${description}\n\n` +
      `\`\`\`\n${preview}\n\`\`\``;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback("Approve ✅", `tool_approve:${name}`),
      Markup.button.callback("Deny ❌", `tool_deny:${name}`),
      Markup.button.callback("Show Full Code 👁", `tool_code:${name}`),
    ]);

    await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...keyboard,
    });
  }

  /**
   * Send a code patch proposal message with inline keyboard for approval.
   */
  async sendPatchProposal(
    patchId: string,
    reason: string,
    filesChanged: string[],
  ): Promise<void> {
    const chatId = this.config.allowedChatId;

    const fileList = filesChanged.map((f) => `- ${f}`).join("\n");
    const text =
      `🔨 **Code Patch Proposal**\n\n` +
      `**Reason:** ${reason}\n\n` +
      `**Files changed:**\n${fileList}`;

    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback("Approve ✅", `patch_approve:${patchId}`),
      Markup.button.callback("Deny ❌", `patch_deny:${patchId}`),
    ]);

    await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...keyboard,
    });
  }

  /**
   * Send a photo to the allowed chat.
   */
  async sendPhoto(photo: Buffer | string, caption?: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const source = typeof photo === "string" ? { source: photo } : { source: photo };
    const msg = await this.bot.telegram.sendPhoto(chatId, source, {
      caption,
    });
    return { messageId: msg.message_id };
  }

  /**
   * Send a video to the allowed chat.
   */
  async sendVideo(video: Buffer, caption?: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const msg = await this.bot.telegram.sendVideo(chatId, { source: video }, {
      caption,
    });
    return { messageId: msg.message_id };
  }

  /**
   * Send a voice message to the allowed chat.
   */
  async sendVoice(audio: Buffer, caption?: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const msg = await this.bot.telegram.sendVoice(chatId, { source: audio }, {
      caption,
    });
    return { messageId: msg.message_id };
  }

  /**
   * Send an audio file to the allowed chat (shows as music player, not voice bubble).
   */
  async sendAudio(audio: Buffer, title?: string, performer?: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const msg = await this.bot.telegram.sendAudio(chatId, { source: audio }, {
      title,
      performer,
    });
    return { messageId: msg.message_id };
  }

  /**
   * Send a sticker to the allowed chat.
   */
  async sendSticker(stickerId: string): Promise<{ messageId: number | string }> {
    const chatId = this.config.allowedChatId;
    const msg = await this.bot.telegram.sendSticker(chatId, stickerId);
    return { messageId: msg.message_id };
  }

  async deleteMessage(messageId: number | string): Promise<void> {
    await this.bot.telegram.deleteMessage(this.config.allowedChatId, Number(messageId));
  }

  /**
   * Post a moment to the Telegram moments channel (if configured).
   */
  async postMoment(text: string, mediaPath?: string): Promise<number | undefined> {
    const channelId = this.config.momentsChannelId;
    if (!channelId) return undefined;

    if (mediaPath && fs.existsSync(mediaPath)) {
      const msg = await this.bot.telegram.sendPhoto(
        channelId,
        { source: mediaPath },
        { caption: text },
      );
      return msg.message_id;
    } else {
      const msg = await this.bot.telegram.sendMessage(channelId, text);
      return msg.message_id;
    }
  }

  async stop(): Promise<void> {
    this.bot.stop("SIGINT");
  }

  /**
   * Send a message to the allowed chat.
   */
  async sendMessage(text: string): Promise<{ messageId: number | string }> {
    try {
      const msg = await this.bot.telegram.sendMessage(this.config.allowedChatId, text, {
        parse_mode: "Markdown",
      });
      return { messageId: msg.message_id };
    } catch {
      const msg = await this.bot.telegram.sendMessage(this.config.allowedChatId, text);
      return { messageId: msg.message_id };
    }
  }

  /**
   * Flush the debounce buffer — combine all buffered messages and dispatch
   * to the handler as a single combined message.
   */
  private flushDebounce(): void {
    const messages = this.debounceBuffer.splice(0);
    const ctx = this.debounceCtx;
    this.debounceTimer = null;
    this.debounceCtx = null;

    if (messages.length === 0 || !ctx || !this.handler) return;

    // Combine messages: join with newline if multiple
    const combined = messages.length === 1
      ? messages[0]
      : messages.join("\n");

    const chatId = ctx.chat.id;

    const sendTyping = async () => {
      await ctx.sendChatAction("typing");
    };

    const sendReply = async (replyText: string): Promise<{ messageId: number | string }> => {
      try {
        const m = await ctx.reply(replyText, { parse_mode: "Markdown" });
        return { messageId: m.message_id };
      } catch {
        const m = await ctx.reply(replyText);
        return { messageId: m.message_id };
      }
    };

    const editReply = async (messageId: number | string, replyText: string) => {
      try {
        await ctx.telegram.editMessageText(chatId, Number(messageId), undefined, replyText);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("message is not modified")) throw err;
      }
    };

    // Sequential message queue: prevent concurrent handleMessage calls
    // (two rapid messages could otherwise both trigger parallel LLM calls → duplicate replies)
    sendTyping().catch(() => {});
    this.messageQueue = this.messageQueue
      .then(() => this.handler!(combined, chatId, sendReply, editReply, sendTyping))
      .catch(async (err) => {
        console.error("Error handling message:", err);
        try {
          await ctx.reply("Something went wrong. Check the logs.");
        } catch { /* ignore */ }
      });
  }

  /** Download a file from Telegram and return it as base64. */
  private async downloadTelegramFile(fileId: string): Promise<{ base64: string; mimeType: ImageData["mimeType"] }> {
    const file = await this.bot.telegram.getFile(fileId);
    const filePath = file.file_path!;
    const url = `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${filePath}`;

    const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mimeMap: Record<string, ImageData["mimeType"]> = {
      jpg: "image/jpeg", jpeg: "image/jpeg",
      png: "image/png", gif: "image/gif", webp: "image/webp",
    };
    const mimeType = mimeMap[ext] ?? "image/jpeg";

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const get = url.startsWith("https") ? https.get : http.get;
      get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });

    return { base64: buffer.toString("base64"), mimeType };
  }

  private setupHandlers(): void {
    // Global error handler — catches any unhandled errors in middleware or handlers.
    // Without this, errors propagate as unhandled rejections and crash the process.
    this.bot.catch((err: unknown) => {
      console.error("Telegraf unhandled error:", err);
      // Do NOT rethrow — let the bot keep running.
    });

    // Handle text messages — with debounce to batch rapid-fire messages.
    // Like a real person: reads all messages first, then responds once.
    this.bot.on("text", async (ctx) => {
      const chatId = ctx.chat.id;

      // Enforce single-user access
      if (chatId !== this.config.allowedChatId) {
        console.log(`Dropping message from unauthorized chat: ${chatId}`);
        return;
      }

      const text = ctx.message.text;

      if (!this.handler) {
        await ctx.reply("MeAI is starting up, please wait...");
        return;
      }

      // Buffer this message and reset the debounce timer
      this.debounceBuffer.push(text);
      this.debounceCtx = ctx;

      // Show typing immediately so user knows she's "reading"
      ctx.sendChatAction("typing").catch(() => {});

      if (this.debounceTimer) clearTimeout(this.debounceTimer);

      this.debounceTimer = setTimeout(() => {
        this.flushDebounce();
      }, TelegramChannel.DEBOUNCE_MS);
    });

    // Handle photo messages (vision) — flush any pending text debounce first
    this.bot.on("photo", async (ctx) => {
      const chatId = ctx.chat.id;
      if (chatId !== this.config.allowedChatId) return;
      if (!this.handler) { await ctx.reply("MeAI is starting up, please wait..."); return; }

      // Flush any pending debounced text messages before handling photo
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.flushDebounce();
      }

      const caption = ctx.message.caption ?? "";

      const sendTyping = async () => { await ctx.sendChatAction("typing"); };
      const sendReply = async (replyText: string): Promise<{ messageId: number | string }> => {
        try { const m = await ctx.reply(replyText, { parse_mode: "Markdown" }); return { messageId: m.message_id }; }
        catch { const m = await ctx.reply(replyText); return { messageId: m.message_id }; }
      };
      const editReply = async (messageId: number | string, replyText: string) => {
        try {
          await ctx.telegram.editMessageText(chatId, Number(messageId), undefined, replyText);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("message is not modified")) throw err;
        }
      };

      sendTyping().catch(() => {});
      Promise.resolve()
        .then(async () => {
          // Pick highest-resolution photo
          const photos = ctx.message.photo;
          const best = photos[photos.length - 1];
          const imageData = await this.downloadTelegramFile(best.file_id);
          const text = caption || `(${getCharacter().user.name} sent a photo)`;
          await this.handler!(text, chatId, sendReply, editReply, sendTyping, imageData);
        })
        .catch(async (err) => {
          console.error("Error handling photo:", err);
          try { await ctx.reply("Image processing failed, please try again."); } catch { /* ignore */ }
        });
    });

    // Handle voice messages and audio files (speech-to-text via Whisper)
    const handleAudio = async (ctx: any, fileId: string, filename: string) => {
      const chatId = ctx.chat.id;
      if (chatId !== this.config.allowedChatId) return;
      if (!this.handler) { await ctx.reply("MeAI is starting up, please wait..."); return; }
      if (!this.transcriber) { await ctx.reply("⚠️ Voice transcription not configured."); return; }

      // Flush any pending debounced text messages before handling audio
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.flushDebounce();
      }

      const sendTyping = async () => { await ctx.sendChatAction("typing"); };
      const sendReply = async (replyText: string): Promise<{ messageId: number | string }> => {
        try { const m = await ctx.reply(replyText, { parse_mode: "Markdown" }); return { messageId: m.message_id }; }
        catch { const m = await ctx.reply(replyText); return { messageId: m.message_id }; }
      };
      const editReply = async (messageId: number | string, replyText: string) => {
        try {
          await ctx.telegram.editMessageText(chatId, Number(messageId), undefined, replyText);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("message is not modified")) throw err;
        }
      };

      sendTyping().catch(() => {});
      Promise.resolve()
        .then(async () => {
          // Download audio
          const { base64 } = await this.downloadTelegramFile(fileId);
          const buffer = Buffer.from(base64, "base64");

          // Show transcribing indicator
          const statusMsg = await sendReply("🎤 Transcribing voice...");

          // Transcribe via Whisper
          let transcript: string;
          try {
            transcript = await this.transcriber!(buffer, filename);
          } catch (err) {
            await ctx.telegram.editMessageText(chatId, Number(statusMsg.messageId), undefined, "❌ Voice recognition failed, please try again.");
            return;
          }

          if (!transcript) {
            await ctx.telegram.editMessageText(chatId, Number(statusMsg.messageId), undefined, "❌ Could not recognize voice content.");
            return;
          }

          // Remove the status indicator — transcript doesn't need to appear in chat
          await ctx.telegram.deleteMessage(chatId, Number(statusMsg.messageId)).catch(() => {});

          // Process as normal message
          await this.handler!(transcript, chatId, sendReply, editReply, sendTyping);
        })
        .catch(async (err) => {
          console.error("Error handling audio:", err);
          try { await ctx.reply("Voice processing failed, please try again."); } catch { /* ignore */ }
        });
    };

    this.bot.on("voice", (ctx) =>
      handleAudio(ctx, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`),
    );

    this.bot.on("audio", (ctx) =>
      handleAudio(ctx, ctx.message.audio.file_id, ctx.message.audio.file_name ?? `audio_${Date.now()}.mp3`),
    );
  }

  async start(): Promise<void> {
    console.log("Telegram bot starting...");

    // Graceful shutdown
    const stop = () => {
      console.log("Stopping Telegram bot...");
      this.bot.stop("SIGINT");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    await this.bot.launch();
    console.log("Telegram bot is running.");
  }
}
