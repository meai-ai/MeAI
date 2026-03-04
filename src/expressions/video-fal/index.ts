/**
 * fal.ai Minimax video generation provider.
 *
 * Extracted from src/video.ts. Uses fal.ai's Minimax Video-01
 * for image-to-video animation (~5s videos).
 *
 * Requires: config.falApiKey
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType, VideoInput } from "../types.js";

/** fal.ai Minimax video result shape */
interface MinimaxVideoResult {
  data: {
    video?: { url?: string };
  };
}

let falApiKey: string | undefined;

const provider: ExpressionProvider = {
  id: "video-fal",
  type: "video" as ExpressionType,
  name: "fal.ai Minimax Video Generation",

  init(config: AppConfig): void {
    falApiKey = config.falApiKey;
    if (falApiKey) {
      console.log("[expressions:video-fal] fal.ai video configured");
    }
  },

  isAvailable(): boolean {
    return !!falApiKey;
  },

  async generateVideo(input: VideoInput): Promise<{ buffer: Buffer; path?: string }> {
    if (!falApiKey) throw new Error("fal.ai API key not configured");

    const { createFalClient } = await import("@fal-ai/client");
    const fal = createFalClient({ credentials: falApiKey });

    const result = await fal.subscribe("fal-ai/minimax/video-01/image-to-video", {
      input: {
        image_url: input.imagePath,
        prompt: input.prompt ?? "gentle natural movement",
      },
    });

    const videoUrl = (result as MinimaxVideoResult).data?.video?.url;
    if (!videoUrl) throw new Error("No video returned from fal.ai");

    const res = await fetch(videoUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer };
  },
};

export default provider;
