/**
 * Generate a new OAuth token pair for MeAI.
 *
 * Uses Authorization Code + PKCE flow (same as anthropic-max-router).
 *
 * Usage:
 *   npx tsx scripts/oauth-login.ts [output-path]
 *
 * Default output: .oauth-tokens.json in project root.
 * Pass a different path to create a second independent session:
 *   npx tsx scripts/oauth-login.ts .oauth-tokens-2.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference";

const outputPath = path.resolve(PROJECT_ROOT, process.argv[2] || ".oauth-tokens.json");

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log("🔑 MeAI OAuth Login (Authorization Code + PKCE)\n");
  console.log(`Output: ${outputPath}\n`);

  // Step 1: Generate PKCE and state
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(32).toString("base64url");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  console.log("👉 Open this URL in your browser:\n");
  console.log(`   ${url.toString()}\n`);
  console.log("=" .repeat(70));
  console.log("After authorizing, the page will show a code and state.");
  console.log("Copy them and paste in this format: code#state");
  console.log("=" .repeat(70) + "\n");

  const input = await ask("Paste code#state here: ");
  const trimmed = input.trim();

  if (!trimmed || !trimmed.includes("#")) {
    console.error("❌ Invalid format. Expected: code#state");
    process.exit(1);
  }

  const hashIdx = trimmed.indexOf("#");
  const code = trimmed.slice(0, hashIdx);
  const returnedState = trimmed.slice(hashIdx + 1);

  if (returnedState !== state) {
    console.error("❌ State mismatch — possible CSRF attack or copy-paste error.");
    process.exit(1);
  }

  // Step 2: Exchange code for tokens
  console.log("\n🔄 Exchanging code for tokens...");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      state: returnedState,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Token exchange failed (${res.status}):`, errText.slice(0, 500));
    process.exit(1);
  }

  const tokenData = (await res.json()) as any;

  const tokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
    expires_in: tokenData.expires_in,
    scope: tokenData.scope || SCOPE,
    created_at: new Date().toISOString(),
  };

  fs.writeFileSync(outputPath, JSON.stringify(tokens, null, 2));
  console.log(`\n✅ Tokens saved to ${outputPath}`);
  console.log(`   Expires in ${Math.round(tokenData.expires_in / 60)} minutes`);
  console.log(`   MeAI will auto-refresh from here.\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
