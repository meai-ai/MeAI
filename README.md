# MeAI

An autonomous AI companion that lives on Telegram — with a simulated daily life, deterministic body state, causal emotions, persistent memory, and the ability to evolve itself. Ships with an example character, but every companion is fully customizable — or let AI generate one for you.

## Features

- **Grounded in reality** — Weather, stock prices, time of day, and news are all real. The companion reacts to actual events, not random prompts.
- **Deterministic body simulation** — Fatigue increases with time awake, hunger grows since last meal, caffeine decays with a 4-hour half-life. No random states.
- **Causal emotions** — Every mood has a real reason (work stress, a discovery, weather change). No "I'm feeling happy today" out of nowhere.
- **Autonomous behavior** — A heartbeat loop fires every ~5 minutes. The companion explores the web, posts on X/Twitter, reaches out proactively, does activities (reading, coding, learning), and rests — all on its own.
- **Self-evolving** — The system can propose new tools (Tier 3, requires approval) and even code patches to itself (Tier 4, with snapshot/rollback and a dead man's switch).
- **Persistent memory** — Hierarchical memory store with semantic search (mem0 + BM25). Remembers what you told it weeks ago and brings it up naturally.
- **AI character generation** — A 7-step specialist agent pipeline (psychologist, sociologist, novelist, director, synthesizer, YAML assembler, identity writer) can generate a deeply rich character from scratch, from your ideas, or as a soul match to your personality.
- **5-axis extensibility** — Modules, channels, LLM providers, senses, and expressions are all plug-in registries with auto-discovery. Add new capabilities without touching core code.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/anthropics/MeAI.git
cd MeAI
npm install

# 2. Setup (interactive wizard — API keys + character creation, including AI generation)
npm run setup

# 3. Run
npm start
```

To verify your setup before starting: `npm run check`

## Requirements

| Service | Required | Cost | What It Enables |
|---------|----------|------|-----------------|
| [Telegram bot token](https://t.me/BotFather) | Yes | Free | Chat interface |
| [Anthropic API key](https://console.anthropic.com/) | Yes | ~$5/mo | Conversation |
| [OpenAI API key](https://platform.openai.com/api-keys) | No | ~$1/mo | Semantic memory search |
| [fal.ai API key](https://fal.ai/dashboard/keys) | No | ~$1/mo | AI selfie generation |
| [Fish Audio API key](https://fish.audio) | No | ~$1/mo | Voice messages |
| X/Twitter API keys | No | Free | Social posting |
| [Claude CLI](https://claude.ai/code) (Max subscription) | No | $200/mo | Background tasks at no API cost |

## Character Creation

The setup wizard (`npm run setup`) offers 5 ways to create your character:

| Mode | What Happens |
|------|-------------|
| **Quick start** | Minimal template — get running in 2 minutes |
| **Full template** | Rich config for manual customization (see [docs/CREATE_CHARACTER.md](docs/CREATE_CHARACTER.md)) |
| **AI Random** | 7 specialist agents generate a unique character from scratch |
| **AI + Your Ideas** | You provide basics (name, city, personality), AI fills in depth |
| **AI Soul Match** | Describe yourself, AI creates a psychologically complementary companion |

AI modes (3–5) use Claude CLI and take about 2 minutes. The pipeline runs 7 specialist agents in sequence:

1. **Psychology** — Big Five personality, attachment style, emotional patterns, internal contradictions
2. **Sociology** — City, occupation, communities, cultural background, social dynamics
3. **Novelist** — Backstory, quirks, speech patterns, friends, hobbies, relationship dynamics
4. **Director** — Appearance, living space, daily rhythms, food, body config, sensory anchors
5. **Synthesizer** — Weaves all outputs into a coherent `character.yaml` with persona prompts
6. **YAML Assembly** — Resolves city coordinates, injects timezone, validates schema
7. **Identity Writer** — 600–1200 line first-person narrative (`IDENTITY.md`) in the character's own voice

You can also manually create or edit your character at any time:

- `data/character.yaml` — Structured data (identity, location, friends, hobbies, body config, persona prompts)
- `data/memory/IDENTITY.md` — Free-form narrative identity (the LLM reads this as "who am I")
- `data/memory/USER.md` — Who the user is (the LLM reads this as "who am I talking to")

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

| Module | Path | What It Does |
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

## Extensibility

MeAI has 5 extensible axes, all built on a shared auto-discovery registry. Drop a file in the right directory, restart, and it's live.

| Axis | Directory | Built-in | Guide |
|------|-----------|----------|-------|
| **Modules** | `src/modules/<name>/` | Pets | [CREATE_MODULE.md](docs/CREATE_MODULE.md) |
| **Channels** | `src/channel/<name>.ts` | Telegram, Discord | [CREATE_CHANNEL.md](docs/CREATE_CHANNEL.md) |
| **LLM Providers** | `src/llm/<name>/` | Anthropic API, Claude CLI, Ollama | [CREATE_LLM_PROVIDER.md](docs/CREATE_LLM_PROVIDER.md) |
| **Senses** | `src/senses/<name>/` | Weather (Open-Meteo), Market (Yahoo), Search (DuckDuckGo, Tavily) | [CREATE_SENSE.md](docs/CREATE_SENSE.md) |
| **Expressions** | `src/expressions/<name>/` | Image (fal.ai), TTS (Fish Audio), Music (Suno), Video (fal.ai), Social (X) | [CREATE_EXPRESSION.md](docs/CREATE_EXPRESSION.md) |

Each axis shares the same pattern:

1. Create `index.ts` in the appropriate subdirectory with a default export implementing the interface
2. Restart MeAI — the registry auto-discovers your plugin
3. See the corresponding guide for the interface details and a working example

## Configuration

The setup wizard (`npm run setup`) creates `data/config.json` and `data/character.yaml` for you.

### Manual Setup

If you prefer to configure manually, create `data/config.json`:

```json
{
  "telegramBotToken": "your-bot-token",
  "allowedChatId": 123456789,
  "anthropicApiKey": "sk-ant-..."
}
```

Copy `data/character.minimal.yaml` to `data/character.yaml` and edit it.

### Environment Variables

For Docker/server deployments, you can use environment variables instead of (or in addition to) `config.json`:

```bash
export TELEGRAM_BOT_TOKEN="..."
export ALLOWED_CHAT_ID="123456789"
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="..."       # optional
export FAL_API_KEY="..."          # optional
```

Environment variables override values in `config.json`.

### LLM Routing

- **Main conversation**: Uses the configured `model` via `anthropicApiKey` (or OpenAI if `conversationProvider: "openai"`)
- **Background tasks** (heartbeat, curiosity, emotion, etc.): Uses `claude --print` CLI, which leverages a Claude Max subscription at no API cost

> You need either a Claude Max subscription with `claude` CLI installed, or sufficient API credits for background tasks.

## Adding Skills

Create `data/skills/<name>/SKILL.md` (knowledge) and optionally `data/skills/<name>/tools.ts` (exports `getTools(config): ToolDefinition[]`). Skills are hot-loaded every turn — no restart needed.

## Contributing

MeAI is designed to be extended. The best entry points for contributors:

- **Add a channel** — Connect MeAI to Discord, Slack, WhatsApp, or any platform. See [docs/CREATE_CHANNEL.md](docs/CREATE_CHANNEL.md).
- **Add a sense** — Give MeAI new information sources (news APIs, social feeds, IoT sensors). See [docs/CREATE_SENSE.md](docs/CREATE_SENSE.md).
- **Add an expression** — New creative outputs (drawing, dance notation, 3D models). See [docs/CREATE_EXPRESSION.md](docs/CREATE_EXPRESSION.md).
- **Add a module** — New simulation systems (fitness tracking, dream journal, relationships). See [docs/CREATE_MODULE.md](docs/CREATE_MODULE.md).
- **Add an LLM provider** — Support for Gemini, Mistral, local models, etc. See [docs/CREATE_LLM_PROVIDER.md](docs/CREATE_LLM_PROVIDER.md).

All five axes use the same auto-discovery pattern — no changes to core code required.

## Commands

```bash
npm run setup      # Interactive setup wizard
npm run check      # Validate config and API connectivity
npm start          # Run the bot
npm run typecheck  # Type-check without emitting
npm test           # Run tests
```

## License

[Apache 2.0](LICENSE)
