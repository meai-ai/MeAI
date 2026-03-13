/**
 * Context Planner — Two-pass LLM context selection.
 *
 * Uses a fast, cheap LLM call (gpt-4o-mini) to decide which context sections
 * the main conversation needs, then returns a ContextPlan that controls
 * which sections get included in the system prompt.
 *
 * Saves ~60-90% of system prompt tokens on simple messages while preserving
 * full context for deep conversations.
 */

import { claudeText } from "../claude-runner.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("context-planner");

// ── Types ────────────────────────────────────────────────────────────

export interface ContextPlan {
  persona: "full" | "compact";
  identity: boolean;
  user_profile: boolean;
  memories: boolean;
  emotion: "full" | "summary" | false;
  opinions: boolean;
  diary: boolean;
  goals: boolean;
  narrative: boolean;
  skills: boolean;
  sessions: boolean;
  documents: boolean;
  world: string[]; // IDs of world blocks to include
  capabilities: "full" | "minimal";
  // Phase 1 additions: gate control for sections that bypass planner
  intents: boolean;           // default true
  episodes: boolean;          // default true
  relationship: boolean;      // default true
  user_state: boolean;        // default true
  moments: boolean;           // default false
  brainstem: boolean;         // default false
  emerging_values: boolean;   // default false
  self_narrative: boolean;    // default false
  personal_stance: boolean;   // default false
  reciprocity: boolean;       // default false
  identityRefs: string[];     // identity sections to expand
}

/** Full context — equivalent to current behavior (used as fallback). */
export const FULL_PLAN: ContextPlan = {
  persona: "full",
  identity: true,
  user_profile: true,
  memories: true,
  emotion: "full",
  opinions: true,
  diary: true,
  goals: true,
  narrative: true,
  skills: true,
  sessions: true,
  documents: true,
  world: ["time", "schedule", "body", "market", "pet", "hobbies", "social", "entertainment", "notifications", "discoveries", "activities"],
  capabilities: "full",
  // Phase 1 gate defaults
  intents: true,
  episodes: true,
  relationship: true,
  user_state: true,
  moments: false,
  brainstem: false,
  emerging_values: false,
  self_narrative: false,
  personal_stance: false,
  reciprocity: false,
  identityRefs: [],
};

// ── Planner Prompt ───────────────────────────────────────────────────

const PLANNER_PROMPT = `You are a context router for a chat system. Given the user's message and recent chat history, decide which context sections the AI needs to respond well. Exclude sections only when clearly irrelevant — when in doubt, include.

Available sections:
- persona: "full" | "compact" (compact for simple greetings only)
- identity: true/false (skip only for pure factual questions)
- user_profile: true/false (include when conversation is personal)
- memories: true/false (include for most conversations)
- emotion: "full" | "summary" (summary for casual, full for emotional depth)
- opinions: true/false (for debate/opinion topics)
- diary: true/false (rarely needed)
- goals: true/false (life direction discussions)
- narrative: true/false (ongoing arc discussions)
- skills: true/false (when user needs photos, voice, search, weather, or actions)
- sessions: true/false (only for "remember when" or referencing past chats)
- documents: true/false (only for document references)
- world: array of: "time","schedule","body","market","pet","hobbies","social","entertainment","notifications","discoveries","activities"
- capabilities: "full" | "minimal" (minimal for trivial greetings)
- intents: true/false (default true -- pending tasks/promises, skip for pure greetings)
- episodes: true/false (default true -- past conversation scenes)
- relationship: true/false (default true -- attachment dynamics with user)
- user_state: true/false (default true -- user's current mental state)
- moments: true/false (default false -- social posts, include when discussing social sharing)
- brainstem: true/false (default false -- subconscious thoughts, for deep reflection)
- emerging_values: true/false (default false -- evolving values, for philosophical discussion)
- self_narrative: true/false (default false -- self-understanding, for identity/growth topics)
- personal_stance: true/false (default false -- personal positions, for debate)
- reciprocity: true/false (default false -- relationship balance, for relationship discussions)
- identityRefs: string[] (default [] -- identity sections to expand when topic matches)

Respond with JSON only, no explanation.`;

// ── Core Function ────────────────────────────────────────────────────

/**
 * Call Claude CLI (haiku) to decide which context sections are needed.
 * Falls back to FULL_PLAN on any error.
 */
export async function planContext(
  userMessage: string,
  recentMessages: string[],
): Promise<ContextPlan> {
  const recentContext = recentMessages.length > 0
    ? `\nRecent messages:\n${recentMessages.slice(-3).map((m, i) => `${i + 1}. ${m}`).join("\n")}`
    : "";

  const userPrompt = `User message: "${userMessage}"${recentContext}`;

  try {
    const content = await claudeText({
      label: "context-planner.plan",
      system: PLANNER_PROMPT,
      prompt: userPrompt,
      model: "fast",
      timeoutMs: 15_000,
    });

    if (!content) {
      log.warn("empty planner response — using full plan");
      return FULL_PLAN;
    }

    // Extract JSON from response (claude CLI may include extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn("no JSON in planner response — using full plan");
      return FULL_PLAN;
    }

    const raw = JSON.parse(jsonMatch[0]);
    const plan = normalizePlan(raw);

    log.info(`plan: ${JSON.stringify(plan)}`);
    return plan;
  } catch (err) {
    log.warn("planner call failed — using full plan", err);
    return FULL_PLAN;
  }
}

// ── Normalization ────────────────────────────────────────────────────

/** Normalize raw LLM output into a valid ContextPlan with safe defaults. */
function normalizePlan(raw: any): ContextPlan {
  const VALID_WORLD_IDS = new Set([
    "time", "schedule", "body", "market", "pet",
    "hobbies", "social", "entertainment", "notifications", "discoveries", "activities",
  ]);

  // Default to inclusive — only exclude when LLM explicitly says false
  const world = Array.isArray(raw.world)
    ? raw.world.filter((id: string) => VALID_WORLD_IDS.has(id))
    : ["time", "schedule"];
  // Ensure time and schedule are always present
  if (!world.includes("time")) world.unshift("time");
  if (!world.includes("schedule")) world.push("schedule");

  // Normalize identityRefs
  const VALID_IDENTITY_REFS = new Set([
    "appearance", "living", "daily", "vibe-coding", "friends",
    "food", "sensory", "philosophy", "private", "family",
  ]);
  const identityRefs = Array.isArray(raw.identityRefs)
    ? raw.identityRefs.filter((r: string) => VALID_IDENTITY_REFS.has(r))
    : [];

  return {
    persona: raw.persona === "compact" ? "compact" : "full",
    identity: raw.identity !== false,         // default true
    user_profile: raw.user_profile === true,
    memories: raw.memories !== false,          // default true
    emotion: raw.emotion === "summary" ? "summary"
      : raw.emotion === false ? "summary"     // never fully disable emotion
      : "full",                               // default to full -- emotion was under-injected
    opinions: raw.opinions === true,
    diary: raw.diary === true,
    goals: raw.goals === true,
    narrative: raw.narrative === true,
    skills: raw.skills !== false,             // default true
    sessions: raw.sessions === true,
    documents: raw.documents === true,
    world,
    capabilities: raw.capabilities === "minimal" ? "minimal" : "full", // default full
    // Phase 1 gate -- default true (planner can turn off)
    intents: raw.intents !== false,           // default true
    episodes: raw.episodes !== false,         // default true
    relationship: raw.relationship !== false,  // default true
    user_state: raw.user_state !== false,     // default true
    // Phase 1 gate -- default false (planner must turn on)
    moments: raw.moments === true,
    brainstem: raw.brainstem === true,
    emerging_values: raw.emerging_values === true,
    self_narrative: raw.self_narrative === true,
    personal_stance: raw.personal_stance === true,
    reciprocity: raw.reciprocity === true,
    identityRefs,
  };
}
