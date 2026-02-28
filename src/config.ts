/**
 * Config loader for MeAI.
 *
 * Reads data/config.json (or a path from MEAI_CONFIG env var),
 * validates it with Zod, resolves the statePath to an absolute path,
 * and ensures required runtime directories exist.
 *
 * Everything lives under <project-root>/data/ by default.
 * config.json is gitignored to keep secrets out of the repo.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./types.js";

/** Absolute path to the project root (parent of src/). */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ConfigSchema = z.object({
  telegramBotToken: z.string().min(1),
  allowedChatId: z.number().int(),
  anthropicApiKey: z.string().min(1),
  openaiApiKey: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  openaiModel: z.string().optional(),
  claudeModel: z.string().default("claude-sonnet-4-5-20250929"),
  conversationProvider: z.enum(["anthropic", "openai"]).optional(),
  maxContextTokens: z.number().int().positive().default(180_000),
  compactionThreshold: z.number().min(0).max(1).default(0.8),
  statePath: z.string().default(""),
  /** X (Twitter) API credentials — all optional, enables social features when present */
  xApiKey: z.string().optional(),
  xApiKeySecret: z.string().optional(),
  xAccessToken: z.string().optional(),
  xAccessTokenSecret: z.string().optional(),
  /** fal.ai API key — optional, enables selfie/sticker generation */
  falApiKey: z.string().optional(),
  /** Fish Audio TTS — optional, enables voice messages */
  fishAudioApiKey: z.string().optional(),
  fishAudioVoiceId: z.string().optional(),
  /** Tavily Search API — optional, high-quality web search (falls back to DuckDuckGo) */
  tavilyApiKey: z.string().optional(),
  /** Suno API — optional, enables music composition */
  sunoApiKey: z.string().optional(),
  /** Telegram channel ID for moments timeline — optional, e.g. "@mychannel" or "-1001234567890" */
  momentsChannelId: z.string().optional(),
  /** Channel type — "telegram" (default), "discord", etc. */
  channel: z.string().default("telegram"),
  /** LLM provider configuration — maps roles to provider IDs */
  llm: z.object({
    conversation: z.string().default("anthropic-api"),
    background: z.string().default("claude-cli"),
    embedding: z.string().default("anthropic-api"),
    vision: z.string().default("anthropic-api"),
  }).default({}),
});

function resolveHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

/**
 * Ensure that all runtime directories under statePath exist.
 */
function ensureDirectories(statePath: string): void {
  const dirs = [
    statePath,
    path.join(statePath, "memory"),
    path.join(statePath, "skills"),
    path.join(statePath, "sessions"),
    path.join(statePath, "sessions", "archive"),
    path.join(statePath, "evolution"),
    path.join(statePath, "evolution", "pending"),
    path.join(statePath, "evolution", "history"),
    path.join(statePath, "evolution", "rollback"),
    path.join(statePath, "selfie"),
    path.join(statePath, "selfie", "generated"),
    path.join(statePath, "video"),
    path.join(statePath, "video", "generated"),
    path.join(statePath, "tts"),
    path.join(statePath, "music"),
    path.join(statePath, "music", "generated"),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Seed default files if they don't already exist.
 */
function seedDefaults(statePath: string): void {
  const identityPath = path.join(statePath, "memory", "IDENTITY.md");
  if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(
      identityPath,
      "I am MeAI, the user's close friend. Personality is straightforward, warm, and outgoing. Speaks casually with my own life and thoughts.\n(Specific identity defined by character.yaml)\n",
    );
  }

  const userPath = path.join(statePath, "memory", "USER.md");
  if (!fs.existsSync(userPath)) {
    fs.writeFileSync(userPath, "No user profile yet. Learn about your user through conversation.\n");
  }

  // Only create store.json if not yet migrated to hierarchical category files
  const migratedMarker = path.join(statePath, "memory", ".migrated");
  if (!fs.existsSync(migratedMarker)) {
    const storePath = path.join(statePath, "memory", "store.json");
    if (!fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, JSON.stringify({ memories: [] }, null, 2) + "\n");
    }
  }
}

/**
 * Build config overrides from environment variables.
 * Env vars take precedence over config.json values.
 */
function getEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (process.env.TELEGRAM_BOT_TOKEN) overrides.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.ALLOWED_CHAT_ID) overrides.allowedChatId = Number(process.env.ALLOWED_CHAT_ID);
  if (process.env.ANTHROPIC_API_KEY) overrides.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) overrides.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.FAL_API_KEY) overrides.falApiKey = process.env.FAL_API_KEY;
  if (process.env.FISH_AUDIO_API_KEY) overrides.fishAudioApiKey = process.env.FISH_AUDIO_API_KEY;
  if (process.env.TAVILY_API_KEY) overrides.tavilyApiKey = process.env.TAVILY_API_KEY;
  return overrides;
}

export function loadConfig(): AppConfig {
  const configFile =
    process.env.MEAI_CONFIG ??
    path.join(PROJECT_ROOT, "data", "config.json");

  const resolved = resolveHome(configFile);
  const envOverrides = getEnvOverrides();

  let raw: Record<string, unknown> = {};

  if (fs.existsSync(resolved)) {
    try {
      raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      console.error(`Failed to parse config file: ${resolved}`);
      console.error(err);
      process.exit(1);
    }
  } else if (Object.keys(envOverrides).length > 0) {
    console.log("No config.json found — using environment variables.");
  } else {
    console.error(`Config file not found: ${resolved}`);
    console.error(
      "Run 'npm run setup' to create one, or set TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, and ANTHROPIC_API_KEY environment variables.",
    );
    process.exit(1);
  }

  // Env vars override config.json values
  const merged = { ...raw, ...envOverrides };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    console.error("Invalid config:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const rawStatePath = result.data.statePath || path.join(PROJECT_ROOT, "data");
  const config: AppConfig = {
    ...result.data,
    statePath: resolveHome(rawStatePath),
  };

  ensureDirectories(config.statePath);
  seedDefaults(config.statePath);

  return config;
}
