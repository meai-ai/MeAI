# MeAI

An autonomous AI companion that lives on Telegram — with a simulated daily schedule, emotions with causal grounding, physical body state, social relationships, hobbies, and autonomous behaviors.

MeAI ships with an example character template, but you can define your own character by editing `data/character.yaml` and `data/memory/IDENTITY.md`. See [Creating a Character](docs/CREATE_CHARACTER.md) for a step-by-step guide.

## What Makes It Different

- **Grounded in reality** — Weather, stock prices, time of day, and news are all real. The companion reacts to actual events, not random prompts.
- **Deterministic body simulation** — Fatigue increases with time awake, hunger grows since last meal, caffeine decays with a 4-hour half-life. No random states.
- **Causal emotions** — Every mood has a real reason (work stress, a discovery, weather change). No "I'm feeling happy today" out of nowhere.
- **Autonomous behavior** — A heartbeat loop fires every ~5 minutes. The companion explores the web, posts on X/Twitter, reaches out proactively, does activities (reading, coding, learning), and rests — all on its own.
- **Self-evolving** — The system can propose new tools (Tier 3, requires approval) and even code patches to itself (Tier 4, with snapshot/rollback and a dead man's switch).
- **Persistent memory** — Hierarchical memory store with semantic search (mem0 + BM25). Remembers what you told it weeks ago and brings it up naturally.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/meai-ai/MeAI.git
cd MeAI
npm install

# 2. Configure
cp data/config.example.json data/config.json
# Edit data/config.json with your API keys (see Configuration below)

# 3. Install Playwright browser (needed for web exploration)
npx playwright install chromium

# 4. Run
npm start
```

## Configuration

Edit `data/config.json` with your credentials:

| Key | Required | Description |
|-----|----------|-------------|
| `telegramBotToken` | Yes | From [@BotFather](https://t.me/BotFather) |
| `allowedChatId` | Yes | Your Telegram user ID (use [@userinfobot](https://t.me/userinfobot)) |
| `anthropicApiKey` | Yes | From [Anthropic Console](https://console.anthropic.com/) |
| `openaiApiKey` | No | Enables mem0 semantic memory + optional GPT conversation |
| `xApiKey` / `xApiKeySecret` / `xAccessToken` / `xAccessTokenSecret` | No | Enables X/Twitter posting and reading |
| `falApiKey` | No | Enables AI selfie/image generation ([fal.ai](https://fal.ai)) |
| `fishAudioApiKey` / `fishAudioVoiceId` | No | Enables voice messages ([Fish Audio](https://fish.audio)) |
| `tavilyApiKey` | No | High-quality web search (falls back to DuckDuckGo) |
| `sunoApiKey` | No | Enables music composition |
| `momentsChannelId` | No | Telegram channel ID for "朋友圈" (life moments timeline) |

### LLM Routing

- **Main conversation**: Uses the configured `model` via `anthropicApiKey` (or OpenAI if `conversationProvider: "openai"`)
- **Background tasks** (heartbeat, curiosity, emotion, etc.): Uses `claude --print` CLI, which leverages a Claude Max subscription at no API cost

> You need either a Claude Max subscription with `claude` CLI installed, or sufficient API credits for background tasks.

## Architecture

```
Telegram message → channel/telegram.ts → agent/loop.ts → context.ts (system prompt)
                                                        → Claude API (streaming)
                                                        → tool calls → response

Heartbeat (every ~5 min) → LLM decides action:
  explore    → curiosity.ts (web discovery via Playwright)
  reach_out  → proactive.ts (message user)
  post       → social.ts (X/Twitter)
  activity   → activities.ts (coding, reading, learning)
  rest       → do nothing
```

### Key Modules

| Module | File | What It Does |
|--------|------|-------------|
| World | `src/world.ts` | Weather, stocks, daily schedule generation |
| Emotion | `src/emotion.ts` | Causal mood engine from real-world signals |
| Body | `src/body.ts` | Fatigue, hunger, caffeine, menstrual cycle |
| Memory | `src/memory/` | Hierarchical store + mem0 semantic search |
| Session | `src/session/` | JSONL transcripts with auto-compaction |
| Curiosity | `src/curiosity.ts` | Autonomous web exploration |
| Social | `src/social.ts` | X/Twitter posting |
| Proactive | `src/proactive.ts` | Reaches out to user on its own |
| Evolution | `src/evolution/` | Self-improvement (tools, patches, memory) |
| Heartbeat | `src/heartbeat.ts` | Central coordination loop |

### Evolution Tiers

| Tier | What | Approval |
|------|------|----------|
| 1 | Memory CRUD | None |
| 2 | Skill CRUD | None |
| 3 | Tool proposals | Telegram inline keyboard |
| 4 | Code patches | Telegram + snapshot/rollback + dead man's switch |

## Customizing Your Character

To create your own character:

1. Edit `data/character.yaml` — structured data (name, location, timezone, friends, hobbies, body config)
2. Edit `data/memory/IDENTITY.md` — free-form narrative identity document (the LLM reads this as "who am I")
3. Edit `data/memory/USER.md` — who the user is (the LLM reads this as "who am I talking to")

See [docs/CREATE_CHARACTER.md](docs/CREATE_CHARACTER.md) for the full guide.

## Adding Skills

Create `data/skills/<name>/SKILL.md` (knowledge) and optionally `data/skills/<name>/tools.ts` (exports `getTools(config): ToolDefinition[]`). Skills are hot-loaded every turn — no restart needed.

## Commands

```bash
npm start          # Run the bot
npm run typecheck  # Type-check without emitting
```

## License

[Apache 2.0](LICENSE)
