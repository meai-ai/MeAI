# Creating a Channel

Channels are how MeAI communicates with users — Telegram, Discord, Slack, WhatsApp, web UI, CLI, etc.

## Quick Start

1. Create `src/channel/your-channel.ts` implementing the `Channel` interface
2. Register it in `src/channel/factory.ts`
3. Set `"channel": "your-channel"` in `config.json`

## Channel Interface

```typescript
interface Channel {
  readonly id: string;      // "telegram", "discord"
  readonly name: string;    // "Telegram Bot"

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: MessageHandler): void;
  onTranscribe?(handler: TranscribeHandler): void;

  // Outgoing
  sendMessage(text: string): Promise<{ messageId: number | string }>;
  sendPhoto(photo: Buffer | string, caption?: string): Promise<{ messageId: number | string }>;
  sendVideo?(video: Buffer, caption?: string): Promise<{ messageId: number | string }>;
  sendVoice?(voice: Buffer, caption?: string): Promise<{ messageId: number | string }>;
  sendAudio?(audio: Buffer, title?: string, performer?: string): Promise<{ messageId: number | string }>;
  deleteMessage?(messageId: number | string): Promise<void>;

  // Evolution approval (optional)
  sendToolProposal?(name: string, description: string, code: string): Promise<void>;
  sendPatchProposal?(patchId: string, reason: string, filesChanged: string[]): Promise<void>;

  // Moments (optional)
  postMoment?(text: string, mediaPath?: string): Promise<number | undefined>;
}
```

## MessageHandler

Your channel must call the registered `MessageHandler` when a message arrives:

```typescript
type MessageHandler = (
  text: string,
  chatId: number | string,
  sendReply: (text: string) => Promise<{ messageId: number | string }>,
  editReply: (messageId: number | string, text: string) => Promise<void>,
  sendTyping: () => Promise<void>,
  imageData?: ImageData,
) => Promise<void>;
```

The `sendReply`, `editReply`, and `sendTyping` closures let the agent loop interact with the channel without knowing its specifics.

## Registration

Add your channel to `src/channel/factory.ts`:

```typescript
import { YourChannel } from "./your-channel.js";

export function createChannel(config: AppConfig): Channel {
  const channelType = config.channel ?? "telegram";
  switch (channelType) {
    case "telegram": return new TelegramChannel(config);
    case "your-channel": return new YourChannel(config);
    default: return new TelegramChannel(config);
  }
}
```

## Config

Set the channel type in `data/config.json`:

```json
{
  "channel": "discord",
  "discordBotToken": "...",
  "discordChannelId": "..."
}
```

## Reference

See `src/channel/telegram.ts` for the full Telegram implementation and `src/channel/discord.ts` for a stub starter.

## Optional Features

- **Approval UI**: Implement `sendToolProposal`/`sendPatchProposal` for Tier 3/4 evolution
- **Moments**: Implement `postMoment` for timeline/feed posting
- **Transcription**: Register `onTranscribe` for voice-to-text
- **Message debouncing**: Buffer rapid messages and dispatch once (see Telegram's 3s debounce)
