# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is MeAI

MeAI is an autonomous AI companion that lives on Telegram. It ships with an example character template (`data/character.example.yaml`), but all character-specific content is abstracted into `data/character.yaml` — you can define your own character without touching TypeScript.

The companion has a complete simulated life: daily schedule, emotions with causal grounding, physical body state, social relationships, hobbies, and autonomous behaviors (web exploration, X/Twitter posting, proactive messaging, activities). A central heartbeat coordination loop drives all autonomous behavior.

## Commands

```bash
npm start          # Run the bot (tsx transpiles TypeScript on-the-fly, no build step)
npm run typecheck  # Type-check without emitting (tsc --noEmit)
```

There is no build step, no linter, and no test suite. TypeScript is executed directly via `tsx`.

## Architecture

### Entry Point & Module Initialization

`src/index.ts` initializes all modules by calling their `init*()` functions with `statePath`, then wires up the Telegram channel, heartbeat, and watchdog. Every module follows the same pattern:

```
init<Module>(statePath) → getState() → format<Module>Context() for system prompt
```

State persists as JSON files under `data/`.

### Core Loop: Message Handling

1. Telegram message arrives → `src/channel/telegram.ts`
2. `src/agent/loop.ts` handles message: loads session transcript, routes skills, hot-loads tools
3. `src/agent/context.ts` assembles the system prompt from ~10 context sources (identity, memories, world, emotion, body, social, skills, notifications, etc.)
4. Claude API called with streaming; response is edited into Telegram in real-time
5. Tool calls handled inline; turn appended to JSONL transcript

### Heartbeat Coordination (`src/heartbeat.ts`)

Central pulse fires every ~5 minutes. An LLM decides what the character should do based on time of day, emotional state, idle time, cooldowns:
- **explore** → `src/curiosity.ts` (web discovery via DuckDuckGo/Playwright)
- **reach_out** → `src/proactive.ts` (message user)
- **post** → `src/social.ts` (X/Twitter)
- **activity** → `src/activities.ts` (vibe coding, deep reading, learning)
- **rest** → do nothing

### Progressive Skill Loading (`src/agent/skill-router.ts`)

Not all skills are loaded every turn. The router scores skills against the user message (keyword match + recency boost), injects top 6 fully, and shows the rest as a compact directory. Always-on skills: `claude-code`, `datetime`, `weather`, `web-search`, `x-browser`.

### Evolution Tiers (`src/evolution/`)

| Tier | What | Approval |
|------|------|----------|
| 1 | Memory CRUD (`memory.ts`) | None |
| 2 | Skill CRUD (`skills.ts`) | None |
| 3 | Tool proposals (`installer.ts`) | Telegram inline keyboard |
| 4 | Code patches (`patcher.ts`) | Telegram + snapshot/rollback + dead man's switch |

### Session Management (`src/session/`)

Conversations stored as JSONL (`data/sessions/main.jsonl`). When transcript hits 80% of token budget (~180k), it compacts: LLM generates slug/title/topics/summary, full transcript moves to `data/sessions/archive/`.

### Deterministic Body & Emotion

- `src/body.ts`: Physical state computed from schedule rules, not random. Fatigue increases with time awake, hunger increases since last meal, caffeine decays with 4h half-life. Menstrual cycle is optional (configurable via `character.yaml`).
- `src/emotion.ts`: Every mood has a causal explanation (work events, market movements, discoveries, micro-events). No random moods.

### Real-World Data Sources

- `src/world.ts`: Yahoo Finance (stocks), Open-Meteo (weather), daily schedule generation
- `src/interests.ts`: RSS, YouTube API, podcast feeds
- `src/curiosity.ts`: DuckDuckGo search + Playwright scraping
- `src/notifications.ts`: Price alerts, weather changes, RSS updates (all real, never simulated)

### LLM Routing

- Main conversation: configured provider (Anthropic or OpenAI) via `conversationProvider` config
- Background tasks (heartbeat, curiosity, etc.): `src/claude-runner.ts` wraps `claude --print` CLI (uses Max subscription, no API billing)

## Key Files

- `src/index.ts` — Initialization & module wiring
- `src/agent/loop.ts` — Main message handler with streaming
- `src/agent/context.ts` — System prompt assembly (~10 context blocks)
- `src/agent/tools.ts` — Tool registry with hot-loading from skill directories
- `src/types.ts` — Shared TypeScript interfaces
- `src/config.ts` — Config loader with Zod validation
- `data/config.json` — API keys and settings (gitignored)
- `src/character.ts` — Character loader (loads `data/character.yaml`, exports `getCharacter()`)
- `data/character.yaml` — Character definition (identity, location, friends, persona prompts — gitignored)
- `data/character.example.yaml` — Full example character (copy to `character.yaml` to start)
- `data/memory/IDENTITY.md` — Narrative identity document (LLM reads as "who am I")
- `data/memory/USER.md` — User profile (LLM reads as "who am I talking to")
- `data/skills/` — User-created skills (SKILL.md + optional tools.ts per skill)

## Configuration

`data/config.json` contains API keys (`telegramBotToken`, `anthropicApiKey`, `openaiApiKey`, X API credentials), `allowedChatId`, model selection, and `statePath`. Schema validated by Zod in `src/config.ts`.

## Adding a New Module

1. Create `src/my-module.ts` with `initMyModule(statePath)`, `getMyState()`, `formatMyContext()`
2. Call `initMyModule()` in `src/index.ts`
3. Add `formatMyContext()` output to system prompt in `src/agent/context.ts`
4. State persists to `data/my-state.json`

## Adding a Skill

Create `data/skills/<name>/SKILL.md` (knowledge) and optionally `data/skills/<name>/tools.ts` (exports `getTools(config): ToolDefinition[]`). Skills are hot-loaded every turn — no restart needed.

## Character Abstraction

All character-specific content is driven by `data/character.yaml` via `src/character.ts`:

- `initCharacter(statePath)` — loads & validates YAML at startup
- `getCharacter()` — singleton getter used by all modules
- Schema validated with Zod; sensible defaults for optional fields

No source file should contain hardcoded character names, locations, or persona text. All such content comes from `getCharacter()`.

See `docs/CREATE_CHARACTER.md` for a guide to creating your own character.

## Language Note

The default character speaks Chinese. Code comments, identity documents, and LLM prompts may be in Chinese. Commit messages and code identifiers are in English.
