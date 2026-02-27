# Creating an Expression Provider

Expression Providers handle creative output — image generation, text-to-speech, video, music, social posting.

## Quick Start

1. Create `src/expressions/<your-provider>/index.ts`
2. Export a default `ExpressionProvider` instance
3. Restart MeAI — your provider is auto-discovered

## ExpressionProvider Interface

```typescript
interface ExpressionProvider {
  readonly id: string;           // "image-dalle", "tts-elevenlabs"
  readonly type: ExpressionType; // "image" | "tts" | "video" | "music" | "social_post"
  readonly name: string;

  init?(config: AppConfig): void | Promise<void>;
  isAvailable(): boolean;

  generateImage?(prompt: string, options?: ImageOptions): Promise<{ buffer: Buffer; path?: string }>;
  generateSpeech?(text: string, options?: TTSOptions): Promise<{ buffer: Buffer; format: string }>;
  generateVideo?(input: VideoInput): Promise<{ buffer: Buffer; path?: string }>;
  generateMusic?(input: MusicInput): Promise<{ buffer: Buffer; path?: string }>;
  postSocial?(text: string, media?: Buffer): Promise<{ postId?: string; url?: string }>;
}
```

## Expression Types

| Type | Default Provider | What It Does |
|------|-----------------|-------------|
| `image` | `image-fal` | Selfie/photo generation |
| `tts` | `tts-fish` | Voice messages |
| `video` | `video-fal` | Animated selfie videos |
| `music` | `music-suno` | AI music composition |
| `social_post` | `social-x` | X/Twitter posting |

## Usage

The registry provides the first available provider for each type:

```typescript
import { expressionRegistry } from "./expressions/registry.js";

const imageProvider = expressionRegistry.getExpression("image");
if (imageProvider) {
  const { buffer } = await imageProvider.generateImage!("a sunny park selfie");
}
```

## Existing Providers

- `image-fal` — fal.ai FLUX (requires `falApiKey`)
- `tts-fish` — Fish Audio (requires `fishAudioApiKey` + `fishAudioVoiceId`)
- `video-fal` — fal.ai Minimax (requires `falApiKey`)
- `music-suno` — Suno (requires `sunoApiKey`)
- `social-x` — X/Twitter (requires X API credentials)
