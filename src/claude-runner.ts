/**
 * Claude Runner — unified LLM call layer for background tasks.
 *
 * Primary path (when maxOAuthEnabled): Anthropic API via Max OAuth ($0 cost).
 * Fallback / default: Claude Code CLI (`claude --print`).
 *
 * Usage:
 *   const text = await claudeRun({ system: "...", prompt: "...", model: "fast" });
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient, isMaxOAuthAvailable } from "./max-oauth.js";

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

// ── Model mapping ────────────────────────────────────────────────────

function modelId(model: string): string {
  return model === "smart"
    ? "claude-sonnet-4-6"
    : "claude-haiku-4-5-20251001";
}

// ── Types ────────────────────────────────────────────────────────────

export interface ClaudeRunOptions {
  /** System instructions (role, persona, output format) */
  system: string;
  /** User prompt (the actual question / data) */
  prompt: string;
  /** "fast" = haiku (default), "smart" = sonnet */
  model?: "fast" | "smart";
  /** Timeout in ms (default: 180s) */
  timeoutMs?: number;
  /** Max output chars to return (default: 16000) */
  maxOutputChars?: number;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  error?: string;
  /** Token usage — only available when using the API path */
  usage?: { inputTokens: number; outputTokens: number };
}

// ── API Client (Max OAuth) ───────────────────────────────────────────

let apiClient: Anthropic | null = null;

/**
 * Initialize the API-based runner. Call once at startup after initMaxOAuth().
 * If Max OAuth is available, background tasks will use the API instead of CLI.
 */
export function initClaudeRunnerApi(apiKey: string): void {
  if (isMaxOAuthAvailable()) {
    apiClient = createAnthropicClient(apiKey);
    console.log("[claude-runner] API path enabled (Max OAuth)");
  }
}

async function runApi(
  system: string,
  prompt: string,
  model: string,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<ClaudeRunResult> {
  if (!apiClient) return { ok: false, text: "", error: "API client not initialized" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await apiClient.messages.create(
      {
        model: modelId(model),
        max_tokens: 4096,
        system,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const usage = response.usage ? {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    } : undefined;

    return {
      ok: true,
      text: text.length > maxOutputChars ? text.slice(0, maxOutputChars) : text,
      usage,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: "", error: `API error: ${msg}` };
  }
}

// ── Core Runner ──────────────────────────────────────────────────────

/**
 * Run a prompt through the best available backend.
 * Primary: Anthropic API via Max OAuth (when enabled).
 * Fallback: Claude Code CLI (`claude --print`).
 */
export async function claudeRun(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const {
    system,
    prompt,
    model = "fast",
    timeoutMs = 180_000,
    maxOutputChars = 16_000,
  } = opts;

  // Strip null bytes — scraped web content can contain them and spawn() rejects them
  const cleanSystem = system.replace(/\0/g, "");
  const cleanPrompt = prompt.replace(/\0/g, "");

  // Primary path: API via Max OAuth
  if (apiClient) {
    const result = await runApi(cleanSystem, cleanPrompt, model, timeoutMs, maxOutputChars);
    if (result.ok) return result;
    // API failed — fall back to CLI
    console.warn(`[claude-runner] API failed, falling back to CLI: ${result.error}`);
  }

  // Fallback: Claude CLI
  const claudePath = await findClaude();
  if (!claudePath) {
    return {
      ok: false,
      text: "",
      error: "Claude Code CLI not found. Run: npm install -g @anthropic-ai/claude-code",
    };
  }

  const modelFlag = modelId(model);

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
