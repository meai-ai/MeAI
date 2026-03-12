/**
 * Claude Runner — calls LLM via Claude Code CLI, not through the API.
 *
 * Extracts the subprocess pattern from data/skills/claude-code/tools.ts into
 * reusable utility functions for all background modules.
 *
 * Benefits:
 *   - Uses Max subscription billing, no API token cost
 *   - Unified call entry point for watchdog monitoring
 *   - Shares the same binary lookup logic with skills
 *
 * Usage:
 *   const text = await claudeRun({ system: "...", prompt: "...", model: "fast" });
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// ── Binary Lookup ────────────────────────────────────────────────────

const CLAUDE_CANDIDATES = [
  "/opt/node22/bin/claude",
  "/usr/local/bin/claude",
  "/usr/bin/claude",
  "/opt/homebrew/bin/claude",
  `${homedir()}/.npm-global/bin/claude`,
  `${homedir()}/.local/bin/claude`,
  `${homedir()}/node_modules/.bin/claude`,
];

let _claudePathCache: string | null | undefined = undefined;

async function findClaude(): Promise<string | null> {
  if (_claudePathCache !== undefined) return _claudePathCache;
  for (const p of CLAUDE_CANDIDATES) {
    if (existsSync(p)) { _claudePathCache = p; return p; }
  }
  return new Promise((res) => {
    const which = spawn("which", ["claude"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    which.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    which.on("close", (code: number | null) => {
      const p = out.trim();
      _claudePathCache = (code === 0 && p) ? p : null;
      res(_claudePathCache);
    });
    which.on("error", () => { _claudePathCache = null; res(null); });
  });
}

// ── Types ────────────────────────────────────────────────────────────

export interface ClaudeRunOptions {
  /** System instructions (role, persona, output format) */
  system: string;
  /** User prompt (the actual question / data) */
  prompt: string;
  /** "fast" = haiku (default), "smart" = sonnet */
  model?: "fast" | "smart";
  /** Timeout in ms (default: 30s) */
  timeoutMs?: number;
  /** Max output chars to return (default: 16000) */
  maxOutputChars?: number;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  error?: string;
}

// ── Core Runner ──────────────────────────────────────────────────────

/**
 * Run a prompt through Claude Code CLI (`claude --print`).
 * Uses Max subscription — no API key billing.
 */
export async function claudeRun(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const {
    system,
    prompt,
    model = "fast",
    timeoutMs = 180_000,
    maxOutputChars = 16_000,
  } = opts;

  const claudePath = await findClaude();
  if (!claudePath) {
    return {
      ok: false,
      text: "",
      error: "Claude Code CLI not found. Run: npm install -g @anthropic-ai/claude-code",
    };
  }

  const modelFlag = model === "smart"
    ? "claude-sonnet-4-6"
    : "claude-haiku-4-5-20251001";

  // Strip null bytes — scraped web content can contain them and spawn() rejects them
  const cleanSystem = system.replace(/\0/g, "");
  const cleanPrompt = prompt.replace(/\0/g, "");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Strip CLAUDECODE env to allow nested invocation
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn(
      claudePath,
      [
        "--print",
        "--dangerously-skip-permissions",
        "--model", modelFlag,
        "--system-prompt", cleanSystem,
        cleanPrompt,
      ],
      {
        cwd: homedir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000);
    }, timeoutMs);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          ok: false,
          text: stdout.slice(-2_000),
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          text: stdout.slice(0, 2_000),
          error: stderr.slice(0, 1_000) || `Exit code ${code}`,
        });
        return;
      }

      resolve({
        ok: true,
        text: stdout.length > maxOutputChars
          ? stdout.slice(0, maxOutputChars)
          : stdout,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        text: "",
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

/** Check if an error is transient and worth retrying. */
function isTransientError(error: string): boolean {
  const transientPatterns = [
    "overloaded_error",
    "overloaded",
    "rate_limit",
    "529",
    "503",
    "502",
    "ECONNRESET",
    "ETIMEDOUT",
    "socket hang up",
    "network",
    "connection reset",
  ];
  const lower = error.toLowerCase();
  return transientPatterns.some(p => lower.includes(p.toLowerCase()));
}

/**
 * Convenience: run and extract text (returns "" on failure).
 * Most background modules just need the text output.
 * Retries up to 10 times on transient errors (overloaded, connection reset)
 * with 6-second intervals.
 */
export async function claudeText(opts: ClaudeRunOptions): Promise<string> {
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 6_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await claudeRun(opts);

    if (result.ok) return result.text;

    const errorMsg = result.error ?? "";

    // Retry on transient errors
    if (attempt < MAX_RETRIES && isTransientError(errorMsg)) {
      console.warn(`[claude-runner] Transient error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${errorMsg} — retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }

    // Non-transient or exhausted retries
    console.warn(`[claude-runner] Failed (${opts.model ?? "fast"}): ${errorMsg}`);
    return result.text;
  }

  return ""; // Should not reach here
}

/**
 * Check if Claude Code CLI is available.
 */
export async function isClaudeAvailable(): Promise<boolean> {
  return (await findClaude()) !== null;
}
