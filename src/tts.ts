/**
 * TTS voice messages — gives the character a voice via Fish Audio.
 *
 * Follows the selfie pattern:
 *   src/tts.ts (core) + data/skills/tts/tools.ts (tool def)
 *   → handleTTSResult in loop.ts → sendVoiceFn → telegram.sendVoice
 *
 * Emotion→voice mapping (no LLM call, pure lookup):
 *   energy 1-3 → speed 0.85x (tired/slow)
 *   energy 4-7 → speed 1.0x (normal)
 *   energy 8-10 → speed 1.15x (energetic)
 *   valence 1-3 → temperature 0.5 (flat/subdued)
 *   valence 4-7 → temperature 0.7 (neutral)
 *   valence 8-10 → temperature 0.9 (expressive)
 *
 * Requires:
 *   - config.fishAudioApiKey
 *   - config.fishAudioVoiceId
 *   - ffmpeg on PATH (for opus→ogg container wrapping)
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { createLogger } from "./lib/logger.js";
import type { AppConfig } from "./types.js";

const log = createLogger("tts");

// ── Types ────────────────────────────────────────────────────────────

export type VoiceTrigger =
  | "emotional_reaction"
  | "greeting"
  | "teasing"
  | "excitement"
  | "sleepy"
  | "answer"
  | "proactive_voice";

interface TTSState {
  dailyDate: string;
  dailyCount: number;
  lastTTSAt: number;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_DAILY_VOICES = 20;

// ── TTSEngine class ─────────────────────────────────────────────────

export class TTSEngine {
  private config: AppConfig;
  private stateFilePath: string;
  private ttsDir: string;

  constructor(config: AppConfig) {
    this.config = config;
    this.ttsDir = path.join(config.statePath, "tts");
    this.stateFilePath = path.join(this.ttsDir, "state.json");

    if (!this.isTTSEnabled()) {
      log.info("TTS disabled (missing fishAudioApiKey or fishAudioVoiceId)");
      return;
    }

    log.info("TTS enabled — Fish Audio voice messages ready");
  }

  // ── Public API ───────────────────────────────────────────────────────

  isTTSEnabled(): boolean {
    return !!(this.config?.fishAudioApiKey && this.config?.fishAudioVoiceId);
  }

  /**
   * Generate a voice message from text.
   * Returns the audio buffer (OGG/Opus for Telegram) and file path, or null if rate-limited/disabled.
   */
  async generateVoice(
    text: string,
    trigger: VoiceTrigger,
  ): Promise<{ audio: Buffer; audioPath: string } | null> {
    if (!this.isTTSEnabled() || !this.config) return null;

    // Rate limiting
    const state = this.loadState();
    const now = Date.now();
    const todayStr = pstDateStr();

    if (state.dailyDate !== todayStr) {
      state.dailyDate = todayStr;
      state.dailyCount = 0;
    }

    if (state.dailyCount >= MAX_DAILY_VOICES) {
      log.info("Daily voice limit reached");
      return null;
    }

    // No interval limit — voice messages can be sent consecutively

    try {
      // Natural voice defaults — keep it simple, no emotion-based speed/temp tweaking
      const voiceParams = { speed: 1.0, temperature: 0.85 };

      log.info(
        `Generating voice: trigger=${trigger}, text="${text.slice(0, 40)}...", speed=${voiceParams.speed}, temp=${voiceParams.temperature}`,
      );

      // Strip emoji — TTS can't pronounce them
      const ttsText = text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}✨⭐❤️💕🥰😘😄😂🤣😭😢😤😡😏😜🥺💪🔥👍🎉🎵✅❌⚠️]/gu, "").trim() || text;

      // Call Fish Audio TTS API
      const opusBuffer = await this.callFishAudio(ttsText, voiceParams);
      if (!opusBuffer) return null;

      // Wrap opus in OGG container for Telegram voice messages
      const oggBuffer = await this.wrapOpusInOgg(opusBuffer);

      // Save to disk
      const filename = `${now}-${trigger}.ogg`;
      const audioPath = path.join(this.ttsDir, filename);
      fs.writeFileSync(audioPath, oggBuffer);

      // Update state
      state.dailyCount++;
      state.lastTTSAt = now;
      this.saveState(state);

      log.info(`Voice generated: ${filename} (${oggBuffer.length} bytes)`);
      return { audio: oggBuffer, audioPath };
    } catch (err) {
      log.error("Voice generation failed", err);
      return null;
    }
  }

  /** How many voice messages have been sent today. */
  getVoiceDailyCount(): number {
    const state = this.loadState();
    const todayStr = pstDateStr();
    return state.dailyDate === todayStr ? state.dailyCount : 0;
  }

  // ── Private: Fish Audio API ──────────────────────────────────────────

  private async callFishAudio(
    text: string,
    params: { speed: number; temperature: number },
  ): Promise<Buffer | null> {
    if (!this.config?.fishAudioApiKey || !this.config?.fishAudioVoiceId) return null;

    const body = JSON.stringify({
      text,
      reference_id: this.config.fishAudioVoiceId,
      format: "opus",
      opus_bitrate: 64,
      latency: "normal",
      prosody: {
        speed: params.speed,
      },
      temperature: params.temperature,
      top_p: 0.8,
      repetition_penalty: 1.1,
    });

    try {
      const resp = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.fishAudioApiKey}`,
          "Content-Type": "application/json",
          model: "s1",
        },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        log.error(`Fish Audio API error ${resp.status}: ${errText.slice(0, 200)}`);
        return null;
      }

      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      log.error("Fish Audio API call failed", err);
      return null;
    }
  }

  // ── Private: Audio conversion ────────────────────────────────────────

  /**
   * Wrap raw opus audio in OGG container using ffmpeg.
   * Telegram requires OGG/Opus for voice messages.
   */
  private wrapOpusInOgg(opusBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tmpIn = path.join(this.ttsDir, `_tmp_${Date.now()}.opus`);
      const tmpOut = path.join(this.ttsDir, `_tmp_${Date.now()}.ogg`);

      fs.writeFileSync(tmpIn, opusBuffer);

      execFile(
        "ffmpeg",
        ["-y", "-i", tmpIn, "-c", "copy", tmpOut],
        { timeout: 10_000 },
        (err) => {
          // Cleanup input temp file
          try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }

          if (err) {
            try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
            reject(new Error(`ffmpeg failed: ${err.message}`));
            return;
          }

          try {
            const result = fs.readFileSync(tmpOut);
            fs.unlinkSync(tmpOut);
            resolve(result);
          } catch (readErr) {
            reject(new Error(`Failed to read ffmpeg output: ${readErr}`));
          }
        },
      );
    });
  }

  // ── Private: State persistence ───────────────────────────────────────

  private loadState(): TTSState {
    return readJsonSafe<TTSState>(this.stateFilePath, {
      dailyDate: "",
      dailyCount: 0,
      lastTTSAt: 0,
    });
  }

  private saveState(state: TTSState): void {
    writeJsonAtomic(this.stateFilePath, state);
  }
}

// ── Module state (backward compat singleton) ─────────────────────────

let _singleton: TTSEngine | null = null;

// ── Init ─────────────────────────────────────────────────────────────

export function initTTS(cfg: AppConfig): TTSEngine {
  _singleton = new TTSEngine(cfg);
  return _singleton;
}

// ── Backward-compat function exports ─────────────────────────────────

export function isTTSEnabled(): boolean {
  return _singleton?.isTTSEnabled() ?? false;
}

export async function generateVoice(
  text: string,
  trigger: VoiceTrigger,
): Promise<{ audio: Buffer; audioPath: string } | null> {
  return _singleton?.generateVoice(text, trigger) ?? null;
}

export function getVoiceDailyCount(): number {
  return _singleton?.getVoiceDailyCount() ?? 0;
}
