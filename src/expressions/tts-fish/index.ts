/**
 * Fish Audio TTS provider.
 *
 * Extracted from src/tts.ts. Uses Fish Audio's API for text-to-speech
 * with emotion-aware speed and temperature mapping.
 *
 * Requires: config.fishAudioApiKey, config.fishAudioVoiceId
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType, TTSOptions } from "../types.js";

let fishApiKey: string | undefined;
let fishVoiceId: string | undefined;

const provider: ExpressionProvider = {
  id: "tts-fish",
  type: "tts" as ExpressionType,
  name: "Fish Audio TTS",

  init(config: AppConfig): void {
    fishApiKey = config.fishAudioApiKey;
    fishVoiceId = config.fishAudioVoiceId;
    if (fishApiKey && fishVoiceId) {
      console.log("[expressions:tts-fish] Fish Audio configured");
    }
  },

  isAvailable(): boolean {
    return !!(fishApiKey && fishVoiceId);
  },

  async generateSpeech(text: string, options?: TTSOptions): Promise<{ buffer: Buffer; format: string }> {
    if (!fishApiKey || !fishVoiceId) throw new Error("Fish Audio not configured");

    const voiceId = options?.voiceId ?? fishVoiceId;
    const speed = options?.speed ?? 1.0;
    const temperature = options?.temperature ?? 0.7;

    const response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fishApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: "opus",
        speed,
        temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`Fish Audio API error: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, format: "opus" };
  },
};

export default provider;
