/**
 * Emotion engine — gives the character moods with real-world causes.
 *
 * Instead of random mood generation, emotions are derived from:
 * 1. Work events (from daily schedule — meetings, deadlines, small wins/setbacks)
 * 2. Market movements (stocks she's watching — big swings affect mood)
 * 3. News/content (interesting or frustrating things she read today)
 * 4. Time-of-day / day-of-week patterns (Monday blues, Friday relief)
 * 5. Small life events (LLM-generated daily micro-events grounded in her life)
 *
 * Every emotion has an explicit CAUSE — this is what makes it feel real.
 * The engine refreshes every ~2 hours, and the emotional state is injected
 * into the system prompt so her responses naturally reflect her mood.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { claudeText } from "./claude-runner.js";
import { loadHobbyProgress } from "./hobbies.js";
import { getDaylightStatus, getWorkContext } from "./world.js";
import { getStoreManager } from "./memory/store-manager.js";
import { createLogger } from "./lib/logger.js";
import { getCycleMoodModifiers, getBodyState, type BodyState } from "./body.js";
import { getNarrativeEmotionSignals } from "./narrative.js";
import { formatTimelineContext, enqueueTimelineJob, addTimelineEvent } from "./timeline.js";
import { getUserTZ } from "./lib/pst-date.js";
import { s, renderTemplate, getCharacter } from "./character.js";

const log = createLogger("emotion");

// ── Module init ──────────────────────────────────────────────────────

let dataPath = "";
let lastLoggedMicroEvent = "";

export function initEmotion(config: { statePath: string }): void {
  dataPath = config.statePath;
}

// ── Types ────────────────────────────────────────────────────────────


export interface EmotionalState {
  /** Short label: e.g. "a bit irritable", "feeling good", "tired", "excited" */
  mood: string;
  /** What caused this mood — the key innovation. Always traceable to something real. */
  cause: string;
  /** 1-10 scale: 1=exhausted, 10=buzzing with energy */
  energy: number;
  /** 1-10 scale: 1=frustrated/sad, 10=ecstatic */
  valence: number;
  /** How this affects her communication style — injected into system prompt */
  behaviorHints: string;
  /** Optional: a small life event that happened today (LLM-generated, grounded in her life) */
  microEvent: string;
  /** When this state was generated */
  generatedAt: number;
  /** 5.2: Active defense mechanism (optional) */
  defenseMechanism?: DefenseMechanism;
}

/** 5.2: Defense mechanism — how the character unconsciously copes with negative emotions. */
export interface DefenseMechanism {
  type: "humor" | "rationalization" | "displacement" | "none";
  trigger: string;    // what's really bothering her
  surface: string;    // what she's talking about instead
}

/** 5.4: Rumination state — spiraling negative thoughts. */
export interface RuminationState {
  startedAt: number;
  trigger: string;
  spiralDepth: number;  // 0-3
  interrupted: boolean;
}

/** A journal entry — one snapshot in the rolling emotion log. */
interface JournalEntry {
  timestamp: number;
  mood: string;
  cause: string;
  energy: number;
  valence: number;
  microEvent: string;
  /** Ongoing narrative threads active at this point */
  activeThreads: NarrativeThread[];
}

/**
 * A narrative thread — an ongoing storyline that spans multiple days.
 * Examples: "writing a deep-dive report on Tesla, expecting to finish Friday"
 *           "pottery class bowl is in the kiln, should be ready next Saturday"
 *           "the cat has been overeating recently and needs to diet"
 */
interface NarrativeThread {
  /** Short id: "tesla-report", "pottery-bowl", "cat-diet" */
  id: string;
  /** What's going on */
  description: string;
  /** Current status: ongoing | resolved | abandoned */
  status: "ongoing" | "resolved" | "abandoned";
  /** When this thread started */
  startedAt: number;
}

interface EmotionJournal {
  entries: JournalEntry[];
  /** Active narrative threads that carry across days */
  threads: NarrativeThread[];
  /** Emotional contagion events from the user (2.2) */
  contagion?: ContagionEvent[];
  /** 5.4: Active rumination state */
  rumination?: RuminationState;
}

/** Tracks emotional contagion from the user's shared emotions */
interface ContagionEvent {
  timestamp: number;
  /** Valence shift (negative = the user shared stress/sadness) */
  valenceShift: number;
  cause: string;
}

// ── Cache ────────────────────────────────────────────────────────────

const EMOTION_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours — mood shifts naturally

function getEmotionCachePath(): string {
  return path.join(dataPath, "emotion-state.json");
}

function loadCachedEmotion(): EmotionalState | null {
  if (!dataPath) return null;
  const p = getEmotionCachePath();
  const state = readJsonSafe<EmotionalState | null>(p, null);
  if (state && Date.now() - state.generatedAt < EMOTION_CACHE_TTL) return state;
  return null; // expired or missing
}

function saveCachedEmotion(state: EmotionalState): void {
  if (!dataPath) return;
  writeJsonAtomic(getEmotionCachePath(), state);
}

// ── Signal gathering ─────────────────────────────────────────────────

interface EmotionSignals {
  timeContext: string;       // e.g. "Wednesday 3pm, workday"
  workContext: string;       // e.g. "just finished 2-hour research meeting, need to update DCF model next"
  marketContext: string;     // e.g. "NVDA up 4.2%, S&P slightly up 0.3%"
  newsContext: string;       // recent headlines she might have seen
  recentMemories: string;   // the user's emotional.* memories (user's real life)
  characterMemories: string;     // the character's own recent life (activity.*, inner.*)
  emotionHistory: string;   // recent emotion journal entries for narrative continuity
  activeThreads: string;    // ongoing multi-day storylines
  bodyContext: string;       // fatigue, hunger, period, sickness from body.ts
  socialContext: string;     // FOMO, recent friend updates from friends.ts
  hobbyContext: string;      // hobbies with high abandonment risk
  seasonalContext: string;   // seasonal + earnings season context
  timelineContext: string;   // today's established facts from timeline
}

function gatherTimeContext(scheduleActivity?: string): string {
  const now = new Date();
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const hour = userTime.getHours();
  const dayOfWeek = s().time.day_names[userTime.getDay()];
  const isWeekend = userTime.getDay() === 0 || userTime.getDay() === 6;
  const month = userTime.getMonth() + 1;
  const day = userTime.getDate();

  // Use actual schedule activity when available; fall back to generic hour-based label
  let timeOfDay: string;
  if (scheduleActivity) {
    timeOfDay = scheduleActivity;
  } else if (hour >= 6 && hour < 9) timeOfDay = "morning / commuting";
  else if (hour >= 9 && hour < 12) timeOfDay = "morning work";
  else if (hour >= 12 && hour < 14) timeOfDay = "lunch / afternoon break";
  else if (hour >= 14 && hour < 17) timeOfDay = "afternoon work";
  else if (hour >= 17 && hour < 19) timeOfDay = "wrapping up / commuting home";
  else if (hour >= 19 && hour < 22) timeOfDay = "evening at home";
  else if (hour >= 22 || hour < 2) timeOfDay = "late night";
  else timeOfDay = "early morning";

  // Real daylight status from Open-Meteo sunrise/sunset data
  const lightHint = getDaylightStatus() ?? (hour >= 7 && hour < 18 ? "still light out" : "dark outside");

  return `${month}/${day} ${dayOfWeek} ${hour}:${String(userTime.getMinutes()).padStart(2, "0")}, ${isWeekend ? "weekend" : "workday"}, ${timeOfDay}, ${lightHint}`;
}

// ── Emotion Journal (rolling log for narrative continuity) ────────────

const JOURNAL_MAX_ENTRIES = 30; // ~3 days at 2-hour intervals, keeps context manageable
const JOURNAL_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function getJournalPath(): string {
  return path.join(dataPath, "emotion-journal.json");
}

function loadJournal(): EmotionJournal {
  if (!dataPath) return { entries: [], threads: [] };
  const p = getJournalPath();
  if (!fs.existsSync(p)) return { entries: [], threads: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as EmotionJournal;
  } catch (err) {
    log.warn("failed to parse emotion journal", err);
    return { entries: [], threads: [] };
  }
}

function saveJournal(journal: EmotionJournal): void {
  if (!dataPath) return;
  // Prune old entries
  const cutoff = Date.now() - JOURNAL_MAX_AGE;
  journal.entries = journal.entries
    .filter(e => e.timestamp > cutoff)
    .slice(-JOURNAL_MAX_ENTRIES);
  // Prune resolved/abandoned threads older than 3 days
  const threadCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  journal.threads = journal.threads.filter(
    t => t.status === "ongoing" || t.startedAt > threadCutoff,
  );
  fs.writeFileSync(getJournalPath(), JSON.stringify(journal, null, 2) + "\n");
}

/** Append a new entry to the journal after generating a new emotional state. */
function appendToJournal(state: EmotionalState, threads: NarrativeThread[]): void {
  const journal = loadJournal();
  journal.entries.push({
    timestamp: state.generatedAt,
    mood: state.mood,
    cause: state.cause,
    energy: state.energy,
    valence: state.valence,
    microEvent: state.microEvent,
    activeThreads: threads.filter(t => t.status === "ongoing"),
  });
  journal.threads = threads;
  saveJournal(journal);
}

/** Format recent journal entries as context for the LLM. */
function formatJournalHistory(): string {
  const journal = loadJournal();
  if (journal.entries.length === 0) return "";

  // Group by day, show last 3 days at most
  const now = new Date();
  const userNow = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const todayStr = `${userNow.getFullYear()}-${String(userNow.getMonth() + 1).padStart(2, "0")}-${String(userNow.getDate()).padStart(2, "0")}`;

  // Take last 8 entries for context (covers ~16 hours)
  const recent = journal.entries.slice(-8);
  const lines: string[] = [];

  for (const entry of recent) {
    const d = new Date(entry.timestamp);
    const ut = new Date(d.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const dateStr = `${ut.getMonth() + 1}/${ut.getDate()} ${ut.getHours()}:${String(ut.getMinutes()).padStart(2, "0")}`;
    const isToday = `${ut.getFullYear()}-${String(ut.getMonth() + 1).padStart(2, "0")}-${String(ut.getDate()).padStart(2, "0")}` === todayStr;
    const dayLabel = isToday ? "today" : `${ut.getMonth() + 1}/${ut.getDate()}`;
    lines.push(`[${dayLabel} ${ut.getHours()}:${String(ut.getMinutes()).padStart(2, "0")}] ${entry.mood} (${entry.cause}) energy:${entry.energy} valence:${entry.valence}${entry.microEvent ? ` / small thing: ${entry.microEvent}` : ""}`);
  }

  return lines.join("\n");
}

/** Format active narrative threads as context. */
function formatActiveThreads(): string {
  const journal = loadJournal();
  const ongoing = journal.threads.filter(t => t.status === "ongoing");
  const lines: string[] = [];

  for (const t of ongoing) {
    const daysAgo = Math.floor((Date.now() - t.startedAt) / (24 * 60 * 60 * 1000));
    const age = daysAgo === 0 ? "started today" : `${daysAgo} days ago`;
    lines.push(`- ${t.description} (${age})`);
  }

  // 10.1: Narrative arc emotion signals
  try {
    const narrativeSignals = getNarrativeEmotionSignals();
    for (const sig of narrativeSignals) {
      if (sig && sig.trim()) {
        lines.push(`- ${sig}`);
      }
    }
  } catch { /* non-fatal */ }

  return lines.join("\n");
}

function loadRecentEmotionalMemories(): string {
  try {
    const memories = getStoreManager().loadCategory("emotional");
    return memories
      .map(m => `${m.key}: ${m.value}`)
      .join("\n");
  } catch (err) {
    log.warn("failed to load emotional memories", err);
    return "";
  }
}

/** Load the character's own recent life events (activities, reflections, discoveries). */
function loadCharacterMemories(): string {
  try {
    const memories = getStoreManager().loadCategory("character");
    const recent = memories.slice(-10); // last 10 entries
    return recent.map(m => m.value).join("\n");
  } catch (err) {
    log.warn("failed to load character memories", err);
    return "";
  }
}

// loadPreviousEmotion removed — replaced by journal-based history

/** Gather seasonal + earnings calendar context for emotion signals. */
function gatherSeasonalContext(): string {
  const now = new Date();
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const month = userTime.getMonth() + 1;
  const day = userTime.getDate();

  const parts: string[] = [];
  const seasonal = getSeasonalModifiers(month);
  const earnings = getEarningsSeasonPressure(month, day);
  if (seasonal.hint) parts.push(seasonal.hint);
  if (earnings.hint) parts.push(earnings.hint);
  return parts.join("; ") || s().body.normal_mood;
}

/** Format hobbies with high abandonment risk as emotional signal. */
function formatHobbySignals(): string {
  try {
    const progress = loadHobbyProgress();
    if (!progress.meta) return "";
    const neglected: string[] = [];
    for (const [key, meta] of Object.entries(progress.meta)) {
      if (meta.abandonmentRisk > 0.4) {
        neglected.push(`${key} (abandonment risk ${Math.round(meta.abandonmentRisk * 100)}%)`);
      }
    }
    return neglected.length > 0 ? `Some hobbies are at risk of being abandoned: ${neglected.join(", ")}` : "";
  } catch { return ""; }
}

// ── LLM Generation ──────────────────────────────────────────────────

interface GenerationResult {
  state: EmotionalState;
  threads: NarrativeThread[];
}

async function generateEmotionalState(signals: EmotionSignals): Promise<GenerationResult> {
  const char = getCharacter();
  const charName = char.name;
  const userName = char.user.name;
  const emotionBio = char.persona.emotion_bio ?? `About ${charName}: ${char.work?.title ?? ""}`;
  const lifeSim = char.persona.life_simulation ?? "";

  const customPrompt = char.persona.emotion_generator;
  const systemPrompt = customPrompt
    ? renderTemplate(customPrompt, char, { userName, charName, emotionBio, lifeSim: lifeSim || "" })
    : `You are ${charName}'s inner emotion simulator. Based on their current real situation (time, work, market, news) and recent emotional trajectory, generate their current emotional state.

${emotionBio}

Rules:
1. Emotions must have specific causes — no random good or bad moods
2. Causes must come from input signals (work, market, news, time, life events) — don't fabricate
3. Also generate a daily "micro event" (small life moment) — this can be creative but must fit ${charName}'s life context
   Important: micro events must be about ${charName}'s own life (their work, friends, places) — absolutely never about ${userName}'s family
   ${lifeSim ? lifeSim : `Important: ${charName}'s life context is determined by their schedule and timeline`}
   Important: microEvent must be based on events from today's timeline. If the timeline says they had a salad, don't say they had ramen. If no timeline data, you can be creative
   Examples:
   - "The cat knocked over a water glass this morning"
   - "Favorite barista wasn't at the coffee shop today"
   - "The bowl from pottery class came out of the kiln — looks better than expected"
   - "Headphones died during commute"
   - "Colleague recommended a new ramen place"
   - "Today's oat latte turned out really good"
   - "Saw the cracked pottery bowl on the shelf, thought about it for a moment"
   - "Brother sent a video of his kid in the family chat — liked it, but felt a twinge of something"
   - "Walked past a couple holding hands, suddenly realized it's been a while since being with someone"
   These small things should occasionally affect mood, but not every time — sometimes they're just background color
   About 5% of the time, micro event can be an existential thought:
   - "Suddenly wondered if AI agent decision-making is basically gradient descent"
   - "Looking at my own code, wondered what it means if AI can really replace analysts"
   - "Found an article about free will late at night, couldn't stop thinking about it"
   These deep thoughts only appear occasionally, and would only come up in conversation with ${userName} — because they'd understand
4. behaviorHints must specifically describe how emotion affects chat style, in instruction format:
   - High fatigue → "shorter replies, doesn't initiate topics, occasional typos"
   - Excited → "fast pace, lots of exclamation marks, wants to share, might send multiple messages"
   - Anxious → "longer messages, tends to over-explain, repeatedly confirms"
   - Irritable → "brief, impatient, might snap"
   - Happy/relaxed → "normal pace, willing to chat, makes jokes"
   Format: "fatigue 8/10, messages will be short and slow, won't expand complex topics"
5. energy and valence should be realistic: long meeting → low energy, Friday afternoon → high valence, etc.
6. energy recovery: eating restores 1-2 points, coffee helps, rest after exercise helps, leisure time naturally restores energy. Don't keep energy at 1-3 for hours — people bounce back after eating or coffee.

Continuity rules (important!):
7. Carefully read "recent emotional trajectory" — this is the record of emotional changes over the last few days
8. Emotional changes should have reasonable transitions, no abrupt jumps:
   - If yesterday was anxious due to project pressure, today won't suddenly be happy — unless there's a specific reason (e.g., project completed successfully)
   - If energy has been high, a sudden drop needs a reason (e.g., overtime, poor sleep)
   - Allow natural mood recovery, but it takes time (down → calm → good is more realistic than down → very happy)
9. Update narrative threads — these are ongoing multi-day storylines:
   - Check existing threads, advance their progress (e.g., report goes from "writing" → "almost done" → "submitted")
   - If something new started (new project, new plan), create a new thread
   - If something finished, mark as resolved
   - If no longer relevant, mark as abandoned
   - Keep 3-5 ongoing threads, not too many
10. Body state affects emotions: fatigue → easily irritable, less patient; period discomfort → low comfort, wants to stay in; sick → low energy, antisocial
11. Social state affects emotions: haven't seen friends in a while → a bit lonely/FOMO; socially active recently → good mood, sense of belonging
12. Hobby neglect → mild guilt ("haven't practiced in a while"), but don't over-amplify

Output strictly in the following JSON format, nothing else:
{
  "mood": "short mood label (2-6 words)",
  "cause": "one sentence explaining why this mood",
  "energy": number 1-10,
  "valence": number 1-10,
  "behaviorHints": "specific instructions: fatigue level, reply length, tone, patience, willingness to chat",
  "microEvent": "one small thing that happened today",
  "threads": [
    {"id": "short-id", "description": "current status of this thread", "status": "ongoing/resolved/abandoned"}
  ]
}`;

  try {
    const text = await claudeText({
      system: systemPrompt,
      prompt: `Current signals:

Time: ${signals.timeContext}

Work: ${signals.workContext || "(no specific work info — don't fabricate work content)"}

Market: ${signals.marketContext || "(haven't checked the market today — don't mention market-related content)"}

News: ${signals.newsContext || "(no news available)"}

${userName}'s recent life updates (this is the user's real life, not ${charName}'s — do NOT put ${userName}'s family life into ${charName}'s micro event):
${signals.recentMemories || "(none)"}

${charName}'s own recent life (explorations, learning, activities, feelings — micro event should draw inspiration from here):
${signals.characterMemories || "(no records yet)"}

Recent emotional trajectory:
${signals.emotionHistory || "(first run, no history)"}

Current ongoing narrative threads:
${signals.activeThreads || "(no ongoing threads)"}

Body state: ${signals.bodyContext || "(normal)"}

Social state: ${signals.socialContext || "(normal)"}

Hobby state: ${signals.hobbyContext || "(normal)"}

Season & work rhythm: ${signals.seasonalContext || "(normal)"}

Today's timeline (established facts — microEvent must be consistent with this, no contradictions):
${signals.timelineContext || "(no records for today yet)"}

Generate the current emotional state and update narrative threads.`,
      model: "smart",
      timeoutMs: 90_000,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      // Repair common LLM JSON issues before parsing
      // 1. Remove trailing commas before } or ]
      jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");
      // 2. Replace unescaped newlines/tabs inside string values
      jsonStr = jsonStr.replace(/"([^"]*?)"/g, (_m, content: string) =>
        `"${content.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`,
      );
      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        // Second attempt: strip all control chars
        jsonStr = jsonStr.replace(/[\x00-\x1f]/g, " ");
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          // Third attempt: fix unescaped quotes inside string values
          // e.g. "mood": "she said "so tired"" → "mood": "she said \"so tired\""
          jsonStr = jsonStr.replace(/"([^"]*?)"\s*:/g, (m) => `<<<${m}>>>`);  // protect keys
          jsonStr = jsonStr.replace(/:\s*"((?:[^"\\]|\\.)*)"/g, (_m, val: string) => {
            // Re-escape any unescaped internal quotes
            return `: "${val.replace(/(?<!\\)"/g, '\\"')}"`;
          });
          jsonStr = jsonStr.replace(/<<<(".*?"\s*:)>>>/g, "$1");  // restore keys
          parsed = JSON.parse(jsonStr);
        }
      }

      const energy = clamp(parsed.energy ?? 5, 1, 10);
      const valence = clamp(parsed.valence ?? 5, 1, 10);

      const state: EmotionalState = {
        mood: parsed.mood ?? "calm",
        cause: parsed.cause ?? "",
        energy,
        valence,
        behaviorHints: parsed.behaviorHints || generateDeterministicHints(energy, valence),
        microEvent: parsed.microEvent ?? "",
        generatedAt: Date.now(),
      };

      // Parse thread updates from LLM
      const existingThreads = loadJournal().threads;
      let threads: NarrativeThread[] = existingThreads;

      if (Array.isArray(parsed.threads)) {
        threads = parsed.threads.map((t: any) => {
          const existing = existingThreads.find(e => e.id === t.id);
          return {
            id: t.id ?? `thread-${Date.now()}`,
            description: t.description ?? "",
            status: t.status ?? "ongoing",
            startedAt: existing?.startedAt ?? Date.now(),
          };
        });
      }

      return { state, threads };
    }
  } catch (err) {
    console.error("[emotion] Generation error:", err);
  }

  return { state: defaultState(), threads: loadJournal().threads };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── Energy Recovery from Physical State ─────────────────────────────

/**
 * Deterministic upward energy adjustments based on body state.
 * Mirrors existing downward post-processing (burden, rumination, seasonal).
 * Only boosts when energy is below what the body would suggest.
 */
function applyEnergyRecovery(
  state: EmotionalState,
  body: BodyState,
  scheduleCategory: string | null,
): EmotionalState {
  const bodyBaseline = 10 - body.fatigue; // fatigue=3 → baseline=7
  if (state.energy >= bodyBaseline) return state; // already at/above body baseline

  let boost = 0;

  // Caffeine: +1 if active, +2 if strong
  if (body.caffeineLevel >= 6) boost += 2;
  else if (body.caffeineLevel >= 4) boost += 1;

  // Post-meal: low hunger means recently ate
  if (body.hunger <= 3) boost += 1;
  // Currently eating
  if (scheduleCategory === "meal") boost += 1;

  // Post-exercise endorphins (only if past the fatigue spike)
  if (body.exercisedToday && body.fatigue < 7) boost += 1;

  // Leisure/rest blocks
  if (scheduleCategory === "entertainment" || scheduleCategory === "rest") boost += 1;

  // Cap total boost
  boost = Math.min(boost, 3);

  // Body-emotion mismatch floor: if body is fine but energy is tanked
  const mismatchFloor = Math.max(1, bodyBaseline - 2);
  const newEnergy = Math.max(
    state.energy + boost,
    state.energy < mismatchFloor ? mismatchFloor : state.energy,
  );

  if (newEnergy !== state.energy) {
    log.info(`energy recovery: ${state.energy} → ${clamp(newEnergy, 1, 10)} (boost=${boost}, floor=${mismatchFloor}, body.fatigue=${body.fatigue}, caffeine=${body.caffeineLevel}, hunger=${body.hunger}, category=${scheduleCategory})`);
    return { ...state, energy: clamp(newEnergy, 1, 10) };
  }
  return state;
}

// ── 5.6: Personality × Emotion Coupling ─────────────────────────────

/** Fixed Big-5 personality traits for the character — drives emotion amplification. */
const PERSONALITY_TRAITS = {
  conscientiousness: 0.8,  // high → work setbacks hit harder
  extraversion: 0.7,       // high → isolation drains valence
  neuroticism: 0.5,        // moderate — baseline emotional reactivity
  openness: 0.8,           // high → curious, but not directly coupled
  agreeableness: 0.6,      // moderate — can push back, but cares
} as const;

// ── 10.3: Seasonal & Earnings Calendar ──────────────────────────────

interface SeasonalModifiers {
  valenceShift: number;
  energyShift: number;
  hint: string;
}

/** Seasonal mood arc based on current month. */
function getSeasonalModifiers(month: number): SeasonalModifiers {
  // Winter blues (Dec-Feb)
  if (month === 12 || month === 1 || month === 2) {
    return { valenceShift: -0.3, energyShift: -0.3, hint: "short winter days, feeling a bit lazy" };
  }
  // Spring energy (Mar-May)
  if (month >= 3 && month <= 5) {
    return { valenceShift: 0.3, energyShift: 0.3, hint: "" };
  }
  // Summer social (Jun-Aug)
  if (month >= 6 && month <= 8) {
    return { valenceShift: 0.2, energyShift: 0.2, hint: "" };
  }
  // Fall reflection (Sep-Nov)
  const fallHint = getCharacter().persona.seasonal_mood?.["fall"] ?? getCharacter().persona.seasonal_mood?.["秋天"] ?? "";
  return { valenceShift: -0.1, energyShift: 0, hint: fallHint };
}

/** Earnings season work pressure — last 2 weeks of Jan/Apr/Jul/Oct. */
function getEarningsSeasonPressure(month: number, day: number): { valenceShift: number; energyShift: number; hint: string } {
  const earningsMonths = [1, 4, 7, 10];
  if (earningsMonths.includes(month) && day >= 15) {
    return { valenceShift: -0.5, energyShift: -0.3, hint: "earnings season, high pressure and long hours" };
  }
  return { valenceShift: 0, energyShift: 0, hint: "" };
}

/** Deterministic fallback when LLM doesn't generate behaviorHints */
function generateDeterministicHints(energy: number, valence: number): string {
  const parts: string[] = [];
  // Energy-driven style
  if (energy <= 3) parts.push("very low energy, short replies, won't expand complex topics");
  else if (energy <= 5) parts.push("average energy, normal chat but not particularly proactive");
  else if (energy >= 8) parts.push("high energy, talkative, fast responses, willing to deep-dive");
  // Valence-driven tone
  if (valence <= 3) parts.push("bad mood, flat tone, might be a bit dismissive");
  else if (valence >= 8) parts.push("great mood, light tone, makes jokes, lots of exclamation marks");
  else if (valence <= 5 && energy <= 4) parts.push("a bit listless, replies may be slow and short");
  // Specific combos
  if (energy >= 7 && valence >= 7) parts.push("feeling great, proactive, wants to share things");
  if (energy <= 3 && valence <= 4) parts.push("tired and down, might only reply with a word or two");
  return parts.join("; ") || "normal state, chatting normally";
}

// ── 2.2: Emotional Contagion from the User ──────────────────────────

/**
 * Record that the user shared strong emotions — the character absorbs some of it.
 * Called from the agent loop when the user's message contains emotional content.
 */
export function recordEmotionalContagion(valenceShift: number, cause: string): void {
  if (!dataPath) return;
  const journal = loadJournal();
  if (!journal.contagion) journal.contagion = [];
  journal.contagion.push({
    timestamp: Date.now(),
    valenceShift: clamp(valenceShift, -2, 2),
    cause,
  });
  // Keep last 10 events
  if (journal.contagion.length > 10) journal.contagion = journal.contagion.slice(-10);
  saveJournal(journal);
}

/**
 * Compute active contagion effect using exponential decay.
 * Each event decays with half-life of ~4 hours.
 */
function computeContagionEffect(): number {
  const journal = loadJournal();
  if (!journal.contagion || journal.contagion.length === 0) return 0;

  const now = Date.now();
  let totalEffect = 0;
  for (const event of journal.contagion) {
    const hoursElapsed = (now - event.timestamp) / (60 * 60 * 1000);
    if (hoursElapsed > 12) continue; // ignore old events
    // Exponential decay: effect = shift × e^(-0.5 × hours)
    totalEffect += event.valenceShift * Math.exp(-0.5 * hoursElapsed);
  }
  return clamp(totalEffect, -3, 3);
}

// ── 2.3: Mood Inertia with Recovery Curves ──────────────────────────

/**
 * Constrain valence changes based on time elapsed since last state.
 * Major swings (±3+) require minimum 4 hours to fully recover.
 */
function applyMoodInertia(state: EmotionalState): EmotionalState {
  const journal = loadJournal();
  if (journal.entries.length === 0) return state;

  const lastEntry = journal.entries[journal.entries.length - 1];
  const hoursElapsed = (Date.now() - lastEntry.timestamp) / (60 * 60 * 1000);

  // Max allowed valence change based on time elapsed
  let maxDelta: number;
  if (hoursElapsed < 1) maxDelta = 2;
  else if (hoursElapsed < 2) maxDelta = 3;
  else if (hoursElapsed < 4) maxDelta = 4;
  else maxDelta = 6; // after 4+ hours, allow larger shifts

  const deltaV = state.valence - lastEntry.valence;
  if (Math.abs(deltaV) > maxDelta) {
    state = {
      ...state,
      valence: clamp(
        lastEntry.valence + Math.sign(deltaV) * maxDelta,
        1, 10,
      ),
    };
  }

  // Also constrain energy changes (but more relaxed since energy is more physical)
  // Asymmetric: allow faster upward recovery than downward decline
  const deltaE = state.energy - lastEntry.energy;
  const maxEnergyUp = Math.min(maxDelta + 2, 7);   // faster recovery (coffee/food perks you up quickly)
  const maxEnergyDown = Math.min(maxDelta + 1, 7);  // unchanged — exhaustion builds gradually
  const maxEnergyDelta = deltaE > 0 ? maxEnergyUp : maxEnergyDown;
  if (Math.abs(deltaE) > maxEnergyDelta) {
    state = {
      ...state,
      energy: clamp(
        lastEntry.energy + Math.sign(deltaE) * maxEnergyDelta,
        1, 10,
      ),
    };
  }

  return state;
}

// ── 2.4: Attention Burden Ceiling ───────────────────────────────────

/**
 * Count concurrent stressors from narrative threads + body/schedule.
 * Returns a burden score that affects fatigue and irritability.
 */
function computeAttentionBurden(): number {
  const journal = loadJournal();
  const ongoingThreads = journal.threads.filter(t => t.status === "ongoing");

  let burden = 0;
  // Each ongoing thread is a stressor (especially long-running ones)
  for (const thread of ongoingThreads) {
    const daysActive = (Date.now() - thread.startedAt) / (24 * 60 * 60 * 1000);
    burden += daysActive > 5 ? 1.5 : 1; // old threads weigh more
  }

  return burden;
}

/**
 * Apply attention burden effects to emotional state.
 * When burden > 3: reduce valence, bump fatigue signal in hints.
 */
function applyAttentionBurden(state: EmotionalState): EmotionalState {
  const burden = computeAttentionBurden();
  if (burden <= 3) return state;

  const overload = burden - 3;
  const valencePenalty = Math.min(2, Math.round(overload * 0.7));
  const newState = {
    ...state,
    valence: clamp(state.valence - valencePenalty, 1, 10),
    energy: clamp(state.energy - Math.min(2, Math.round(overload * 0.5)), 1, 10),
  };

  // Append burden hint
  if (burden > 4) {
    newState.behaviorHints = (newState.behaviorHints ? newState.behaviorHints + "; " : "") +
      "too many things going on, patience is low";
  }

  return newState;
}

// ── 5.2: Defense Mechanisms ──────────────────────────────────────────

/**
 * Probabilistically assign a defense mechanism when valence is low.
 * ~20-30% of low-valence states trigger a defense.
 */
function maybeAssignDefenseMechanism(state: EmotionalState): EmotionalState {
  if (state.valence > 4) return state; // only triggers on low mood
  if (Math.random() > 0.25) return state; // 25% chance

  const cause = state.cause.toLowerCase();
  let mechanism: DefenseMechanism;

  if (/焦虑|不安|担心|害怕|anxious|worried|scared|uneasy/.test(cause) || state.valence <= 3) {
    // Anxious → humor/deflection
    mechanism = {
      type: "humor",
      trigger: state.cause,
      surface: "using self-deprecation or jokes to mask unease",
    };
  } else if (/工作|项目|季报|失误|判断|work|project|report|mistake|earnings/.test(cause)) {
    // Work setback → rationalization
    mechanism = {
      type: "rationalization",
      trigger: state.cause,
      surface: "rationalizing why the outcome isn't actually that bad",
    };
  } else {
    // Frustrated → displacement onto pet/weather/minor things
    const _char = getCharacter();
    const petTarget = _char.pet ? `${_char.pet.name} knocked something over again` : "the neighbors are too loud";
    const targets = [petTarget, `the weather in ${_char.location.city} is really annoying`, "the coffee shop downstairs was way too crowded today"];
    mechanism = {
      type: "displacement",
      trigger: state.cause,
      surface: targets[Math.floor(Math.random() * targets.length)],
    };
  }

  return { ...state, defenseMechanism: mechanism };
}

// ── 5.4: Rumination Tracking ────────────────────────────────────────

/**
 * Update rumination state based on sustained low valence.
 * Low valence for >3h → spiralDepth increases (1 per 2h), valence penalty -0.5×depth.
 */
function updateRuminationState(state: EmotionalState): EmotionalState {
  const journal = loadJournal();

  // Check if the user just interrupted rumination
  // (handled externally via interruptRumination())

  // Count consecutive low-valence entries (<=4)
  const entries = journal.entries;
  let lowValenceStreak = 0;
  let streakStartTime = Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].valence <= 4) {
      lowValenceStreak++;
      streakStartTime = entries[i].timestamp;
    } else {
      break;
    }
  }

  // Also count current state
  if (state.valence <= 4) lowValenceStreak++;

  const hoursLow = (Date.now() - streakStartTime) / (60 * 60 * 1000);

  if (hoursLow < 3 || lowValenceStreak < 2) {
    // Clear rumination if mood improved
    if (journal.rumination) {
      journal.rumination = undefined;
      saveJournal(journal);
    }
    return state;
  }

  // Start or deepen rumination
  const prevDepth = journal.rumination?.spiralDepth ?? 0;
  const newDepth = Math.min(3, Math.floor((hoursLow - 3) / 2) + 1);

  journal.rumination = {
    startedAt: journal.rumination?.startedAt ?? streakStartTime,
    trigger: journal.rumination?.trigger ?? state.cause,
    spiralDepth: newDepth,
    interrupted: journal.rumination?.interrupted ?? false,
  };
  saveJournal(journal);

  // Apply valence penalty
  const penalty = Math.round(0.5 * newDepth);
  const hints = newDepth >= 2 ? "spiraling, can't stop overthinking" : "keeps going back to the same thing";

  return {
    ...state,
    valence: clamp(state.valence - penalty, 1, 10),
    behaviorHints: (state.behaviorHints ? state.behaviorHints + "; " : "") + hints,
  };
}

/**
 * 5.4: User messaging interrupts rumination — call from loop.ts.
 * Returns valence bonus if rumination was interrupted.
 */
export function interruptRumination(): number {
  if (!dataPath) return 0;
  const journal = loadJournal();
  if (!journal.rumination || journal.rumination.interrupted) return 0;

  journal.rumination.interrupted = true;
  saveJournal(journal);
  return 0.5; // valence bonus for interruption
}

/** Get current rumination state for context display. */
export function getRuminationState(): RuminationState | null {
  if (!dataPath) return null;
  const journal = loadJournal();
  return journal.rumination ?? null;
}

/**
 * 5.6: Personality × emotion coupling — amplify or dampen emotions
 * based on the character's fixed Big-5 traits.
 */
function applyPersonalityCoupling(state: EmotionalState): EmotionalState {
  let { valence, energy, behaviorHints } = state;
  const hints: string[] = [];

  // Conscientiousness × work cause → amplify low-valence penalty
  if (PERSONALITY_TRAITS.conscientiousness > 0.5 && valence <= 4) {
    const cause = state.cause.toLowerCase();
    if (/工作|研报|项目|deadline|会议|老板|季报|财报|work|report|project|meeting|boss|earnings/.test(cause)) {
      const amplify = 1 + (PERSONALITY_TRAITS.conscientiousness - 0.5);
      const penalty = Math.round((5 - valence) * (amplify - 1));
      valence = clamp(valence - penalty, 1, 10);
    }
  }

  // Extraversion × isolation → valence drain
  // Check recent journal for isolation signals (no social in 4+ hours)
  const journal = loadJournal();
  const lastEntry = journal.entries[journal.entries.length - 1];
  if (lastEntry && PERSONALITY_TRAITS.extraversion > 0.5) {
    const hoursSinceLastEntry = (Date.now() - lastEntry.timestamp) / (60 * 60 * 1000);
    // If isolated for 4+ hours and extraverted, drain valence
    if (hoursSinceLastEntry >= 4) {
      const isolationHours = Math.min(hoursSinceLastEntry - 4, 4); // cap at 4 extra hours
      const drain = Math.round(isolationHours * 0.5 * (PERSONALITY_TRAITS.extraversion - 0.3));
      if (drain > 0) {
        valence = clamp(valence - drain, 1, 10);
        hints.push("been alone too long, want to talk to someone");
      }
    }
  }

  const extraHints = hints.length > 0
    ? (behaviorHints ? behaviorHints + "; " : "") + hints.join("; ")
    : behaviorHints;

  return { ...state, valence, energy, behaviorHints: extraHints };
}

function defaultState(): EmotionalState {
  const now = new Date();
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const hour = userTime.getHours();

  if (hour >= 6 && hour < 9) {
    return {
      mood: "not fully awake",
      cause: "just woke up, waiting for coffee to kick in",
      energy: 4,
      valence: 5,
      behaviorHints: "replies may be short, still waking up",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else if (hour >= 9 && hour < 12) {
    return {
      mood: "getting into the zone",
      cause: "morning work time, caffeine kicking in",
      energy: 7,
      valence: 6,
      behaviorHints: "fairly focused, chat will be concise",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else if (hour >= 12 && hour < 14) {
    return {
      mood: "hungry",
      cause: "lunchtime, getting hungry",
      energy: 5,
      valence: 5,
      behaviorHints: "might mention food, attention a bit scattered",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else if (hour >= 14 && hour < 17) {
    return {
      mood: "afternoon drowsiness",
      cause: "afternoon work, a bit sleepy after lunch",
      energy: 5,
      valence: 5,
      behaviorHints: "normal chat, occasionally zones out",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else if (hour >= 17 && hour < 19) {
    return {
      mood: "almost done for the day",
      cause: "day is wrapping up, thinking about evening plans",
      energy: 4,
      valence: 6,
      behaviorHints: "more relaxed, might be chattier",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else if (hour >= 19 && hour < 22) {
    return {
      mood: "cozy at home",
      cause: "relaxing at home, probably watching something or scrolling phone",
      energy: 4,
      valence: 6,
      behaviorHints: "relaxed, willing to chat, replies might be longer",
      microEvent: "",
      generatedAt: Date.now(),
    };
  } else {
    // 22:00 - 6:00
    return {
      mood: "getting sleepy",
      cause: "it's late, getting ready for bed or scrolling in bed",
      energy: 3,
      valence: 5,
      behaviorHints: "short replies, might fall asleep any moment",
      microEvent: "",
      generatedAt: Date.now(),
    };
  }
}

// ── Emotion Transition Tracking ──────────────────────────────────

export interface EmotionTransition {
  previous: { mood: string; energy: number; valence: number } | null;
  current: EmotionalState;
  delta: { energy: number; valence: number };
  isSignificant: boolean;   // |delta.valence| >= 2 or |delta.energy| >= 2
  transitionLabel: string;  // e.g. "mood improving" / "feeling down" / "energy recovering" / "energy declining" / ""
  /** 7.6: Emotional momentum — trending direction computed from last 3 entries */
  momentum: "trending_up" | "trending_down" | "stable" | "volatile";
  /** Slope of valence trend (positive = improving, negative = declining) */
  slope: number;
}

/**
 * 7.6: Compute emotional momentum from recent journal entries.
 * Uses last 3 entries' valence deltas + variance to determine trend.
 */
function computeEmotionalMomentum(entries: JournalEntry[]): { momentum: EmotionTransition["momentum"]; slope: number } {
  if (entries.length < 2) return { momentum: "stable", slope: 0 };

  const recent = entries.slice(-3);
  const deltas: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i].valence - recent[i - 1].valence);
  }

  if (deltas.length === 0) return { momentum: "stable", slope: 0 };

  const avgSlope = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variance = deltas.length > 1
    ? deltas.reduce((sum, d) => sum + (d - avgSlope) ** 2, 0) / deltas.length
    : 0;

  // Volatile if variance is high (big swings)
  if (variance > 4) return { momentum: "volatile", slope: avgSlope };
  // Trending up/down if slope is significant
  if (avgSlope >= 1) return { momentum: "trending_up", slope: avgSlope };
  if (avgSlope <= -1) return { momentum: "trending_down", slope: avgSlope };
  return { momentum: "stable", slope: avgSlope };
}

/**
 * Compute emotion transition from the last journal entry to current cached state.
 * Pure deterministic logic — no LLM call.
 */
export function getEmotionTransition(): EmotionTransition | null {
  const current = loadCachedEmotion();
  if (!current) return null;

  const journal = loadJournal();
  const entries = journal.entries;
  const prev = entries.length >= 2
    ? entries[entries.length - 2]  // second-to-last = previous state
    : entries.length === 1
      ? entries[0]
      : null;

  if (!prev) {
    return {
      previous: null,
      current,
      delta: { energy: 0, valence: 0 },
      isSignificant: false,
      transitionLabel: "",
      momentum: "stable",
      slope: 0,
    };
  }

  const deltaEnergy = current.energy - prev.energy;
  const deltaValence = current.valence - prev.valence;
  const isSignificant = Math.abs(deltaValence) >= 2 || Math.abs(deltaEnergy) >= 2;

  let transitionLabel = "";
  if (deltaValence >= 2) transitionLabel = "mood improving";
  else if (deltaValence <= -2) transitionLabel = "mood declining";
  else if (deltaEnergy >= 2) transitionLabel = "energy recovering";
  else if (deltaEnergy <= -2) transitionLabel = "energy dropping";

  // 7.6: Compute emotional momentum from last 3 journal entries
  const { momentum, slope } = computeEmotionalMomentum(entries);

  return {
    previous: { mood: prev.mood, energy: prev.energy, valence: prev.valence },
    current,
    delta: { energy: deltaEnergy, valence: deltaValence },
    isSignificant,
    transitionLabel,
    momentum,
    slope,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get the character's current emotional state.
 * Uses cache if fresh enough; otherwise generates a new state from real-world signals.
 *
 * @param workContext - Current work schedule info (from world.ts)
 * @param marketContext - Current market data (from world.ts)
 * @param newsContext - Recent headlines (from interests.ts)
 */
export async function getEmotionalState(
  workContext?: string,
  marketContext?: string,
  newsContext?: string,
  bodyContext?: string,
  socialContext?: string,
  scheduleActivity?: string,
): Promise<EmotionalState> {
  // Check cache first
  const cached = loadCachedEmotion();
  if (cached) return cached;

  // Gather signals — including journal history for narrative continuity
  const signals: EmotionSignals = {
    timeContext: gatherTimeContext(scheduleActivity),
    workContext: workContext ?? "",
    marketContext: marketContext ?? "",
    newsContext: newsContext ?? "",
    recentMemories: loadRecentEmotionalMemories(),
    characterMemories: loadCharacterMemories(),
    emotionHistory: formatJournalHistory(),
    activeThreads: formatActiveThreads(),
    bodyContext: bodyContext ?? "",
    socialContext: socialContext ?? "",
    hobbyContext: formatHobbySignals(),
    seasonalContext: gatherSeasonalContext(),
    timelineContext: formatTimelineContext(),
  };

  // Generate new emotional state with thread updates
  // Wrapped in timeline queue so the LLM sees the latest timeline state
  let { state, threads } = await enqueueTimelineJob(() => generateEmotionalState(signals));

  // Post-processing: mood inertia, recovery, contagion, attention burden
  state = applyMoodInertia(state);

  // Energy recovery from physical state (after inertia, before burden/rumination)
  try {
    const body = await getBodyState();
    const work = await getWorkContext();
    const category = work.currentBlock?.category ?? null;
    state = applyEnergyRecovery(state, body, category);
  } catch { /* body/world may not be ready during startup */ }

  // Apply emotional contagion from the user
  const contagionEffect = computeContagionEffect();
  if (Math.abs(contagionEffect) >= 0.5) {
    state = {
      ...state,
      valence: clamp(Math.round(state.valence + contagionEffect), 1, 10),
    };
  }

  // Apply attention burden ceiling
  state = applyAttentionBurden(state);

  // 5.2: Defense mechanisms
  state = maybeAssignDefenseMechanism(state);

  // 5.4: Rumination tracking
  state = updateRuminationState(state);

  // 5.5: Menstrual cycle mood modulation
  try {
    const cycleMods = getCycleMoodModifiers();
    if (cycleMods.valenceShift !== 0) {
      state = { ...state, valence: clamp(Math.round(state.valence + cycleMods.valenceShift), 1, 10) };
    }
    if (cycleMods.hint) {
      state = { ...state, behaviorHints: (state.behaviorHints ? state.behaviorHints + "; " : "") + cycleMods.hint };
    }
  } catch { /* body module may not be initialized yet */ }

  // 5.6: Personality × emotion coupling
  state = applyPersonalityCoupling(state);

  // 10.3: Seasonal emotional arcs
  {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const month = userTime.getMonth() + 1;
    const day = userTime.getDate();
    const seasonal = getSeasonalModifiers(month);
    const earnings = getEarningsSeasonPressure(month, day);
    const totalValenceShift = seasonal.valenceShift + earnings.valenceShift;
    const totalEnergyShift = seasonal.energyShift + earnings.energyShift;
    if (totalValenceShift !== 0) {
      state = { ...state, valence: clamp(Math.round(state.valence + totalValenceShift), 1, 10) };
    }
    if (totalEnergyShift !== 0) {
      state = { ...state, energy: clamp(Math.round(state.energy + totalEnergyShift), 1, 10) };
    }
    const hints = [seasonal.hint, earnings.hint].filter(Boolean);
    if (hints.length > 0) {
      state = { ...state, behaviorHints: (state.behaviorHints ? state.behaviorHints + "; " : "") + hints.join("; ") };
    }
  }

  // Re-generate behaviorHints if values were adjusted
  if (!state.behaviorHints) {
    state = { ...state, behaviorHints: generateDeterministicHints(state.energy, state.valence) };
  }

  // Persist to both cache (for fast reads) and journal (for continuity)
  saveCachedEmotion(state);
  appendToJournal(state, threads);

  console.log(`[emotion] New state: ${state.mood} (energy: ${state.energy}, valence: ${state.valence}) — ${state.cause}`);
  const microPrefix = state.microEvent?.slice(0, 20) ?? "";
  if (state.microEvent && microPrefix !== lastLoggedMicroEvent) {
    console.log(`[emotion] Micro event: ${state.microEvent}`);
    lastLoggedMicroEvent = microPrefix;

    // Write micro-event to timeline so all systems see the same facts
    try {
      const now = new Date();
      const pstTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
      const hh = String(pstTime.getHours()).padStart(2, "0");
      const mm = String(pstTime.getMinutes()).padStart(2, "0");
      // Truncate to first sentence for summary
      const firstSentence = state.microEvent.split(/[。！；\n——]/)[0]?.trim() || state.microEvent;
      const summary = firstSentence.length > 60 ? firstSentence.slice(0, 60) + "…" : firstSentence;
      addTimelineEvent({
        time: `${hh}:${mm}`,
        category: "emotion",
        summary,
        details: state.microEvent,
        source: "narration",
      });
    } catch (err) {
      log.warn("failed to write micro-event to timeline", err);
    }
  }
  const ongoingThreads = threads.filter(t => t.status === "ongoing");
  if (ongoingThreads.length > 0) {
    console.log(`[emotion] Active threads: ${ongoingThreads.map(t => t.description).join(" | ")}`);
  }

  return state;
}

/**
 * Format emotional state as context for system prompt injection.
 * This is what the character "feels" right now — injected alongside time/space/work context.
 */
export function formatEmotionContext(state: EmotionalState, transition?: EmotionTransition | null): string {
  const lines: string[] = [];

  // Mood label — with transition annotation if significant
  let moodLine = `Current mood: ${state.mood}`;
  if (transition?.isSignificant && transition.previous) {
    moodLine += ` (shifted from "${transition.previous.mood}")`;
  }
  lines.push(moodLine);
  lines.push(`Cause: ${state.cause}`);
  lines.push(`Energy: ${state.energy}/10, Valence: ${state.valence}/10`);

  if (state.microEvent) {
    lines.push(`Small thing that happened today (this is real — must stay consistent in chat, don't fabricate a different version): ${state.microEvent}`);
  }

  if (state.behaviorHints) {
    lines.push(`State effects: ${state.behaviorHints}`);
  }

  // 5.2: Defense mechanism context
  if (state.defenseMechanism && state.defenseMechanism.type !== "none") {
    const dm = state.defenseMechanism;
    lines.push(`Defense mechanism: ${dm.type} — triggered by "${dm.trigger}", but on the surface talking about "${dm.surface}"`);
  }

  // Significant transition hint
  if (transition?.isSignificant && transition.transitionLabel) {
    lines.push(`${transition.transitionLabel} — noticeable mood shift, can mention naturally if the topic comes up`);
  }

  // 7.6: Emotional momentum — trending direction
  if (transition?.momentum && transition.momentum !== "stable") {
    const momentumLabels: Record<string, string> = {
      trending_up: "Emotional trend: improving",
      trending_down: "Emotional trend: declining",
      volatile: "Emotional trend: volatile",
    };
    const label = momentumLabels[transition.momentum];
    if (label) lines.push(label);
  }

  // Active narrative threads — ongoing storylines she can naturally reference
  const threadsStr = formatActiveThreads();
  if (threadsStr) {
    lines.push(`\nThings going on recently (can bring up naturally in chat):\n${threadsStr}`);
  }

  return lines.join("\n");
}

/**
 * Force a mood shift — call this when a significant real-time event happens
 * (e.g., market flash crash, breaking news about a company she covers).
 * Invalidates the cache so next getEmotionalState() generates fresh.
 */
export function invalidateEmotionCache(): void {
  if (!dataPath) return;
  const p = getEmotionCachePath();
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch (err) { log.warn("failed to invalidate emotion cache", err); }
  }
}
