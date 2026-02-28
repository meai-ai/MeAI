/**
 * Video selfies — animates a selfie image into a short ~5s video.
 *
 * Uses fal.ai Minimax Video-01 (image-to-video) via the @fal-ai/client SDK:
 *   fal.subscribe() handles submit → poll → result automatically.
 *
 * Not a separate tool — piggybacks on the existing selfie flow.
 * ~20% of selfies randomly become videos; if generation fails,
 * the caller falls back to sending the photo as normal.
 *
 * Rate limited: 10 videos/day, 10-min minimum interval ($0.50/video).
 */

import fs from "node:fs";
import path from "node:path";
import { createFalClient } from "@fal-ai/client";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { createLogger } from "./lib/logger.js";
import type { AppConfig } from "./types.js";

const log = createLogger("video");

// ── Constants ────────────────────────────────────────────────────────

const MAX_DAILY_VIDEOS = 10;
const MIN_VIDEO_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const FAL_MODEL = "fal-ai/minimax/video-01/image-to-video";

// ── State ────────────────────────────────────────────────────────────

interface VideoState {
  dailyDate: string;
  dailyCount: number;
  lastVideoAt: number;
}

// ── VideoEngine class ───────────────────────────────────────────────

export class VideoEngine {
  private config: AppConfig;
  private falClient: ReturnType<typeof createFalClient> | null = null;
  private videoStatePath: string;
  private videoGeneratedDir: string;

  constructor(config: AppConfig) {
    this.config = config;
    this.videoStatePath = path.join(config.statePath, "video", "state.json");
    this.videoGeneratedDir = path.join(config.statePath, "video", "generated");

    if (config.falApiKey) {
      this.falClient = createFalClient({ credentials: config.falApiKey });
      log.info("Video selfies enabled");
    } else {
      log.info("Video selfies disabled (no falApiKey)");
    }
  }

  isVideoEnabled(): boolean {
    return !!this.falClient;
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Animate a selfie image into a short video.
   * Returns the video buffer + saved path, or null on failure / rate limit.
   */
  async generateVideoFromImage(
    imageBuffer: Buffer,
    prompt: string,
    trigger = "selfie",
  ): Promise<{ video: Buffer; videoPath: string } | null> {
    if (!this.config?.falApiKey) return null;

    // Rate limiting
    const state = this.loadState();
    const now = Date.now();
    const todayStr = pstDateStr();

    if (state.dailyDate !== todayStr) {
      state.dailyDate = todayStr;
      state.dailyCount = 0;
    }

    if (state.dailyCount >= MAX_DAILY_VIDEOS) {
      log.info("Daily video limit reached");
      return null;
    }

    if (now - state.lastVideoAt < MIN_VIDEO_INTERVAL_MS) {
      log.info("Video interval too short, skipping");
      return null;
    }

    try {
      // Upload selfie as base64 data URI
      const isJpeg = imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8;
      const mimeType = isJpeg ? "image/jpeg" : "image/png";
      const imageDataUri = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

      // Craft a short animation prompt from the selfie caption
      const videoPrompt = this.buildVideoPrompt(prompt);

      log.info(`Submitting video: prompt="${videoPrompt.slice(0, 80)}..."`);

      // Use fal.subscribe() — handles submit → poll → result automatically
      const result = await this.falClient!.subscribe(FAL_MODEL, {
        input: {
          prompt: videoPrompt,
          image_url: imageDataUri,
          prompt_optimizer: true,
        },
        pollInterval: 5_000,
        timeout: 3 * 60 * 1000,
        logs: false,
        onQueueUpdate: (update) => {
          log.debug(`Queue: ${update.status}`);
        },
      }) as { data: { video?: { url: string } } };

      const videoUrl = result.data?.video?.url;
      if (!videoUrl) {
        log.error("No video URL in result");
        return null;
      }

      log.info(`Video ready: ${videoUrl.slice(0, 80)}...`);

      // Download MP4
      const videoBuffer = await this.downloadVideo(videoUrl);
      if (!videoBuffer) return null;

      // Save to disk
      const filename = `${now}-${trigger}.mp4`;
      const videoPath = path.join(this.videoGeneratedDir, filename);
      fs.writeFileSync(videoPath, videoBuffer);

      // Update state
      state.dailyCount++;
      state.lastVideoAt = now;
      this.saveState(state);

      log.info(`Video saved: ${filename} (${(videoBuffer.length / 1024).toFixed(0)}KB)`);
      return { video: videoBuffer, videoPath };
    } catch (err) {
      log.error("Video generation failed", err);
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildVideoPrompt(captionOrPrompt: string): string {
    // Keep it short — Minimax works best with simple motion descriptions
    const cleaned = captionOrPrompt.replace(/\*\*/g, "").trim();
    if (!cleaned) return "The woman smiles gently and looks at the camera, natural subtle movement.";
    // Add subtle motion cue if the prompt is purely descriptive
    if (!/move|turn|wave|smile|laugh|nod|walk|blink|tilt/i.test(cleaned)) {
      return `${cleaned}. Subtle natural movement, slight smile.`;
    }
    return cleaned;
  }

  private async downloadVideo(url: string): Promise<Buffer | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.error(`Video download failed ${resp.status}`);
        return null;
      }
      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      log.error("Video download error", err);
      return null;
    }
  }

  private loadState(): VideoState {
    return readJsonSafe<VideoState>(this.videoStatePath, {
      dailyDate: "",
      dailyCount: 0,
      lastVideoAt: 0,
    });
  }

  private saveState(state: VideoState): void {
    writeJsonAtomic(this.videoStatePath, state);
  }
}

// ── Module state (backward compat singleton) ─────────────────────────

let _singleton: VideoEngine | null = null;

// ── Init ─────────────────────────────────────────────────────────────

export function initVideo(cfg: AppConfig): VideoEngine {
  _singleton = new VideoEngine(cfg);
  return _singleton;
}

// ── Backward-compat function exports ─────────────────────────────────

export function isVideoEnabled(): boolean {
  return _singleton?.isVideoEnabled() ?? false;
}

export async function generateVideoFromImage(
  imageBuffer: Buffer,
  prompt: string,
  trigger = "selfie",
): Promise<{ video: Buffer; videoPath: string } | null> {
  return _singleton?.generateVideoFromImage(imageBuffer, prompt, trigger) ?? null;
}
