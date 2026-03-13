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
};

// ── Planner Prompt ───────────────────────────────────────────────────

const PLANNER_PROMPT = `You are a context router for a chat system. Given the user's message and recent chat history, decide which context sections the AI needs to respond well. Exclude sections only when clearly irrelevant — when in doubt, include.

Available sections:
- persona: "full" | "compact" (speaking style rules — compact for simple greetings only, full for everything else)
- identity: true/false (who the AI persona is — include for most conversations, skip only for pure factual questions)
- user_profile: true/false (facts about the user — include when conversation is personal)
- memories: true/false (past conversation memories — include for most conversations to maintain continuity)
- emotion: "full" | "summary" (mood state — summary for casual chat, full for emotional depth. Always include at least summary)
- opinions: true/false (viewpoints — for debate/opinion topics)
- diary: true/false (journal entries — rarely needed)
- goals: true/false (motivations — for life direction discussions)
- narrative: true/false (life storylines — for ongoing arc discussions)
- skills: true/false (tool capabilities — include when user might want photos, voice, search, weather, or any action)
- sessions: true/false (past conversation index — only for "remember when" or referencing past chats)
- documents: true/false (saved files — only for document references)
- world: array of: "time","schedule","body","market","pet","hobbies","social","entertainment","notifications","discoveries","activities" (always include "time" and "schedule"; add others when topic matches)
- capabilities: "full" | "minimal" (tool instructions — full for most conversations, minimal only for trivial greetings)

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

  return {
    persona: raw.persona === "compact" ? "compact" : "full",
    identity: raw.identity !== false,         // default true
    user_profile: raw.user_profile === true,
    memories: raw.memories !== false,          // default true
    emotion: raw.emotion === "full" ? "full"
      : raw.emotion === false ? "summary"     // never fully disable emotion
      : "summary",
    opinions: raw.opinions === true,
    diary: raw.diary === true,
    goals: raw.goals === true,
    narrative: raw.narrative === true,
    skills: raw.skills !== false,             // default true
    sessions: raw.sessions === true,
    documents: raw.documents === true,
    world,
    capabilities: raw.capabilities === "minimal" ? "minimal" : "full", // default full
  };
}
