/**
 * Expression Provider interface — abstraction for creative output.
 *
 * Contributors can swap image generation (DALL-E, Stable Diffusion),
 * TTS (ElevenLabs, OpenAI), video, music, and social posting providers
 * by creating src/expressions/<provider>/index.ts.
 */

import type { AppConfig } from "../types.js";

/** Types of creative expression. */
export type ExpressionType = "image" | "tts" | "video" | "music" | "social_post";

/** Options for image generation. */
export interface ImageOptions {
  /** Reference image path for consistent identity. */
  referenceImage?: string;
  /** Style hint (e.g. "anime", "photorealistic"). */
  style?: string;
  /** Aspect ratio (e.g. "16:9", "1:1"). */
  aspectRatio?: string;
}

/** Options for text-to-speech. */
export interface TTSOptions {
  /** Speed multiplier (0.5-2.0). */
  speed?: number;
  /** Expressiveness (0.0-1.0). */
  temperature?: number;
  /** Provider-specific voice ID. */
  voiceId?: string;
}

/** Input for video generation. */
export interface VideoInput {
  /** Source image to animate. */
  imagePath: string;
  /** Prompt describing desired motion. */
  prompt?: string;
}

/** Input for music generation. */
export interface MusicInput {
  /** Text prompt for the song. */
  prompt: string;
  /** Style/genre hint. */
  style?: string;
  /** Title for the generated track. */
  title?: string;
}

/** Core interface for all expression providers. */
export interface ExpressionProvider {
  /** Unique provider ID, e.g. "image-fal", "tts-elevenlabs". */
  readonly id: string;
  /** Expression type this provider handles. */
  readonly type: ExpressionType;
  /** Display name, e.g. "fal.ai FLUX Image Generation". */
  readonly name: string;

  /** Called once at startup with the app config. */
  init?(config: AppConfig): void | Promise<void>;
  /** Whether this provider is currently available. */
  isAvailable(): boolean;

  /** Generate an image from a prompt. */
  generateImage?(prompt: string, options?: ImageOptions): Promise<{ buffer: Buffer; path?: string }>;
  /** Generate speech from text. */
  generateSpeech?(text: string, options?: TTSOptions): Promise<{ buffer: Buffer; format: string }>;
  /** Generate a video from an image. */
  generateVideo?(input: VideoInput): Promise<{ buffer: Buffer; path?: string }>;
  /** Generate music from a prompt. */
  generateMusic?(input: MusicInput): Promise<{ buffer: Buffer; path?: string }>;
  /** Post to social media. */
  postSocial?(text: string, media?: Buffer): Promise<{ postId?: string; url?: string }>;

  /** Config key — reads from config.json. */
  configKey?: string;
}
