/**
 * Claude CLI LLM Provider — uses `claude --print` for completions.
 *
 * Extracted from src/claude-runner.ts. Uses Max subscription billing,
 * not API key billing. Ideal for background tasks.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { AppConfig } from "../../types.js";
import type { LLMProvider, LLMRole, CompleteOptions } from "../types.js";

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

const provider: LLMProvider = {
  id: "claude-cli",
  name: "Claude CLI (Max subscription)",
  roles: ["background"] as LLMRole[],

  isAvailable(): boolean {
    // Optimistic — actual check is async. findClaude() caches result.
    return _claudePathCache !== null;
  },

  async init(): Promise<void> {
    _claudePathCache = undefined; // reset cache
    const path = await findClaude();
    if (path) {
      console.log(`[llm:claude-cli] Found Claude CLI at: ${path}`);
    } else {
      console.log("[llm:claude-cli] Claude CLI not found — provider unavailable");
    }
  },

  async complete(opts: CompleteOptions): Promise<string> {
    const {
      system,
      prompt,
      model,
      timeoutMs = 180_000,
      maxTokens = 16_000,
    } = opts;

    const claudePath = await findClaude();
    if (!claudePath) {
      throw new Error("Claude Code CLI not found. Run: npm install -g @anthropic-ai/claude-code");
    }

    const modelFlag = model ?? "claude-haiku-4-5-20251001";

    // Strip null bytes from web-scraped content
    const cleanSystem = system.replace(/\0/g, "");
    const cleanPrompt = prompt.replace(/\0/g, "");

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

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
          reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.slice(0, 1_000) || `Exit code ${code}`));
          return;
        }
        const text = stdout.length > maxTokens * 4
          ? stdout.slice(0, maxTokens * 4)
          : stdout;
        resolve(text);
      });

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Spawn error: ${err.message}`));
      });
    });
  },
};

export default provider;
