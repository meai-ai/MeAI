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
import type { GenerationMode, GenerationInputs } from "./character-gen.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "data", "config.json");
const CHARACTER_PATH = path.join(PROJECT_ROOT, "data", "character.yaml");
const IDENTITY_PATH = path.join(PROJECT_ROOT, "data", "memory", "IDENTITY.md");
const USER_MD_PATH = path.join(PROJECT_ROOT, "data", "memory", "USER.md");
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

  // Load existing config if present (skip already-configured steps)
  let existingConfig: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch { /* ignore parse errors, start fresh */ }
  }

  // Collect all values — start from existing config
  const config: Record<string, unknown> = { ...existingConfig };

  // Count what's already configured
  const alreadySet: string[] = [];
  if (config.telegramBotToken) alreadySet.push("Telegram Bot Token");
  if (config.allowedChatId) alreadySet.push("Chat ID");
  if (config.anthropicApiKey) alreadySet.push("Anthropic API Key");
  if (config.openaiApiKey) alreadySet.push("OpenAI API Key");
  if (config.falApiKey) alreadySet.push("Fal.ai API Key");

  if (alreadySet.length > 0) {
    console.log(`Already configured: ${alreadySet.join(", ")}`);
    console.log("Skipping those steps. Only missing items will be asked.\n");
  }

  // ── Step 1: Telegram Bot Token ───────────────────────────────────
  if (!config.telegramBotToken) {
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
  }

  // ── Step 2: Chat ID ──────────────────────────────────────────────
  if (!config.allowedChatId) {
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
  }

  // ── Step 3: LLM Setup (Max OAuth or Anthropic API Key) ──────────
  if (!config.anthropicApiKey) {
    console.log(`
--- Step 3/5: LLM Setup ---

MeAI needs a Claude LLM backend. You have two options:

  Option A (Recommended): Claude Max subscription ($0 API cost)
    If you have a Claude Max subscription, MeAI can use it for ALL LLM calls
    at zero additional cost. Run: npx anthropic-max-router
    to generate OAuth tokens, then press Enter to skip the API key.

  Option B: Anthropic API key (pay-per-use)
    Go to https://console.anthropic.com/ > Settings > API Keys > Create Key.
    New accounts get $5 free credits.
`);
    const apiKey = await askOptional("Paste your Anthropic API key (or press Enter to use Max OAuth): ");
    if (apiKey) {
      config.anthropicApiKey = apiKey;
      if (!apiKey.startsWith("sk-ant-")) {
        console.log("(Warning: key doesn't start with sk-ant- — continuing anyway)\n");
      }
    } else {
      console.log("No API key provided — MeAI will use Max OAuth (generate tokens with: npx anthropic-max-router)\n");
    }
  }

  // ── Step 4: Optional API Keys ────────────────────────────────────
  if (!config.openaiApiKey || !config.falApiKey) {
    console.log(`
--- Step 4/5: Optional Features ---

These are optional — press Enter to skip any.
`);

    if (!config.openaiApiKey) {
      const openaiKey = await askOptional("OpenAI API key (enables semantic memory search)\n  Get one at https://platform.openai.com/api-keys\n  Paste key or press Enter to skip: ");
      if (openaiKey) config.openaiApiKey = openaiKey;
      console.log();
    }

    if (!config.falApiKey) {
      const falKey = await askOptional("Fal.ai API key (enables AI-generated selfies)\n  Get one at https://fal.ai/dashboard/keys\n  Paste key or press Enter to skip: ");
      if (falKey) config.falApiKey = falKey;
    }
  }

  // ── Step 5: Character Setup ──────────────────────────────────────
  let charName = "Alex";
  let characterCity = "New York";
  let templateName = "minimal";

  // Skip if character.yaml already exists with a real character name
  const characterExists = fs.existsSync(CHARACTER_PATH) && (() => {
    try {
      const content = fs.readFileSync(CHARACTER_PATH, "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const name = nameMatch?.[1]?.trim();
      return name && name !== "Your Character Name" && name !== "Alex";
    } catch { return false; }
  })();

  if (characterExists) {
    const content = fs.readFileSync(CHARACTER_PATH, "utf-8");
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    charName = nameMatch?.[1]?.trim() ?? "Unknown";
    const cityMatch = content.match(/^\s+city:\s*(.+)$/m);
    characterCity = cityMatch?.[1]?.trim() ?? "Unknown";
    console.log(`\nCharacter already configured: ${charName} (${characterCity})`);
    const regenAnswer = await ask("Regenerate character? (y/N) ");
    if (regenAnswer.toLowerCase() !== "y") {
      // Save config (may have new keys) and print summary
      fs.mkdirSync(path.join(PROJECT_ROOT, "data"), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
      printSummary(charName, characterCity, "existing", config);
      rl.close();
      return;
    }
  }

  console.log(`
--- Step 5/5: Create Your Character ---

Your AI companion needs a name and personality.

Choose how to create your character:
  1) Quick start — minimal template, get running fast (recommended for first-timers)
  2) Full template — rich config for manual customization (see docs/CREATE_CHARACTER.md)
  3) AI Random — specialist AI agents generate a unique character from scratch
  4) AI + Your Ideas — you provide basics, AI fills in the deep details
  5) AI Soul Match — describe yourself, AI creates your ideal companion

  Options 3-5 use Claude CLI (Max subscription) and take about 2 minutes.
`);

  const modeChoice = (await askOptional("Choice (1-5, default: 1): ")) || "1";
  const mode = modeChoice.trim();

  if (mode === "3" || mode === "4" || mode === "5") {
    // ── AI-powered character generation (uses Claude CLI) ──────────
    let genMode: GenerationMode;
    let genInputs: GenerationInputs;

    if (mode === "3") {
      // ── AI Random ────────────────────────────────────────────────
      templateName = "AI random";
      console.log("\nGenerating a unique character from scratch...\n");
      const userName = (await askOptional("Your name (what the AI calls you): ")) || "User";

      genMode = "random";
      genInputs = { mode: "random", userName };

    } else if (mode === "4") {
      // ── AI + Your Ideas ──────────────────────────────────────────
      templateName = "AI + your ideas";
      console.log("\nProvide some basics — press Enter to let AI decide any field.\n");
      const userName = (await askOptional("Your name (what the AI calls you): ")) || "User";
      const inputName = await askOptional("Character's name (Enter = AI decides): ");
      const inputAge = await askOptional("Character's age (Enter = AI decides): ");
      const inputGender = await askOptional("Character's gender (female/male/nonbinary, Enter = AI decides): ");
      const inputCity = await askOptional("City where the character lives (Enter = AI decides): ");
      const inputOccupation = await askOptional("Character's occupation (Enter = AI decides): ");
      const inputPersonality = await askOptional("Personality keywords, e.g. 'witty, introverted, creative' (Enter = AI decides): ");
      const inputRelationship = await askOptional("Relationship to you, e.g. 'best friend', 'roommate' (default: close friend): ");

      genMode = "user-defined";
      genInputs = {
        mode: "user-defined",
        userName,
        userDefined: {
          charName: inputName || undefined,
          charAge: inputAge || undefined,
          charGender: inputGender || undefined,
          charCity: inputCity || undefined,
          charOccupation: inputOccupation || undefined,
          charPersonalityKeywords: inputPersonality || undefined,
          userName,
          userRelationship: inputRelationship || undefined,
        },
      };

    } else {
      // ── AI Soul Match ────────────────────────────────────────────
      templateName = "AI soul match";
      console.log("\nTell us about yourself — the AI will create a complementary companion.\n");
      const userName = (await askOptional("Your name: ")) || "User";
      const userCity = await askOptional("Your city (Enter = skip): ");
      const userOccupation = await askOptional("Your occupation (Enter = skip): ");
      const userPersonality = await askOptional("Describe your personality in a few words: ");
      const userInterests = await askOptional("Your interests/hobbies: ");
      const userLifestyle = await askOptional("Your lifestyle (e.g. 'busy professional', 'stay-at-home parent'): ");
      const userPrefs = await askOptional("What do you want in a companion? (e.g. 'someone fun and spontaneous'): ");

      genMode = "soul-match";
      genInputs = {
        mode: "soul-match",
        userName,
        soulMatch: {
          userName,
          userCity: userCity || undefined,
          userOccupation: userOccupation || undefined,
          userPersonality: userPersonality || undefined,
          userInterests: userInterests || undefined,
          userLifestyle: userLifestyle || undefined,
          userCompanionPreferences: userPrefs || undefined,
        },
      };
    }

    console.log("\nStarting AI character generation...\n");

    // Initialize Max OAuth + API client so character-gen uses API (fast) instead of CLI (slow)
    const statePath = path.join(PROJECT_ROOT, "data");
    const { initMaxOAuth } = await import("../src/max-oauth.js");
    const { initClaudeRunnerApi } = await import("../src/claude-runner.js");
    initMaxOAuth(statePath);
    initClaudeRunnerApi(String(config.anthropicApiKey ?? ""));

    // Dynamic import to avoid loading at module level
    const { generateCharacter } = await import("./character-gen.js");

    try {
      const result = await generateCharacter(genMode, genInputs, (step, total, label) => {
        console.log(`  [${step}/${total}] ${label}`);
      });

      console.log("  done!\n");

      charName = result.characterName;
      characterCity = result.characterCity;

      // Write files atomically at the end
      fs.mkdirSync(path.join(PROJECT_ROOT, "data"), { recursive: true });
      fs.mkdirSync(path.join(PROJECT_ROOT, "data", "memory"), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
      fs.writeFileSync(CHARACTER_PATH, result.characterYaml);
      fs.writeFileSync(IDENTITY_PATH, result.identityMd);
      if (result.userMd) {
        fs.writeFileSync(USER_MD_PATH, result.userMd);
      }

      // Print summary
      printSummary(charName, characterCity, templateName, config);

      rl.close();
      return;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\nCharacter generation failed: ${msg}`);
      if (msg.includes("Claude Code CLI not found")) {
        console.log("Install Claude CLI: npm install -g @anthropic-ai/claude-code");
      }
      console.log("Falling back to quick start template...\n");
      // Fall through to template-based generation
    }
  }

  // ── Template-based character generation (modes 1, 2, or AI fallback) ──

  const useFullTemplate = mode === "2";
  const CHARACTER_FULL_TEMPLATE = path.join(PROJECT_ROOT, "data", "character.example.yaml");
  const templatePath = useFullTemplate ? CHARACTER_FULL_TEMPLATE : CHARACTER_TEMPLATE;
  templateName = useFullTemplate ? "full" : "minimal";

  if (useFullTemplate) {
    console.log("\nUsing the full template. You can customize everything in data/character.yaml after setup.\n");
  }

  charName = (await askOptional("Character's name (default: Alex): ")) || "Alex";
  const userName = (await askOptional("Your name (what the AI calls you): ")) || "User";
  const gender = (await askOptional("Character's gender (female/male/nonbinary, default: female): ")) || "female";
  const city = (await askOptional("City where the character lives (default: New York): ")) || "New York";
  characterCity = city;

  // Look up city coordinates
  const cityKey = city.toLowerCase();
  const coords = CITY_COORDS[cityKey] ?? CITY_COORDS["new york"];
  const defaultTZ = coords.tz;

  const timezone = (await askOptional(`Timezone (default: ${defaultTZ}): `)) || defaultTZ;

  // Generate character.yaml from chosen template
  let characterYaml: string;
  if (fs.existsSync(templatePath)) {
    characterYaml = fs.readFileSync(templatePath, "utf-8");

    if (useFullTemplate) {
      // Full template uses placeholder values like "Your Character Name"
      // Note: {character.name} and {user.name} are runtime template vars — don't replace those
      characterYaml = characterYaml
        .replace(/^name: Your Character Name\b.*$/m, `name: ${charName}`)
        .replace(/^english_name: MeAI$/m, `english_name: ${charName}`)
        .replace(/^age: 25$/m, `age: 28`)
        .replace(/^gender: female\b.*$/m, `gender: ${gender}`)
        .replace(/^timezone: America\/Los_Angeles\b.*$/m, `timezone: ${timezone}`)
        .replace(/^  city: "".*$/m, `  city: ${city}`)
        .replace(/latitude: 37\.7749/m, `latitude: ${coords.lat}`)
        .replace(/longitude: -122\.4194/m, `longitude: ${coords.lon}`)
        .replace(/^  name: User\b.*$/m, `  name: ${userName}`);
    } else {
      // Minimal template uses "Alex" / "User" as defaults
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
    }
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
  printSummary(charName, characterCity, templateName, config);

  rl.close();
}

function printSummary(charName: string, city: string, templateName: string, config: Record<string, unknown>) {
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
Character created: ${charName} (${city}) — ${templateName} template

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
}

main().catch((err) => {
  console.error("Setup error:", err);
  rl.close();
  process.exit(1);
});
