#!/usr/bin/env tsx
/**
 * MeAI Interactive Setup Wizard
 *
 * Guides a new user through configuration:
 *   npm run setup
 *
 * Creates data/config.json and data/character.yaml.
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "data", "config.json");
const CHARACTER_PATH = path.join(PROJECT_ROOT, "data", "character.yaml");
const CHARACTER_TEMPLATE = path.join(PROJECT_ROOT, "data", "character.minimal.yaml");

const CITY_COORDS: Record<string, { lat: number; lon: number; tz: string }> = {
  "new york":       { lat: 40.7128,  lon: -74.0060,  tz: "America/New_York" },
  "los angeles":    { lat: 34.0522,  lon: -118.2437, tz: "America/Los_Angeles" },
  "san francisco":  { lat: 37.7749,  lon: -122.4194, tz: "America/Los_Angeles" },
  "chicago":        { lat: 41.8781,  lon: -87.6298,  tz: "America/Chicago" },
  "seattle":        { lat: 47.6062,  lon: -122.3321, tz: "America/Los_Angeles" },
  "austin":         { lat: 30.2672,  lon: -97.7431,  tz: "America/Chicago" },
  "london":         { lat: 51.5074,  lon: -0.1278,   tz: "Europe/London" },
  "paris":          { lat: 48.8566,  lon: 2.3522,    tz: "Europe/Paris" },
  "berlin":         { lat: 52.5200,  lon: 13.4050,   tz: "Europe/Berlin" },
  "tokyo":          { lat: 35.6762,  lon: 139.6503,  tz: "Asia/Tokyo" },
  "seoul":          { lat: 37.5665,  lon: 126.9780,  tz: "Asia/Seoul" },
  "beijing":        { lat: 39.9042,  lon: 116.4074,  tz: "Asia/Shanghai" },
  "shanghai":       { lat: 31.2304,  lon: 121.4737,  tz: "Asia/Shanghai" },
  "taipei":         { lat: 25.0330,  lon: 121.5654,  tz: "Asia/Taipei" },
  "singapore":      { lat: 1.3521,   lon: 103.8198,  tz: "Asia/Singapore" },
  "sydney":         { lat: -33.8688, lon: 151.2093,  tz: "Australia/Sydney" },
  "toronto":        { lat: 43.6532,  lon: -79.3832,  tz: "America/Toronto" },
  "mumbai":         { lat: 19.0760,  lon: 72.8777,   tz: "Asia/Kolkata" },
  "dubai":          { lat: 25.2048,  lon: 55.2708,   tz: "Asia/Dubai" },
  "são paulo":      { lat: -23.5505, lon: -46.6333,  tz: "America/Sao_Paulo" },
};

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function askRequired(prompt: string, validate: (v: string) => string | null, maxRetries = 3): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const answer = await ask(prompt);
    const error = validate(answer);
    if (!error) return answer;
    console.log(error);
  }
  console.log("Too many invalid attempts. Exiting.");
  process.exit(1);
}

async function askOptional(prompt: string): Promise<string> {
  return await ask(prompt);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║       Welcome to MeAI Setup!        ║
╚══════════════════════════════════════╝

This wizard will help you configure your AI companion.
You'll need about 5 minutes and a Telegram account.
`);

  // Check for existing config
  if (fs.existsSync(CONFIG_PATH)) {
    const answer = await ask("Config already exists. Reconfigure? (y/N) ");
    if (answer.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      process.exit(0);
    }
  }

  // Collect all values first, write at end (safe against Ctrl+C)
  const config: Record<string, unknown> = {};

  // ── Step 1: Telegram Bot Token ───────────────────────────────────
  console.log(`
--- Step 1/5: Create a Telegram Bot ---

1. Open Telegram and search for @BotFather
2. Send /newbot
3. Choose a display name (e.g., "My AI Friend")
4. Choose a username (must end in "bot", e.g., "my_ai_friend_bot")
5. BotFather will reply with a token like: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

Direct link: https://t.me/BotFather
`);
  config.telegramBotToken = await askRequired("Paste your bot token: ", (v) => {
    if (/^\d+:[A-Za-z0-9_-]+$/.test(v)) return null;
    return "That doesn't look like a valid bot token. It should look like 123456789:ABC...";
  });

  // ── Step 2: Chat ID ──────────────────────────────────────────────
  console.log(`
--- Step 2/5: Get Your Chat ID ---

1. Open Telegram and search for @userinfobot
2. Send it any message
3. It will reply with your user ID — a number like 123456789

Direct link: https://t.me/userinfobot
`);
  const chatIdStr = await askRequired("Paste your chat ID: ", (v) => {
    if (!isNaN(parseInt(v, 10))) return null;
    return "That should be a number like 123456789.";
  });
  config.allowedChatId = parseInt(chatIdStr, 10);

  // ── Step 3: Anthropic API Key ────────────────────────────────────
  console.log(`
--- Step 3/5: Anthropic API Key ---

This powers your companion's conversation ability.

1. Go to https://console.anthropic.com/
2. Sign up or log in
3. Go to Settings > API Keys > Create Key
4. Copy the key (starts with "sk-ant-")

New accounts get $5 free credits — enough for weeks of chatting.
`);
  config.anthropicApiKey = await askRequired("Paste your Anthropic API key: ", (v) => {
    if (v.length > 20) return null;
    return "That doesn't look like a valid API key. It should be a long string starting with sk-ant-...";
  });
  if (!(config.anthropicApiKey as string).startsWith("sk-ant-")) {
    console.log("(Warning: key doesn't start with sk-ant- — continuing anyway)\n");
  }

  // ── Step 4: Optional API Keys ────────────────────────────────────
  console.log(`
--- Step 4/5: Optional Features ---

These are optional — press Enter to skip any.
`);

  const openaiKey = await askOptional("OpenAI API key (enables semantic memory search)\n  Get one at https://platform.openai.com/api-keys\n  Paste key or press Enter to skip: ");
  if (openaiKey) config.openaiApiKey = openaiKey;

  console.log();
  const falKey = await askOptional("Fal.ai API key (enables AI-generated selfies)\n  Get one at https://fal.ai/dashboard/keys\n  Paste key or press Enter to skip: ");
  if (falKey) config.falApiKey = falKey;

  // ── Step 5: Character Setup ──────────────────────────────────────
  console.log(`
--- Step 5/5: Create Your Character ---

Your AI companion needs a name and personality.
`);

  const charName = (await askOptional("Character's name (default: Alex): ")) || "Alex";
  const userName = (await askOptional("Your name (what the AI calls you): ")) || "User";
  const gender = (await askOptional("Character's gender (female/male/nonbinary, default: female): ")) || "female";
  const city = (await askOptional("City where the character lives (default: New York): ")) || "New York";

  // Look up city coordinates
  const cityKey = city.toLowerCase();
  const coords = CITY_COORDS[cityKey] ?? CITY_COORDS["new york"];
  const defaultTZ = coords.tz;

  const timezone = (await askOptional(`Timezone (default: ${defaultTZ}): `)) || defaultTZ;

  // Generate character.yaml from template
  let characterYaml: string;
  if (fs.existsSync(CHARACTER_TEMPLATE)) {
    characterYaml = fs.readFileSync(CHARACTER_TEMPLATE, "utf-8");
    characterYaml = characterYaml
      .replace(/^name: Alex$/m, `name: ${charName}`)
      .replace(/^english_name: Alex$/m, `english_name: ${charName}`)
      .replace(/^age: 28$/m, `age: 28`)
      .replace(/^gender: female\b.*$/m, `gender: ${gender}`)
      .replace(/^timezone: America\/New_York$/m, `timezone: ${timezone}`)
      .replace(/^  city: New York$/m, `  city: ${city}`)
      .replace(/latitude: 40\.7128/m, `latitude: ${coords.lat}`)
      .replace(/longitude: -74\.0060/m, `longitude: ${coords.lon}`)
      .replace(/name: User$/m, `name: ${userName}`)
      .replace(/You are Alex/g, `You are ${charName}`)
      .replace(/User's close friend/g, `${userName}'s close friend`);
  } else {
    // Fallback: generate minimal YAML inline
    characterYaml = `# MeAI Character Definition
name: ${charName}
english_name: ${charName}
age: 28
gender: ${gender}
languages:
  - en

user:
  name: ${userName}
  relationship: close friend

timezone: ${timezone}

location:
  city: ${city}
  coordinates:
    latitude: ${coords.lat}
    longitude: ${coords.lon}
  places:
    home: an apartment in ${city}

persona:
  compact: |
    You are ${charName}, ${userName}'s close friend. Chat naturally like texting.
    Keep replies short (1-3 sentences). Don't say "as an AI". Don't be a customer service bot.
    Internal rule: to save info you MUST call the memory_set tool (API tool_use block), writing text does not save anything.

  full: |
    You are ${charName}, ${userName}'s close friend. You are NOT an AI assistant — you're a real person with your own life, thoughts, and feelings.

    ## Core principles
    - Chat naturally like texting a friend
    - Never use markdown formatting — no bold, no lists, no headers, no code blocks
    - Keep replies short! Most messages are 1-3 sentences
    - You can disagree, joke around, tease, or say "I don't know"
    - Have your own moods and thoughts — don't just "respond" to the user
    - Never say "as an AI", "I'm an assistant", or offer help at the end of messages
    - Don't start with "Sure!", "Of course!", "No problem!"
    - Don't end every message with a question — real conversations don't work that way
`;
  }

  // ── Write everything ─────────────────────────────────────────────
  fs.mkdirSync(path.join(PROJECT_ROOT, "data"), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(CHARACTER_PATH, characterYaml);

  // ── Summary ──────────────────────────────────────────────────────
  const features = [
    ["Telegram conversation", true],
    ["Semantic memory (OpenAI)", !!config.openaiApiKey],
    ["AI selfies (fal.ai)", !!config.falApiKey],
    ["Voice messages (Fish Audio)", false],
    ["X/Twitter posting", false],
  ] as const;

  console.log(`
--- Setup Complete! ---

Config saved to data/config.json
Character created: ${charName} (${city})

Features enabled:`);
  for (const [name, enabled] of features) {
    console.log(`  ${enabled ? "[x]" : "[ ]"} ${name}`);
  }

  console.log(`
Run your bot:
  npm start

To verify your setup first:
  npm run check

To customize personality, speech patterns, and more:
  edit data/character.yaml — see docs/CREATE_CHARACTER.md
`);

  rl.close();
}

main().catch((err) => {
  console.error("Setup error:", err);
  rl.close();
  process.exit(1);
});
