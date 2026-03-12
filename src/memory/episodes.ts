/**
 * Episodic Memory — structures conversation memories as scenes/events.
 *
 * Instead of flat key-value facts, episodes capture *when*, *who*, *where*,
 * *what happened*, and how it *felt*. This gives the character the ability to recall
 * past interactions as coherent scenes rather than isolated data points.
 *
 * Pattern: init → load/save → query functions → context formatter
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import { emitState } from "../lib/state-bus.js";

const log = createLogger("episodes");

// ── Types ────────────────────────────────────────────────────────────

export interface Episode {
  id: string;                    // "ep_1709817600000_cafe_chat"
  when: number;                  // timestamp
  date: string;                  // "2026-03-09"
  who: string[];                 // participants
  where?: string;                // inferred from context
  what: string;                  // 1-2 sentence scene summary
  emotionalValence: number;      // -1 to 1
  emotionalNote: string;         // brief emotional context
  topics: string[];              // topic tags
  causalLinks?: string[];        // links to other episode IDs or memory keys
  significance: number;          // 0-1, how important this episode is
  /** Provenance: episodes are LLM-constructed scene summaries */
  sourceType?: "observed" | "inferred" | "narrative";
}

// ── Module state ─────────────────────────────────────────────────────

let _statePath = "";
let _episodes: Episode[] = [];

const MAX_EPISODES = 200;

function getFilePath(): string {
  return path.join(_statePath, "episodes.json");
}

function load(): void {
  _episodes = readJsonSafe<Episode[]>(getFilePath(), []);
}

function save(): void {
  writeJsonAtomic(getFilePath(), _episodes);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initEpisodes(statePath: string): void {
  _statePath = statePath;
  load();
  log.info(`episodes: ${_episodes.length} episodes loaded`);
}

// ── Add ──────────────────────────────────────────────────────────────

export function addEpisode(ep: Omit<Episode, "id">): Episode {
  // Generate ID from timestamp + slugified what
  const slug = ep.what
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 30)
    .replace(/_$/, "");
  const id = `ep_${ep.when}_${slug}`;

  const episode: Episode = { id, ...ep, sourceType: ep.sourceType ?? "inferred" };
  _episodes.push(episode);

  // Evict lowest-significance old episodes when over cap
  if (_episodes.length > MAX_EPISODES) {
    // Sort by significance (asc), then by age (oldest first) for ties
    const scored = _episodes.map((e, idx) => ({ e, idx, score: e.significance + (idx / _episodes.length) * 0.1 }));
    scored.sort((a, b) => a.score - b.score);
    // Remove the lowest-scoring episode
    const toRemove = scored[0].e.id;
    _episodes = _episodes.filter(e => e.id !== toRemove);
  }

  save();
  log.info(`episode added: ${id} (total: ${_episodes.length})`);
  emitState({ type: "episode:added", topic: ep.topics?.[0] ?? ep.what.slice(0, 30), significance: ep.significance });
  return episode;
}

// ── Query functions ──────────────────────────────────────────────────

/**
 * Simple token-overlap keyword search on what/topics/emotionalNote.
 */
export function findSimilarEpisodes(query: string, limit = 5): Episode[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored = _episodes.map(ep => {
    const epText = [ep.what, ep.emotionalNote, ...ep.topics].join(" ");
    const epTokens = tokenize(epText);
    const overlap = queryTokens.filter(t => epTokens.some(et => et.includes(t) || t.includes(et))).length;
    const score = overlap / queryTokens.length;
    return { ep, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.ep);
}

export function findByTimeRange(startTs: number, endTs: number): Episode[] {
  return _episodes.filter(ep => ep.when >= startTs && ep.when <= endTs);
}

export function findByEmotion(valence: "positive" | "negative" | "neutral", limit = 5): Episode[] {
  const { positiveMin, negativeMax } = getEmotionThresholds();
  const filtered = _episodes.filter(ep => {
    if (valence === "positive") return ep.emotionalValence > positiveMin;
    if (valence === "negative") return ep.emotionalValence < negativeMax;
    return ep.emotionalValence >= negativeMax && ep.emotionalValence <= positiveMin;
  });
  // Return most recent first
  return filtered.sort((a, b) => b.when - a.when).slice(0, limit);
}

export function findByTopic(topic: string, limit = 5): Episode[] {
  const topicLower = topic.toLowerCase();
  return _episodes
    .filter(ep => ep.topics.some(t => t.toLowerCase().includes(topicLower) || topicLower.includes(t.toLowerCase())))
    .sort((a, b) => b.when - a.when)
    .slice(0, limit);
}

export function getRecentEpisodes(limit = 5): Episode[] {
  return [..._episodes].sort((a, b) => b.when - a.when).slice(0, limit);
}

// ── Mode-aware scoring weights ──────────────────────────────────────

type EpisodeWeights = { topic: number; emotion: number; recency: number; significance: number; limit: number; fallback: number };

const EPISODE_WEIGHTS: Record<string, EpisodeWeights> = {
  emotional:     { topic: 0.3, emotion: 0.4, recency: 0.2, significance: 0.1, limit: 4, fallback: 2 },
  technical:     { topic: 0.6, emotion: 0.1, recency: 0.15, significance: 0.15, limit: 2, fallback: 1 },
  planning:      { topic: 0.45, emotion: 0.1, recency: 0.3, significance: 0.15, limit: 3, fallback: 2 },
  philosophical: { topic: 0.35, emotion: 0.25, recency: 0.1, significance: 0.3, limit: 3, fallback: 2 },
  casual:        { topic: 0.4, emotion: 0.2, recency: 0.25, significance: 0.15, limit: 3, fallback: 2 },
  subdued:       { topic: 0.4, emotion: 0.2, recency: 0.2, significance: 0.2, limit: 2, fallback: 1 },
};

const DEFAULT_WEIGHTS: EpisodeWeights = { topic: 0.5, emotion: 0.2, recency: 0.15, significance: 0.15, limit: 3, fallback: 2 };

// ── Adaptive emotion thresholds ─────────────────────────────────────

function getEmotionThresholds(): { positiveMin: number; negativeMax: number } {
  if (_episodes.length < 10) return { positiveMin: 0.2, negativeMax: -0.2 };
  const valences = _episodes.map(e => e.emotionalValence).sort((a, b) => a - b);
  const p33 = valences[Math.floor(valences.length * 0.33)];
  const p67 = valences[Math.floor(valences.length * 0.67)];
  return { positiveMin: p67, negativeMax: p33 };
}

// ── Context formatting (for system prompt) ───────────────────────────

/**
 * Finds episodes relevant to current conversation by topic similarity
 * and emotional resonance. Returns formatted text for system prompt.
 *
 * Mode hint adjusts scoring weights (e.g. emotional mode emphasizes
 * emotional resonance, technical mode emphasizes topic overlap).
 */
export function formatEpisodicContext(
  currentTopics: string[],
  currentValence: number,
  mode?: "emotional" | "technical" | "planning" | "philosophical" | "casual" | "subdued",
): string {
  if (_episodes.length === 0) return "";

  const w = (mode && EPISODE_WEIGHTS[mode]) || DEFAULT_WEIGHTS;

  // Score each episode by topic overlap + emotional resonance
  const topicTokens = tokenize(currentTopics.join(" "));

  const scored = _episodes.map(ep => {
    // Topic similarity
    const epTokens = tokenize([...ep.topics, ep.what].join(" "));
    const topicOverlap = topicTokens.length > 0
      ? topicTokens.filter(t => epTokens.some(et => et.includes(t) || t.includes(et))).length / topicTokens.length
      : 0;

    // Emotional resonance — episodes with similar valence score higher
    const emotionDist = Math.abs(ep.emotionalValence - currentValence);
    const emotionScore = 1 - emotionDist; // 0 to 1, higher = more similar emotion

    // Recency boost — more recent episodes slightly preferred
    const ageHours = (Date.now() - ep.when) / 3_600_000;
    const recencyScore = Math.max(0, 1 - ageHours / (30 * 24)); // decays over 30 days

    // Significance weight
    const sigScore = ep.significance;

    // Combined score with mode-aware weights
    const score = topicOverlap * w.topic + emotionScore * w.emotion + recencyScore * w.recency + sigScore * w.significance;
    return { ep, score, topicOverlap };
  });

  // Filter to episodes with at least some relevance, take top N (mode-driven)
  const relevant = scored
    .filter(s => s.score > 0.15 || s.topicOverlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, w.limit);

  if (relevant.length === 0) {
    // Fall back to most recent episodes for continuity (mode-driven count)
    const recent = getRecentEpisodes(w.fallback);
    if (recent.length === 0) return "";
    return formatEpisodeList(recent);
  }

  return formatEpisodeList(relevant.map(r => r.ep));
}

function formatEpisodeList(episodes: Episode[]): string {
  return episodes.map(ep => {
    const dateStr = ep.date;
    const who = ep.who.join(", ");
    const where = ep.where ? ` @ ${ep.where}` : "";
    const { positiveMin, negativeMax } = getEmotionThresholds();
    const emojiPositive = positiveMin + 0.1; // slightly above positive threshold
    const emojiNegative = negativeMax - 0.1; // slightly below negative threshold
    const valenceIndicator = ep.emotionalValence > emojiPositive ? " [+]" : ep.emotionalValence < emojiNegative ? " [-]" : "";
    return `- ${dateStr} | ${who}${where}: ${ep.what}${valenceIndicator}\n  emotion: ${ep.emotionalNote}\n  topics: ${ep.topics.join(", ")}`;
  }).join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  // Simple tokenizer: split on whitespace and punctuation, lowercase, filter short tokens
  return text
    .toLowerCase()
    .split(/[\s,;.!?，。！？、；：""''（）()【】\[\]{}]+/)
    .filter(t => t.length >= 2);
}
