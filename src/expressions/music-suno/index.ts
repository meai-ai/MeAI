/**
 * Suno music generation provider.
 *
 * Extracted from src/music.ts. Uses Suno's API for AI music composition.
 *
 * Requires: config.sunoApiKey
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType, MusicInput } from "../types.js";
import { generateMusic, isMusicEnabled } from "../../music.js";

const provider: ExpressionProvider = {
  id: "music-suno",
  type: "music" as ExpressionType,
  name: "Suno Music Generation",

  init(_config: AppConfig): void {
    if (isMusicEnabled()) {
      console.log("[expressions:music-suno] Suno API configured (delegating to music.ts)");
    }
  },

  isAvailable(): boolean {
    return isMusicEnabled();
  },

  async generateMusic(input: MusicInput): Promise<{ buffer: Buffer; path?: string }> {
    const result = await generateMusic(
      input.prompt,
      input.style ?? "pop",
      { title: input.title },
    );
    if (!result) throw new Error("Music generation failed");
    return { buffer: result.audio, path: result.audioPath };
  },
};

export default provider;
