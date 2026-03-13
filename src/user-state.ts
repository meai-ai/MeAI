/**
 * User State Tracker — Theory of Mind lite.
 *
 * Maintains a running model of the user's mental state: what they're focused on,
 * recent stressors, emotional trajectory, and unspoken needs. Updated from
 * conversations (post-turn extraction) and injected into system prompt.
 *
 * This is NOT the user's profile (stored in USER.md / core memories).
 * This is their *current* mental state — what they're thinking about right now.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("user-state");

// ── Types ────────────────────────────────────────────────────────────

export interface UserFocus {
  topic: string;         // e.g. "Eli's preschool choice"
  firstMentioned: number;
  lastMentioned: number;
  mentionCount: number;
}

export interface UserStressor {
  what: string;          // e.g. "high work pressure, working weekends too"
  detectedAt: number;
  lastMentioned: number;
  intensity: number;     // 0-1
}

export interface TemporalPattern {
  pattern: string;           // e.g. "Monday morning" | "Friday evening" | "weekend afternoon"
  observation: string;       // e.g. "usually talks about work pressure"
  confidence: number;        // 0-1, increases with more observations
  observationCount: number;
  lastObserved: number;
}

export interface UserPrediction {
  what: string;              // e.g. "he might be thinking about where to take the kids this weekend"
  basis: string;             // e.g. "he asked a similar question last Saturday"
  confidence: number;
  generatedAt: number;
}

export interface UserState {
  // Current focuses — what user is thinking about (max 5, LRU eviction)
  focuses: UserFocus[];

  // Active stressors — things weighing on them (max 3)
  stressors: UserStressor[];

  // Emotional trajectory — recent valence trend
  recentMoods: Array<{ valence: number; ts: number }>;  // last 5 conversation moods

  // Mood history — last 30 mood values for adaptive threshold calculation
  moodHistory: number[];

  // Unspoken needs — things the character senses but user hasn't asked for
  unspokenNeeds: string[];  // max 3, e.g. "might need someone to listen about work"

  // Temporal patterns — e.g. "Monday mornings he's usually stressed"
  temporalPatterns: TemporalPattern[];

  // Predicted current state — generated from patterns + time
  predictions: UserPrediction[];

  // Meta
  lastUpdated: number;
  /** All user state data is LLM-inferred from conversation */
  sourceType?: "observed" | "inferred" | "narrative";
}

// ── Module state ─────────────────────────────────────────────────────

let _statePath = "";
let _state: UserState = {
  focuses: [],
  stressors: [],
  recentMoods: [],
  moodHistory: [],
  unspokenNeeds: [],
  temporalPatterns: [],
  predictions: [],
  lastUpdated: 0,
};

function getFilePath(): string {
  return path.join(_statePath, "user-state.json");
}

function load(): void {
  _state = readJsonSafe<UserState>(getFilePath(), {
    focuses: [],
    stressors: [],
    recentMoods: [],
    moodHistory: [],
    unspokenNeeds: [],
    temporalPatterns: [],
    predictions: [],
    lastUpdated: 0,
  });
  // Backfill for existing state files missing new fields
  if (!_state.temporalPatterns) _state.temporalPatterns = [];
  if (!_state.predictions) _state.predictions = [];
  if (!_state.moodHistory) {
    // Seed from existing recentMoods if available
    _state.moodHistory = _state.recentMoods.map(m => m.valence);
  }
}

function save(): void {
  _state.lastUpdated = Date.now();
  writeJsonAtomic(getFilePath(), _state);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initUserState(statePath: string): void {
  _statePath = statePath;
  load();
  expireStale();
  log.info(`user-state: ${_state.focuses.length} focuses, ${_state.stressors.length} stressors`);
}

// ── Expiration ───────────────────────────────────────────────────────

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

function expireStale(): void {
  const now = Date.now();
  _state.focuses = _state.focuses.filter(f => now - f.lastMentioned < SEVEN_DAYS);
  _state.stressors = _state.stressors.filter(s => now - s.lastMentioned < THREE_DAYS);
  // Keep only last 5 moods
  _state.recentMoods = _state.recentMoods.slice(-5);
  // Unspoken needs expire with stressors
  if (_state.stressors.length === 0) _state.unspokenNeeds = [];
}

// ── Adaptive Thresholds ──────────────────────────────────────────────

/**
 * Compute mood classification thresholds from user's actual mood distribution.
 * Uses P30/P70 percentiles of the last 30 mood values. Falls back to 3/7 with
 * fewer than 5 data points.
 */
function getMoodThresholds(): { low: number; high: number } {
  if (_state.moodHistory.length < 5) return { low: 3, high: 7 };
  const sorted = [..._state.moodHistory].sort((a, b) => a - b);
  const p30 = sorted[Math.floor(sorted.length * 0.3)];
  const p70 = sorted[Math.floor(sorted.length * 0.7)];
  return { low: p30, high: p70 };
}

/**
 * Compute prediction confidence threshold from the distribution of stored
 * pattern confidences. Uses the median with a floor of 0.25 to avoid
 * triggering on noise. Falls back to 0.3 with fewer than 3 patterns.
 */
function getPredictionThreshold(): number {
  if (_state.temporalPatterns.length < 3) return 0.3;
  const sorted = _state.temporalPatterns.map(p => p.confidence).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(0.25, median);
}

// ── Update (called from loop.ts post-turn) ───────────────────────────

export interface UserStateUpdate {
  focuses?: string[];       // topics user mentioned or asked about
  stressor?: { what: string; intensity: number } | null;
  mood?: number;            // 0-10 valence detected in user's message
  unspokenNeed?: string | null;
}

export function updateUserState(update: UserStateUpdate): void {
  const now = Date.now();
  _state.sourceType = "inferred";

  // Update focuses
  if (update.focuses) {
    for (const topic of update.focuses) {
      if (!topic || topic.length < 2) continue;
      const existing = _state.focuses.find(f =>
        f.topic === topic || f.topic.includes(topic) || topic.includes(f.topic),
      );
      if (existing) {
        existing.lastMentioned = now;
        existing.mentionCount++;
        // Update topic to more specific version if longer
        if (topic.length > existing.topic.length) existing.topic = topic;
      } else {
        _state.focuses.push({
          topic,
          firstMentioned: now,
          lastMentioned: now,
          mentionCount: 1,
        });
      }
    }
    // Keep top 5 by recency
    _state.focuses.sort((a, b) => b.lastMentioned - a.lastMentioned);
    _state.focuses = _state.focuses.slice(0, 5);
  }

  // Update stressors
  if (update.stressor) {
    const existing = _state.stressors.find(s =>
      s.what.includes(update.stressor!.what.slice(0, 8)) ||
      update.stressor!.what.includes(s.what.slice(0, 8)),
    );
    if (existing) {
      existing.lastMentioned = now;
      existing.intensity = Math.max(existing.intensity, update.stressor.intensity);
    } else {
      _state.stressors.push({
        what: update.stressor.what,
        detectedAt: now,
        lastMentioned: now,
        intensity: update.stressor.intensity,
      });
      _state.stressors = _state.stressors.slice(-3);
    }
  }

  // Update mood trajectory
  if (update.mood !== undefined) {
    _state.recentMoods.push({ valence: update.mood, ts: now });
    _state.recentMoods = _state.recentMoods.slice(-5);
    // Track longer history for adaptive thresholds (last 30)
    _state.moodHistory.push(update.mood);
    _state.moodHistory = _state.moodHistory.slice(-30);
  }

  // Update unspoken needs
  if (update.unspokenNeed) {
    if (!_state.unspokenNeeds.includes(update.unspokenNeed)) {
      _state.unspokenNeeds.push(update.unspokenNeed);
      _state.unspokenNeeds = _state.unspokenNeeds.slice(-3);
    }
  }

  // Record temporal patterns from this update
  const nowDate = new Date();
  const bucket = getHourBucket(nowDate.getHours());
  const dayOfWeek = nowDate.getDay();

  const observations: string[] = [];
  if (update.focuses?.length) observations.push(`discussing ${update.focuses.slice(0, 2).join(" and ")}`);
  if (update.stressor) observations.push(`stressed: ${update.stressor.what.slice(0, 30)}`);
  if (update.mood !== undefined) {
    const { low, high } = getMoodThresholds();
    if (update.mood <= low) observations.push("low mood");
    else if (update.mood >= high) observations.push("good mood");
  }
  if (observations.length > 0) {
    recordTemporalPattern(dayOfWeek, bucket, observations.join(", "));
  }

  expireStale();
  save();
}

// ── Temporal Pattern Recognition ─────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function getHourBucket(hour: number): string {
  if (hour >= 0 && hour < 6) return "late-night";
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

/**
 * Record a temporal pattern from a conversation observation.
 * Called after each user state update with current day+hour and a summary.
 * Pure logic — no LLM calls.
 */
export function recordTemporalPattern(dayOfWeek: number, hourBucket: string, observation: string): void {
  if (!observation || observation.length < 3) return;
  const now = Date.now();
  const pattern = `${DAY_NAMES[dayOfWeek]}${hourBucket}`;

  // Try to merge with existing similar pattern (same day+bucket and overlapping observation)
  const existing = _state.temporalPatterns.find(p =>
    p.pattern === pattern && (
      p.observation.includes(observation.slice(0, 6)) ||
      observation.includes(p.observation.slice(0, 6))
    ),
  );

  if (existing) {
    existing.observationCount++;
    existing.lastObserved = now;
    // Confidence increases with repeated observations, capped at 0.95
    existing.confidence = Math.min(0.95, 0.2 + existing.observationCount * 0.15);
    // Update observation to the longer/more specific version
    if (observation.length > existing.observation.length) {
      existing.observation = observation;
    }
  } else {
    _state.temporalPatterns.push({
      pattern,
      observation,
      confidence: 0.2,
      observationCount: 1,
      lastObserved: now,
    });
  }

  // Keep max 10 patterns, evict lowest confidence first
  if (_state.temporalPatterns.length > 10) {
    _state.temporalPatterns.sort((a, b) => b.confidence - a.confidence);
    _state.temporalPatterns = _state.temporalPatterns.slice(0, 10);
  }

  // Expire patterns not observed in 30 days
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  _state.temporalPatterns = _state.temporalPatterns.filter(p => now - p.lastObserved < THIRTY_DAYS);
}

/**
 * Generate predictions based on current time matching stored temporal patterns.
 * Called from heartbeat. Pure logic — no LLM calls.
 */
export function generatePredictions(): void {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hour = now.getHours();
  const currentBucket = getHourBucket(hour);
  const currentPattern = `${DAY_NAMES[dayOfWeek]}${currentBucket}`;

  // Find matching patterns with sufficient confidence (adaptive threshold)
  const threshold = getPredictionThreshold();
  const matching = _state.temporalPatterns.filter(p =>
    p.pattern === currentPattern && p.confidence > threshold,
  );

  // Generate up to 3 predictions from matching patterns
  _state.predictions = matching
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map(p => ({
      what: `they might be ${p.observation}`,
      basis: `observed similar pattern ${p.observationCount} times on ${p.pattern}`,
      confidence: p.confidence,
      generatedAt: Date.now(),
    }));

  save();
}

/**
 * Format predictions as a short list for heartbeat/proactive context.
 */
export function formatPredictions(): string {
  if (_state.predictions.length === 0) return "";
  return _state.predictions
    .map(p => `${p.what} (${p.basis}, confidence ${Math.round(p.confidence * 100)}%)`)
    .join("; ");
}

// ── Context formatting (for system prompt) ───────────────────────────

export function formatUserStateContext(): string {
  expireStale();

  // Phase 2: Dense one-liner format
  const parts: string[] = [];

  if (_state.focuses.length > 0) {
    const items = _state.focuses.slice(0, 3).map(f => f.topic);
    parts.push(`focus: ${items.join(", ")}`);
  }

  if (_state.stressors.length > 0) {
    parts.push(`stress: ${_state.stressors.map(s => s.what).join(", ")}`);
  }

  if (_state.recentMoods.length >= 2) {
    const recent = _state.recentMoods.slice(-3);
    const trend = recent[recent.length - 1].valence - recent[0].valence;
    if (trend > 1) parts.push("mood improving");
    else if (trend < -1) parts.push("mood declining");
  }

  if (_state.unspokenNeeds.length > 0) {
    parts.push(`unspoken: ${_state.unspokenNeeds.slice(0, 2).join(", ")}`);
  }

  // Predictions -- inline, max 1
  if (_state.predictions.length > 0) {
    parts.push(`hunch: ${_state.predictions[0].what}`);
  }

  return parts.length > 0 ? `[user-state] ${parts.join(" | ")}` : "";
}

export function getUserState(): UserState {
  return _state;
}
