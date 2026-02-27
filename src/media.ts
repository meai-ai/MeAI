/**
 * Media Pipeline — yt-dlp + whisper audio/video transcription.
 *
 * When YouTube captions and podcast show-notes are unavailable,
 * this pipeline downloads the audio via yt-dlp and transcribes
 * it locally with OpenAI Whisper.
 *
 * Flow:
 *   URL → yt-dlp (download audio) → whisper (transcribe) → text
 *
 * Prerequisites (checked at runtime):
 *   - yt-dlp:  brew install yt-dlp
 *   - whisper: pipx install openai-whisper
 *
 * Design:
 *   - Downloads are temporary — audio files deleted after transcription
 *   - Transcription runs in a subprocess with timeout protection
 *   - Falls back gracefully: if tools aren't installed, returns ""
 *   - Concurrent transcription limited to 1 at a time (mutex)
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Constants ────────────────────────────────────────────────────────

/** Max time for yt-dlp download (3 minutes) */
const YTDLP_TIMEOUT_MS = 3 * 60 * 1000;

/** Max time for whisper transcription (5 minutes) */
const WHISPER_TIMEOUT_MS = 5 * 60 * 1000;

/** Max audio file size to transcribe (100 MB) */
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/** Whisper model — "base" is fast and decent quality */
const WHISPER_MODEL = "base";

// ── Tool Availability ────────────────────────────────────────────────

let ytdlpAvailable: boolean | null = null;
let whisperAvailable: boolean | null = null;

function checkTool(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

async function isYtdlpAvailable(): Promise<boolean> {
  if (ytdlpAvailable !== null) return ytdlpAvailable;
  ytdlpAvailable = await checkTool("yt-dlp", ["--version"]);
  if (ytdlpAvailable) {
    console.log("[media] yt-dlp detected ✓");
  } else {
    console.log("[media] yt-dlp not found — audio download disabled (brew install yt-dlp)");
  }
  return ytdlpAvailable;
}

async function isWhisperAvailable(): Promise<boolean> {
  if (whisperAvailable !== null) return whisperAvailable;
  whisperAvailable = await checkTool("whisper", ["--help"]);
  if (whisperAvailable) {
    console.log("[media] whisper detected ✓");
  } else {
    console.log("[media] whisper not found — transcription disabled (pipx install openai-whisper)");
  }
  return whisperAvailable;
}

// ── Concurrency Control ──────────────────────────────────────────────

let transcribing = false;

// ── Core Functions ───────────────────────────────────────────────────

/**
 * Download audio from a URL using yt-dlp.
 * Returns path to the downloaded audio file, or null on failure.
 */
async function ytdlpDownload(url: string, outDir: string): Promise<string | null> {
  if (!await isYtdlpAvailable()) return null;

  const outTemplate = path.join(outDir, "%(title).50s.%(ext)s");

  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      [
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "5",  // medium quality, smaller file
        "--no-playlist",
        "--max-filesize", "100m",
        "-o", outTemplate,
        url,
      ],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`[media] yt-dlp download failed: ${err.message}`);
          if (stderr) console.warn(`[media] stderr: ${stderr.slice(0, 300)}`);
          resolve(null);
          return;
        }

        // Find the downloaded file
        try {
          const files = fs.readdirSync(outDir)
            .filter(f => /\.(mp3|m4a|ogg|opus|wav|webm)$/i.test(f))
            .map(f => ({
              name: f,
              mtime: fs.statSync(path.join(outDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

          if (files.length > 0) {
            const filePath = path.join(outDir, files[0].name);
            const size = fs.statSync(filePath).size;

            if (size > MAX_AUDIO_BYTES) {
              console.warn(`[media] Audio file too large: ${Math.round(size / 1024 / 1024)}MB`);
              fs.unlinkSync(filePath);
              resolve(null);
              return;
            }

            console.log(`[media] Downloaded: ${files[0].name} (${Math.round(size / 1024)}KB)`);
            resolve(filePath);
          } else {
            console.warn("[media] yt-dlp produced no audio file");
            console.warn(`[media] stdout: ${stdout.slice(0, 200)}`);
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Transcribe an audio file using whisper.
 * Returns the transcribed text, or empty string on failure.
 */
async function whisperTranscribe(audioPath: string, outDir: string): Promise<string> {
  if (!await isWhisperAvailable()) return "";

  return new Promise((resolve) => {
    // whisper <file> --model base --output_format txt --output_dir <dir>
    execFile(
      "whisper",
      [
        audioPath,
        "--model", WHISPER_MODEL,
        "--output_format", "txt",
        "--output_dir", outDir,
        "--language", "en",
        "--fp16", "False",  // CPU-friendly
      ],
      { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`[media] whisper transcription failed: ${err.message}`);
          resolve("");
          return;
        }

        // Whisper outputs <filename>.txt
        try {
          const baseName = path.basename(audioPath, path.extname(audioPath));
          const txtPath = path.join(outDir, `${baseName}.txt`);

          if (fs.existsSync(txtPath)) {
            const text = fs.readFileSync(txtPath, "utf-8").trim();
            console.log(`[media] Transcribed: ${text.length} chars`);
            resolve(text);
          } else {
            // Try finding any .txt file in the output dir
            const txtFiles = fs.readdirSync(outDir).filter(f => f.endsWith(".txt"));
            if (txtFiles.length > 0) {
              const text = fs.readFileSync(path.join(outDir, txtFiles[0]), "utf-8").trim();
              resolve(text);
            } else {
              console.warn("[media] whisper produced no output file");
              resolve("");
            }
          }
        } catch {
          resolve("");
        }
      },
    );
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Transcribe media from a URL (YouTube, podcast, any video/audio).
 *
 * Pipeline: URL → yt-dlp (audio download) → whisper (transcribe) → text
 *
 * Returns transcribed text, or empty string if:
 * - Tools not installed
 * - Download failed
 * - Transcription failed
 * - Already transcribing another file (mutex)
 */
export async function transcribeFromUrl(url: string): Promise<string> {
  // Mutex — only one transcription at a time
  if (transcribing) {
    console.log("[media] Skipping — already transcribing another file");
    return "";
  }

  // Quick check: are tools available?
  if (!await isYtdlpAvailable() || !await isWhisperAvailable()) {
    return "";
  }

  transcribing = true;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meai-media-"));

  try {
    console.log(`[media] Starting transcription pipeline for: ${url}`);

    // Step 1: Download audio
    const audioPath = await ytdlpDownload(url, tmpDir);
    if (!audioPath) {
      console.log("[media] Download failed, skipping transcription");
      return "";
    }

    // Step 2: Transcribe
    const text = await whisperTranscribe(audioPath, tmpDir);

    if (text.length > 0) {
      console.log(`[media] Pipeline complete: ${text.length} chars transcribed`);
    }

    return text;
  } catch (err) {
    console.error("[media] Pipeline error:", err);
    return "";
  } finally {
    // Cleanup tmp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
    transcribing = false;
  }
}

/**
 * Check if the media pipeline is available (both tools installed).
 */
export async function isMediaPipelineAvailable(): Promise<boolean> {
  return await isYtdlpAvailable() && await isWhisperAvailable();
}
