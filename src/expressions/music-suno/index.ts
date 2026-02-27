/**
 * Suno music generation provider.
 *
 * Extracted from src/music.ts. Uses Suno's API for AI music composition.
 *
 * Requires: config.sunoApiKey
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType, MusicInput } from "../types.js";

let sunoApiKey: string | undefined;

const provider: ExpressionProvider = {
  id: "music-suno",
  type: "music" as ExpressionType,
  name: "Suno Music Generation",

  init(config: AppConfig): void {
    sunoApiKey = config.sunoApiKey;
    if (sunoApiKey) {
      console.log("[expressions:music-suno] Suno API configured");
    }
  },

  isAvailable(): boolean {
    return !!sunoApiKey;
  },

  async generateMusic(input: MusicInput): Promise<{ buffer: Buffer; path?: string }> {
    if (!sunoApiKey) throw new Error("Suno API key not configured");

    // Suno API: POST /api/generate
    const response = await fetch("https://studio-api.suno.ai/api/external/generate/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sunoApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic: input.prompt,
        tags: input.style ?? "pop",
        title: input.title ?? "Untitled",
      }),
    });

    if (!response.ok) {
      throw new Error(`Suno API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    const audioUrl = data?.clips?.[0]?.audio_url;
    if (!audioUrl) throw new Error("No audio returned from Suno");

    const audioRes = await fetch(audioUrl);
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    return { buffer };
  },
};

export default provider;
