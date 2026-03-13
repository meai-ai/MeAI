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
import { tokenize } from "../memory/search.js";
import { getMem0 } from "../memory/mem0-engine.js";
import { getStoreManager } from "../memory/store-manager.js";
import type { MemoryCategory } from "../memory/store-manager.js";
import { shouldReconsolidate } from "../memory/reconsolidation.js";
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
import type { TurnDirective } from "./turn-directive.js";
import type { RetrievalPolicy } from "./cognitive-controller.js";
import { getRecentMoments } from "../moments.js";
import { getCharacter, s, renderTemplate, isBlankSlate, BLANK_SLATE_PERSONA } from "../character.js";
import { moduleRegistry } from "../modules/registry.js";
import { formatAttentionContext } from "../lib/attention.js";
import { formatRelationshipContext } from "../lib/relationship-model.js";

const log = createLogger("context");

// Token budget allocation (% of maxContextTokens, default 180K)
// MEMORY and WORLD ratios are defaults that can be overridden via config.json
// (memoryBudgetRatio, worldBudgetRatio).
const SYSTEM_PROMPT_BUDGET_RATIO = 0.40; // 40% of context window for system prompt
const DEFAULT_MEMORY_BUDGET_RATIO = 0.15;  // 15% of system prompt budget for memories
const DEFAULT_WORLD_BUDGET_RATIO = 0.25;   // 25% for world/body/emotion context
const SKILLS_BUDGET_RATIO = 0.20;          // 20% for skills

/**
 * Compact a memory entry: strip namespace prefix, remove timestamps, cap at 200 chars.
 */
function compactMemoryEntry(key: string, value: string): string {
  // Strip namespace prefix (e.g., "user.age" -> "age", "emotional.mood" -> "mood")
  const shortKey = key.includes(".") ? key.split(".").slice(1).join(".") : key;
  // Remove timestamp annotations like "2026-02" or "(2026-02-28)"
  let compactValue = value
    .replace(/\s*\(\d{4}-\d{2}(?:-\d{2})?\)\s*/g, "")
    .trim();
  // Cap at 200 chars
  if (compactValue.length > 200) compactValue = compactValue.slice(0, 197) + "...";
  return `${shortKey}: ${compactValue}`;
}

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
 * Uses fused retrieval: a single semantic search + single BM25 search produce
 * rank-based scores that are combined with configurable weights (via
 * RetrievalPolicy.scoreWeights). Soft penalties per category and recency
 * boost are applied before bucket-filling.
 *
 * - Core: always loaded in full (user facts, family, healthcare)
 * - Emotional: top N by fused score (default 8)
 * - Knowledge + Character: top N by fused score (default 3)
 * - Insights: latest per topic (max 3)
 * - System: never included
 */
async function assembleMemoryContext(
  config: AppConfig,
  conversationContext?: string,
  memoryQuery?: string,
  directive?: TurnDirective | null,
  retrievalPolicy?: RetrievalPolicy,
): Promise<string> {
  const manager = getStoreManager();
  const sections: string[] = [];

  // Brainstem-guided retrieval: augment search query with focus concept
  let searchQuery = conversationContext ?? "";
  if (memoryQuery && memoryQuery.length > 2) {
    const normalized = memoryQuery.toLowerCase()
      .replace(/[-_]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!searchQuery.toLowerCase().includes(normalized)) {
      searchQuery = `${searchQuery} ${memoryQuery}`.trim();
    }
  }

  // 1. Core — always loaded in full
  const coreMemories = manager.loadCategory("core");
  if (coreMemories.length > 0) {
    const lines = coreMemories.map((m) => `- ${compactMemoryEntry(m.key, m.value)}`);
    sections.push(`### ${renderTemplate(s().headers.user_key_info)}\n${lines.join("\n")}`);
  }

  // 2 + 3. Fused retrieval: one semantic + one BM25 search for all non-core memories
  const emotionalMemories = manager.loadCategory("emotional");
  const knowledgeMemories = [...manager.loadCategory("knowledge"), ...manager.loadCategory("character")];

  if (emotionalMemories.length > 0 || knowledgeMemories.length > 0) {
    // Build lookup maps
    const allSearchable = [...emotionalMemories, ...knowledgeMemories];
    const memoryMap = new Map(allSearchable.map((m) => [m.key, m]));
    const emotionalKeySet = new Set(emotionalMemories.map((m) => m.key));

    // Fused score map: key -> { semanticRank, bm25Rank }
    const fusedScores = new Map<string, { semanticRank: number; bm25Rank: number }>();

    if (searchQuery && searchQuery.length >= 3) {
      // Single semantic search (top 15)
      const mem0 = getMem0();
      if (mem0?.isReady) {
        try {
          const semanticResults = await mem0.search(searchQuery, 15);
          let rank = 0;
          for (const sr of semanticResults) {
            const metaKey = sr.metadata?.key as string | undefined;
            if (metaKey && memoryMap.has(metaKey)) {
              fusedScores.set(metaKey, { semanticRank: rank, bm25Rank: -1 });
              rank++;
            }
          }
        } catch (err) {
          log.warn("semantic search failed for memory retrieval", err);
        }
      }

      // Single BM25 search (top 40)
      const engine = getSearchEngine(config);
      const bm25Results = engine.search(searchQuery, { limit: 40 });
      let bm25Rank = 0;
      for (const r of bm25Results) {
        if (memoryMap.has(r.memory.key)) {
          const existing = fusedScores.get(r.memory.key);
          if (existing) {
            existing.bm25Rank = bm25Rank;
          } else {
            fusedScores.set(r.memory.key, { semanticRank: -1, bm25Rank });
          }
          bm25Rank++;
        }
      }
    }

    // Compute fused score for each hit
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    type ScoredMemory = { memory: Memory; baseScore: number; category: string };
    const scored: ScoredMemory[] = [];

    const sw = retrievalPolicy?.scoreWeights ?? { semantic: 1, bm25: 1, recency: 1 };

    for (const [key, ranks] of fusedScores) {
      const memory = memoryMap.get(key)!;
      let baseScore = 0;
      // Semantic contribution: 1.0 -> 0.5 by rank (weighted)
      if (ranks.semanticRank >= 0) {
        baseScore += sw.semantic * (1.0 - (ranks.semanticRank / 15) * 0.5);
      }
      // BM25 contribution: 0.6 -> 0.3 by rank (weighted)
      if (ranks.bm25Rank >= 0) {
        baseScore += sw.bm25 * (0.6 - (ranks.bm25Rank / 40) * 0.3);
      }
      // Recency boost (weighted)
      const ageDays = (now - memory.timestamp) / THIRTY_DAYS_MS * 30;
      baseScore += sw.recency * 0.3 * Math.exp(-ageDays / 30);

      const category = emotionalKeySet.has(key) ? "emotional" : "knowledge";
      scored.push({ memory, baseScore, category });
    }

    // Apply soft penalty per category (before directive reranking)
    if (retrievalPolicy?.softPenalty) {
      for (const sm of scored) {
        const penalty = retrievalPolicy.softPenalty[sm.category] ?? 1.0;
        sm.baseScore *= penalty;
      }
    }

    // Directive-guided memory reranking
    if (directive) {
      // Layer 1: Structural boost — commitment entity linkage
      for (const sm of scored) {
        for (const c of directive.openCommitments) {
          const cTokens = tokenize(c.content);
          const mTokens = tokenize(sm.memory.key + " " + sm.memory.value);
          const cSet = new Set(cTokens);
          let matches = 0;
          for (const t of mTokens) { if (cSet.has(t)) matches++; }
          if (cTokens.length > 0 && matches / cTokens.length > 0.3) {
            sm.baseScore += 0.4;
            break;
          }
        }
      }

      // Layer 2: Token overlap boost — grounding hints / concepts / goals
      // Denominator is hintTokens.size (what fraction of hints appear in memory),
      // NOT memTokens.length, to avoid near-zero boosts for long memories
      const hintTokenArr = directive.groundingHints.flatMap(h => tokenize(h))
        .concat(directive.conceptActivations.flatMap(c => tokenize(c.topic)))
        .concat(directive.activeGoalAlignment.flatMap(g => tokenize(g.description)));
      const hintTokens = new Set(hintTokenArr);
      const hintCount = hintTokens.size;
      for (const sm of scored) {
        if (hintCount === 0) break;
        const memTokenSet = new Set(tokenize(sm.memory.value));
        let overlap = 0;
        for (const t of hintTokens) { if (memTokenSet.has(t)) overlap++; }
        sm.baseScore += 0.2 * (overlap / hintCount);
      }
    }

    // Touch access for scored memories (debounced, non-blocking)
    const accessedKeys = scored.map(sm => sm.memory.key);
    if (accessedKeys.length > 0) {
      manager.touchAccess(accessedKeys);
    }

    // Fire-and-forget reconsolidation for stale memories
    const reconCandidates = scored
      .filter(sm => shouldReconsolidate(sm.memory, sm.category as MemoryCategory))
      .slice(0, 3);
    if (reconCandidates.length > 0 && config.openaiApiKey) {
      manager.scheduleReconsolidation(
        reconCandidates.map(sm => ({ memory: sm.memory, category: sm.category as MemoryCategory })),
        searchQuery,
        config.openaiApiKey,
      ).catch(err => log.warn("reconsolidation scheduling failed", err));
    }

    // Fill emotional bucket (policy-driven size, with category bonus)
    const emoBucketSize = retrievalPolicy?.buckets?.emotional ?? 8;
    const emoBonus = retrievalPolicy ? (retrievalPolicy.categoryBonus["emotional"] ?? 0) : 0.2;
    const emotionalBucket: (ScoredMemory & { adjustedScore: number })[] = scored
      .filter(sm => sm.category === "emotional")
      .map(sm => ({ ...sm, adjustedScore: sm.baseScore + emoBonus }))
      .sort((a, b) => b.adjustedScore - a.adjustedScore)
      .slice(0, emoBucketSize);

    // Fill remaining slots with recency-ranked emotional (only if search hits are sparse)
    const emotionalHitKeys = new Set(emotionalBucket.map(sm => sm.memory.key));
    if (emotionalBucket.length < Math.min(4, emoBucketSize) && emotionalMemories.length > 0) {
      const recencyFill = rankByRecency(
        emotionalMemories.filter(m => !emotionalHitKeys.has(m.key)),
        emoBucketSize - emotionalBucket.length,
      );
      for (const m of recencyFill) {
        emotionalBucket.push({ memory: m, baseScore: 0, adjustedScore: 0, category: "emotional" });
      }
    }

    if (emotionalBucket.length > 0) {
      const lines = emotionalBucket.map((sm) => `- ${compactMemoryEntry(sm.memory.key, sm.memory.value)}`);
      sections.push(`### ${s().headers.emotional_memories}\n${lines.join("\n")}`);
    }

    // Fill knowledge bucket (policy-driven)
    const knBucketSize = retrievalPolicy?.buckets?.knowledge ?? 3;
    const knBonus = retrievalPolicy ? (retrievalPolicy.categoryBonus["knowledge"] ?? 0) : 0.2;
    const knBucket: (ScoredMemory & { adjustedScore: number })[] = scored
      .filter(sm => sm.category === "knowledge")
      .map(sm => ({ ...sm, adjustedScore: sm.baseScore + knBonus }))
      .sort((a, b) => b.adjustedScore - a.adjustedScore)
      .slice(0, knBucketSize);

    // Cross-category anchors: let high-scoring excluded items spill in
    const anchors = retrievalPolicy?.crossCategoryAnchors ?? 0;
    if (anchors > 0) {
      const selectedKeys = new Set([
        ...emotionalBucket.map(sm => sm.memory.key),
        ...knBucket.map(sm => sm.memory.key),
      ]);

      const candidates = scored
        .filter(sm => !selectedKeys.has(sm.memory.key))
        .sort((a, b) => b.baseScore - a.baseScore);

      const spilloverCategorySeen = new Set<string>();
      let spillCount = 0;
      for (const sm of candidates) {
        if (spillCount >= anchors) break;
        if (spilloverCategorySeen.has(sm.category)) continue;
        const adjusted = { ...sm, adjustedScore: sm.baseScore };
        if (sm.category === "emotional") emotionalBucket.push(adjusted);
        else knBucket.push(adjusted);
        spilloverCategorySeen.add(sm.category);
        spillCount++;
      }
    }

    // Log retrieval distribution for observability
    log.info(
      `retrieval buckets: emo=${emotionalBucket.length}/${emoBucketSize} ` +
      `kn=${knBucket.length}/${knBucketSize} ` +
      `scored=${scored.length} sw=${sw.semantic}/${sw.bm25}/${sw.recency}`,
    );

    // Render knowledge section (only when conversation context exists)
    if (conversationContext && conversationContext.length >= 5) {
      if (knBucket.length > 0) {
        const lines = knBucket.map((sm) => `- ${compactMemoryEntry(sm.memory.key, sm.memory.value)}`);
        sections.push(`### ${s().headers.relevant_knowledge}\n${lines.join("\n")}`);
      }
    }
  }

  // 4. Insights — latest per topic (policy-driven)
  const insightsBucketSize = retrievalPolicy?.buckets?.insights ?? 3;
  const insightsMemories = manager.loadCategory("insights");
  if (insightsMemories.length > 0) {
    const topInsights = latestPerTopic(insightsMemories, insightsBucketSize);
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

/** One-line emotion summary format, used when plan.emotion === "summary".
 *  Preserves behaviorHints (policyHint) so they don't get stripped. */
export function formatEmotionSummary(emotionContext: string): string {
  // Extract valence and energy from the full emotion context using regex
  const valenceMatch = emotionContext.match(/情绪值[：:]\s*(\d+)/) ?? emotionContext.match(/valence[:\s]*(\d+)/i);
  const energyMatch = emotionContext.match(/精力[：:]\s*(\d+)/) ?? emotionContext.match(/energy[:\s]*(\d+)/i);
  const valence = valenceMatch ? valenceMatch[1] : "?";
  const energy = energyMatch ? energyMatch[1] : "?";
  // Preserve behaviorHints / state effects so they aren't lost in summary mode
  const hintsMatch = emotionContext.match(/State effects:\s*(.+)/i) ?? emotionContext.match(/状态影响[：:]\s*(.+)/);
  const hints = hintsMatch ? `\n${hintsMatch[0]}` : "";
  return `${s().headers.inner_state}: valence ${valence}/10, energy ${energy}/10${hints}`;
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
  memoryQuery?: string,
  directive?: TurnDirective | null,
  retrievalPolicy?: RetrievalPolicy,
): Promise<string> {
  const maxContextTokens = config.maxContextTokens ?? 180_000;
  const totalBudget = Math.floor(maxContextTokens * SYSTEM_PROMPT_BUDGET_RATIO);
  const memoryBudgetRatio = (config as unknown as Record<string, unknown>).memoryBudgetRatio as number | undefined;
  const worldBudgetRatio = (config as unknown as Record<string, unknown>).worldBudgetRatio as number | undefined;
  const memoryBudget = Math.floor(totalBudget * (memoryBudgetRatio ?? DEFAULT_MEMORY_BUDGET_RATIO));
  const worldBudget = Math.floor(totalBudget * (worldBudgetRatio ?? DEFAULT_WORLD_BUDGET_RATIO));
  const skillsBudget = Math.floor(totalBudget * SKILLS_BUDGET_RATIO);

  const identity = loadIdentity(config.statePath);
  const userProfile = loadUserProfile(config.statePath);
  const blankSlate = isBlankSlate(config.statePath);

  // ── Stable sections (always included, not subject to budget trimming) ──
  const stableSections: string[] = [];

  // Blank-slate mode — character not yet created, guide user through setup
  if (blankSlate) {
    stableSections.push(BLANK_SLATE_PERSONA);
  }
  // Header — persona rules (full or compact based on plan)
  else if (plan?.persona === "compact") {
    stableSections.push(getPersonaCompact());
  } else {
  stableSections.push(getCharacter().persona.full ?? "");
  } // end full persona else block

  // Identity — persona definition (skip when plan says false)
  if ((!plan || plan.identity) && identity) {
    stableSections.push(`## ${s().headers.about_self}\n${identity}`);
  }

  // User profile — who the user is (skip when plan says false)
  if ((!plan || plan.user_profile) && userProfile) {
    stableSections.push(`## ${renderTemplate(s().headers.about_user)}\n${userProfile}`);
  }

  // Capabilities — full or minimal based on plan; simplified in blank-slate mode
  if (blankSlate) {
    stableSections.push(`## Available tools
- update_character: Save character details as the user describes them (shows a preview first)
- confirm_character_update: Commit a previewed character change
- memory_set / memory_get / memory_search / memory_list: Remember important things about the user
- get_current_time: Check the current time

Use update_character to save each detail the user shares about who you should be.
Use memory_set to remember things about the user themselves.`);
  } else if (plan?.capabilities === "minimal") {
    stableSections.push(getCapabilitiesMinimal());
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
      stableSections.push(renderTemplate(capabilitiesPrompt, undefined, {
        petSelfieHint, vibeExamples,
      }));
    }
  }

  // Auto-generated rules from conversation analysis; skip in blank-slate mode
  const autoRulesPath = path.join(config.statePath, "auto-rules.md");
  if (!blankSlate && fs.existsSync(autoRulesPath)) {
    const autoRules = fs.readFileSync(autoRulesPath, "utf-8").trim();
    if (autoRules) {
      stableSections.push(`## ${s().headers.auto_rules}\n${autoRules}`);
    }
  }

  const stablePrompt = stableSections.join("\n\n");

  // ── Dynamic sections (priority-sorted, subject to budget enforcement) ──
  // Each section has a priority (higher = more important, kept first when over budget).
  // When the combined dynamic content exceeds the remaining token budget,
  // lowest-priority sections are dropped to fit.
  const prioritizedSections: Array<{ content: string; priority: number; label: string }> = [];

  // Memories — category-aware loading (budget-limited, skip when plan says false)
  if (!plan || plan.memories) {
    const memorySection = await assembleMemoryContext(config, conversationContext, memoryQuery, directive, retrievalPolicy);
    const { text: budgetedMemory, truncated: memTruncated } = truncateToTokenBudget(memorySection, memoryBudget);
    if (memTruncated) log.info(`memories truncated to ${memoryBudget} token budget`);
    prioritizedSections.push({ content: budgetedMemory, priority: 90, label: "memories" });
  }

  // Emotion — controlled by plan (full / summary / false); skip in blank-slate mode
  if (!blankSlate && emotionContext && plan?.emotion !== false) {
    if (plan?.emotion === "summary") {
      prioritizedSections.push({ content: `## ${s().headers.inner_state}\n${formatEmotionSummary(emotionContext)}`, priority: 85, label: "emotion" });
    } else {
      // Full emotion context with behavioral hints
      const emotionBehavior = getCharacter().persona.emotion_behavior;
      if (emotionBehavior) {
        prioritizedSections.push({ content: `## ${s().headers.inner_state}\n${emotionContext}\n\n${renderTemplate(emotionBehavior)}`, priority: 85, label: "emotion" });
      } else {
        prioritizedSections.push({ content: `## ${s().headers.inner_state}\n${emotionContext}`, priority: 85, label: "emotion" });
      }
    }
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
        prioritizedSections.push({ content: `## Active skills\n${budgetedSkills}`, priority: 80, label: "skills" });
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
        prioritizedSections.push({ content: `## Your skills\n${budgetedSkills}`, priority: 80, label: "skills" });
      }
    }
  }

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
    prioritizedSections.push({ content: `## ${s().headers.real_state}\n${budgetedWorld}` +
      (lifeSim ? `\n\n${lifeSim}` : "") +
      (lifeRules ? `\n\n${renderTemplate(lifeRules, undefined, { hobbyNames, friendNames, placeDescriptions, petLine })}` : ""),
      priority: 80, label: "world" });
  }

  // Relationship context — attachment, communication rhythm
  try {
    const relCtx = formatRelationshipContext();
    if (relCtx) prioritizedSections.push({ content: `### Relationship with ${getCharacter().user.name}\n${relCtx}`, priority: 75, label: "relationship" });
  } catch { /* non-fatal */ }

  // 8.2: Goals — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.goals)) {
    try {
      const goalCtx = formatGoalContext();
      if (goalCtx) {
        prioritizedSections.push({ content: `## ${s().headers.my_goals}\n${goalCtx}`, priority: 55, label: "goals" });
      }
    } catch { /* non-fatal */ }
  }

  // 8.4: Opinions — evolving viewpoints for natural disagreement; skip in blank-slate mode
  if (!blankSlate && (!plan || plan.opinions)) {
    try {
      const opinionCtx = formatOpinionContext();
      if (opinionCtx) {
        prioritizedSections.push({ content: `## ${s().headers.my_opinions}\n${opinionCtx}\n${renderTemplate(s().headers.opinions_hint)}`, priority: 50, label: "opinions" });
      }
    } catch { /* non-fatal */ }
  }

  // 10.1: Narrative arcs — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.narrative)) {
    try {
      const narrativeCtx = formatNarrativeContext();
      if (narrativeCtx) {
        prioritizedSections.push({ content: `## ${narrativeCtx}`, priority: 45, label: "narrative" });
      }
    } catch { /* non-fatal */ }
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
      prioritizedSections.push({ content:
        `## ${s().headers.recent_moments}\n${lines.join("\n")}\n\n` +
        renderTemplate(s().headers.moments_ownership),
        priority: 40, label: "moments" });
    }
  } catch { /* non-fatal */ }

  // 8.3: Diary — skip in blank-slate mode
  if (!blankSlate && (!plan || plan.diary)) {
    try {
      const diaryCtx = formatDiaryContext();
      if (diaryCtx) {
        prioritizedSections.push({ content: `## ${diaryCtx}`, priority: 35, label: "diary" });
      }
    } catch { /* non-fatal */ }
  }

  // SimModule context blocks — injected from extensible modules (src/modules/*/index.ts)
  try {
    const moduleBlocks = moduleRegistry.getAllContextBlocks();
    for (const block of moduleBlocks) {
      prioritizedSections.push({ content: `### ${block.header}\n${block.body}`, priority: 35, label: `module:${block.header}` });
    }
  } catch { /* non-fatal */ }

  // Documents — things the character has written and saved
  if (!plan || plan.documents) {
    try {
      const docCtx = formatDocumentContext();
      if (docCtx) {
        prioritizedSections.push({ content: `## ${docCtx}\n\n` +
          renderTemplate(s().headers.documents_hint, undefined, { documents_dir: getDocumentsDir() }),
          priority: 30, label: "documents" });
      }
    } catch { /* non-fatal */ }
  }

  // Attention state — ultradian rhythm, focus, decision fatigue
  try {
    const attentionCtx = formatAttentionContext();
    if (attentionCtx) prioritizedSections.push({ content: `### Attention state\n${attentionCtx}`, priority: 30, label: "attention" });
  } catch { /* non-fatal */ }

  // Brainstem — subconscious thoughts (low priority, background reference)
  if (!blankSlate) try {
    const { formatBrainstemContext } = await import("../brainstem/index.js");
    const brainstemCtx = formatBrainstemContext();
    if (brainstemCtx) prioritizedSections.push({ content: brainstemCtx, priority: 25, label: "brainstem" });
  } catch { /* brainstem may not be initialized */ }

  // Self-narrative — tentative self-understanding
  if (!blankSlate) try {
    const { formatSelfNarrativeContext } = await import("../self-narrative.js");
    const selfNarrCtx = formatSelfNarrativeContext();
    if (selfNarrCtx) prioritizedSections.push({ content: selfNarrCtx, priority: 25, label: "self-narrative" });
  } catch { /* non-fatal */ }

  // User state — what the user is focused on, stressors, emotional trajectory
  if (!blankSlate) try {
    const { formatUserStateContext } = await import("../user-state.js");
    const userStateCtx = formatUserStateContext();
    if (userStateCtx) prioritizedSections.push({ content: `### ${getCharacter().user.name}'s recent state\n${userStateCtx}`, priority: 25, label: "user-state" });
  } catch { /* non-fatal */ }

  // Past sessions index — gives the agent awareness of conversation history
  if (!plan || plan.sessions) {
    const sessionIndex = new SessionIndexManager(config);
    const sessionSummary = sessionIndex.getIndexSummary(10);
    if (sessionSummary) {
      prioritizedSections.push({ content:
        `## Past conversation sessions\n` +
        `You have ${sessionIndex.listAll().length} archived conversation sessions. ` +
        `The user can browse them with /sessions or search with /recall <query>.\n\n` +
        `Recent sessions:\n${sessionSummary}`,
        priority: 20, label: "sessions" });
    }
  }

  // Provenance warnings — narrative contamination alerts
  if (!blankSlate) try {
    const { formatProvenanceWarnings } = await import("../lib/provenance-audit.js");
    const warnings = formatProvenanceWarnings(config.statePath);
    if (warnings) prioritizedSections.push({ content: `### Data quality warnings\n${warnings}`, priority: 15, label: "provenance" });
  } catch { /* non-fatal */ }

  // Error metrics — lightweight system health
  if (!blankSlate) try {
    const { formatErrorMetricsContext } = await import("../lib/error-metrics.js");
    const errCtx = formatErrorMetricsContext();
    if (errCtx) prioritizedSections.push({ content: `### System health\n${errCtx}`, priority: 10, label: "error-metrics" });
  } catch { /* non-fatal */ }

  // ── Enforce dynamic section budget ──────────────────────────────────
  // Sort by priority (highest first), then drop lowest-priority sections until within budget
  const dynamicBudget = totalBudget - estimateTokens(stablePrompt);
  const sorted = prioritizedSections.sort((a, b) => b.priority - a.priority);
  const included: string[] = [];
  let dynamicTokens = 0;
  const dropped: string[] = [];

  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.content);
    if (dynamicTokens + sectionTokens <= dynamicBudget) {
      included.push(section.content);
      dynamicTokens += sectionTokens;
    } else {
      dropped.push(section.label);
    }
  }

  if (dropped.length > 0) {
    log.warn(`context budget enforced: dropped [${dropped.join(", ")}] (budget: ${dynamicBudget}, used: ${dynamicTokens})`);
  }

  const finalPrompt = stablePrompt + "\n\n" + included.join("\n\n");
  const finalTokens = estimateTokens(finalPrompt);
  const stableTokens = estimateTokens(stablePrompt);
  log.info(`system prompt assembled: ~${finalTokens} tokens (stable: ~${stableTokens}, dynamic: ~${finalTokens - stableTokens}, sections: ${included.length}/${prioritizedSections.length}, budget: ${totalBudget})`);
  if (finalTokens > totalBudget) {
    log.warn(`system prompt exceeds budget: ${finalTokens} > ${totalBudget}`);
  }
  return finalPrompt;
}
