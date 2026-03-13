/**
 * Post-turn pipeline — all background processing after a conversation turn.
 *
 * Extracted from loop.ts to keep AgentLoop focused on orchestration.
 * Each function is fire-and-forget (non-fatal), called from runPostTurnPipeline().
 */

import path from "node:path";
import { claudeText } from "../claude-runner.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { getStoreManager } from "../memory/store-manager.js";
import { getCharacter } from "../character.js";
import { addTimelineEvent, enqueueTimelineJob } from "../timeline.js";
import { createLogger } from "../lib/logger.js";
import type { TranscriptEntry, AppConfig } from "../types.js";
import type { TimeBlock } from "../world.js";
import type { ToolRegistry } from "./tools.js";

const log = createLogger("post-turn");

// ── PersonalExemplar type (inlined — will move to turn-directive.ts when ported) ──

export interface PersonalExemplar {
  id: string;
  topic: string;
  behaviorType: "disagreed" | "disclosed" | "cared" | "resurfaced";
  behaviorPattern: string;
  evidence: {
    situationSnippet: string;
    responseSnippet: string;
  };
  quality: number;
  createdAt: number;
}

// Memory namespaces relevant to user facts (for extractMemories dedup).
const USER_MEMORY_PREFIXES = ["user.", "family.", "emotional.", "interests.", "viewpoints.", "healthcare.", "skills."];

/** Safely increment error metrics — no-op if error-metrics module is unavailable. */
function safeIncrementError(module: string, type: string): void {
  try {
    // Dynamic import to avoid hard dependency on error-metrics
    import("../lib/error-metrics.js").then(({ incrementError }) => {
      incrementError(module, type);
    }).catch(() => {});
  } catch { /* module not available yet */ }
}

// ── Public orchestrator ─────────────────────────────────────────────

export interface PostTurnContext {
  userMessage: string;
  response: string;
  recentHistory: TranscriptEntry[];
  currentBlock?: TimeBlock;
  config: AppConfig;
  tools: ToolRegistry;
  /** Full session for pre-compaction flush */
  sessionLoader?: () => TranscriptEntry[];
  needsCompaction?: boolean;
}

/**
 * Run all post-turn background tasks. Each task is independent and non-fatal.
 */
export async function runPostTurnPipeline(ctx: PostTurnContext): Promise<void> {
  const { userMessage, response, recentHistory, currentBlock, tools, config } = ctx;
  const actualText = userMessage;
  const accumulated = response;

  // 1. Background memory extraction — only when user message likely contains personal facts
  if (shouldExtractMemories(actualText)) {
    extractAndSaveMemories(recentHistory, tools).catch((err) =>
      console.error("Memory extraction error:", err),
    );
  }

  // 2. Unified post-turn understanding — single LLM call for all extraction
  // (care, emotion, commitment, state, episode, timeline, intents)
  if (actualText.length > 5 && accumulated.length > 5) {
    postTurnUnderstanding(actualText, accumulated, tools, currentBlock, config.statePath).catch(() => {});
  }

  // 3. Pre-compaction flush — save important memories before transcript compaction
  if (ctx.needsCompaction && ctx.sessionLoader) {
    preCompactionFlush(ctx.sessionLoader, tools).catch((err) =>
      console.error("Pre-compaction flush error:", err),
    );
  }
}

// ── Exemplar extraction (called separately from identity event handling) ──

export async function maybeExtractExemplar(
  userMessage: string,
  assistantResponse: string,
  behaviorType: PersonalExemplar["behaviorType"],
  quality: number,
  topic: string,
  statePath: string,
): Promise<void> {
  const exemplarsPath = path.join(statePath, "exemplars.json");
  const exemplars = readJsonSafe<PersonalExemplar[]>(exemplarsPath, []);

  // Dedup: skip if same topic + behaviorType in last 24h
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (exemplars.some(e => e.topic === topic && e.behaviorType === behaviorType && e.createdAt > oneDayAgo)) return;

  const behaviorPattern = extractBehaviorPattern(assistantResponse, behaviorType);
  if (!behaviorPattern) return;

  exemplars.push({
    id: `ex_${Date.now()}`,
    topic,
    behaviorType,
    behaviorPattern,
    evidence: {
      situationSnippet: userMessage.slice(0, 80).replace(/\n/g, " "),
      responseSnippet: assistantResponse.slice(0, 100).replace(/\n/g, " "),
    },
    quality,
    createdAt: Date.now(),
  });

  while (exemplars.length > 30) exemplars.shift();
  writeJsonAtomic(exemplarsPath, exemplars);
  log.info(`exemplar extracted: ${behaviorType} on "${topic}" (quality=${quality.toFixed(2)}, pattern="${behaviorPattern}")`);

  // Feed exemplar to value formation (if module available)
  try {
    const { reinforceFromExemplar } = await import("../lib/value-formation.js");
    reinforceFromExemplar(statePath, exemplars[exemplars.length - 1]);
  } catch { /* value-formation module not available yet */ }
}

export function extractBehaviorPattern(response: string, type: PersonalExemplar["behaviorType"]): string | null {
  const firstSentences = response.slice(0, 200);
  const hasQuestion = /[?]/.test(firstSentences.slice(0, 80));
  const hasEmpathy = /feel|feeling|tough|not easy|understand|heartache/i.test(firstSentences);
  const hasCallback = /last time|before|remember you|you said/i.test(firstSentences);
  const hasOpinion = /I think|I'd say|disagree|my view/i.test(firstSentences);

  const parts: string[] = [];
  if (type === "disagreed") {
    if (hasQuestion) parts.push("confirmed what they meant first");
    if (hasOpinion) parts.push("then shared a different view");
    if (!hasOpinion) parts.push("gently offered a different angle");
  } else if (type === "cared") {
    if (hasQuestion) parts.push("asked about specific situation first");
    if (hasEmpathy) parts.push("acknowledged the emotion");
    if (hasCallback) parts.push("brought up related past details");
  } else if (type === "disclosed") {
    if (hasEmpathy) parts.push("empathized first");
    parts.push("shared genuine personal feelings");
  } else if (type === "resurfaced") {
    if (hasCallback) parts.push("naturally brought up something from before");
    if (hasQuestion) parts.push("asked about follow-up progress");
  }

  if (parts.length === 0) return null;
  return parts.join(", ");
}

// ── shouldExtractMemories ───────────────────────────────────────────

/**
 * Lightweight heuristic: should we bother running memory extraction?
 * Returns false for greetings, slash commands, very short messages,
 * and messages that look like pure task delegation (no personal facts).
 */
export function shouldExtractMemories(text: string): boolean {
  const trimmed = text.trim();

  // Slash commands are never personal facts
  if (trimmed.startsWith("/")) return false;

  // Very short messages are rarely personal facts (e.g. "hi", "ok", "thanks")
  if (trimmed.length < 15) return false;

  // Common greetings / acknowledgements (case-insensitive)
  const trivialPatterns = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|bye|good morning|good night|gm|gn|yo|sup|lol|haha|hmm|what|how|when|where|why|who)\b/i;
  if (trivialPatterns.test(trimmed) && trimmed.length < 30) return false;

  return true;
}

// ── extractAndSaveMemories ──────────────────────────────────────────

async function extractAndSaveMemories(recentHistory: TranscriptEntry[], tools: ToolRegistry): Promise<void> {
  if (recentHistory.length === 0) return;
  // Ensure last message is from user
  if (recentHistory[recentHistory.length - 1].role !== "user") return;

  const character = getCharacter();
  const charName = character.name;
  const userName = character.user.name;

  // Load existing user-related memories for dedup
  let existingMemories = "";
  try {
    const mems = getStoreManager().loadAll()
      .filter((m) => USER_MEMORY_PREFIXES.some((p) => m.key.startsWith(p)));
    existingMemories = mems.map((m) => `${m.key} = ${m.value}`).join("\n");
  } catch (err) { log.warn("failed to load memories for extraction", err); }

  // Build conversation context
  const conversationText = recentHistory
    .map((e) => `[${e.role}]: ${typeof e.content === "string" ? e.content : JSON.stringify(e.content)}`)
    .join("\n\n");

  const result = await claudeText({
    label: "post-turn.extractMemories",
    system:
      `You are a memory extractor for ${charName}, a personal AI companion.\n\n` +
      `IMPORTANT CONTEXT: ${charName} is a character with their own simulated life. ` +
      `Do NOT save facts about ${charName}'s character/life as user memories — only save facts about the REAL USER (${userName}).\n` +
      `When referring to the AI in memory values, always use '${charName}', never 'MeAI'.\n\n` +
      `Read the conversation and extract any NEW personal facts OR emotional moments the user revealed.\n\n` +
      "EXISTING MEMORIES (do NOT re-save these unless the value changed):\n" +
      (existingMemories || "(none)") + "\n\n" +
      "Rules:\n" +
      "- Use namespaced keys: user.name, user.hobbies, user.philosophy.success, family.daughter.birthday, etc.\n" +
      "- If a key already exists, MERGE new values instead of replacing (e.g. hobbies: append, don't overwrite).\n" +
      "- Capture indirect statements too: if the user answered a question with a personal belief, save it.\n" +
      "- Track interests with interests.* keys, viewpoints with viewpoints.*, emotions with emotional.* keys.\n" +
      "- Include date context in emotional.* values so we know when it happened.\n" +
      "- If there are NO new facts to save, output []\n" +
      "- Do NOT save system/config info, only personal user facts, interests, and emotional moments.\n" +
      `- Do NOT confuse the AI character's world (${charName}'s hobbies, work) with the user's real life.\n` +
      `- IMPORTANT: Always write the subject explicitly in the value. Write '${userName} did X' not just 'did X'. ${userName}'s experiences use user.*/family.*/emotional.* prefixes, ${charName}'s own use inner.*/activity.* prefixes.\n\n` +
      "Output ONLY a JSON array of memories to save:\n" +
      '[{"key": "namespace.key", "value": "the value"}]\n',
    prompt: conversationText,
    model: "smart",
    timeoutMs: 90_000,
  });

  // Match a JSON array — must start with [{ to avoid matching [user] from conversation text
  const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (jsonMatch) {
    try {
      const memories = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
      for (const m of memories) {
        if (m.key && m.value) {
          await tools.execute("memory_set", { key: m.key, value: m.value, confidence: 0.8, sourceType: "observed" });
          console.log(`[memory] auto-saved: ${m.key} = ${m.value}`);
        }
      }
    } catch (err) { log.warn("failed to parse memory extraction results", err); safeIncrementError("post-turn", "memory_extraction"); }
  }
}

// ── postTurnUnderstanding ───────────────────────────────────────────

async function postTurnUnderstanding(
  userMessage: string,
  response: string,
  tools: ToolRegistry,
  currentBlock?: TimeBlock,
  statePath?: string,
): Promise<void> {
  // Skip trivial messages
  if (/^(ok|okay|sure|thanks|haha+|hey|👍|😂|❤️|yes|yeah|yep|cool)$/i.test(userMessage.trim())) return;

  const character = getCharacter();
  const charName = character.name;
  const userName = character.user.name;

  // Build open commitments context for fulfillment detection
  const manager = getStoreManager();
  const existing = manager.loadCategory("commitment");
  const openCommitments = existing.filter(m => m.value.includes("status: open"));
  const openList = openCommitments.length > 0
    ? openCommitments.map(m => `- [${m.key}] ${m.value}`).join("\n")
    : "(none)";

  // Build timeline context for dedup
  const now = new Date();
  const pstTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const hh = String(pstTime.getHours()).padStart(2, "0");
  const mm = String(pstTime.getMinutes()).padStart(2, "0");
  const currentTime = `${hh}:${mm}`;

  let existingTimeline = "(none)";
  try {
    const { getTodayTimeline } = await import("../timeline.js");
    const timeline = getTodayTimeline();
    const recent = timeline.slice(-15);
    if (recent.length > 0) {
      existingTimeline = recent.map(e => `${e.time} [${e.category}] ${e.summary}`).join("\n");
    }
  } catch { safeIncrementError("post-turn", "timeline_read"); }

  try {
    const text = await claudeText({
      label: "post-turn.understanding",
      system: `You are the post-conversation understanding engine. Analyze a turn of conversation between ${userName} and ${charName}, and extract all signals worth recording.

Conversation:
${userName}: ${userMessage.slice(0, 600)}
${charName}: ${response.slice(0, 600)}

Open commitments:
${openList}

Current time: ${currentTime}
${currentBlock ? `Current schedule: ${currentBlock.activity} (${currentBlock.category})` : ""}

Existing timeline:
${existingTimeline}

Analyze and output JSON (each field is independently judged — most fields should be null or [] for most conversations):

{
  "careTopic": {
    "need": "Specific resource/tutorial/recommendation ${userName} needs",
    "sourceSnippet": "Quote from conversation",
    "searchQueries": ["search query 1", "search query 2"],
    "context": "Background",
    "priority": "medium"
  } or null,

  "emotionalCare": {
    "need": "Emotional need worth long-term attention",
    "sourceSnippet": "Quote from conversation",
    "whyItMatters": "Why this matters for the relationship",
    "emotionalWeight": 0.5,
    "context": "Background"
  } or null,

  "commitment": {
    "newCommitment": {
      "what": "What ${charName} promised to do (preserve key entities: names, projects, tech terms)",
      "context": "Background",
      "deadline": "1h"|"today"|"tomorrow"|"this_week"|"next_chat"|null
    } or null,
    "fulfilled": ["commitment.xxx_key"] or []
  },

  "allenState": {
    "focuses": ["Specific topics they're focused on"],
    "stressor": {"what": "Source of stress", "intensity": 0.5} or null,
    "mood": 0-10 or null,
    "unspokenNeed": "What they need but haven't said" or null
  } or null,

  "episode": {
    "who": ["${userName}", "${charName}"],
    "where": "Location" or null,
    "what": "1-2 sentence scene summary (third person)",
    "emotionalValence": -1 to 1,
    "emotionalNote": "Emotional tone",
    "topics": ["topics"],
    "significance": 0 to 1
  } or null,

  "timelineEvents": [
    {"time": "${currentTime}", "category": "category", "summary": "One-line summary", "people": ["people involved"]}
  ] or [],

  "intents": [
    {"what": "Specific thing ${charName} plans to do", "when": "time or null", "priority": "medium", "context": "One-line background"}
  ] or [],

  "responseQuality": {
    "relevance": 0 to 1,
    "depth": 0 to 1,
    "tone": "matched"|"too_formal"|"too_casual",
    "missed": "Key point that was missed" or null
  } or null
}

Extraction rules:
[careTopic] Only extract specific, searchable needs (tutorials, recommendations, resources). Do not extract medical, legal, or high-value financial advice.
[emotionalCare] Only extract when ${userName} expressed a recurring emotional state, relationship expectation, vulnerability, or important long-term issue. One-off complaints don't count.
[commitment] Only extract ${charName}'s specific commitments to ${userName} (help find, look up, recommend, tell next time, etc.). Not ${charName}'s personal plans or polite remarks. deadline: "wait/soon"→1h, "today/later"→today, "tomorrow"→tomorrow, "this week"→this_week, "next time"→next_chat, none→null. Check fulfilled list for completions.
[allenState] focuses should be specific (not vague words), stressor only when clearly expressed, mood inferred from tone (5=neutral), unspokenNeed should be very conservative (usually null).
[episode] Only extract when the conversation forms a complete "scene" with theme and emotional tone. Casual greetings and functional requests don't count. significance: most 0.3-0.5, only truly important ones above 0.7.
[timelineEvents] Extract concrete facts from conversation (current activities, plans, social interactions, emotional events, discoveries). Categories: meal, work, hobby, social, exercise, errand, discovery, plan, rest, emotion. Don't extract pure greetings/chit-chat or duplicates already in timeline.
[intents] Only extract plans/commitments clearly expressed in ${charName}'s reply ("will/plan to/intend to" etc. strong intent signals). Don't extract ${userName}'s plans, weak intentions ("might look into"), or completed items. priority defaults to medium, only give high for strong deadline + strong commitment.
[responseQuality] Evaluate ${charName}'s response quality. relevance=did it answer the question, depth=was it substantive, tone=did it match the context, missed=did it miss a key point.`,
      prompt: `Analyze this conversation turn.`,
      model: "fast",
      timeoutMs: 60_000,
    });

    if (!text) return;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);

    // Dispatch: care topic
    if (parsed.careTopic?.need && parsed.careTopic?.searchQueries?.length) {
      try {
        const { addCareTopic } = await import("../care-topics.js");
        addCareTopic({
          need: parsed.careTopic.need,
          sourceSnippet: parsed.careTopic.sourceSnippet ?? "",
          searchQueries: parsed.careTopic.searchQueries,
          context: parsed.careTopic.context,
          priority: parsed.careTopic.priority,
        });
      } catch { log.warn("care topic dispatch skipped (module not available)"); safeIncrementError("post-turn", "care_topic"); }
    }

    // Dispatch: emotional care
    if (parsed.emotionalCare?.need) {
      try {
        const { addEmotionalCareTopic } = await import("../care-topics.js");
        const topic = addEmotionalCareTopic({
          need: parsed.emotionalCare.need,
          sourceSnippet: parsed.emotionalCare.sourceSnippet ?? "",
          whyItMatters: parsed.emotionalCare.whyItMatters ?? "",
          emotionalWeight: parsed.emotionalCare.emotionalWeight,
          context: parsed.emotionalCare.context,
        });
        if (topic) log.info(`emotional care topic: "${topic.need}" (weight=${topic.emotionalWeight})`);
      } catch { log.warn("emotional care dispatch skipped (module not available)"); safeIncrementError("post-turn", "emotional_care"); }
    }

    // Dispatch: commitment fulfillment + new
    if (parsed.commitment) {
      // Handle fulfillment
      if (Array.isArray(parsed.commitment.fulfilled)) {
        for (const key of parsed.commitment.fulfilled) {
          const match = existing.find(m => m.key === key && m.value.includes("status: open"));
          if (match) {
            const updated = match.value.replace("status: open", "status: done");
            manager.set(match.key, updated, match.confidence, "observed");
            log.info(`commitment fulfilled: "${match.key}"`);
          }
        }
      }

      // Handle new commitment
      if (parsed.commitment.newCommitment?.what) {
        const what = parsed.commitment.newCommitment.what;
        const isDupe = openCommitments.some(m => {
          const existingWhat = m.value.split("|")[0]?.replace("commitment:", "").trim() ?? "";
          return existingWhat.includes(what.slice(0, 8)) || what.includes(existingWhat.slice(0, 8));
        });
        if (!isDupe) {
          const slug = what.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "_");
          const ts = Math.floor(Date.now() / 1000);
          const key = `commitment.${ts}_${slug}`;
          const deadlineLabel = parsed.commitment.newCommitment.deadline as string | null;
          let deadlineTs: number | null = null;
          if (deadlineLabel) {
            const nowMs = Date.now();
            const deadlineMap: Record<string, number> = {
              "1h": nowMs + 60 * 60 * 1000,
              "today": new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).setHours(22, 0, 0, 0),
              "tomorrow": new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })).setHours(22, 0, 0, 0) + 24 * 60 * 60 * 1000,
              "this_week": nowMs + 7 * 24 * 60 * 60 * 1000,
              "next_chat": nowMs + 24 * 60 * 60 * 1000,
            };
            deadlineTs = deadlineMap[deadlineLabel] ?? null;
          }
          const deadlinePart = deadlineTs ? ` | deadline: ${deadlineTs}` : "";
          const value = `commitment: ${what} | status: open | context: ${parsed.commitment.newCommitment.context ?? "mentioned in conversation"}${deadlinePart}`;
          manager.set(key, value, 0.8, "observed");
          log.info(`commitment extracted: "${what}"${deadlineLabel ? ` (deadline: ${deadlineLabel})` : ""}`);

          // Bridge to intents system (if module available)
          try {
            const { addIntent } = await import("../intents.js");
            const whenMap: Record<string, string> = {
              "1h": "soon", "today": "today", "tomorrow": "tomorrow",
              "this_week": "this week", "next_chat": "next chat",
            };
            const intentWhen = deadlineLabel ? (whenMap[deadlineLabel] ?? null) : null;
            addIntent({
              what,
              when: intentWhen,
              priority: deadlineLabel === "1h" || deadlineLabel === "today" ? "high" : "medium",
              context: parsed.commitment.newCommitment.context ?? "promised in conversation",
            });
          } catch { safeIncrementError("post-turn", "intent_bridge"); }
        }
      }
    }

    // Dispatch: user state
    if (parsed.allenState) {
      try {
        const { updateUserState } = await import("../user-state.js");
        updateUserState({
          focuses: parsed.allenState.focuses ?? [],
          stressor: parsed.allenState.stressor ?? null,
          mood: parsed.allenState.mood ?? undefined,
          unspokenNeed: parsed.allenState.unspokenNeed ?? null,
        });
      } catch { safeIncrementError("post-turn", "allen_state"); }
    }

    // Dispatch: episode
    if (parsed.episode?.what && typeof parsed.episode.emotionalValence === "number") {
      try {
        const nowMs = Date.now();
        const dateStr = new Date(nowMs).toLocaleDateString("sv-SE", { timeZone: "America/Los_Angeles" });
        const { addEpisode } = await import("../memory/episodes.js");
        addEpisode({
          when: nowMs,
          date: dateStr,
          who: parsed.episode.who ?? [userName, charName],
          where: parsed.episode.where ?? undefined,
          what: parsed.episode.what,
          emotionalValence: Math.max(-1, Math.min(1, parsed.episode.emotionalValence)),
          emotionalNote: parsed.episode.emotionalNote ?? "",
          topics: parsed.episode.topics ?? [],
          causalLinks: undefined,
          significance: Math.max(0, Math.min(1, parsed.episode.significance ?? 0.3)),
        });
      } catch { safeIncrementError("post-turn", "episode"); }
    }

    // Dispatch: timeline events
    if (Array.isArray(parsed.timelineEvents) && parsed.timelineEvents.length > 0) {
      try {
        await enqueueTimelineJob(async () => {
          for (const evt of parsed.timelineEvents) {
            if (!evt?.summary || !evt?.category) continue;
            addTimelineEvent({
              time: evt.time || currentTime,
              category: evt.category,
              summary: evt.summary.length > 80 ? evt.summary.slice(0, 80) + "…" : evt.summary,
              people: evt.people,
              source: "conversation",
            });
          }
        });
      } catch { safeIncrementError("post-turn", "timeline_events"); }
    }

    // Dispatch: intents (character's plans/promises)
    if (Array.isArray(parsed.intents) && parsed.intents.length > 0) {
      try {
        const { addIntent } = await import("../intents.js");
        for (const intent of parsed.intents) {
          if (!intent?.what || intent.what.length < 3) continue;
          addIntent({
            what: intent.what,
            when: intent.when ?? null,
            priority: intent.priority ?? "medium",
            context: intent.context,
          });
        }
      } catch { safeIncrementError("post-turn", "intents"); }
    }

    // Dispatch: relational observation (piggyback on allenState, zero extra LLM cost)
    if (parsed.allenState) {
      try {
        const { recordObservation } = await import("../relational-impact.js");
        const as = parsed.allenState;

        // Detect emotional opening: mood shift + unspoken need present
        if (as.mood != null && as.mood <= 3 && as.unspokenNeed) {
          recordObservation({
            type: "emotional_opening",
            description: `They seem to be expressing deeper ${as.unspokenNeed.slice(0, 20)}`,
            possibleTrigger: "possibly related to sense of safety in conversation",
            causalConfidence: 0.3,
            significance: 0.5,
            timestamp: Date.now(),
          });
        }

        // Detect return to theme: same focus appears across multiple conversations
        if (as.focuses && as.focuses.length > 0 && as.stressor) {
          recordObservation({
            type: "return_to_theme",
            description: `They seem to keep coming back to "${as.focuses[0]}" related topics`,
            possibleTrigger: `possibly related to ${as.stressor.what.slice(0, 20)}`,
            causalConfidence: 0.3,
            significance: Math.min(0.6, as.stressor.intensity ?? 0.4),
            timestamp: Date.now(),
          });
        }
      } catch { log.warn("relational observation skipped (module not available)"); safeIncrementError("post-turn", "relational_observation"); }
    }

    // Dispatch: response quality (log for now, will feed into learning)
    if (parsed.responseQuality) {
      const rq = parsed.responseQuality;
      if (rq.missed) {
        log.info(`response quality: relevance=${rq.relevance} depth=${rq.depth} tone=${rq.tone} missed="${rq.missed}"`);
      }
      // Feed into interaction learning (if module available)
      try {
        const { recordResponseQuality } = await import("../interaction-learning.js");
        recordResponseQuality(rq);
      } catch { safeIncrementError("post-turn", "response_quality"); }

      // Strong counterevidence for value formation (if module available)
      if (statePath && rq.missed) {
        try {
          const { addStrongCounterEvidence } = await import("../lib/value-formation.js");
          addStrongCounterEvidence(statePath, `${userMessage} ${rq.missed}`);
        } catch { safeIncrementError("post-turn", "counter_evidence"); }
      }
    }
  } catch { safeIncrementError("post-turn", "understanding"); }
}

// ── preCompactionFlush ──────────────────────────────────────────────

/**
 * Pre-compaction memory flush — before compacting the transcript,
 * use LLM to extract any important facts from the conversation
 * that haven't been saved yet.
 */
export async function preCompactionFlush(sessionLoader: () => TranscriptEntry[], tools: ToolRegistry): Promise<void> {
  try {
    const entries = sessionLoader();
    if (entries.length <= 10) return;

    const character = getCharacter();
    const charName = character.name;
    const userName = character.user.name;

    // Get the entries that will be compacted (everything except last 10)
    const toCompact = entries.slice(0, entries.length - 10);

    // Build text from entries being compacted
    const text = toCompact
      .map((e) => `[${e.role}]: ${e.content}`)
      .join("\n\n")
      .slice(0, 8000);  // Cap to avoid huge prompts

    // Load existing user-related memories for dedup
    let existingMemories = "";
    try {
      const mems = getStoreManager().loadAll()
        .filter((m) => USER_MEMORY_PREFIXES.some((p) => m.key.startsWith(p)));
      existingMemories = mems.map((m) => `${m.key} = ${m.value}`).join("\n");
    } catch (err) { log.warn("failed to load memories for pre-compaction flush", err); }

    const result = await claudeText({
      label: "post-turn.preCompactionFlush",
      system:
        `You are a memory flush agent for ${charName}, a personal AI companion. ` +
        "The conversation below is about to be compacted (summarized and discarded). " +
        "Your job is to extract ANY important facts, decisions, preferences, emotional moments, or context that should be preserved as memories.\n\n" +
        `IMPORTANT CONTEXT: ${charName} is a character with their own simulated life. ` +
        `Do NOT save facts about ${charName}'s character/life as user memories — only save facts about the REAL USER (${userName}).\n` +
        `When referring to the AI in memory values, always use '${charName}', never 'MeAI'.\n\n` +
        "EXISTING MEMORIES (do NOT re-save these):\n" +
        (existingMemories || "(none)") + "\n\n" +
        "Rules:\n" +
        "- Save only NEW facts not already in existing memories\n" +
        "- Use namespaced keys: user.*, family.*, preferences.*, context.*, work.*, emotional.*, interests.*, viewpoints.*\n" +
        "- Track interests with interests.* keys (topics, hobbies, tech areas the user is into)\n" +
        "- Capture viewpoints/philosophy with viewpoints.* keys (life beliefs, values, opinions on important topics)\n" +
        "- Capture emotional moments (stress, excitement, frustration, pride, sadness) using emotional.* keys with date context\n" +
        "- Be thorough — this conversation will be lost after compaction\n" +
        "- If nothing new to save, output []\n" +
        `- Do NOT confuse the AI character's world (${charName}'s hobbies, work) with the user's real life.\n` +
        `- IMPORTANT: Always write the subject explicitly in the value. Write '${userName} did X' not just 'did X'. ${userName}'s experiences use user.*/family.*/emotional.* prefixes, ${charName}'s own use inner.*/activity.* prefixes.\n\n` +
        "Output ONLY a JSON array of memories to save:\n" +
        '[{"key": "namespace.key", "value": "the value"}]\n',
      prompt: `Extract important facts from this conversation before it's compacted:\n\n${text}`,
      model: "smart",
      timeoutMs: 90_000,
    });

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    let savedCount = 0;
    if (jsonMatch) {
      try {
        const memories = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
        for (const m of memories) {
          if (m.key && m.value) {
            await tools.execute("memory_set", { key: m.key, value: m.value, confidence: 0.8, sourceType: "observed" });
            savedCount++;
          }
        }
      } catch (err) { log.warn("failed to parse pre-compaction flush results", err); }
    }

    if (savedCount > 0) {
      console.log(`[memory] pre-compaction flush saved ${savedCount} memories`);
    }
  } catch (err) {
    console.error("Pre-compaction flush error:", err);
    // Non-fatal — compaction proceeds even if flush fails
  }
}
