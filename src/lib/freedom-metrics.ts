/**
 * Freedom-Preserving Metrics — 5 reverse indicators to detect if
 * engineering constraints are killing the character's personality.
 *
 * All metrics computed from existing data (zero LLM cost).
 * Trend-only, never gating. Output to data/freedom-metrics.json.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe } from "./atomic-file.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { createLogger } from "./logger.js";

const log = createLogger("freedom-metrics");

// ── Types ────────────────────────────────────────────────────────────

export interface FreedomMetrics {
  timestamp: number;
  /** Opening-trigram diversity over last 20 responses (0-1, higher = more diverse). */
  spontaneity: number;
  /** Jaccard similarity between last 5 response pairs (0-1, lower = better). */
  selfRepetition: number;
  /** Ratio of messages with mood particles (0-1). Surface proxy only — NOT true emotional quality. */
  surfaceWarmth: number;
  /** % of turns where adherence improved but engagement dropped (0-1, lower = better). */
  overCorrection: number;
  /** Belief confidence variance — low variance = all converged (0-1, lower = better). */
  narrativeRigidity: number;
}

interface MetricsFile {
  latest: FreedomMetrics;
  history: FreedomMetrics[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_HISTORY = 30;
const MOOD_PARTICLES = ["呀", "诶", "嘛", "啦", "嗯", "吧", "哎", "噢", "哇", "呢", "吼", "欸"];

// ── Main computation ─────────────────────────────────────────────────

export function computeFreedomMetrics(statePath: string): FreedomMetrics {
  const sessionPath = path.join(statePath, "sessions", "main.jsonl");
  const assistantMessages = loadAssistantMessages(sessionPath, 30);

  return {
    timestamp: Date.now(),
    spontaneity: computeSpontaneity(assistantMessages),
    selfRepetition: computeSelfRepetition(assistantMessages),
    surfaceWarmth: computeSurfaceWarmth(assistantMessages),
    overCorrection: computeOverCorrection(statePath),
    narrativeRigidity: computeNarrativeRigidity(statePath),
  };
}

export function saveFreedomMetrics(statePath: string, metrics: FreedomMetrics): void {
  const filePath = path.join(statePath, "freedom-metrics.json");
  const existing = readJsonSafe<MetricsFile>(filePath, { latest: metrics, history: [] });

  existing.latest = metrics;
  existing.history.push(metrics);
  if (existing.history.length > MAX_HISTORY) {
    existing.history = existing.history.slice(-MAX_HISTORY);
  }

  writeJsonAtomic(filePath, existing);
  log.info(`saved: sp=${metrics.spontaneity.toFixed(2)} rep=${metrics.selfRepetition.toFixed(2)} warm=${metrics.surfaceWarmth.toFixed(2)} oc=${metrics.overCorrection.toFixed(2)} rigid=${metrics.narrativeRigidity.toFixed(2)}`);
}

export function loadFreedomMetricsHistory(statePath: string, days?: number): FreedomMetrics[] {
  const filePath = path.join(statePath, "freedom-metrics.json");
  const data = readJsonSafe<MetricsFile>(filePath, { latest: null as any, history: [] });
  if (!days) return data.history;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return data.history.filter(m => m.timestamp > cutoff);
}

// ── Individual metric computations ──────────────────────────────────

/**
 * Spontaneity: unique opening-trigram diversity over last 20 responses.
 * Higher = more diverse openings.
 */
function computeSpontaneity(messages: string[]): number {
  const recent = messages.slice(-20);
  if (recent.length < 5) return 0.5; // insufficient data

  const trigrams = new Set<string>();
  for (const msg of recent) {
    const chars = [...msg.trim()];
    if (chars.length >= 3) {
      trigrams.add(chars.slice(0, 3).join(""));
    }
  }

  // Diversity = unique trigrams / total messages (capped at 1.0)
  return Math.min(1, trigrams.size / recent.length);
}

/**
 * Self-repetition: average Jaccard similarity between consecutive response pairs.
 * Lower = better (less repetitive).
 */
function computeSelfRepetition(messages: string[]): number {
  const recent = messages.slice(-6); // need 5 pairs from 6 messages
  if (recent.length < 2) return 0;

  const tokenSets = recent.map(m => new Set(
    m.split(/[\s，。！？、；：""''（）()\n]+/).filter(t => t.length > 0),
  ));

  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length - 1; i++) {
    const a = tokenSets[i];
    const b = tokenSets[i + 1];
    let intersection = 0;
    for (const t of a) {
      if (b.has(t)) intersection++;
    }
    const union = new Set([...a, ...b]).size;
    if (union > 0) {
      totalSim += intersection / union;
      pairs++;
    }
  }

  return pairs > 0 ? totalSim / pairs : 0;
}

/**
 * Surface warmth: ratio of messages containing mood particles.
 * Surface proxy only — measures linguistic warmth markers, not true emotional quality.
 */
function computeSurfaceWarmth(messages: string[]): number {
  const recent = messages.slice(-20);
  if (recent.length < 5) return 0.5;

  let withMoodWords = 0;
  for (const msg of recent) {
    if (msg.length < 10) continue; // skip very short replies
    const has = MOOD_PARTICLES.some(w => msg.includes(w));
    if (has) withMoodWords++;
  }

  const countable = recent.filter(m => m.length >= 10).length;
  return countable > 0 ? withMoodWords / countable : 0.5;
}

/**
 * Over-correction: composite engagement proxy.
 * Fires when adherence improved turn-over-turn but engagement signal dropped.
 *
 * Engagement = weighted(reply latency delta, reply length delta, topic continuation).
 */
function computeOverCorrection(statePath: string): number {
  // Load prompt traces for adherence scores
  const tracesDir = path.join(statePath, "prompt-traces");
  if (!fs.existsSync(tracesDir)) return 0;

  // Load session for user reply data
  const sessionPath = path.join(statePath, "sessions", "main.jsonl");
  const sessionLines = loadSessionLines(sessionPath, 40);
  if (sessionLines.length < 4) return 0;

  // Build turn pairs: (assistant reply, user reply after it)
  interface TurnPair {
    assistantTs: number;
    assistantLen: number;
    assistantContent: string;
    userTs: number;
    userLen: number;
    userContent: string;
  }

  const pairs: TurnPair[] = [];
  for (let i = 0; i < sessionLines.length - 1; i++) {
    const cur = sessionLines[i];
    const next = sessionLines[i + 1];
    if (cur.role === "assistant" && next.role === "user") {
      pairs.push({
        assistantTs: cur.timestamp ?? 0,
        assistantLen: (cur.content ?? "").length,
        assistantContent: cur.content ?? "",
        userTs: next.timestamp ?? 0,
        userLen: (next.content ?? "").length,
        userContent: next.content ?? "",
      });
    }
  }

  if (pairs.length < 3) return 0;

  // Check consecutive pairs for "adherence up but engagement down"
  let overCorrectionCount = 0;
  let comparisons = 0;

  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const curr = pairs[i];

    // Reply latency delta (higher = user took longer → possible disengagement)
    const prevLatency = prev.userTs - prev.assistantTs;
    const currLatency = curr.userTs - curr.assistantTs;
    const latencyDelta = prevLatency > 0 && currLatency > 0
      ? (currLatency - prevLatency) / Math.max(prevLatency, 1000)
      : 0;

    // Reply length delta (shorter → possible disengagement)
    const lengthDelta = prev.userLen > 0
      ? (curr.userLen - prev.userLen) / Math.max(prev.userLen, 10)
      : 0;

    // Topic continuation (low overlap → topic abandoned)
    const prevTokens = new Set(prev.userContent.split(/\s+/).filter(t => t.length > 1));
    const currTokens = new Set(curr.userContent.split(/\s+/).filter(t => t.length > 1));
    let topicOverlap = 0;
    if (prevTokens.size > 0) {
      let overlap = 0;
      for (const t of prevTokens) { if (currTokens.has(t)) overlap++; }
      topicOverlap = overlap / prevTokens.size;
    }

    // Composite engagement signal
    const engagement =
      0.4 * Math.max(0, -latencyDelta) +  // negative latency delta = better
      0.3 * Math.max(0, lengthDelta) +      // positive length delta = better
      0.3 * topicOverlap;                    // topic continuation = better

    // Simple heuristic: if engagement dropped significantly
    if (engagement < 0.1 && latencyDelta > 0.5) {
      overCorrectionCount++;
    }
    comparisons++;
  }

  return comparisons > 0 ? Math.min(1, overCorrectionCount / comparisons) : 0;
}

/**
 * Narrative rigidity: variance of belief confidence scores.
 * Low variance = all beliefs converged to same confidence = rigid.
 */
function computeNarrativeRigidity(statePath: string): number {
  const selfModelPath = path.join(statePath, "brainstem", "self-model.json");
  const selfModel = readJsonSafe<{ beliefs?: Array<{ confidence: number }> }>(selfModelPath, { beliefs: [] });

  const confidences = (selfModel.beliefs ?? []).map(b => b.confidence);
  if (confidences.length < 3) return 0.5; // insufficient data

  // Compute variance
  const mean = confidences.reduce((s, c) => s + c, 0) / confidences.length;
  const variance = confidences.reduce((s, c) => s + (c - mean) ** 2, 0) / confidences.length;

  // Low variance = high rigidity. Map: variance 0→rigidity 1, variance 0.1→rigidity 0
  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, 1 - variance * 10));
}

// ── Data loading helpers ─────────────────────────────────────────────

function loadAssistantMessages(sessionPath: string, limit: number): string[] {
  if (!fs.existsSync(sessionPath)) return [];
  try {
    const content = fs.readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const messages: string[] = [];

    for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === "assistant" && entry.content) {
          messages.unshift(entry.content);
        }
      } catch { continue; }
    }

    return messages;
  } catch {
    return [];
  }
}

interface SessionLine {
  role: string;
  content?: string;
  timestamp?: number;
}

function loadSessionLines(sessionPath: string, limit: number): SessionLine[] {
  if (!fs.existsSync(sessionPath)) return [];
  try {
    const content = fs.readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: SessionLine[] = [];

    const start = Math.max(0, lines.length - limit);
    for (let i = start; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch { continue; }
    }

    return entries;
  } catch {
    return [];
  }
}
