#!/usr/bin/env tsx
/**
 * MeAI Config Check
 *
 * Validates the setup without starting the bot:
 *   npm run check
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ConfigSchema = z.object({
  telegramBotToken: z.string().min(1),
  allowedChatId: z.number().int(),
  anthropicApiKey: z.string().optional().default(""),
  openaiApiKey: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  openaiModel: z.string().optional(),
  claudeModel: z.string().default("claude-sonnet-4-5-20250929"),
  conversationProvider: z.enum(["anthropic", "openai"]).optional(),
  maxContextTokens: z.number().int().positive().default(180_000),
  compactionThreshold: z.number().min(0).max(1).default(0.8),
  statePath: z.string().default(""),
  xApiKey: z.string().optional(),
  xApiKeySecret: z.string().optional(),
  xAccessToken: z.string().optional(),
  xAccessTokenSecret: z.string().optional(),
  falApiKey: z.string().optional(),
  fishAudioApiKey: z.string().optional(),
  fishAudioVoiceId: z.string().optional(),
  tavilyApiKey: z.string().optional(),
  sunoApiKey: z.string().optional(),
  momentsChannelId: z.string().optional(),
  channel: z.string().default("telegram"),
  llm: z.object({
    conversation: z.string().default("anthropic-api"),
    background: z.string().default("claude-cli"),
    embedding: z.string().default("anthropic-api"),
    vision: z.string().default("anthropic-api"),
  }).default({}),
});

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const SKIP = "\x1b[33m-\x1b[0m";

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(msg: string) { console.log(`  ${PASS} ${msg}`); passed++; }
function fail(msg: string) { console.log(`  ${FAIL} ${msg}`); failed++; }
function skip(msg: string) { console.log(`  ${SKIP} ${msg}`); skipped++; }

async function main() {
  console.log("\nMeAI Config Check\n");

  // ── 1. Config file ───────────────────────────────────────────────
  console.log("Config:");
  const configPath = path.join(PROJECT_ROOT, "data", "config.json");

  if (!fs.existsSync(configPath)) {
    fail("data/config.json not found — run 'npm run setup'");
    printSummary();
    return;
  }
  pass("data/config.json exists");

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    pass("config.json is valid JSON");
  } catch {
    fail("config.json is not valid JSON");
    printSummary();
    return;
  }

  const result = ConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    for (const issue of result.error.issues) {
      fail(`config.${issue.path.join(".")}: ${issue.message}`);
    }
    printSummary();
    return;
  }
  pass("config passes schema validation");

  const config = result.data;

  // ── 2. Required keys ────────────────────────────────────────────
  console.log("\nRequired keys:");
  if (config.telegramBotToken) pass("telegramBotToken present");
  else fail("telegramBotToken missing");

  if (config.allowedChatId) pass("allowedChatId present");
  else fail("allowedChatId missing");

  // Check Max OAuth tokens
  const oauthTokenPath = path.join(PROJECT_ROOT, ".oauth-tokens.json");
  const hasOAuth = fs.existsSync(oauthTokenPath);

  if (hasOAuth) pass("Max OAuth tokens present ($0 LLM cost)");
  else if (config.anthropicApiKey) pass("anthropicApiKey present (pay-per-use)");
  else fail("No LLM backend: set anthropicApiKey or generate Max OAuth tokens (npx anthropic-max-router)");

  // ── 3. Character file ───────────────────────────────────────────
  console.log("\nCharacter:");
  const characterPath = path.join(PROJECT_ROOT, "data", "character.yaml");
  if (fs.existsSync(characterPath)) {
    try {
      const { parse } = await import("yaml");
      const charData = parse(fs.readFileSync(characterPath, "utf-8"));
      if (charData?.name) {
        pass(`character.yaml loaded (name: ${charData.name})`);
      } else {
        fail("character.yaml missing 'name' field");
      }
    } catch (err) {
      fail(`character.yaml parse error: ${(err as Error).message}`);
    }
  } else {
    fail("data/character.yaml not found — run 'npm run setup' or copy from character.minimal.yaml");
  }

  // ── 4. API connectivity ─────────────────────────────────────────
  console.log("\nAPI connectivity:");

  // Telegram
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string } };
    if (data.ok) {
      pass(`Telegram bot: @${data.result?.username}`);
    } else {
      fail("Telegram bot token is invalid");
    }
  } catch (err) {
    fail(`Telegram API error: ${(err as Error).message}`);
  }

  // Anthropic API key check (only if provided — Max OAuth users may not have one)
  if (config.anthropicApiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok) {
        pass("Anthropic API key valid");
      } else {
        const err = await res.json() as { error?: { message?: string } };
        fail(`Anthropic API: ${err.error?.message ?? res.statusText}`);
      }
    } catch (err) {
      fail(`Anthropic API error: ${(err as Error).message}`);
    }
  } else if (hasOAuth) {
    pass("Using Max OAuth (no API key needed)");
  } else {
    skip("No Anthropic API key — using CLI fallback");
  }

  // ── 5. Optional features ────────────────────────────────────────
  console.log("\nOptional features:");

  if (config.openaiApiKey) pass("OpenAI API key (semantic memory)");
  else skip("OpenAI API key — semantic memory disabled");

  if (config.falApiKey) pass("fal.ai API key (AI selfies)");
  else skip("fal.ai API key — selfie generation disabled");

  if (config.fishAudioApiKey) pass("Fish Audio API key (voice messages)");
  else skip("Fish Audio API key — voice messages disabled");

  if (config.tavilyApiKey) pass("Tavily API key (premium web search)");
  else skip("Tavily API key — using DuckDuckGo fallback");

  if (config.xApiKey && config.xApiKeySecret && config.xAccessToken && config.xAccessTokenSecret) {
    pass("X/Twitter API keys (social posting)");
  } else {
    skip("X/Twitter API keys — social features disabled");
  }

  // Claude CLI
  try {
    execSync("which claude", { stdio: "pipe" });
    pass("Claude CLI installed (background tasks at no API cost)");
  } catch {
    skip("Claude CLI not installed — background tasks will use API credits");
  }

  printSummary();
}

function printSummary() {
  console.log(`\n──────────────────────────`);
  console.log(`${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${SKIP} ${skipped} skipped`);

  if (failed > 0) {
    console.log("\nFix the issues above, then run 'npm run check' again.\n");
    process.exit(1);
  } else {
    console.log("\nAll checks passed! Run 'npm start' to launch your bot.\n");
  }
}

main().catch((err) => {
  console.error("Check error:", err);
  process.exit(1);
});
