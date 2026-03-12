/**
 * Claude Max OAuth integration.
 *
 * Manages OAuth tokens (load / auto-refresh) and provides a custom `fetch`
 * wrapper that transparently converts standard Anthropic SDK requests into
 * Max-subscription OAuth requests by:
 *   1. Replacing `x-api-key` with `Authorization: Bearer <oauth_token>`
 *   2. Adding required `anthropic-beta` flags
 *   3. Prepending the mandatory Claude Code system prompt
 *
 * Token file: `<statePath>/../.oauth-tokens.json` (project root).
 * Generate it once via `npx anthropic-max-router` CLI, then MeAI handles
 * auto-refresh forever.
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ── OAuth constants ────────────────────────────────────────────────

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_BETA =
  "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const REQUIRED_SYSTEM_TEXT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// ── Token types ────────────────────────────────────────────────────

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  scope: string;
  created_at: string;
}

// ── Module state ───────────────────────────────────────────────────

let tokenPath = "";
let cached: OAuthTokens | null = null;

// ── Public API ─────────────────────────────────────────────────────

export function initMaxOAuth(statePath: string): void {
  // Token file lives in project root (sibling of data/)
  tokenPath = path.resolve(statePath, "..", ".oauth-tokens.json");
}

/** Whether a `.oauth-tokens.json` file exists at the expected path. */
export function isMaxOAuthAvailable(): boolean {
  if (!tokenPath) return false;
  return fs.existsSync(tokenPath);
}

/**
 * Create an Anthropic client.
 * If OAuth tokens are available, returns a client that transparently uses
 * Max subscription auth.  Otherwise falls back to the plain API key.
 */
export function createAnthropicClient(
  apiKey: string,
  opts?: { maxRetries?: number },
): Anthropic {
  if (isMaxOAuthAvailable()) {
    return new Anthropic({
      apiKey: "max-oauth", // placeholder — overridden by custom fetch
      maxRetries: opts?.maxRetries,
      fetch: createOAuthFetch(),
    });
  }
  return new Anthropic({ apiKey, maxRetries: opts?.maxRetries });
}

// ── Token management ───────────────────────────────────────────────

function loadTokens(): OAuthTokens | null {
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens: OAuthTokens): void {
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  const res = await globalThis.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[max-oauth] Token refresh failed (${res.status}): ${errText}`);
  }
  const fresh = (await res.json()) as OAuthTokens;
  if (!fresh.refresh_token) fresh.refresh_token = tokens.refresh_token;
  fresh.expires_at = Date.now() + fresh.expires_in * 1000;
  fresh.created_at = new Date().toISOString();
  saveTokens(fresh);
  cached = fresh;
  console.log("[max-oauth] Token refreshed, expires in", Math.round(fresh.expires_in / 60), "min");
  return fresh;
}

async function getValidToken(): Promise<string> {
  let tokens = cached ?? loadTokens();
  if (!tokens) throw new Error("[max-oauth] No tokens found");

  const BUFFER = 5 * 60 * 1000; // refresh 5 min before expiry
  if (Date.now() >= tokens.expires_at - BUFFER) {
    tokens = await refreshTokens(tokens);
  }
  cached = tokens;
  return tokens.access_token;
}

// ── Custom fetch wrapper ───────────────────────────────────────────

function createOAuthFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const token = await getValidToken();
    const headers = new Headers(init?.headers as Record<string, string>);

    // Swap auth: remove API-key, set Bearer
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("anthropic-beta", ANTHROPIC_BETA);

    // Inject required system prompt into POST /messages bodies
    let body = init?.body;
    if (body && typeof body === "string") {
      try {
        const json = JSON.parse(body);
        if (json.messages && json.model) {
          // It's a messages API call — ensure system prompt prefix
          const existing = normalizeSystem(json.system);
          if (!existing.length || existing[0]?.text !== REQUIRED_SYSTEM_TEXT) {
            json.system = [
              { type: "text", text: REQUIRED_SYSTEM_TEXT },
              ...existing,
            ];
          }
          body = JSON.stringify(json);
        }
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    // Remove content-length — body size may have changed after system prompt injection.
    // Node fetch will recalculate it automatically.
    headers.delete("content-length");

    return globalThis.fetch(input, { ...init, headers, body });
  };
}

function normalizeSystem(
  system: unknown,
): Array<{ type: string; text: string; [k: string]: unknown }> {
  if (!system) return [];
  if (typeof system === "string") return [{ type: "text", text: system }];
  if (Array.isArray(system)) return system;
  return [];
}
