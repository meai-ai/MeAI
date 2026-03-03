/**
 * Progressive Skill Loading — selects only relevant skills per turn.
 *
 * Instead of injecting all skills (and all their tools) into every turn,
 * this module scores each skill against the current user message and
 * recent conversation context, then returns only the top-N most relevant
 * skills for full injection.
 *
 * The model always sees a compact one-line directory of ALL available
 * skills so it knows they exist. Only the selected skills get their
 * full SKILL.md content and tool definitions loaded.
 *
 * Design goals:
 * - Zero external dependencies (no embeddings, no LLM call)
 * - Sub-millisecond per skill — scales to 100+ skills
 * - Conversation continuity: skills used in recent turns get a boost
 * - Always-on skills (e.g. claude-code) bypass scoring entirely
 */

import type { Skill, AppConfig } from "../types.js";

// ── Configuration ────────────────────────────────────────────────────

/** Maximum number of skills to fully inject per turn (excluding always-on). */
const MAX_SKILLS_PER_TURN = 6;

/** Base skills that are always loaded regardless of relevance score. */
const BASE_ALWAYS_ON_SKILLS = ["claude-code", "datetime", "weather", "web-search", "x-browser"];

/**
 * Get the set of always-on skills, conditionally including skills
 * that depend on API keys being configured.
 */
export function getAlwaysOnSkills(config?: AppConfig): Set<string> {
  const skills = [...BASE_ALWAYS_ON_SKILLS];
  if (config?.falApiKey) skills.push("selfie");
  if (config?.fishAudioApiKey) skills.push("tts");
  return new Set(skills);
}

/** Boost multiplier for skills whose tools were called in the last N turns. */
const RECENCY_BOOST = 2.0;

/** Minimum score threshold — skills below this are never selected. */
const MIN_SCORE_THRESHOLD = 0.05;

// ── Keyword extraction ──────────────────────────────────────────────

/** Common English stop words to skip during keyword extraction. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "about",
  "after", "before", "between", "under", "above", "up", "down", "out",
  "off", "over", "or", "and", "but", "nor", "not", "no", "so", "if",
  "then", "than", "too", "very", "just", "that", "this", "these",
  "those", "it", "its", "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "they", "them", "their", "what", "which", "who", "when",
  "where", "how", "all", "each", "every", "any", "some", "such", "only",
  "also", "more", "most", "other", "use", "using", "used", "e", "g",
]);

/**
 * Extract weighted keywords from a skill's SKILL.md content.
 *
 * Keywords from the skill name and "## When to use" section get extra weight
 * since those are the strongest signal for routing.
 */
export function extractKeywords(skill: Skill): Map<string, number> {
  const keywords = new Map<string, number>();

  function addTokens(text: string, weight: number): void {
    // Tokenize: split on non-alphanumeric, filter short/stop words
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t));

    for (const token of tokens) {
      keywords.set(token, (keywords.get(token) ?? 0) + weight);
    }
  }

  // Skill name parts (highest weight — the name IS the intent)
  addTokens(skill.name.replace(/-/g, " "), 5.0);

  // "## When to use" section gets high weight
  const whenToUse = skill.content.match(/##\s*When to use\s*\n([\s\S]*?)(?=\n##|\n*$)/i);
  if (whenToUse) {
    addTokens(whenToUse[1], 3.0);
  }

  // Title / first line
  const firstLine = skill.content.split("\n").find((l) => l.trim().length > 0);
  if (firstLine) {
    addTokens(firstLine.replace(/^#+\s*/, ""), 2.0);
  }

  // Rest of content (lower weight)
  addTokens(skill.content, 0.5);

  return keywords;
}

// ── Scoring ─────────────────────────────────────────────────────────

export interface SkillScore {
  skill: Skill;
  score: number;
  reason: string; // brief explanation for debugging
}

/**
 * Score a single skill against the user's message.
 *
 * Uses keyword overlap with weights. Each matching token contributes
 * its keyword weight, normalized by the total message token count
 * to avoid favoring long messages.
 */
function scoreSkill(
  skill: Skill,
  messageTokens: string[],
  keywords: Map<string, number>,
  recentlyUsedSkills: Set<string>,
): SkillScore {
  if (messageTokens.length === 0) {
    return { skill, score: 0, reason: "empty message" };
  }

  let rawScore = 0;
  const matchedTerms: string[] = [];

  for (const token of messageTokens) {
    const weight = keywords.get(token);
    if (weight !== undefined) {
      rawScore += weight;
      if (!matchedTerms.includes(token)) {
        matchedTerms.push(token);
      }
    }
  }

  // Normalize by message length to keep scores comparable across message sizes
  let score = rawScore / messageTokens.length;

  // Boost if skill was used in recent turns
  if (recentlyUsedSkills.has(skill.name)) {
    score *= RECENCY_BOOST;
  }

  const reason = matchedTerms.length > 0
    ? `matched: ${matchedTerms.slice(0, 5).join(", ")}`
    : "no match";

  return { skill, score, reason };
}

/**
 * Tokenize a user message for scoring.
 */
function tokenizeMessage(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ── Public API ──────────────────────────────────────────────────────

export interface SkillSelection {
  /** Skills selected for full injection (SKILL.md + tools). */
  selected: Skill[];
  /** All skills with their scores (for debugging / /skills command). */
  scores: SkillScore[];
  /** Compact directory of ALL skills (name → one-liner). */
  directory: Map<string, string>;
}

/**
 * Select the most relevant skills for the current turn.
 *
 * @param allSkills         All available skills (from loadSkills)
 * @param userMessage       Current user message text
 * @param recentlyUsedSkills  Set of skill names used in the last few turns
 * @param maxSkills         Max skills to select (default: MAX_SKILLS_PER_TURN)
 * @param config            App config — used to determine conditional always-on skills
 */
export function selectSkills(
  allSkills: Skill[],
  userMessage: string,
  recentlyUsedSkills: Set<string> = new Set(),
  maxSkills: number = MAX_SKILLS_PER_TURN,
  config?: AppConfig,
): SkillSelection {
  const alwaysOnSkills = getAlwaysOnSkills(config);

  // Build compact directory (always included for the model's awareness)
  const directory = new Map<string, string>();
  for (const skill of allSkills) {
    // Extract first meaningful line after the title
    const lines = skill.content.split("\n").filter((l) => l.trim().length > 0);
    const oneLiner = lines.length > 1
      ? lines[1].replace(/^#+\s*/, "").trim()
      : lines[0]?.replace(/^#+\s*/, "").trim() ?? skill.name;
    directory.set(skill.name, oneLiner.slice(0, 80));
  }

  // If there are few enough skills, just load them all (no filtering needed)
  if (allSkills.length <= maxSkills + alwaysOnSkills.size) {
    return {
      selected: allSkills,
      scores: allSkills.map((s) => ({ skill: s, score: 1, reason: "all loaded (below threshold)" })),
      directory,
    };
  }

  // Pre-compute keyword maps for all skills
  const keywordMaps = new Map<string, Map<string, number>>();
  for (const skill of allSkills) {
    keywordMaps.set(skill.name, extractKeywords(skill));
  }

  const messageTokens = tokenizeMessage(userMessage);

  // Score each skill
  const scores: SkillScore[] = allSkills.map((skill) =>
    scoreSkill(skill, messageTokens, keywordMaps.get(skill.name)!, recentlyUsedSkills),
  );

  // Partition: always-on vs scored
  const alwaysOn: Skill[] = [];
  const candidates: SkillScore[] = [];

  for (const entry of scores) {
    if (alwaysOnSkills.has(entry.skill.name)) {
      alwaysOn.push(entry.skill);
    } else {
      candidates.push(entry);
    }
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Pick top-N above threshold
  const selected: Skill[] = [...alwaysOn];
  for (const candidate of candidates) {
    if (selected.length >= maxSkills + alwaysOn.length) break;
    if (candidate.score < MIN_SCORE_THRESHOLD) break;
    selected.push(candidate.skill);
  }

  // If nothing matched at all (e.g. greeting message), include at least
  // recently used skills so context is maintained
  if (selected.length === alwaysOn.length && recentlyUsedSkills.size > 0) {
    for (const skill of allSkills) {
      if (recentlyUsedSkills.has(skill.name) && !alwaysOnSkills.has(skill.name)) {
        selected.push(skill);
      }
    }
  }

  return { selected, scores, directory };
}

/**
 * Extract skill names from recent tool calls in transcript entries.
 *
 * Maps tool names back to their owning skill by checking which skill
 * directories contain a tools.ts file. Falls back to prefix matching
 * (e.g. tool "weather_forecast" → skill "weather").
 */
export function extractRecentlyUsedSkills(
  recentToolCalls: Array<{ name: string }>,
  allSkillNames: string[],
): Set<string> {
  const used = new Set<string>();

  for (const call of recentToolCalls) {
    const toolName = call.name.toLowerCase();

    // Direct match: tool name equals skill name
    if (allSkillNames.includes(toolName)) {
      used.add(toolName);
      continue;
    }

    // Prefix match: tool "weather_forecast" → skill "weather"
    for (const skillName of allSkillNames) {
      if (toolName.startsWith(skillName.replace(/-/g, "_"))) {
        used.add(skillName);
        break;
      }
      // Also check underscore-to-hyphen: "stock_lookup" → "stock-tracker"
      const toolPrefix = toolName.split("_")[0];
      if (skillName.startsWith(toolPrefix) && toolPrefix.length >= 3) {
        used.add(skillName);
        break;
      }
    }
  }

  return used;
}
