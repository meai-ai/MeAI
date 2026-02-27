/**
 * Channel interface — abstraction for communication platforms.
 *
 * Telegram, Discord, Slack, WhatsApp, web UI, voice, CLI — anything
 * that can send and receive messages implements this interface.
 */

export interface ImageData {
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/**
 * Handler called when a message arrives from the channel.
 * The channel provides reply/edit/typing helpers bound to the conversation.
 */
export type MessageHandler = (
  text: string,
  chatId: number | string,
  sendReply: (text: string) => Promise<{ messageId: number | string }>,
  editReply: (messageId: number | string, text: string) => Promise<void>,
  sendTyping: () => Promise<void>,
  imageData?: ImageData,
) => Promise<void>;

/** Handler for audio transcription. */
export type TranscribeHandler = (buffer: Buffer, filename: string) => Promise<string>;

/** An approval request for evolution Tier 3/4. */
export interface ApprovalRequest {
  type: "tool" | "patch";
  id: string;
  title: string;
  description: string;
  detail?: string;
}

/** Handler for approval responses (approve/deny). */
export type ApprovalHandler = (
  id: string,
  type: "tool" | "patch",
  approved: boolean,
) => Promise<void>;

/**
 * Core Channel interface — all communication platforms implement this.
 */
export interface Channel {
  /** Unique channel ID, e.g. "telegram", "discord". */
  readonly id: string;
  /** Display name, e.g. "Telegram Bot". */
  readonly name: string;

  /** Start the channel (connect, launch bot, etc.). */
  start(): Promise<void>;
  /** Stop the channel gracefully. */
  stop(): Promise<void>;

  /** Register the message handler (called by the agent loop). */
  onMessage(handler: MessageHandler): void;
  /** Register the audio transcription handler. */
  onTranscribe?(handler: TranscribeHandler): void;

  // ── Outgoing messages ──────────────────────────────────────────────

  sendMessage(text: string): Promise<{ messageId: number | string }>;
  sendPhoto(photo: Buffer | string, caption?: string): Promise<{ messageId: number | string }>;
  sendVideo?(video: Buffer, caption?: string): Promise<{ messageId: number | string }>;
  sendVoice?(voice: Buffer, caption?: string): Promise<{ messageId: number | string }>;
  sendAudio?(audio: Buffer, title?: string, performer?: string): Promise<{ messageId: number | string }>;
  deleteMessage?(messageId: number | string): Promise<void>;

  // ── Evolution approval (Tier 3/4) ──────────────────────────────────

  /** Send a tool or patch proposal for user approval. */
  sendToolProposal?(name: string, description: string, code: string): Promise<void>;
  sendPatchProposal?(patchId: string, reason: string, filesChanged: string[]): Promise<void>;

  /** Register handlers for approval UI interactions. */
  setupToolApprovalHandlers?(config: unknown): void;
  setupPatchApprovalHandlers?(config: unknown, sendMessage: (text: string) => Promise<void>): void;

  // ── Moments / Timeline ─────────────────────────────────────────────

  /** Post a moment to the timeline channel (if supported). */
  postMoment?(text: string, mediaPath?: string): Promise<number | undefined>;
}
