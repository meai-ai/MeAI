/**
 * Music generation — gives the character the ability to compose songs via Suno API.
 *
 * Follows the tts.ts / video.ts pattern:
 *   src/music.ts (core) + data/skills/music/tools.ts (tool def)
 *   → handleMusicResult in loop.ts → sendAudioFn → telegram.sendAudio
 *
 * Emotion→style mapping (no LLM call, pure lookup):
 *   High energy + positive valence → upbeat pop, indie rock, funk
 *   Low energy + positive valence  → lo-fi, acoustic, bossa nova
 *   High energy + negative valence → emo rock, dramatic piano
 *   Low energy + negative valence  → melancholy ballad, ambient, sad piano
 *
 * Requires:
 *   - config.sunoApiKey
 *
 * Rate limited: 5 compositions/day, 30-min minimum interval (~$0.06-0.12/generation)
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { getEmotionalState } from "./emotion.js";
import { createLogger } from "./lib/logger.js";
import type { AppConfig } from "./types.js";

const log = createLogger("music");

// ── Types ────────────────────────────────────────────────────────────

export interface MusicResult {
  audioPath: string;
  audio: Buffer;
  title: string;
  style: string;
}

interface MusicState {
  dailyDate: string;
  dailyCount: number;
  lastMusicAt: number;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_DAILY_COMPOSITIONS = 5;
const MIN_MUSIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
const SUNO_API_BASE = "https://api.sunoapi.org/api/v1";

// ── Module state ─────────────────────────────────────────────────────

let config: AppConfig | null = null;
let stateFilePath = "";
let musicDir = "";
let generatedDir = "";

// ── Init ─────────────────────────────────────────────────────────────

export function initMusic(cfg: AppConfig): void {
  config = cfg;
  musicDir = path.join(cfg.statePath, "music");
  generatedDir = path.join(musicDir, "generated");
  stateFilePath = path.join(musicDir, "state.json");

  if (!isMusicEnabled()) {
    log.info("Music disabled (missing sunoApiKey)");
    return;
  }

  log.info("Music enabled — Suno API composition ready");
}

// ── Public API ───────────────────────────────────────────────────────

export function isMusicEnabled(): boolean {
  return !!config?.sunoApiKey;
}

/**
 * Generate a music track via Suno API.
 * Returns the audio buffer, file path, title, and style, or null if rate-limited/disabled.
 */
export async function generateMusic(
  prompt: string,
  style: string,
  opts?: { instrumental?: boolean; title?: string },
): Promise<MusicResult | null> {
  if (!isMusicEnabled() || !config) return null;

  // Rate limiting
  const state = loadState();
  const now = Date.now();
  const todayStr = pstDateStr();

  if (state.dailyDate !== todayStr) {
    state.dailyDate = todayStr;
    state.dailyCount = 0;
  }

  if (state.dailyCount >= MAX_DAILY_COMPOSITIONS) {
    log.info("Daily composition limit reached");
    return null;
  }

  if (now - state.lastMusicAt < MIN_MUSIC_INTERVAL_MS) {
    log.info("Music interval too short, skipping");
    return null;
  }

  try {
    const title = opts?.title ?? "Untitled";
    const instrumental = opts?.instrumental ?? false;

    log.info(`Submitting: "${title}" style="${style}" instrumental=${instrumental}`);

    // Submit generation request
    const taskId = await callSunoApi(prompt, style, title, instrumental);
    if (!taskId) return null;

    log.info(`Task submitted: ${taskId}`);

    // Poll for completion
    const audioUrl = await pollForCompletion(taskId);
    if (!audioUrl) return null;

    log.info(`Audio ready: ${audioUrl.slice(0, 80)}...`);

    // Download MP3
    const audioBuffer = await downloadMp3(audioUrl);
    if (!audioBuffer) return null;

    // Save to disk
    const filename = `${now}-${title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "-").slice(0, 30)}.mp3`;
    const audioPath = path.join(generatedDir, filename);
    fs.writeFileSync(audioPath, audioBuffer);

    // Update state
    state.dailyCount++;
    state.lastMusicAt = now;
    saveState(state);

    log.info(`Saved: ${filename} (${(audioBuffer.length / 1024).toFixed(0)}KB)`);
    return { audio: audioBuffer, audioPath, title, style };
  } catch (err) {
    log.error("Music generation failed", err);
    return null;
  }
}

/**
 * Map emotion energy/valence to a music style suggestion.
 * Pure lookup, no LLM call.
 */
export function mapEmotionToStyle(energy: number, valence: number): string {
  if (energy >= 6 && valence >= 6) {
    // High energy + positive
    const styles = ["upbeat pop", "indie rock", "funk", "dance pop", "synth-pop"];
    return styles[Math.floor(Math.random() * styles.length)];
  }
  if (energy < 6 && valence >= 6) {
    // Low energy + positive
    const styles = ["lo-fi", "acoustic", "bossa nova", "soft jazz", "dream pop"];
    return styles[Math.floor(Math.random() * styles.length)];
  }
  if (energy >= 6 && valence < 6) {
    // High energy + negative
    const styles = ["emo rock", "dramatic piano", "post-punk", "industrial", "dark electronic"];
    return styles[Math.floor(Math.random() * styles.length)];
  }
  // Low energy + negative
  const styles = ["melancholy ballad", "ambient", "sad piano", "slowcore", "dark ambient"];
  return styles[Math.floor(Math.random() * styles.length)];
}

/**
 * Get the current emotion-based style suggestion.
 */
export async function getEmotionStyle(): Promise<string> {
  const emotion = await getEmotionalState(undefined, undefined);
  return mapEmotionToStyle(emotion?.energy ?? 5, emotion?.valence ?? 5);
}

// ── Suno API ────────────────────────────────────────────────────────

async function callSunoApi(
  prompt: string,
  style: string,
  title: string,
  instrumental: boolean,
): Promise<string | null> {
  if (!config?.sunoApiKey) return null;

  const body: Record<string, unknown> = {
    title,
    tags: style,
    prompt: instrumental ? "" : prompt,
    gpt_description_prompt: instrumental ? prompt : "",
    make_instrumental: instrumental,
  };

  try {
    const resp = await fetch(`${SUNO_API_BASE}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.sunoApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      log.error(`API submit failed ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as { data?: { taskId?: string } };
    return data.data?.taskId ?? null;
  } catch (err) {
    log.error("API submit error", err);
    return null;
  }
}

async function pollForCompletion(taskId: string): Promise<string | null> {
  if (!config?.sunoApiKey) return null;

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const resp = await fetch(
        `${SUNO_API_BASE}/generate/record-info?taskId=${taskId}`,
        {
          headers: { Authorization: `Bearer ${config.sunoApiKey}` },
        },
      );

      if (!resp.ok) {
        log.warn(`Poll status ${resp.status}`);
        continue;
      }

      const data = (await resp.json()) as {
        data?: {
          status?: string;
          sunoData?: Array<{ audio_url?: string }>;
        };
      };

      const status = data.data?.status;
      log.debug(`Poll: ${status}`);

      if (status === "SUCCESS" || status === "FIRST_SUCCESS") {
        const audioUrl = data.data?.sunoData?.[0]?.audio_url;
        if (audioUrl) return audioUrl;
        log.warn("Status SUCCESS but no audio_url found");
        return null;
      }

      if (status === "FAILED" || status === "ERROR") {
        log.error("Music generation failed on server");
        return null;
      }

      // PENDING, TEXT_SUCCESS — keep polling
    } catch (err) {
      log.warn("Poll error", err);
    }
  }

  log.error("Music generation timed out");
  return null;
}

async function downloadMp3(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.error(`MP3 download failed ${resp.status}`);
      return null;
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    log.error("MP3 download error", err);
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadState(): MusicState {
  return readJsonSafe<MusicState>(stateFilePath, {
    dailyDate: "",
    dailyCount: 0,
    lastMusicAt: 0,
  });
}

function saveState(state: MusicState): void {
  writeJsonAtomic(stateFilePath, state);
}
