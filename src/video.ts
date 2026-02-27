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

let appConfig: AppConfig | null = null;
let falClient: ReturnType<typeof createFalClient> | null = null;
let videoStatePath = "";
let videoGeneratedDir = "";

// ── Init ─────────────────────────────────────────────────────────────

export function initVideo(cfg: AppConfig): void {
  appConfig = cfg;
  videoStatePath = path.join(cfg.statePath, "video", "state.json");
  videoGeneratedDir = path.join(cfg.statePath, "video", "generated");

  if (cfg.falApiKey) {
    falClient = createFalClient({ credentials: cfg.falApiKey });
    log.info("Video selfies enabled");
  } else {
    log.info("Video selfies disabled (no falApiKey)");
  }
}

export function isVideoEnabled(): boolean {
  return !!falClient;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Animate a selfie image into a short video.
 * Returns the video buffer + saved path, or null on failure / rate limit.
 */
export async function generateVideoFromImage(
  imageBuffer: Buffer,
  prompt: string,
  trigger = "selfie",
): Promise<{ video: Buffer; videoPath: string } | null> {
  if (!appConfig?.falApiKey) return null;

  // Rate limiting
  const state = loadState();
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
    const videoPrompt = buildVideoPrompt(prompt);

    log.info(`Submitting video: prompt="${videoPrompt.slice(0, 80)}..."`);

    // Use fal.subscribe() — handles submit → poll → result automatically
    const result = await falClient!.subscribe(FAL_MODEL, {
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
    const videoBuffer = await downloadVideo(videoUrl);
    if (!videoBuffer) return null;

    // Save to disk
    const filename = `${now}-${trigger}.mp4`;
    const videoPath = path.join(videoGeneratedDir, filename);
    fs.writeFileSync(videoPath, videoBuffer);

    // Update state
    state.dailyCount++;
    state.lastVideoAt = now;
    saveState(state);

    log.info(`Video saved: ${filename} (${(videoBuffer.length / 1024).toFixed(0)}KB)`);
    return { video: videoBuffer, videoPath };
  } catch (err) {
    log.error("Video generation failed", err);
    return null;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

function buildVideoPrompt(captionOrPrompt: string): string {
  // Keep it short — Minimax works best with simple motion descriptions
  const cleaned = captionOrPrompt.replace(/\*\*/g, "").trim();
  if (!cleaned) return "The woman smiles gently and looks at the camera, natural subtle movement.";
  // Add subtle motion cue if the prompt is purely descriptive
  if (!/move|turn|wave|smile|laugh|nod|walk|blink|tilt/i.test(cleaned)) {
    return `${cleaned}. Subtle natural movement, slight smile.`;
  }
  return cleaned;
}

async function downloadVideo(url: string): Promise<Buffer | null> {
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

function loadState(): VideoState {
  return readJsonSafe<VideoState>(videoStatePath, {
    dailyDate: "",
    dailyCount: 0,
    lastVideoAt: 0,
  });
}

function saveState(state: VideoState): void {
  writeJsonAtomic(videoStatePath, state);
}
