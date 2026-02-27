/**
 * Channel factory — creates the appropriate channel implementation
 * based on configuration.
 *
 * Default: Telegram. Contributors can add Discord, Slack, etc.
 * by creating a new Channel implementation and registering it here.
 */

import type { AppConfig } from "../types.js";
import type { Channel } from "./types.js";
import { TelegramChannel } from "./telegram.js";

/**
 * Create a channel instance based on config.
 * Reads config.channel (default: "telegram") and returns the right implementation.
 */
export function createChannel(config: AppConfig): Channel {
  const channelType = (config as AppConfig & { channel?: string }).channel ?? "telegram";

  switch (channelType) {
    case "telegram":
      return new TelegramChannel(config);
    default:
      console.warn(`Unknown channel type "${channelType}", falling back to Telegram`);
      return new TelegramChannel(config);
  }
}
