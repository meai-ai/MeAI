/**
 * Discord channel — stub implementation for contributors.
 *
 * This is a reference skeleton showing how to implement the Channel interface
 * for Discord. To use it:
 * 1. Install discord.js: npm install discord.js
 * 2. Add discordBotToken + discordChannelId to config.json
 * 3. Set "channel": "discord" in config.json
 * 4. Fill in the method implementations below
 */

import type { AppConfig } from "../types.js";
import type { Channel, MessageHandler, TranscribeHandler, ImageData } from "./types.js";

export class DiscordChannel implements Channel {
  readonly id = "discord";
  readonly name = "Discord Bot";

  private handler: MessageHandler | null = null;
  // private client: DiscordClient; // uncomment when discord.js is installed

  constructor(_config: AppConfig) {
    // TODO: Initialize Discord.js client
    // this.client = new Client({ intents: [...] });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onTranscribe?(_handler: TranscribeHandler): void {
    // Discord doesn't have native voice-to-text, but could integrate Whisper
  }

  async start(): Promise<void> {
    // TODO: await this.client.login(token);
    console.log("[discord] Discord channel started (stub — not yet implemented)");
  }

  async stop(): Promise<void> {
    // TODO: this.client.destroy();
  }

  async sendMessage(text: string): Promise<{ messageId: number | string }> {
    // TODO: const msg = await channel.send(text);
    // return { messageId: msg.id };
    console.log(`[discord] sendMessage (stub): ${text.slice(0, 100)}`);
    return { messageId: "stub" };
  }

  async sendPhoto(
    _photo: Buffer | string,
    _caption?: string,
  ): Promise<{ messageId: number | string }> {
    // TODO: send photo as attachment
    console.log("[discord] sendPhoto (stub)");
    return { messageId: "stub" };
  }

  async sendVideo?(
    _video: Buffer,
    _caption?: string,
  ): Promise<{ messageId: number | string }> {
    console.log("[discord] sendVideo (stub)");
    return { messageId: "stub" };
  }

  async sendVoice?(
    _voice: Buffer,
    _caption?: string,
  ): Promise<{ messageId: number | string }> {
    console.log("[discord] sendVoice (stub)");
    return { messageId: "stub" };
  }

  async deleteMessage?(_messageId: number | string): Promise<void> {
    // TODO: await message.delete();
  }
}
