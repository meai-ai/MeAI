/**
 * Context assembler — builds the system prompt from memory, skills, and identity files.
 *
 * Reads IDENTITY.md, USER.md, memory store, and skill files to construct
 * a rich system prompt that tells the agent who it is, what it knows,
 * and what capabilities it has.
 */

import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Memory, Skill } from "../types.js";
import { getSearchEngine } from "../evolution/memory.js";
import { getMem0 } from "../memory/mem0-engine.js";
import { getStoreManager } from "../memory/store-manager.js";
import type { SkillSelection } from "./skill-router.js";
import { SessionIndexManager } from "../session/index.js";
import { createLogger } from "../lib/logger.js";
import { estimateTokens, truncateToTokenBudget } from "../lib/token-counter.js";
import { formatOpinionContext } from "../opinions.js";
import { formatDiaryContext } from "../journal.js";
import { formatGoalContext } from "../goals.js";
import { formatNarrativeContext } from "../narrative.js";
import { formatDocumentContext, getDocumentsDir } from "../documents.js";
import type { ContextPlan } from "./context-planner.js";
import { getRecentMoments } from "../moments.js";
import { getCharacter, s, renderTemplate, isBlankSlate, BLANK_SLATE_PERSONA } from "../character.js";
import { moduleRegistry } from "../modules/registry.js";

const log = createLogger("context");

// Token budget allocation (% of maxContextTokens, default 180K)
const SYSTEM_PROMPT_BUDGET_RATIO = 0.40; // 40% of context window for system prompt
const MEMORY_BUDGET_RATIO = 0.15;        // 15% of system prompt budget for memories
const WORLD_BUDGET_RATIO = 0.25;         // 25% for world/body/emotion context
const SKILLS_BUDGET_RATIO = 0.20;        // 20% for skills

/**
 * Rank memories by recency (exponential decay over 30 days) weighted by confidence.
 */
function rankByRecency(memories: Memory[], limit: number): Memory[] {
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  return memories
    .map((m) => ({
      ...m,
      score: m.confidence * Math.exp(-(now - m.timestamp) / THIRTY_DAYS_MS),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Get the latest insight per topic prefix (e.g., insights.daily → most recent one).
 */
function latestPerTopic(memories: Memory[], maxTopics: number): Memory[] {
  const byTopic = new Map<string, Memory>();
  for (const m of memories) {
    // Topic = second segment: insights.daily.* → "daily", insights.pattern.* → "pattern"
    const parts = m.key.split(".");
    const topic = parts.length >= 2 ? parts[1] : m.key;
    const existing = byTopic.get(topic);
    if (!existing || m.timestamp > existing.timestamp) {
      byTopic.set(topic, m);
    }
  }
  return [...byTopic.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxTopics);
}

/**
 * Category-aware memory assembly for system prompt.
 *
 * - Core: always loaded in full (user facts, family, healthcare)
 * - Emotional: top 8 by search relevance + recency
 * - Knowledge: 0-3 entries, only when conversationally relevant
 * - Insights: latest per topic (max 3)
 * - System: never included
 */
async function assembleMemoryContext(
  config: AppConfig,
  conversationContext?: string,
): Promise<string> {
  const manager = getStoreManager();
  const sections: string[] = [];

  // 1. Core — always loaded in full
  const coreMemories = manager.loadCategory("core");
  if (coreMemories.length > 0) {
    const lines = coreMemories.map((m) => `- ${m.key}: ${m.value}`);
    sections.push(`### ${renderTemplate(s().headers.user_key_info)}\n${lines.join("\n")}`);
  }

  // 2. Emotional — top 8 by relevance+recency (always search, even on short messages)
  const emotionalMemories = manager.loadCategory("emotional");
  if (emotionalMemories.length > 0) {
    let topEmotional: Memory[];
    if (conversationContext) {
      // Search-based ranking
      const seen = new Set<string>();
      const merged: Memory[] = [];

      // Semantic search
      const mem0 = getMem0();
      if (mem0?.isReady) {
        try {
          const semanticResults = await mem0.search(conversationContext, 10);
          const emotionalKeys = new Set(emotionalMemories.map((m) => m.key));
          const emotionalMap = new Map(emotionalMemories.map((m) => [m.key, m]));
          for (const sr of semanticResults) {
            const metaKey = sr.metadata?.key as string | undefined;
            if (metaKey && emotionalKeys.has(metaKey) && !seen.has(metaKey)) {
              seen.add(metaKey);
              merged.push(emotionalMap.get(metaKey)!);
            }
          }
        } catch (err) {
          log.warn("semantic search failed for emotional memories", err);
        }
      }

      // BM25 supplement (search broadly since results span all categories)
      const engine = getSearchEngine(config);
      const bm25Results = engine.search(conversationContext, { limit: 30 });
      const emotionalKeySet = new Set(emotionalMemories.map((m) => m.key));
      for (const r of bm25Results) {
        if (emotionalKeySet.has(r.memory.key) && !seen.has(r.memory.key)) {
          seen.add(r.memory.key);
          merged.push(r.memory);
        }
      }

      // Fill remaining slots with recency-ranked
      const recencyFill = rankByRecency(
        emotionalMemories.filter((m) => !seen.has(m.key)),
        8 - merged.length,
      );
      merged.push(...recencyFill);

      topEmotional = merged.slice(0, 8);
    } else {
      topEmotional = rankByRecency(emotionalMemories, 8);
    }

    if (topEmotional.length > 0) {
      const lines = topEmotional.map((m) => `- ${m.key}: ${m.value}`);
      sections.push(`### ${s().headers.emotional_memories}\n${lines.join("\n")}`);
    }
  }

  // 3. Knowledge — 0-3 entries, only when conversationally relevant
  if (conversationContext && conversationContext.length >= 5) {
    const knowledgeMemories = [...manager.loadCategory("knowledge"), ...manager.loadCategory("character")];
    if (knowledgeMemories.length > 0) {
      const seen = new Set<string>();
      const relevant: Memory[] = [];

      // Semantic search
      const mem0 = getMem0();
      if (mem0?.isReady) {
        try {
          const semanticResults = await mem0.search(conversationContext, 5);
          const knowledgeKeys = new Set(knowledgeMemories.map((m) => m.key));
          const knowledgeMap = new Map(knowledgeMemories.map((m) => [m.key, m]));
          for (const sr of semanticResults) {
            const metaKey = sr.metadata?.key as string | undefined;
            if (metaKey && knowledgeKeys.has(metaKey) && !seen.has(metaKey)) {
              seen.add(metaKey);
              relevant.push(knowledgeMap.get(metaKey)!);
            }
          }
        } catch (err) {
          log.warn("semantic search failed for knowledge memories", err);
        }
      }

      // BM25 (search broadly since results span all categories)
      const engine = getSearchEngine(config);
      const bm25Results = engine.search(conversationContext, { limit: 20 });
      const knowledgeKeySet = new Set(knowledgeMemories.map((m) => m.key));
      for (const r of bm25Results) {
        if (knowledgeKeySet.has(r.memory.key) && !seen.has(r.memory.key)) {
          seen.add(r.memory.key);
          relevant.push(r.memory);
        }
      }

      const topKnowledge = relevant.slice(0, 3);
      if (topKnowledge.length > 0) {
        const lines = topKnowledge.map((m) => `- ${m.key}: ${m.value}`);
        sections.push(`### ${s().headers.relevant_knowledge}\n${lines.join("\n")}`);
      }
    }
  }

  // 4. Insights — latest per topic (max 3)
  const insightsMemories = manager.loadCategory("insights");
  if (insightsMemories.length > 0) {
    const topInsights = latestPerTopic(insightsMemories, 3);
    if (topInsights.length > 0) {
      const lines = topInsights.map((m) => `- ${m.key}: ${m.value}`);
      sections.push(`### ${s().headers.recent_insights}\n${lines.join("\n")}`);
    }
  }

  // 5. System — never included in conversation context

  if (sections.length === 0) {
    return `## ${s().headers.my_memories}\n${s().headers.no_memories}`;
  }

  return `## ${s().headers.my_memories}\n${sections.join("\n\n")}`;
}

/**
 * Load the identity file.
 */
function loadIdentity(statePath: string): string {
  const filePath = path.join(statePath, "memory", "IDENTITY.md");
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8").trim();
}

/**
 * Load the user profile file.
 */
function loadUserProfile(statePath: string): string {
  const filePath = path.join(statePath, "memory", "USER.md");
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8").trim();
}


/**
 * Keyword routing map: maps keywords in user messages to skill names.
 * Skills not matched are excluded from the system prompt and tool loading,
 * saving 30-50% of tool definition tokens per turn.
 * "claude-code" is always included since it's the primary delegation target.
 */
const SKILL_KEYWORDS: Record<string, string[]> = {
  "weather":        ["weather", "forecast", "temperature", "rain", "snow", "wind", "humid", "sunny", "cloudy", "aqi", "air quality"],
  "calculator":     ["calculate", "math", "compute", "add", "subtract", "multiply", "divide", "equation", "formula"],
  "apple-calendar": ["calendar", "schedule", "event", "appointment", "meeting", "agenda"],
  "contacts":       ["contact", "phone number", "email address", "address book"],
  "datetime":       ["time", "date", "timezone", "clock", "day", "month", "year", "today", "tomorrow", "yesterday"],
  "email-summary":  ["email", "inbox", "mail"],
  "expense-tracker":["expense", "spending", "cost", "budget", "money", "payment", "receipt", "financial"],
  "file-reader":    ["file", "read file", "open file", "document"],
  "local-events":   ["local event", "nearby", "happening", "concert", "festival", "show"],
  "news-digest":    ["news", "headline", "article", "current events", "breaking"],
  "notes":          ["note", "write down", "jot", "notebook"],
  "phone-call":     ["call", "phone", "ring", "dial"],
  "reminders":      ["remind", "reminder", "alarm", "alert", "don't forget"],
  "stock-tracker":  ["stock", "share price", "market", "ticker", "portfolio", "invest", "trading"],
  "todo-list":      ["todo", "to-do", "task", "checklist", "to do list"],
  "translator":     ["translate", "translation", "翻译"],
  "web-search":     ["search", "google", "look up", "find out", "browse"],
};

/**
 * Match user message text against skill keywords.
 * Returns the set of skill names that should be loaded this turn.
 * Always includes "claude-code" (delegation target).
 */
export function matchSkills(userMessage: string): Set<string> {
  const lower = userMessage.toLowerCase();
  const matched = new Set<string>(["claude-code"]);

  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(skill);
        break;
      }
    }
  }

  return matched;
}

/**
 * Scan all skill directories and load their SKILL.md files.
 */
export function loadSkills(statePath: string): Skill[] {
  const skillsDir = path.join(statePath, "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, "utf-8").trim();
    const toolsPath = path.join(skillsDir, entry.name, "tools.ts");
    const hasTools = fs.existsSync(toolsPath);

    skills.push({
      name: entry.name,
      content,
      hasTools,
    });
  }

  return skills;
}

// ── Compact Persona ──────────────────────────────────────────────────

/** Minimal persona rules (~150 tokens) for simple exchanges — loaded from character.yaml */
function getPersonaCompact(): string {
  return getCharacter().persona.compact ?? "";
}

// ── Compact Emotion ──────────────────────────────────────────────────

/** One-line emotion summary format, used when plan.emotion === "summary". */
export function formatEmotionSummary(emotionContext: string): string {
  // Extract valence and energy from the full emotion context using regex
  const valenceMatch = emotionContext.match(/情绪值[：:]\s*(\d+)/) ?? emotionContext.match(/valence[:\s]*(\d+)/i);
  const energyMatch = emotionContext.match(/精力[：:]\s*(\d+)/) ?? emotionContext.match(/energy[:\s]*(\d+)/i);
  const valence = valenceMatch ? valenceMatch[1] : "?";
  const energy = energyMatch ? energyMatch[1] : "?";
  return `${s().headers.inner_state}: valence ${valence}/10, energy ${energy}/10`;
}

// ── Compact Capabilities ─────────────────────────────────────────────

function getCapabilitiesMinimal(): string {
  return getCharacter().persona.capabilities_minimal ?? "";
}

/**
 * Assemble the full system prompt.
 *
 * When conversationContext is provided, uses mem0 semantic search (with BM25 fallback)
 * to inject memories relevant to the current conversation (not just top-by-recency).
 *
 * When a SkillSelection is provided (progressive loading), only selected
 * skills get their full SKILL.md injected. A compact one-line directory
 * of ALL available skills is always included so the model knows what
 * exists. When no selection is provided, falls back to the legacy
 * truncated-preview behavior for all skills.
 *
 * When a ContextPlan is provided (two-pass context selection), only
 * the sections selected by the planner are included, saving tokens.
 */
export async function assembleSystemPrompt(
  config: AppConfig,
  conversationContext?: string,
  skillSelection?: SkillSelection,
  worldContext?: string,
  emotionContext?: string,
  plan?: ContextPlan,
): Promise<string> {
  const maxContextTokens = config.maxContextTokens ?? 180_000;
  const totalBudget = Math.floor(maxContextTokens * SYSTEM_PROMPT_BUDGET_RATIO);
  const memoryBudget = Math.floor(totalBudget * MEMORY_BUDGET_RATIO);
  const worldBudget = Math.floor(totalBudget * WORLD_BUDGET_RATIO);
  const skillsBudget = Math.floor(totalBudget * SKILLS_BUDGET_RATIO);

  const identity = loadIdentity(config.statePath);
  const userProfile = loadUserProfile(config.statePath);
  const blankSlate = isBlankSlate(config.statePath);

  const sections: string[] = [];

  // Blank-slate mode — character not yet created, guide user through setup
  if (blankSlate) {
    sections.push(BLANK_SLATE_PERSONA);
  }
  // Header — persona rules (full or compact based on plan)
  else if (plan?.persona === "compact") {
    sections.push(getPersonaCompact());
  } else {
  sections.push(getCharacter().persona.full ?? "");
  } // end full persona else block

  // Identity — persona definition (skip when plan says false)
  if ((!plan || plan.identity) && identity) {
    sections.push(`## ${s().headers.about_self}\n${identity}`);
  }

  // User profile — who the user is (skip when plan says false)
  if ((!plan || plan.user_profile) && userProfile) {
    sections.push(`## ${renderTemplate(s().headers.about_user)}\n${userProfile}`);
  }

  // Memories — category-aware loading (budget-limited, skip when plan says false)
  if (!plan || plan.memories) {
    const memorySection = await assembleMemoryContext(config, conversationContext);
    const { text: budgetedMemory, truncated: memTruncated } = truncateToTokenBudget(memorySection, memoryBudget);
    if (memTruncated) log.info(`memories truncated to ${memoryBudget} token budget`);
    sections.push(budgetedMemory);
  }

  // Emotion — controlled by plan (full / summary / false); skip in blank-slate mode
  if (!blankSlate && emotionContext && plan?.emotion !== false) {
    if (plan?.emotion === "summary") {
      sections.push(`## ${s().headers.inner_state}\n${formatEmotionSummary(emotionContext)}`);
    } else {
      // Full emotion context with behavioral hints
      const emotionBehavior = getCharacter().persona.emotion_behavior;
      if (emotionBehavior) {
        sections.push(`## ${s().headers.inner_state}\n${emotionContext}\n\n${renderTemplate(emotionBehavior)}`);
      } else {
        sections.push(`## ${s().headers.inner_state}\n${emotionContext}`);
      }
    }
  }

  // Recent Moments — skip in blank-slate mode
  if (!blankSlate) try {
    const moments = getRecentMoments(6);
    if (moments.length > 0) {
      const lines = moments.map((m) => {
        const ago = Math.round((Date.now() - m.timestamp) / 60_000);
        const timeLabel = ago < 60 ? s().time.minutes_ago.replace("{n}", String(ago)) : s().time.hours_ago.replace("{n}", String(Math.round(ago / 60)));
        return `- ${timeLabel}: ${m.text}`;
      });
      sections.push(
        `## ${s().headers.recent_moments}\n${lines.join("\n")}\n\n` +
        renderTemplate(s().headers.moments_ownership),
      );
    }
  } catch { /* non-fatal */ }

  // 8.4: Opinions — evolving viewpoints for natural disagreement; skip in blank-slate mode
  if (!blankSlate && (!plan || plan.opinions)) {
    try {
      const opinionCtx = formatOpinionContext();
      if (opinionCtx) {
        sections.push(`## ${s().headers.my_opinions}\n${opinionCtx}\n${renderTemplate(s().headers.opinions_hint)}`);
      }
    } catch { /* non-fatal */ }
  }

  // 8.3: Diary — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.diary)) {
    try {
      const diaryCtx = formatDiaryContext();
      if (diaryCtx) {
        sections.push(`## ${diaryCtx}`);
      }
    } catch { /* non-fatal */ }
  }

  // 8.2: Goals — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.goals)) {
    try {
      const goalCtx = formatGoalContext();
      if (goalCtx) {
        sections.push(`## ${s().headers.my_goals}\n${goalCtx}`);
      }
    } catch { /* non-fatal */ }
  }

  // 10.1: Narrative arcs — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.narrative)) {
    try {
      const narrativeCtx = formatNarrativeContext();
      if (narrativeCtx) {
        sections.push(`## ${narrativeCtx}`);
      }
    } catch { /* non-fatal */ }
  }

  // Skills — progressive loading or legacy fallback (budget-limited, skip when plan says false)
  if (!plan || plan.skills) {
    if (skillSelection) {
      const { selected } = skillSelection;

      if (selected.length > 0) {
        const fullSections = selected.map((s) => `### Skill: ${s.name}\n${s.content}`);
        const skillsText = fullSections.join("\n\n");
        const { text: budgetedSkills, truncated } = truncateToTokenBudget(skillsText, skillsBudget);
        if (truncated) log.info(`skills truncated to ${skillsBudget} token budget`);
        sections.push(`## Active skills\n${budgetedSkills}`);
      }
    } else {
      const skills = loadSkills(config.statePath);
      if (skills.length > 0) {
        const skillSections = skills.map((s) => {
          const preview = s.content.length > 150 ? s.content.slice(0, 150) + "…" : s.content;
          return `### Skill: ${s.name}\n${preview}`;
        });
        const skillsText = skillSections.join("\n\n");
        const { text: budgetedSkills, truncated } = truncateToTokenBudget(skillsText, skillsBudget);
        if (truncated) log.info(`legacy skills truncated to ${skillsBudget} token budget`);
        sections.push(`## Your skills\n${budgetedSkills}`);
      }
    }
  }

  // Past sessions index — gives the agent awareness of conversation history
  if (!plan || plan.sessions) {
    const sessionIndex = new SessionIndexManager(config);
    const sessionSummary = sessionIndex.getIndexSummary(10);
    if (sessionSummary) {
      sections.push(
        `## Past conversation sessions\n` +
        `You have ${sessionIndex.listAll().length} archived conversation sessions. ` +
        `The user can browse them with /sessions or search with /recall <query>.\n\n` +
        `Recent sessions:\n${sessionSummary}`,
      );
    }
  }

  // Documents — things the character has written and saved
  if (!plan || plan.documents) {
    try {
      const docCtx = formatDocumentContext();
      if (docCtx) {
        sections.push(`## ${docCtx}\n\n` +
          renderTemplate(s().headers.documents_hint, undefined, { documents_dir: getDocumentsDir() }));
      }
    } catch { /* non-fatal */ }
  }

  // SimModule context blocks — injected from extensible modules (src/modules/*/index.ts)
  try {
    const moduleBlocks = moduleRegistry.getAllContextBlocks();
    for (const block of moduleBlocks) {
      sections.push(`### ${block.header}\n${block.body}`);
    }
  } catch { /* non-fatal */ }

  // Real-world context — grounds character in physical reality (budget-limited); skip in blank-slate mode
  if (!blankSlate && worldContext) {
    const char = getCharacter();
    const { text: budgetedWorld, truncated: worldTruncated } = truncateToTokenBudget(worldContext, worldBudget);
    if (worldTruncated) log.info(`world context truncated to ${worldBudget} token budget`);

    // Build character-specific life rhythm context
    const petLine = char.pet?.name ?? "";
    const hobbyNames = Object.keys(char.hobbies).join(", ");
    const friendNames = Object.values(char.friends).map(f => f.name).join(", ");
    const placeDescriptions = Object.values(char.location.places).join(", ");
    const lifeSim = char.persona.life_simulation ?? "";

    const lifeRules = char.persona.life_rules;
    sections.push(`## ${s().headers.real_state}\n${budgetedWorld}` +
      (lifeSim ? `\n\n${lifeSim}` : "") +
      (lifeRules ? `\n\n${renderTemplate(lifeRules, undefined, { hobbyNames, friendNames, placeDescriptions, petLine })}` : ""));
  }

  // Capabilities — full or minimal based on plan; simplified in blank-slate mode
  if (blankSlate) {
    sections.push(`## Available tools
- update_character: Save character details as the user describes them (shows a preview first)
- confirm_character_update: Commit a previewed character change
- memory_set / memory_get / memory_search / memory_list: Remember important things about the user
- get_current_time: Check the current time

Use update_character to save each detail the user shares about who you should be.
Use memory_set to remember things about the user themselves.`);
  } else if (plan?.capabilities === "minimal") {
    sections.push(getCapabilitiesMinimal());
  } else {
    const char = getCharacter();
    const userName = char.user.name;
    const petName = char.pet?.name;
    const petSelfieHint = petName ? `, ${petName}` : "";
    const vibeCoding = char.hobbies.vibe_coding as Record<string, unknown> | undefined;
    const vibeProjects = (vibeCoding?.recent_completions as string[] | undefined) ?? [];
    const vibeExamples = vibeProjects.length > 0 ? vibeProjects.join(", ") : "";

    const capabilitiesPrompt = char.persona.capabilities;
    if (capabilitiesPrompt) {
      sections.push(renderTemplate(capabilitiesPrompt, undefined, {
        petSelfieHint, vibeExamples,
      }));
    }
  }

  // Auto-generated rules from conversation analysis; skip in blank-slate mode
  const autoRulesPath = path.join(config.statePath, "auto-rules.md");
  if (!blankSlate && fs.existsSync(autoRulesPath)) {
    const autoRules = fs.readFileSync(autoRulesPath, "utf-8").trim();
    if (autoRules) {
      sections.push(`## ${s().headers.auto_rules}\n${autoRules}`);
    }
  }

  const finalPrompt = sections.join("\n\n");
  const finalTokens = estimateTokens(finalPrompt);
  log.info(`system prompt assembled: ~${finalTokens} tokens (budget: ${totalBudget})`);
  if (finalTokens > totalBudget) {
    log.warn(`system prompt exceeds budget: ${finalTokens} > ${totalBudget}`);
  }
  return finalPrompt;
}
