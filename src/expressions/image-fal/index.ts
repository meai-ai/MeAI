/**
 * fal.ai FLUX image generation provider.
 *
 * Extracted from src/selfie.ts. Uses fal.ai's FLUX Kontext model
 * for scene-aware selfie generation with optional LoRA for identity consistency.
 *
 * Requires: config.falApiKey
 */

import type { AppConfig } from "../../types.js";
import type { ExpressionProvider, ExpressionType, ImageOptions } from "../types.js";

let falApiKey: string | undefined;

const provider: ExpressionProvider = {
  id: "image-fal",
  type: "image" as ExpressionType,
  name: "fal.ai FLUX Image Generation",

  init(config: AppConfig): void {
    falApiKey = config.falApiKey;
    if (falApiKey) {
      console.log("[expressions:image-fal] fal.ai API key configured");
    }
  },

  isAvailable(): boolean {
    return !!falApiKey;
  },

  async generateImage(prompt: string, options?: ImageOptions): Promise<{ buffer: Buffer; path?: string }> {
    if (!falApiKey) throw new Error("fal.ai API key not configured");

    // Use direct fetch like the original selfie.ts — avoids SDK strict typing issues
    // and supports both LoRA (text-to-image) and Kontext (reference image) modes.
    const payload: Record<string, unknown> = { prompt };
    let endpoint: string;

    if (options?.referenceImage) {
      // Kontext mode: reference image for identity consistency
      endpoint = "https://fal.run/fal-ai/flux-pro/kontext/max";
      payload.image_url = options.referenceImage;
      payload.guidance_scale = 1.5;
      payload.num_inference_steps = 50;
    } else {
      // Text-to-image mode
      endpoint = "https://fal.run/fal-ai/flux-pro/v1.1";
      payload.image_size = "square_hd";
      payload.num_inference_steps = 28;
    }

    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Key ${falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`fal.ai API error ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { images?: Array<{ url: string }> };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error("No image returned from fal.ai");

    const imgResp = await fetch(imageUrl);
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    return { buffer };
  },
};

export default provider;
