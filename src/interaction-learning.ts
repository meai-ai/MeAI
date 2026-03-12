/**
 * Interaction Learning (L13) — tracks implicit feedback signals from user's
 * behavior and learns what works.
 *
 * Pure statistical analysis — no LLM calls. Signals are recorded when:
 *   - The character sends a proactive message
 *   - The user replies (with depth/speed classification)
 *   - The user ignores a proactive message (no reply within 2 hours)
 *
 * Patterns are computed periodically (e.g. from heartbeat reflect action)
 * and surfaced to the proactive scheduler and heartbeat signal boosts.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("interaction-learning");

// ── Types ──────────────────────────────────────────────────────────────

interface InteractionSignal {
  timestamp: number;
  type:
    | "proactive_sent"
    | "proactive_ignored"
    | "proactive_replied"
    | "deep_reply"
    | "short_reply"
    | "quick_reply"
    | "delayed_reply";
  context?: string;
  topics?: string[];             // content topics associated with this signal
  hourBucket: HourBucket;
  dayType: DayType;
  replyLengthChars?: number;   // raw message length
  replyDelayMs?: number;       // raw delay
}

interface TopicPreference {
  topic: string;                 // normalized topic name
  engagementScore: number;       // 0-1 (weighted: reply rate × depth × speed)
  replyRate: number;             // 0-1
  avgDepth: number;              // 0-1 normalized
  avgSpeed: number;              // 0-1 (fast=1, slow=0)
  sampleCount: number;
  lastSeen: number;
}

interface BehavioralPattern {
  pattern: string;        // e.g. "weekend afternoon reply_rate 0.8"
  metric: string;         // "reply_rate" | "depth" | "speed"
  value: number;          // 0-1 normalized
  sampleCount: number;
  lastUpdated: number;
}

interface WeeklyReport {
  generatedAt: number;
  summary: string;
  replyRate: number;
  avgResponseDepth: number;
  bestTiming: string;
  worstTiming: string;
}

interface AdaptiveThresholds {
  depthP25: number;    // 25th percentile of reply lengths → below = short
  depthP75: number;    // 75th percentile → above = deep
  speedP25: number;    // 25th percentile of reply delays (ms) → below = quick
  speedP75: number;    // 75th percentile → above = delayed
  sampleCount: number;
  lastComputed: number;
}

interface ResponseQualityEntry {
  timestamp: number;
  relevance: number;
  depth: number;
  tone: "matched" | "too_formal" | "too_casual";
  missed?: string;
}

// ── 4.2: Style-Reaction Pairing types ───────────────────────────────

export interface ResponseStyleFeatures {
  responseLength: number;
  hasQuestion: boolean;
  hasCallback: boolean;         // referenced past conversation
  hasEmpathy: boolean;          // empathy markers
  hasOpinion: boolean;          // opinion markers
  hasHumor: boolean;            // humor/banter markers
  hasVulnerability: boolean;    // self-disclosure markers
  openingType: "question" | "empathy" | "banter" | "info" | "reaction" | "other";
  conversationMode?: string;
  topics: string[];
}

export interface UserReactionSignals {
  replyDelayMs: number;
  replyLengthChars: number;
  topicContinued: boolean;
  followUpQuestion: boolean;
}

export interface StyleReactionPair {
  timestamp: number;
  style: ResponseStyleFeatures;
  reaction: UserReactionSignals;
  qualitySignal: number;        // composite 0-1
  pairingConfidence: number;    // how clean this pairing is (0-1)
}

/** User-specific relational pattern — NOT a universal truth */
export interface RelationalPattern {
  feature: string;              // "hasEmpathy" | "hasCallback" | ...
  condition?: string;           // optional mode: "emotional" | "casual"
  avgQuality: number;
  avgQualityWithout: number;
  lift: number;                 // avgQuality - avgQualityWithout
  sampleCount: number;
  label: string;                // e.g. "use empathy opening in emotional topics (effective for user)"
}

interface InteractionLearningState {
  signals: InteractionSignal[];
  patterns: BehavioralPattern[];
  topicPreferences?: TopicPreference[];   // content preference scores
  weeklyReport?: WeeklyReport;
  lastProactiveSentAt?: number;    // tracking for ignore detection
  lastProactiveContext?: string;
  lastProactiveTopics?: string[];  // topics of the pending proactive message
  adaptiveThresholds?: AdaptiveThresholds;
  responseQuality?: ResponseQualityEntry[];  // recent response quality assessments
  // 4.2: Style-reaction learning
  styleLearning?: {
    pairs: StyleReactionPair[];           // max 200
    patterns: RelationalPattern[];
    lastComputedAt: number;
  };
  // Keyed by session ID to prevent cross-session contamination
  pendingBySession?: Record<string, {
    features: ResponseStyleFeatures;
    timestamp: number;
    assistantContent: string;  // for topic overlap check
  }>;
}

type HourBucket = "morning" | "afternoon" | "evening" | "late_night";
type DayType = "workday" | "weekend";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_SIGNALS = 200;
const MAX_PATTERNS = 20;
const IGNORE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── Module state ───────────────────────────────────────────────────────

let statePath = "";
let filePath = "";

const DEFAULT_STATE: InteractionLearningState = {
  signals: [],
  patterns: [],
};

// ── Helpers ────────────────────────────────────────────────────────────

function getHourBucket(date?: Date): HourBucket {
  const d = date ?? new Date();
  const pst = new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const hour = pst.getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 24) return "evening";
  return "late_night";
}

function getDayType(date?: Date): DayType {
  const d = date ?? new Date();
  const pst = new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = pst.getDay();
  return (day === 0 || day === 6) ? "weekend" : "workday";
}

function loadState(): InteractionLearningState {
  return readJsonSafe<InteractionLearningState>(filePath, { ...DEFAULT_STATE });
}

function saveState(state: InteractionLearningState): void {
  writeJsonAtomic(filePath, state);
}

function addSignal(signal: InteractionSignal): void {
  const state = loadState();
  state.signals.push(signal);
  // Rolling window — evict oldest
  if (state.signals.length > MAX_SIGNALS) {
    state.signals = state.signals.slice(-MAX_SIGNALS);
  }
  saveState(state);
}

// ── Adaptive thresholds ───────────────────────────────────────────────

const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
  depthP25: 20,
  depthP75: 200,
  speedP25: 5 * 60 * 1000,     // 5 minutes
  speedP75: 60 * 60 * 1000,    // 60 minutes
  sampleCount: 0,
  lastComputed: 0,
};

const MIN_ADAPTIVE_SAMPLES = 10;

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function recomputeAdaptiveThresholds(): void {
  const state = loadState();
  const replySignals = state.signals.filter(
    s => s.type === "proactive_replied" && s.replyLengthChars != null && s.replyDelayMs != null
  );

  if (replySignals.length < MIN_ADAPTIVE_SAMPLES) {
    // Not enough data — clear adaptive thresholds so we fall back to defaults
    state.adaptiveThresholds = undefined;
    saveState(state);
    return;
  }

  const lengths = replySignals.map(s => s.replyLengthChars!).sort((a, b) => a - b);
  const delays = replySignals.map(s => s.replyDelayMs!).sort((a, b) => a - b);

  state.adaptiveThresholds = {
    depthP25: percentile(lengths, 0.25),
    depthP75: percentile(lengths, 0.75),
    speedP25: percentile(delays, 0.25),
    speedP75: percentile(delays, 0.75),
    sampleCount: replySignals.length,
    lastComputed: Date.now(),
  };
  saveState(state);
  log.info(`Recomputed adaptive thresholds from ${replySignals.length} samples: depth [${state.adaptiveThresholds.depthP25}, ${state.adaptiveThresholds.depthP75}], speed [${state.adaptiveThresholds.speedP25}ms, ${state.adaptiveThresholds.speedP75}ms]`);
}

function getAdaptiveThresholds(): AdaptiveThresholds {
  const state = loadState();
  if (state.adaptiveThresholds && state.adaptiveThresholds.sampleCount >= MIN_ADAPTIVE_SAMPLES) {
    return state.adaptiveThresholds;
  }
  return DEFAULT_THRESHOLDS;
}

// ── Public API ─────────────────────────────────────────────────────────

/** Initialize the module — call once at startup. */
export function initInteractionLearning(sp: string): void {
  statePath = sp;
  filePath = path.join(sp, "interaction-learning.json");
  log.info("Initialized");
}

/**
 * Record that the character sent a proactive message.
 * Also checks if the previous proactive was ignored (no reply within 2h).
 */
export function recordProactiveSent(context?: string, topics?: string[]): void {
  if (!filePath) return;
  const now = Date.now();
  const state = loadState();

  // Check if previous proactive was ignored
  if (
    state.lastProactiveSentAt &&
    now - state.lastProactiveSentAt > IGNORE_THRESHOLD_MS
  ) {
    // No reply was recorded since lastProactiveSentAt → ignored
    const lastSentDate = new Date(state.lastProactiveSentAt);
    addSignal({
      timestamp: state.lastProactiveSentAt,
      type: "proactive_ignored",
      context: state.lastProactiveContext,
      topics: state.lastProactiveTopics,
      hourBucket: getHourBucket(lastSentDate),
      dayType: getDayType(lastSentDate),
    });
    log.info("Previous proactive was ignored");
  }

  // Record this send
  const signal: InteractionSignal = {
    timestamp: now,
    type: "proactive_sent",
    context,
    topics,
    hourBucket: getHourBucket(),
    dayType: getDayType(),
  };
  addSignal(signal);

  // Update tracking fields
  const freshState = loadState();
  freshState.lastProactiveSentAt = now;
  freshState.lastProactiveContext = context;
  freshState.lastProactiveTopics = topics;
  saveState(freshState);

  log.info(`Proactive sent recorded (${getHourBucket()} / ${getDayType()})`);
}

/**
 * Record that the user replied to a proactive message.
 * Call this when a user message arrives and there's a pending proactive.
 */
export function recordUserReply(messageLength: number, delayMs: number): void {
  if (!filePath) return;
  const state = loadState();

  if (!state.lastProactiveSentAt) return; // no pending proactive

  const sentDate = new Date(state.lastProactiveSentAt);
  const bucket = getHourBucket(sentDate);
  const dayType = getDayType(sentDate);

  const replyTopics = state.lastProactiveTopics;

  // Record the reply (with raw metrics for adaptive threshold computation)
  addSignal({
    timestamp: Date.now(),
    type: "proactive_replied",
    context: state.lastProactiveContext,
    topics: replyTopics,
    hourBucket: bucket,
    dayType,
    replyLengthChars: messageLength,
    replyDelayMs: delayMs,
  });

  // Classify depth using adaptive thresholds
  const thresholds = getAdaptiveThresholds();
  if (messageLength > thresholds.depthP75) {
    addSignal({
      timestamp: Date.now(),
      type: "deep_reply",
      context: state.lastProactiveContext,
      topics: replyTopics,
      hourBucket: bucket,
      dayType,
    });
  } else if (messageLength < thresholds.depthP25) {
    addSignal({
      timestamp: Date.now(),
      type: "short_reply",
      context: state.lastProactiveContext,
      topics: replyTopics,
      hourBucket: bucket,
      dayType,
    });
  }

  // Classify speed using adaptive thresholds
  if (delayMs < thresholds.speedP25) {
    addSignal({
      timestamp: Date.now(),
      type: "quick_reply",
      context: state.lastProactiveContext,
      topics: replyTopics,
      hourBucket: bucket,
      dayType,
    });
  } else if (delayMs > thresholds.speedP75) {
    addSignal({
      timestamp: Date.now(),
      type: "delayed_reply",
      context: state.lastProactiveContext,
      topics: replyTopics,
      hourBucket: bucket,
      dayType,
    });
  }

  // Clear pending proactive
  const freshState = loadState();
  freshState.lastProactiveSentAt = undefined;
  freshState.lastProactiveContext = undefined;
  freshState.lastProactiveTopics = undefined;
  saveState(freshState);

  log.info(`User reply recorded: ${messageLength} chars, ${Math.round(delayMs / 60000)}min delay`);
}

/**
 * Record that the user ignored the last proactive message (explicit call).
 * Normally detected automatically by recordProactiveSent, but can be called directly.
 */
export function recordProactiveIgnored(): void {
  if (!filePath) return;
  const state = loadState();
  if (!state.lastProactiveSentAt) return;

  addSignal({
    timestamp: state.lastProactiveSentAt,
    type: "proactive_ignored",
    context: state.lastProactiveContext,
    topics: state.lastProactiveTopics,
    hourBucket: getHourBucket(new Date(state.lastProactiveSentAt)),
    dayType: getDayType(new Date(state.lastProactiveSentAt)),
  });

  // Clear pending
  state.lastProactiveSentAt = undefined;
  state.lastProactiveContext = undefined;
  state.lastProactiveTopics = undefined;
  saveState(state);

  log.info("Proactive ignored recorded");
}

/**
 * Check whether there's a pending proactive message (for reply detection).
 * Returns { pending, sentAt } — sentAt is undefined if no pending.
 */
export function getPendingProactive(): { pending: boolean; sentAt?: number } {
  if (!filePath) return { pending: false };
  const state = loadState();
  if (!state.lastProactiveSentAt) return { pending: false };
  return { pending: true, sentAt: state.lastProactiveSentAt };
}

/**
 * Compute behavioral patterns from accumulated signals.
 * Call periodically (e.g. from heartbeat reflect).
 */
export function computePatterns(): void {
  if (!filePath) return;
  const state = loadState();
  const signals = state.signals;
  if (signals.length < 5) return; // not enough data

  const groups = new Map<string, InteractionSignal[]>();
  for (const s of signals) {
    const key = `${s.dayType}_${s.hourBucket}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const patterns: BehavioralPattern[] = [];
  const now = Date.now();

  for (const [key, groupSignals] of groups) {
    const [dayType, hourBucket] = key.split("_");
    const label = `${dayType === "weekend" ? "weekend" : "workday"} ${hourBucket}`;

    const sent = groupSignals.filter(s => s.type === "proactive_sent").length;
    const replied = groupSignals.filter(s => s.type === "proactive_replied").length;
    const ignored = groupSignals.filter(s => s.type === "proactive_ignored").length;

    // Reply rate
    const totalOutcomes = replied + ignored;
    if (totalOutcomes >= 2) {
      const replyRate = replied / totalOutcomes;
      patterns.push({
        pattern: `${label} reply_rate ${replyRate.toFixed(2)}`,
        metric: "reply_rate",
        value: replyRate,
        sampleCount: totalOutcomes,
        lastUpdated: now,
      });
    }

    // Depth: ratio of deep replies vs all replies
    const deepReplies = groupSignals.filter(s => s.type === "deep_reply").length;
    const shortReplies = groupSignals.filter(s => s.type === "short_reply").length;
    const totalDepthSignals = deepReplies + shortReplies;
    if (totalDepthSignals >= 2) {
      const depth = deepReplies / totalDepthSignals;
      patterns.push({
        pattern: `${label} depth ${depth.toFixed(2)}`,
        metric: "depth",
        value: depth,
        sampleCount: totalDepthSignals,
        lastUpdated: now,
      });
    }

    // Speed: ratio of quick replies vs all speed signals
    const quickReplies = groupSignals.filter(s => s.type === "quick_reply").length;
    const delayedReplies = groupSignals.filter(s => s.type === "delayed_reply").length;
    const totalSpeedSignals = quickReplies + delayedReplies;
    if (totalSpeedSignals >= 2) {
      const speed = quickReplies / totalSpeedSignals;
      patterns.push({
        pattern: `${label} speed ${speed.toFixed(2)}`,
        metric: "speed",
        value: speed,
        sampleCount: totalSpeedSignals,
        lastUpdated: now,
      });
    }
  }

  // Keep top patterns by sample count, cap at MAX_PATTERNS
  patterns.sort((a, b) => b.sampleCount - a.sampleCount);
  state.patterns = patterns.slice(0, MAX_PATTERNS);
  saveState(state);

  log.info(`Computed ${state.patterns.length} patterns from ${signals.length} signals`);

  // Update adaptive thresholds from raw reply data
  recomputeAdaptiveThresholds();

  // Update topic preferences
  computeTopicPreferences();

  // 4.2: Update relational patterns from style-reaction pairs
  computeRelationalPatterns();
}

// ── Topic Preference Learning ───────────────────────────────────────

const MAX_TOPIC_PREFS = 30;

function normalizeTopic(t: string): string {
  return t.toLowerCase().replace(/\s+/g, "").trim();
}

/**
 * Compute per-topic engagement scores from signals that have topics.
 * Groups signals by topic, calculates reply_rate × depth × speed → engagementScore.
 */
function computeTopicPreferences(): void {
  const state = loadState();
  const signals = state.signals;

  // Collect topic → signals mapping
  const topicSignals = new Map<string, InteractionSignal[]>();
  for (const s of signals) {
    if (!s.topics) continue;
    for (const t of s.topics) {
      const norm = normalizeTopic(t);
      if (norm.length < 2) continue;
      if (!topicSignals.has(norm)) topicSignals.set(norm, []);
      topicSignals.get(norm)!.push(s);
    }
  }

  const thresholds = getAdaptiveThresholds();
  const prefs: TopicPreference[] = [];

  for (const [topic, sigs] of topicSignals) {
    const sent = sigs.filter(s => s.type === "proactive_sent").length;
    const replied = sigs.filter(s => s.type === "proactive_replied").length;
    const ignored = sigs.filter(s => s.type === "proactive_ignored").length;
    const outcomes = replied + ignored;
    if (outcomes < 1) continue; // need at least 1 outcome

    const replyRate = outcomes > 0 ? replied / outcomes : 0;

    // Depth: average reply length normalized by P75
    const replyLengths = sigs
      .filter(s => s.type === "proactive_replied" && s.replyLengthChars != null)
      .map(s => s.replyLengthChars!);
    const avgLength = replyLengths.length > 0
      ? replyLengths.reduce((a, b) => a + b, 0) / replyLengths.length
      : 0;
    const avgDepth = Math.min(1, avgLength / Math.max(thresholds.depthP75, 50));

    // Speed: average delay normalized inversely by P75
    const replyDelays = sigs
      .filter(s => s.type === "proactive_replied" && s.replyDelayMs != null)
      .map(s => s.replyDelayMs!);
    const avgDelay = replyDelays.length > 0
      ? replyDelays.reduce((a, b) => a + b, 0) / replyDelays.length
      : thresholds.speedP75;
    const avgSpeed = Math.max(0, 1 - avgDelay / Math.max(thresholds.speedP75, 60_000));

    // Engagement = weighted combination: reply_rate matters most
    const engagement = replyRate * 0.5 + avgDepth * 0.3 + avgSpeed * 0.2;

    const lastSeen = Math.max(...sigs.map(s => s.timestamp));

    // Use the original (non-normalized) topic name from the most recent signal
    const originalTopic = sigs
      .filter(s => s.topics)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
      ?.topics?.find(t => normalizeTopic(t) === topic) ?? topic;

    prefs.push({
      topic: originalTopic,
      engagementScore: Math.round(engagement * 100) / 100,
      replyRate: Math.round(replyRate * 100) / 100,
      avgDepth: Math.round(avgDepth * 100) / 100,
      avgSpeed: Math.round(avgSpeed * 100) / 100,
      sampleCount: outcomes,
      lastSeen,
    });
  }

  // Sort by engagement, keep top N
  prefs.sort((a, b) => b.engagementScore - a.engagementScore);
  state.topicPreferences = prefs.slice(0, MAX_TOPIC_PREFS);
  saveState(state);

  if (prefs.length > 0) {
    log.info(`Topic preferences: ${prefs.slice(0, 5).map(p => `${p.topic}(${p.engagementScore})`).join(", ")}`);
  }
}

/**
 * Get topic preferences for other modules (curiosity, proactive, heartbeat).
 */
export function getTopicPreferences(): {
  preferred: string[];   // topics user engages with (engagement > 0.5)
  avoided: string[];     // topics user ignores (engagement < 0.2)
  all: TopicPreference[];
} {
  if (!filePath) return { preferred: [], avoided: [], all: [] };
  const state = loadState();
  const prefs = state.topicPreferences ?? [];

  const preferred = prefs
    .filter(p => p.engagementScore >= 0.5 && p.sampleCount >= 2)
    .map(p => p.topic);
  const avoided = prefs
    .filter(p => p.engagementScore <= 0.2 && p.sampleCount >= 2)
    .map(p => p.topic);

  return { preferred, avoided, all: prefs };
}

/**
 * Lightweight topic extraction from a text message.
 * Extracts Chinese noun phrases (2-6 chars between punctuation) and
 * English multi-word terms. No LLM call — pure heuristic.
 */
export function extractTopicsFromText(text: string): string[] {
  const topics: string[] = [];
  // English: extract capitalized words or multi-word terms
  const enMatches = text.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) ?? [];
  for (const m of enMatches) {
    if (m.length >= 3 && !["The", "This", "That", "What", "How", "Why"].includes(m)) {
      topics.push(m);
    }
  }
  // Deduplicate and limit
  return [...new Set(topics)].slice(0, 5);
}

/**
 * Format topic preference insights for heartbeat/proactive context.
 */
export function formatTopicPreferences(): string {
  const { preferred, avoided } = getTopicPreferences();
  if (preferred.length === 0 && avoided.length === 0) return "";

  const parts: string[] = [];
  if (preferred.length > 0) {
    parts.push(`Topics user is interested in: ${preferred.slice(0, 5).join(", ")}`);
  }
  if (avoided.length > 0) {
    parts.push(`Topics user rarely responds to: ${avoided.slice(0, 3).join(", ")}`);
  }
  return parts.join(" | ");
}

/**
 * Get timing advice for the proactive scheduler.
 * Returns best/worst times and overall reply rate.
 */
export function getTimingAdvice(): {
  bestTimes: string[];
  avoidTimes: string[];
  replyRate: number;
} {
  if (!filePath) return { bestTimes: [], avoidTimes: [], replyRate: 0 };
  const state = loadState();
  const replyPatterns = state.patterns.filter(p => p.metric === "reply_rate");

  if (replyPatterns.length === 0) {
    return { bestTimes: [], avoidTimes: [], replyRate: 0 };
  }

  const sorted = [...replyPatterns].sort((a, b) => b.value - a.value);
  const bestTimes = sorted
    .filter(p => p.value >= 0.6 && p.sampleCount >= 3)
    .map(p => {
      const label = p.pattern.split(" ")[0];
      return `${label}(${Math.round(p.value * 100)}%)`;
    });
  const avoidTimes = sorted
    .filter(p => p.value <= 0.3 && p.sampleCount >= 3)
    .map(p => {
      const label = p.pattern.split(" ")[0];
      return `${label}(${Math.round(p.value * 100)}%)`;
    });

  // Overall reply rate
  const totalReplied = state.signals.filter(s => s.type === "proactive_replied").length;
  const totalIgnored = state.signals.filter(s => s.type === "proactive_ignored").length;
  const overallRate = (totalReplied + totalIgnored) > 0
    ? totalReplied / (totalReplied + totalIgnored)
    : 0;

  return { bestTimes, avoidTimes, replyRate: overallRate };
}

/**
 * Format a concise learning context for the system prompt or heartbeat.
 */
export function formatLearningContext(): string {
  if (!filePath) return "";
  const advice = getTimingAdvice();
  if (advice.bestTimes.length === 0 && advice.avoidTimes.length === 0) return "";

  const parts: string[] = [];
  parts.push(`Overall reply rate: ${Math.round(advice.replyRate * 100)}%`);
  if (advice.bestTimes.length > 0) {
    parts.push(`Highest reply rate: ${advice.bestTimes.join(", ")}`);
  }
  if (advice.avoidTimes.length > 0) {
    parts.push(`Lowest reply rate: ${advice.avoidTimes.join(", ")}`);
  }

  // Add depth/speed insights
  const state = loadState();
  const depthPatterns = state.patterns
    .filter(p => p.metric === "depth" && p.value >= 0.6 && p.sampleCount >= 3);
  if (depthPatterns.length > 0) {
    const labels = depthPatterns.map(p => p.pattern.split(" ")[0]);
    parts.push(`More deep conversations: ${labels.join(", ")}`);
  }

  // Add topic preferences
  const topicCtx = formatTopicPreferences();
  if (topicCtx) parts.push(topicCtx);

  return parts.join(" | ");
}

/**
 * Record response quality assessment.
 */
export function recordResponseQuality(rq: {
  relevance: number;
  depth: number;
  tone: "matched" | "too_formal" | "too_casual";
  missed?: string;
}): void {
  if (!filePath) return;
  const state = loadState();
  if (!state.responseQuality) state.responseQuality = [];
  state.responseQuality.push({
    timestamp: Date.now(),
    relevance: rq.relevance,
    depth: rq.depth,
    tone: rq.tone,
    missed: rq.missed ?? undefined,
  });
  // Keep last 50 entries
  if (state.responseQuality.length > 50) {
    state.responseQuality = state.responseQuality.slice(-50);
  }
  saveState(state);
}

export function getResponseQualityStats(): { avgRelevance: number; avgDepth: number; toneMismatchRate: number; recentMisses: string[] } | null {
  if (!filePath) return null;
  const state = loadState();
  const entries = state.responseQuality ?? [];
  if (entries.length < 5) return null;

  const recent = entries.slice(-20);
  const avgRelevance = recent.reduce((s, e) => s + e.relevance, 0) / recent.length;
  const avgDepth = recent.reduce((s, e) => s + e.depth, 0) / recent.length;
  const toneMismatchRate = recent.filter(e => e.tone !== "matched").length / recent.length;
  const recentMisses = recent.filter(e => e.missed).map(e => e.missed!).slice(-3);

  return { avgRelevance, avgDepth, toneMismatchRate, recentMisses };
}

export function generateWeeklyReport(): string {
  if (!filePath) return "";
  const state = loadState();
  const signals = state.signals;

  // Filter to last 7 days
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekSignals = signals.filter(s => s.timestamp >= weekAgo);

  if (weekSignals.length < 3) return "Not enough data this week for a report.";

  const sent = weekSignals.filter(s => s.type === "proactive_sent").length;
  const replied = weekSignals.filter(s => s.type === "proactive_replied").length;
  const ignored = weekSignals.filter(s => s.type === "proactive_ignored").length;
  const deepReplies = weekSignals.filter(s => s.type === "deep_reply").length;
  const quickReplies = weekSignals.filter(s => s.type === "quick_reply").length;

  const replyRate = (replied + ignored) > 0 ? replied / (replied + ignored) : 0;
  const depthRate = replied > 0 ? deepReplies / replied : 0;

  const advice = getTimingAdvice();

  const report = [
    `Weekly Interaction Learning Report`,
    `Proactive messages: ${sent}`,
    `Reply rate: ${Math.round(replyRate * 100)}% (${replied} replied / ${ignored} ignored)`,
    `Deep reply ratio: ${Math.round(depthRate * 100)}%`,
    `Quick replies: ${quickReplies}`,
    advice.bestTimes.length > 0 ? `Best times: ${advice.bestTimes.join(", ")}` : "",
    advice.avoidTimes.length > 0 ? `Avoid times: ${advice.avoidTimes.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  // Save weekly report
  state.weeklyReport = {
    generatedAt: Date.now(),
    summary: report,
    replyRate,
    avgResponseDepth: depthRate,
    bestTiming: advice.bestTimes[0] ?? "none",
    worstTiming: advice.avoidTimes[0] ?? "none",
  };
  saveState(state);

  return report;
}

// ── 4.2: Style-Reaction Learning ────────────────────────────────────

const MAX_STYLE_PAIRS = 200;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// English stop words — common function words
const EN_CONTENT_STOP_WORDS = new Set([
  "the", "is", "at", "to", "in", "on", "it", "and", "or", "of", "a", "an",
  "for", "by", "be", "am", "are", "was", "were", "been", "being", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "this", "that", "with", "from", "but", "not",
]);

/**
 * Extract content words from text for topic overlap.
 * English: whitespace-tokenized, lowercased, stop-word removed.
 */
export function extractContentWords(text: string): Set<string> {
  const words = new Set<string>();

  // English words
  const englishWords = text.match(/[a-zA-Z]{2,}/g) ?? [];
  for (const w of englishWords) {
    const lower = w.toLowerCase();
    if (!EN_CONTENT_STOP_WORDS.has(lower)) words.add(lower);
  }

  return words;
}

/**
 * Check if there is meaningful topic overlap between two texts.
 * Uses content-word Jaccard similarity >= 0.1.
 */
export function hasTopicOverlap(assistantText: string, userText: string): boolean {
  const assistantWords = extractContentWords(assistantText);
  const userWords = extractContentWords(userText);
  if (assistantWords.size === 0 || userWords.size === 0) return false;

  let intersection = 0;
  for (const w of userWords) {
    if (assistantWords.has(w)) intersection++;
  }
  const union = new Set([...assistantWords, ...userWords]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  return jaccard >= 0.1;
}

/**
 * Extract response style features from an assistant response.
 */
export function extractResponseStyleFeatures(
  response: string,
  conversationMode?: string,
  topics?: string[],
): ResponseStyleFeatures {
  const firstChunk = response.slice(0, 200);

  const hasQuestion = /[?]/.test(firstChunk.slice(0, 80));
  const hasEmpathy = /feel|feeling|understand|tough|not easy|heartache/i.test(firstChunk);
  const hasCallback = /last time|before|remember you|you said|you mentioned/i.test(firstChunk);
  const hasOpinion = /I think|I'd say|disagree|my view|I believe/i.test(firstChunk);
  const hasHumor = /haha|lol|lmao|funny|hilarious/i.test(firstChunk);
  const hasVulnerability = /honestly|to be honest|actually I|truth is|I admit/i.test(firstChunk);

  // Classify opening type
  let openingType: ResponseStyleFeatures["openingType"] = "other";
  const opening = response.slice(0, 30);
  if (/^[^.!?]{0,10}[?]/.test(opening)) openingType = "question";
  else if (/^(I feel|I understand|that's tough|not easy)/i.test(opening)) openingType = "empathy";
  else if (/^(haha|lol|oh man|that's funny)/i.test(opening)) openingType = "banter";
  else if (/^(by the way|speaking of|about|actually)/i.test(opening)) openingType = "info";
  else if (/^(oh|wow|really|no way|wait)/i.test(opening)) openingType = "reaction";

  return {
    responseLength: response.length,
    hasQuestion,
    hasCallback,
    hasEmpathy,
    hasOpinion,
    hasHumor,
    hasVulnerability,
    openingType,
    conversationMode,
    topics: topics ?? [],
  };
}

/**
 * Strict pairing gate: only record pair when all conditions are met.
 */
export function isPairingValid(
  assistantTimestamp: number,
  assistantContent: string,
  userTimestamp: number,
  userContent: string,
  hasInterveningAssistant: boolean,
): boolean {
  // 1. No intervening assistant messages
  if (hasInterveningAssistant) return false;

  const delay = userTimestamp - assistantTimestamp;

  // 2. Reply within reasonable window (< 24h) and not negative
  if (delay > 24 * 60 * 60 * 1000 || delay < 0) return false;

  // 3. Not cross-sleep window (> 6h gap = likely sleep/work)
  if (delay > 6 * 60 * 60 * 1000) return false;

  // 4. Short-reply exception
  const isShortReply = userContent.length < 15;
  if (isShortReply) {
    const trimmed = userContent.trim();
    const STRONG_REACTIVE = /^(haha|lol|really|exactly|right|totally|wow|no way)/i.test(trimmed);
    const WEAK_REACTIVE = /^(ok|sure|yeah|yep|cool|fine)$/i.test(trimmed);
    // Use adaptive speedP25 from user's actual reply speed distribution
    const fastReplyThreshold = getAdaptiveThresholds().speedP25;
    const hasFastReply = delay < fastReplyThreshold;

    if (STRONG_REACTIVE) return true;
    if (WEAK_REACTIVE && hasFastReply) return true;
    // Weak reactive + slow reply = likely polite closure, skip
    if (WEAK_REACTIVE) return false;
  }

  // Normal-length reply: require topic overlap
  if (!hasTopicOverlap(assistantContent, userContent)) return false;

  return true;
}

/**
 * Compute user's reaction signals from a reply.
 */
export function computeUserReaction(
  assistantTimestamp: number,
  assistantContent: string,
  userTimestamp: number,
  userContent: string,
): UserReactionSignals {
  return {
    replyDelayMs: userTimestamp - assistantTimestamp,
    replyLengthChars: userContent.length,
    topicContinued: hasTopicOverlap(assistantContent, userContent),
    followUpQuestion: /[?]/.test(userContent),
  };
}

/**
 * Compute quality signal from user's reaction (0-1).
 */
export function computeQualitySignal(reaction: UserReactionSignals): number {
  const thresholds = getAdaptiveThresholds();

  // Speed: normalized 0-1 (fast = 1, slow = 0)
  const speedScore = Math.max(0, Math.min(1,
    1 - reaction.replyDelayMs / Math.max(thresholds.speedP75, 60_000),
  ));

  // Depth: normalized 0-1 by adaptive thresholds
  const depthScore = Math.min(1, reaction.replyLengthChars / Math.max(thresholds.depthP75, 50));

  // Topic continued: binary 0 or 1
  const topicScore = reaction.topicContinued ? 1 : 0;

  // Follow-up question: binary 0 or 1
  const followUpScore = reaction.followUpQuestion ? 1 : 0;

  // Weighted composite
  const quality = 0.35 * speedScore + 0.25 * depthScore + 0.2 * topicScore + 0.2 * followUpScore;
  return Math.max(0, Math.min(1, quality));
}

/**
 * Store pending style features for a session.
 * Also sweeps stale entries (> 24h).
 */
export function storePendingStyleFeatures(
  sessionId: string,
  features: ResponseStyleFeatures,
  assistantContent: string,
): void {
  if (!filePath) return;
  const state = loadState();
  if (!state.pendingBySession) state.pendingBySession = {};

  // Sweep stale entries
  const now = Date.now();
  for (const [sid, pending] of Object.entries(state.pendingBySession)) {
    if (now - pending.timestamp > PENDING_TTL_MS) {
      delete state.pendingBySession[sid];
    }
  }

  state.pendingBySession[sessionId] = {
    features,
    timestamp: now,
    assistantContent: assistantContent.slice(0, 500),  // cap for storage
  };
  saveState(state);
}

/**
 * Get pending style features for a session. Returns null if none or stale.
 */
export function getPendingStyleFeatures(sessionId: string): {
  features: ResponseStyleFeatures;
  timestamp: number;
  assistantContent: string;
} | null {
  if (!filePath) return null;
  const state = loadState();
  const pending = state.pendingBySession?.[sessionId];
  if (!pending) return null;
  if (Date.now() - pending.timestamp > PENDING_TTL_MS) return null;
  return pending;
}

/**
 * Clear pending style features for a session.
 */
export function clearPendingStyleFeatures(sessionId: string): void {
  if (!filePath) return;
  const state = loadState();
  if (state.pendingBySession) {
    delete state.pendingBySession[sessionId];
    saveState(state);
  }
}

/**
 * Record a style-reaction pair into the rolling window.
 */
export function recordStyleReactionPair(
  style: ResponseStyleFeatures,
  reaction: UserReactionSignals,
  confidence: number,
): void {
  if (!filePath) return;
  const state = loadState();
  if (!state.styleLearning) {
    state.styleLearning = { pairs: [], patterns: [], lastComputedAt: 0 };
  }

  const quality = computeQualitySignal(reaction);
  state.styleLearning.pairs.push({
    timestamp: Date.now(),
    style,
    reaction,
    qualitySignal: quality,
    pairingConfidence: confidence,
  });

  // Rolling window
  if (state.styleLearning.pairs.length > MAX_STYLE_PAIRS) {
    state.styleLearning.pairs = state.styleLearning.pairs.slice(-MAX_STYLE_PAIRS);
  }

  saveState(state);
  log.info(`style-reaction pair recorded: quality=${quality.toFixed(2)}, confidence=${confidence}`);
}

// Feature labels for pattern computation
const BINARY_FEATURES: Array<{ key: keyof ResponseStyleFeatures; label: string }> = [
  { key: "hasQuestion", label: "questions" },
  { key: "hasCallback", label: "callbacks" },
  { key: "hasEmpathy", label: "empathy" },
  { key: "hasOpinion", label: "opinions" },
  { key: "hasHumor", label: "humor" },
  { key: "hasVulnerability", label: "self-disclosure" },
];

/**
 * Compute relational patterns from style-reaction pairs.
 * Per binary feature: avg quality with vs without → lift.
 * Patterns must have lift > 0.1 AND sampleCount >= 10.
 */
export function computeRelationalPatterns(): void {
  if (!filePath) return;
  const state = loadState();
  if (!state.styleLearning || state.styleLearning.pairs.length < 5) return;

  const pairs = state.styleLearning.pairs;
  const patterns: RelationalPattern[] = [];

  // Collect unique conversation modes for conditional analysis
  const modes = new Set(pairs.map(p => p.style.conversationMode).filter(Boolean));

  for (const { key, label } of BINARY_FEATURES) {
    const withFeature = pairs.filter(p => p.style[key] === true);
    const withoutFeature = pairs.filter(p => p.style[key] === false);

    if (withFeature.length < 3 || withoutFeature.length < 3) continue;

    const avgWith = withFeature.reduce((s, p) => s + p.qualitySignal, 0) / withFeature.length;
    const avgWithout = withoutFeature.reduce((s, p) => s + p.qualitySignal, 0) / withoutFeature.length;
    const lift = avgWith - avgWithout;

    // Sample-size-aware lift threshold: max(0.05, 0.5/sqrt(n))
    // At n=10→0.158, n=25→0.100, n=100→0.050
    const n = withFeature.length;
    const liftThreshold = Math.max(0.05, 0.5 / Math.sqrt(n));
    if (Math.abs(lift) > liftThreshold && n >= 5) {
      const direction = lift > 0 ? "use " : "less ";

      // Check if the effect is mode-conditional (e.g. empathy only helps in emotional mode)
      let condition: string | undefined;
      for (const mode of modes) {
        const modePairs = pairs.filter(p => p.style.conversationMode === mode);
        if (modePairs.length < 6) continue;
        const modeWith = modePairs.filter(p => p.style[key] === true);
        const modeWithout = modePairs.filter(p => p.style[key] === false);
        if (modeWith.length < 3 || modeWithout.length < 3) continue;
        const modeLift = (modeWith.reduce((s, p) => s + p.qualitySignal, 0) / modeWith.length) -
                         (modeWithout.reduce((s, p) => s + p.qualitySignal, 0) / modeWithout.length);
        // Sample-size-aware multiplier: n<10→2.0×, n<30→1.5×, n≥30→1.3×
        const modeN = modePairs.length;
        const modeMultiplier = modeN < 10 ? 2.0 : modeN < 30 ? 1.5 : 1.3;
        if (Math.abs(modeLift) > Math.abs(lift) * modeMultiplier) {
          condition = mode;
        }
      }

      const conditionLabel = condition ? `in ${condition} topics: ` : "";
      patterns.push({
        feature: key,
        condition,
        avgQuality: Math.round(avgWith * 100) / 100,
        avgQualityWithout: Math.round(avgWithout * 100) / 100,
        lift: Math.round(lift * 100) / 100,
        sampleCount: withFeature.length,
        label: `${conditionLabel}${direction}${label} (effective for user, lift=${lift.toFixed(2)}, n=${withFeature.length})`,
      });
    }
  }

  // Sort by absolute lift descending
  patterns.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
  state.styleLearning.patterns = patterns.slice(0, 10);
  state.styleLearning.lastComputedAt = Date.now();
  saveState(state);

  if (patterns.length > 0) {
    log.info(`relational patterns: ${patterns.map(p => `${p.feature}(lift=${p.lift})`).join(", ")}`);
  }
}

/**
 * Get top relational patterns for turn directive injection.
 */
export function getTopRelationalPatterns(n = 3): RelationalPattern[] {
  if (!filePath) return [];
  const state = loadState();
  if (!state.styleLearning?.patterns) return [];
  return state.styleLearning.patterns.slice(0, n);
}
