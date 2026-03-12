/**
 * 4.1A+B: Value Formation — 3-stage progressive crystallization with bidirectional lifecycle.
 *
 * WRITE PERMISSIONS (P0 boundary):
 * - This module OWNS: candidates, emergingValues, counterevidence in ValueFormationState
 * - This module CANNOT write: self-model beliefs, identity state, turn-directive
 * - Only processCommittedPromotions() calls the passed-in birthBelief callback
 * - Only processDecommitments() calls the passed-in removeBelief callback
 *
 * 3-Stage Model:
 *   candidate (evidence accumulating)
 *       | readiness >= 0.5, stability >= 0.4, age > 14d
 *   emerging value (stays in value-formation state)
 *       | readiness >= 0.8, stability >= 0.7, age > 60d, sourceVariety >= 0.2, ceScore < 0.3
 *   committed value (enters self-model as formal belief)
 *
 * Bidirectional Lifecycle:
 *   candidate -> emerging -> committed        (forward crystallization)
 *   committed -> contested -> emerging         (counterevidence erosion)
 *   emerging -> archived                       (no reinforcement decay)
 *
 * Graded Counterevidence:
 *   weak (0.2), moderate (0.5), strong (1.0) — ceScore replaces flat ratio
 *
 * Zero LLM cost (except scanCounterEvidence strong grade from post-turn).
 * Runs from nightly reflection.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { createLogger } from "./logger.js";

const log = createLogger("value-formation");

// ── Local Types (for decoupled usage) ────────────────────────────────

/** Minimal PersonalExemplar shape needed by this module */
export interface PersonalExemplar {
  behaviorType: string;
  behaviorPattern: string;
  topic: string;
  quality: number;
  createdAt: number;
}

// ── Types ────────────────────────────────────────────────────────────

export type ValueDomain =
  | "care"          // caring/compassion
  | "honesty"       // honesty/authenticity
  | "closeness"     // intimacy/connection
  | "autonomy"      // independence/self-direction
  | "grounding"     // concreteness/pragmatism
  | "playfulness"   // humor/lightness
  | "restraint"     // restraint/space
  | "reciprocity";  // reciprocity/equality

export type ValuePattern =
  | "callback"      // remembering what the other person said
  | "empathy"       // empathizing
  | "concreteness"  // starting from specifics
  | "humor"         // humor
  | "vulnerability" // self-disclosure
  | "disagreement"  // daring to disagree
  | "patience"      // waiting/not rushing
  | "follow_through"; // tracking follow-ups

export interface ValueVector {
  domain: ValueDomain;
  pattern: ValuePattern;
  polarity: "prefer" | "avoid";
  strength: number;             // 0-1
}

export interface ValueEvidence {
  timestamp: number;
  type: "exemplar" | "opinion_held" | "relational_pattern" | "behavioral_consistency";
  description: string;
  sourceLayer: "relational" | "cross_source";
  weight: number;  // 0-1
}

export interface CounterEvidence {
  timestamp: number;
  type: "exemplar" | "opinion_held" | "relational_pattern" | "behavioral_consistency";
  description: string;
  sourceLayer: "relational" | "cross_source";
  weight: number;  // 0-1
  grade: "weak" | "moderate" | "strong";
  // weak: 0.2 weight — no behavioral match, single occurrence
  // moderate: 0.5 weight — cross-mode lift contradiction, diary antonym
  // strong: 1.0 weight — explicit self-contradiction, user pointed out inconsistency
}

const CE_GRADE_WEIGHTS: Record<CounterEvidence["grade"], number> = {
  weak: 0.2,
  moderate: 0.5,
  strong: 1.0,
};

export interface ValueCandidate {
  id: string;
  vector: ValueVector;
  source: "exemplar_convergence" | "opinion_stability" | "relational_pattern" | "preference_promotion";
  evidence: ValueEvidence[];
  counterevidence: CounterEvidence[];
  firstObserved: number;
  lastReinforced: number;
  stabilityScore: number;
  promotionReadiness: number;
  displayLabel?: string;
  status: "active" | "archived";
}

export interface EmergingValue {
  candidateId: string;
  displayLabel: string;
  domain: ValueDomain;
  promotedAt: number;
  lastReinforcedAt: number;
  counterevidence: CounterEvidence[];
}

export interface ValueFormationState {
  candidates: ValueCandidate[];
  lastScanAt: number;
  promotionEnabled: boolean;
  promotedValueIds: string[];     // legacy compat
  emergingValues: EmergingValue[];
  lastEmergingAt: number;
  lastCommittedAt: number;
  lastCommittedDomain: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_CANDIDATES = 20;
const MIN_EXEMPLAR_COUNT = 3;
const MIN_EXEMPLAR_QUALITY = 0.8;
const MIN_OPINION_DAYS = 30;
const MIN_RELATIONAL_LIFT = 0.15;
const MIN_RELATIONAL_SAMPLES = 15;
const MIN_RELATIONAL_DAYS = 14;

// Promotion thresholds
const EMERGING_MIN_READINESS = 0.5;
const EMERGING_MIN_STABILITY = 0.4;
const EMERGING_MIN_AGE_DAYS = 14;

const COMMITTED_MIN_READINESS = 0.8;
const COMMITTED_MIN_STABILITY = 0.7;
const COMMITTED_MIN_AGE_DAYS = 60;
const COMMITTED_MIN_SOURCE_VARIETY = 0.2;
const COMMITTED_MAX_CE_SCORE = 0.3;

const EMERGING_STALE_DAYS = 30;       // no reinforcement -> archived
const CONTESTED_CE_WINDOW_DAYS = 45;  // ceScore > 0.4 in window -> decommit
const CONTESTED_CE_THRESHOLD = 0.4;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── Counterevidence antonym patterns for diary scanning ──────────────

const PATTERN_ANTONYMS: Record<ValuePattern, RegExp> = {
  concreteness: /vague|abstract|hand-wavy|generic|broad/i,
  empathy:      /cold|indifferent|dismissive|distracted/i,
  callback:     /forgot|didn't remember|skipped|overlooked/i,
  humor:        /serious|dull|boring|unfunny/i,
  vulnerability: /avoidant|closed off|guarded|hiding/i,
  disagreement: /compliant|people-pleasing|afraid to say|agreeing blindly/i,
  patience:     /rushed|impatient|hurried|pressed for time/i,
  follow_through: /forgot to follow|didn't follow up|gave up|dropped/i,
};

// ── Display label templates ──────────────────────────────────────────

const DOMAIN_TEMPLATES: Record<ValueDomain, Record<"prefer" | "avoid", string>> = {
  care:          { prefer: "caring means {pattern}", avoid: "caring should not involve {pattern}" },
  honesty:       { prefer: "in relationships, prefer {pattern}", avoid: "in relationships, avoid {pattern}" },
  closeness:     { prefer: "closeness comes from {pattern}", avoid: "closeness does not come from {pattern}" },
  autonomy:      { prefer: "autonomy shows in {pattern}", avoid: "autonomy does not come from {pattern}" },
  grounding:     { prefer: "communication tends toward {pattern}", avoid: "communication avoids {pattern}" },
  playfulness:   { prefer: "lightness comes from {pattern}", avoid: "lightness does not come from {pattern}" },
  restraint:     { prefer: "restraint shows in {pattern}", avoid: "should not over-{pattern}" },
  reciprocity:   { prefer: "reciprocity shows in {pattern}", avoid: "reciprocity does not come from {pattern}" },
};

const PATTERN_LABELS: Record<ValuePattern, string> = {
  callback: "remembering what was said before",
  empathy: "starting from emotions",
  concreteness: "starting from concrete situations",
  humor: "using humor to lighten things",
  vulnerability: "authentically showing oneself",
  disagreement: "daring to express disagreement",
  patience: "giving space and time",
  follow_through: "tracking follow-up progress",
};

function assembleDisplayLabel(vector: ValueVector): string {
  const template = DOMAIN_TEMPLATES[vector.domain]?.[vector.polarity];
  if (!template) return `${vector.domain}:${vector.pattern}:${vector.polarity}`;
  return template.replace("{pattern}", PATTERN_LABELS[vector.pattern] ?? vector.pattern);
}

// ── Exemplar -> ValueVector mapping ───────────────────────────────────

const BEHAVIOR_TO_VECTOR: Record<string, ValueVector> = {
  "cared:asked about specific situation first": { domain: "care", pattern: "concreteness", polarity: "prefer", strength: 0.6 },
  "cared:responded to emotions": { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.6 },
  "cared:brought up related details from before": { domain: "closeness", pattern: "callback", polarity: "prefer", strength: 0.6 },
  "disclosed:shared real feelings": { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.5 },
  "disclosed:empathized first": { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.5 },
  "disagreed:then shared different view": { domain: "autonomy", pattern: "disagreement", polarity: "prefer", strength: 0.5 },
  "disagreed:confirmed meaning first": { domain: "grounding", pattern: "concreteness", polarity: "prefer", strength: 0.5 },
  "resurfaced:naturally brought up past topic": { domain: "closeness", pattern: "callback", polarity: "prefer", strength: 0.6 },
  "resurfaced:asked about follow-up": { domain: "closeness", pattern: "follow_through", polarity: "prefer", strength: 0.6 },
};

// Relational feature -> ValueVector mapping
const FEATURE_TO_VECTOR: Record<string, ValueVector> = {
  hasCallback: { domain: "closeness", pattern: "callback", polarity: "prefer", strength: 0.5 },
  hasEmpathy: { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.5 },
  hasOpinion: { domain: "autonomy", pattern: "disagreement", polarity: "prefer", strength: 0.4 },
  hasHumor: { domain: "playfulness", pattern: "humor", polarity: "prefer", strength: 0.4 },
  hasVulnerability: { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.5 },
  hasQuestion: { domain: "grounding", pattern: "concreteness", polarity: "prefer", strength: 0.3 },
};

// ── State management ─────────────────────────────────────────────────

function getStateFilePath(statePath: string): string {
  return path.join(statePath, "value-formation.json");
}

function loadState(statePath: string): ValueFormationState {
  const raw = readJsonSafe<ValueFormationState>(getStateFilePath(statePath), {
    candidates: [],
    lastScanAt: 0,
    promotionEnabled: false,
    promotedValueIds: [],
    emergingValues: [],
    lastEmergingAt: 0,
    lastCommittedAt: 0,
    lastCommittedDomain: null,
  });
  // Migration: add missing fields
  if (!raw.emergingValues) raw.emergingValues = [];
  if (raw.lastEmergingAt == null) raw.lastEmergingAt = 0;
  if (raw.lastCommittedAt == null) raw.lastCommittedAt = 0;
  if (raw.lastCommittedDomain === undefined) raw.lastCommittedDomain = null;
  // Migration: add counterevidence + status to candidates
  for (const c of raw.candidates) {
    if (!c.counterevidence) c.counterevidence = [];
    if (!c.status) c.status = "active";
  }
  return raw;
}

function saveState(statePath: string, state: ValueFormationState): void {
  writeJsonAtomic(getStateFilePath(statePath), state);
}

// ── Anti-monoculture ─────────────────────────────────────────────────

function isDuplicate(candidate: ValueCandidate, existing: ValueCandidate[]): boolean {
  return existing.some(e =>
    e.vector.domain === candidate.vector.domain &&
    e.vector.pattern === candidate.vector.pattern &&
    e.vector.polarity === candidate.vector.polarity,
  );
}

export function isCandidateDiverse(candidate: ValueCandidate, existing: ValueCandidate[]): boolean {
  // No duplicate domain+pattern+polarity
  if (isDuplicate(candidate, existing)) return false;

  // Domain concentration check: no single domain > 40% of candidates
  const domainCounts: Record<string, number> = {};
  for (const e of existing) {
    domainCounts[e.vector.domain] = (domainCounts[e.vector.domain] ?? 0) + 1;
  }
  const maxAllowed = Math.max(3, Math.ceil(existing.length * 0.4));
  if ((domainCounts[candidate.vector.domain] ?? 0) >= maxAllowed) return false;

  return true;
}

// ── Eviction ─────────────────────────────────────────────────────────

function evictWeakestCandidate(candidates: ValueCandidate[]): void {
  candidates.sort((a, b) => {
    // Primary: stability (ascending — lowest first)
    if (Math.abs(a.stabilityScore - b.stabilityScore) > 0.1)
      return a.stabilityScore - b.stabilityScore;
    // Secondary: recency of reinforcement (ascending — oldest first)
    return a.lastReinforced - b.lastReinforced;
  });
  candidates.shift(); // remove weakest
}

// ── Scoring ──────────────────────────────────────────────────────────

function computeStabilityScore(evidence: ValueEvidence[]): number {
  if (evidence.length < 2) return 0;

  // Regularity: standard deviation of intervals between evidence timestamps
  const timestamps = evidence.map(e => e.timestamp).sort((a, b) => a - b);
  const timeSpanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const timeSpanDays = timeSpanMs / (24 * 60 * 60 * 1000);

  // Require at least 14 days span
  if (timeSpanDays < 14) return 0;

  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  const meanInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const variance = intervals.reduce((s, v) => s + (v - meanInterval) ** 2, 0) / intervals.length;
  const cv = meanInterval > 0 ? Math.sqrt(variance) / meanInterval : 1;

  // regularity: 1 = perfectly regular, 0 = highly irregular
  const regularity = Math.max(0, 1 - cv);

  // timeSpanFactor: 0 at 14d, 1 at 90d (log scale)
  const timeSpanFactor = Math.min(1, Math.log(timeSpanDays / 14 + 1) / Math.log(90 / 14 + 1));

  return regularity * timeSpanFactor;
}

export function computeSourceVariety(evidence: ValueEvidence[]): number {
  if (evidence.length === 0) return 0;

  const layers = new Set(evidence.map(e => e.sourceLayer));
  const types = new Set(evidence.map(e => e.type));

  // All from single sourceLayer
  if (layers.size === 1 && types.size === 1) return 0;

  // Multiple types but all relational
  if (!layers.has("cross_source")) return 0.1;

  // Has at least one cross_source evidence
  return 0.2;
}

/**
 * Compute counterevidence score using graded weights.
 * ceScore = sum(ce.gradeWeight) / (sum(evidence.weight) + sum(ce.gradeWeight))
 */
export function computeCeScore(evidence: ValueEvidence[], counterevidence: CounterEvidence[]): number {
  if (evidence.length === 0 && counterevidence.length === 0) return 0;
  const evidenceSum = evidence.reduce((s, e) => s + e.weight, 0);
  const ceSum = counterevidence.reduce((s, ce) => s + CE_GRADE_WEIGHTS[ce.grade], 0);
  const total = evidenceSum + ceSum;
  if (total === 0) return 0;
  return ceSum / total;
}

export function computePromotionReadiness(candidate: ValueCandidate): number {
  const stability = candidate.stabilityScore;
  const evidenceCount = Math.min(candidate.evidence.length / 10, 1);
  const sourceVariety = computeSourceVariety(candidate.evidence);

  // Age factor: 0 at 14d, 1 at 90d (log scale)
  const ageDays = (Date.now() - candidate.firstObserved) / (24 * 60 * 60 * 1000);
  const ageFactor = ageDays < 14 ? 0 : Math.min(1, Math.log(ageDays / 14 + 1) / Math.log(90 / 14 + 1));

  // Use ceScore instead of flat contradiction ratio
  const ceScore = computeCeScore(candidate.evidence, candidate.counterevidence ?? []);

  return (
    0.3 * stability +
    0.2 * evidenceCount +
    0.2 * sourceVariety +
    0.15 * ageFactor +
    0.15 * (1 - ceScore)
  );
}

// ── Candidate creation helpers ───────────────────────────────────────

function createCandidate(
  vector: ValueVector,
  source: ValueCandidate["source"],
  evidence: ValueEvidence[],
): ValueCandidate {
  const now = Date.now();
  const candidate: ValueCandidate = {
    id: `vc_${now}_${Math.random().toString(36).slice(2, 6)}`,
    vector,
    source,
    evidence,
    counterevidence: [],
    firstObserved: now,
    lastReinforced: now,
    stabilityScore: 0,
    promotionReadiness: 0,
    status: "active",
  };
  candidate.stabilityScore = computeStabilityScore(evidence);
  candidate.promotionReadiness = computePromotionReadiness(candidate);
  candidate.displayLabel = assembleDisplayLabel(vector);
  return candidate;
}

function addOrReinforce(
  state: ValueFormationState,
  candidate: ValueCandidate,
): void {
  // Check for existing with same vector
  const existing = state.candidates.find(c =>
    c.vector.domain === candidate.vector.domain &&
    c.vector.pattern === candidate.vector.pattern &&
    c.vector.polarity === candidate.vector.polarity,
  );

  if (existing) {
    // Reinforce: add new evidence, update scores
    existing.evidence.push(...candidate.evidence);
    // Cap evidence at 20
    if (existing.evidence.length > 20) {
      existing.evidence = existing.evidence.slice(-20);
    }
    existing.lastReinforced = Date.now();
    existing.stabilityScore = computeStabilityScore(existing.evidence);
    existing.promotionReadiness = computePromotionReadiness(existing);
    return;
  }

  // Anti-monoculture check
  if (!isCandidateDiverse(candidate, state.candidates)) {
    log.info(`candidate blocked by anti-monoculture: ${candidate.displayLabel}`);
    return;
  }

  // Evict if at capacity
  if (state.candidates.length >= MAX_CANDIDATES) {
    evictWeakestCandidate(state.candidates);
  }

  state.candidates.push(candidate);
  log.info(`value candidate created: ${candidate.displayLabel} (source=${candidate.source})`);
}

// ── Scan pathways ────────────────────────────────────────────────────

/**
 * Pathway 1: Exemplar convergence.
 * 3+ exemplars with same behaviorType, quality >= 0.8, sharing a common pattern.
 */
function scanExemplarConvergence(statePath: string, state: ValueFormationState): void {
  try {
    const exemplars = readJsonSafe<PersonalExemplar[]>(
      path.join(statePath, "exemplars.json"), [],
    );

    // Group by behaviorType
    const byType = new Map<string, PersonalExemplar[]>();
    for (const ex of exemplars) {
      if (ex.quality < MIN_EXEMPLAR_QUALITY) continue;
      if (!byType.has(ex.behaviorType)) byType.set(ex.behaviorType, []);
      byType.get(ex.behaviorType)!.push(ex);
    }

    for (const [type, exs] of byType) {
      if (exs.length < MIN_EXEMPLAR_COUNT) continue;

      // Find common patterns in behavior descriptions
      for (const [patternKey, vector] of Object.entries(BEHAVIOR_TO_VECTOR)) {
        const [expectedType, patternFragment] = patternKey.split(":");
        if (expectedType !== type) continue;

        const matching = exs.filter(e => e.behaviorPattern.includes(patternFragment));
        if (matching.length >= MIN_EXEMPLAR_COUNT) {
          const evidence: ValueEvidence[] = matching.slice(-5).map(e => ({
            timestamp: e.createdAt,
            type: "exemplar" as const,
            description: `${e.topic}: ${e.behaviorPattern}`,
            sourceLayer: "cross_source" as const,
            weight: e.quality,
          }));

          const candidate = createCandidate(vector, "exemplar_convergence", evidence);
          addOrReinforce(state, candidate);
        }
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Pathway 2: Opinion stability.
 * Opinions held >30d, confidence >= 0.7, survived >=1 challenge.
 */
function scanOpinionStability(statePath: string, state: ValueFormationState): void {
  try {
    interface Opinion {
      topic: string;
      position: string;
      confidence: number;
      status?: "held" | "undetermined";
      evolvedAt: number;
      lastChallenged?: number;
    }
    const opinions = readJsonSafe<{ opinions: Opinion[] }>(
      path.join(statePath, "opinions.json"), { opinions: [] },
    );

    const now = Date.now();
    const thirtyDaysMs = MIN_OPINION_DAYS * 24 * 60 * 60 * 1000;

    for (const op of opinions.opinions) {
      if (op.confidence < 0.7) continue;
      if (op.status !== "held") continue;
      if (now - op.evolvedAt < thirtyDaysMs) continue;
      if (!op.lastChallenged) continue; // must have survived at least 1 challenge

      // Map topic to domain heuristically
      const topic = op.topic.toLowerCase();
      let domain: ValueDomain = "honesty"; // default
      let pattern: ValuePattern = "concreteness";

      if (/care|compassion/.test(topic)) { domain = "care"; pattern = "empathy"; }
      else if (/honest|authentic/.test(topic)) { domain = "honesty"; pattern = "vulnerability"; }
      else if (/independen|autonom|freedom/.test(topic)) { domain = "autonomy"; pattern = "disagreement"; }
      else if (/humor|lighthearted/.test(topic)) { domain = "playfulness"; pattern = "humor"; }
      else if (/concrete|practical|grounded/.test(topic)) { domain = "grounding"; pattern = "concreteness"; }

      const evidence: ValueEvidence[] = [{
        timestamp: op.evolvedAt,
        type: "opinion_held",
        description: `Opinion "${op.topic}": ${op.position} (confidence=${op.confidence})`,
        sourceLayer: "cross_source",
        weight: op.confidence,
      }];

      const vector: ValueVector = { domain, pattern, polarity: "prefer", strength: op.confidence * 0.5 };
      const candidate = createCandidate(vector, "opinion_stability", evidence);
      addOrReinforce(state, candidate);
    }
  } catch { /* non-fatal */ }
}

/**
 * Pathway 3: Relational pattern lift (from 4.2).
 * Features with lift > 0.15, sampleCount >= 15, stable >14 days.
 */
function scanRelationalPatterns(statePath: string, state: ValueFormationState): void {
  try {
    interface StyleLearning {
      pairs: Array<{ timestamp: number }>;
      patterns: Array<{ feature: string; lift: number; sampleCount: number }>;
      lastComputedAt: number;
    }
    const ilState = readJsonSafe<{ styleLearning?: StyleLearning }>(
      path.join(statePath, "interaction-learning.json"), {},
    );

    if (!ilState.styleLearning?.patterns) return;

    const now = Date.now();
    const pairs = ilState.styleLearning.pairs ?? [];
    // Check if pairs span at least 14 days
    if (pairs.length < MIN_RELATIONAL_SAMPLES) return;
    const timestamps = pairs.map(p => p.timestamp).sort((a, b) => a - b);
    const spanDays = (timestamps[timestamps.length - 1] - timestamps[0]) / (24 * 60 * 60 * 1000);
    if (spanDays < MIN_RELATIONAL_DAYS) return;

    for (const pattern of ilState.styleLearning.patterns) {
      if (Math.abs(pattern.lift) < MIN_RELATIONAL_LIFT) continue;
      if (pattern.sampleCount < MIN_RELATIONAL_SAMPLES) continue;

      const vector = FEATURE_TO_VECTOR[pattern.feature];
      if (!vector) continue;

      // If negative lift, flip polarity
      const polarity: "prefer" | "avoid" = pattern.lift > 0 ? "prefer" : "avoid";
      const adjustedVector: ValueVector = { ...vector, polarity, strength: Math.abs(pattern.lift) };

      const evidence: ValueEvidence[] = [{
        timestamp: now,
        type: "relational_pattern",
        description: `${pattern.feature}: lift=${pattern.lift.toFixed(2)}, n=${pattern.sampleCount}`,
        sourceLayer: "relational",
        weight: Math.min(1, Math.abs(pattern.lift) * 3),
      }];

      const candidate = createCandidate(adjustedVector, "relational_pattern", evidence);
      addOrReinforce(state, candidate);
    }
  } catch { /* non-fatal */ }
}

/**
 * Pathway 4: Preference promotion.
 * Existing beliefs with category "preference" surviving >90d.
 */
function scanPreferenceBeliefs(statePath: string, state: ValueFormationState): void {
  try {
    interface SelfModelData { beliefs?: Array<{ category: string; statement: string; confidence: number; createdAt: number; domain?: string }> }
    const selfModelData = readJsonSafe<SelfModelData>(
      path.join(statePath, "brainstem", "self-model.json"), { beliefs: [] },
    );

    const beliefs = selfModelData.beliefs ?? [];
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    for (const belief of beliefs) {
      if (belief.category !== "preference") continue;
      if (now - belief.createdAt < ninetyDaysMs) continue;
      if (belief.confidence < 0.5) continue;

      // Map statement/domain to structured vector
      const stmt = belief.statement.toLowerCase();
      let domain: ValueDomain = "grounding"; // fallback
      let pattern: ValuePattern = "concreteness";

      if (/care|compassion|nurtur/.test(stmt)) { domain = "care"; pattern = "empathy"; }
      else if (/honest|authentic|sincer/.test(stmt)) { domain = "honesty"; pattern = "vulnerability"; }
      else if (/independen|autonom|freedom/.test(stmt)) { domain = "autonomy"; pattern = "disagreement"; }
      else if (/humor|funny|lighthearted/.test(stmt)) { domain = "playfulness"; pattern = "humor"; }
      else if (/closeness|intimacy|connection/.test(stmt)) { domain = "closeness"; pattern = "callback"; }
      else if (/patience|wait|space/.test(stmt)) { domain = "restraint"; pattern = "patience"; }
      else if (/reciproc|equal|fair/.test(stmt)) { domain = "reciprocity"; pattern = "follow_through"; }
      else if (/concrete|practical|grounded/.test(stmt)) { domain = "grounding"; pattern = "concreteness"; }

      const vector: ValueVector = {
        domain,
        pattern,
        polarity: "prefer",
        strength: belief.confidence * 0.4,
      };

      const evidence: ValueEvidence[] = [{
        timestamp: belief.createdAt,
        type: "behavioral_consistency",
        description: `Long-held preference: ${belief.statement} (confidence=${belief.confidence})`,
        sourceLayer: "cross_source",
        weight: belief.confidence,
      }];

      const candidate = createCandidate(vector, "preference_promotion", evidence);
      addOrReinforce(state, candidate);
    }
  } catch { /* non-fatal */ }
}

// ── Counterevidence scanning (zero LLM cost) ────────────────────────

/**
 * Scan for counterevidence across diary, interaction learning, and exemplars.
 * Called daily from doReflection.
 */
export function scanCounterEvidence(statePath: string): void {
  const state = loadState(statePath);
  const now = Date.now();
  const activeCandidates = state.candidates.filter(c => c.status === "active");

  // 1. PATTERN_ANTONYMS diary scan — grade=moderate
  try {
    const diary = readJsonSafe<{ entries: Array<{ content: string; timestamp?: number; date?: string }> }>(
      path.join(statePath, "diary.json"), { entries: [] },
    );
    const recentEntries = diary.entries.filter(e => {
      const ts = e.timestamp ?? 0;
      return now - ts < 14 * ONE_DAY_MS;
    });
    const recentText = recentEntries.map(e => e.content).join("\n");

    for (const c of activeCandidates) {
      const antonymPattern = PATTERN_ANTONYMS[c.vector.pattern];
      if (!antonymPattern) continue;
      if (antonymPattern.test(recentText)) {
        // Don't add duplicate CE for same pattern within 7 days
        const recentCe = c.counterevidence.some(
          ce => ce.description.includes("diary_antonym") && now - ce.timestamp < 7 * ONE_DAY_MS,
        );
        if (!recentCe) {
          c.counterevidence.push({
            timestamp: now,
            type: "behavioral_consistency",
            description: `diary_antonym: ${c.vector.pattern} antonym found in recent diary`,
            sourceLayer: "cross_source",
            weight: 0.5,
            grade: "moderate",
          });
          log.info(`counterevidence (moderate): diary antonym for ${c.displayLabel}`);
        }
      }
    }
  } catch { /* non-fatal */ }

  // 2. Cross-mode lift contradiction — grade=moderate
  try {
    interface StyleLearning {
      patterns: Array<{ feature: string; lift: number; sampleCount: number; mode?: string }>;
    }
    const ilState = readJsonSafe<{ styleLearning?: StyleLearning }>(
      path.join(statePath, "interaction-learning.json"), {},
    );
    if (ilState.styleLearning?.patterns) {
      for (const c of activeCandidates) {
        // Check if any feature contradicts the candidate's direction
        const feature = Object.entries(FEATURE_TO_VECTOR).find(
          ([, v]) => v.domain === c.vector.domain && v.pattern === c.vector.pattern,
        );
        if (!feature) continue;
        const [featureName] = feature;
        const patterns = ilState.styleLearning.patterns.filter(p => p.feature === featureName);
        // If lift goes in opposite direction of candidate polarity
        for (const p of patterns) {
          const liftPositive = p.lift > 0;
          const candidatePrefers = c.vector.polarity === "prefer";
          if (liftPositive !== candidatePrefers && Math.abs(p.lift) > 0.1) {
            const recentCe = c.counterevidence.some(
              ce => ce.description.includes("lift_contradiction") && now - ce.timestamp < 14 * ONE_DAY_MS,
            );
            if (!recentCe) {
              c.counterevidence.push({
                timestamp: now,
                type: "relational_pattern",
                description: `lift_contradiction: ${featureName} lift=${p.lift.toFixed(2)} contradicts ${c.vector.polarity}`,
                sourceLayer: "relational",
                weight: 0.5,
                grade: "moderate",
              });
              log.info(`counterevidence (moderate): lift contradiction for ${c.displayLabel}`);
            }
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  // 3. No behavioral follow-through — grade=weak
  // emerging > 30d but exemplar count not growing
  for (const ev of state.emergingValues) {
    const candidate = state.candidates.find(c => c.id === ev.candidateId);
    if (!candidate) continue;
    const ageDays = (now - ev.promotedAt) / ONE_DAY_MS;
    if (ageDays <= 30) continue;
    const recentExemplars = candidate.evidence.filter(
      e => e.type === "exemplar" && now - e.timestamp < 30 * ONE_DAY_MS,
    );
    if (recentExemplars.length === 0) {
      const recentCe = candidate.counterevidence.some(
        ce => ce.description.includes("no_behavioral") && now - ce.timestamp < 14 * ONE_DAY_MS,
      );
      if (!recentCe) {
        candidate.counterevidence.push({
          timestamp: now,
          type: "behavioral_consistency",
          description: `no_behavioral: emerging ${ageDays.toFixed(0)}d with no recent exemplar reinforcement`,
          sourceLayer: "cross_source",
          weight: 0.2,
          grade: "weak",
        });
        log.info(`counterevidence (weak): no behavioral follow-through for ${candidate.displayLabel}`);
      }
    }
  }

  // Cap counterevidence at 15 per candidate
  for (const c of state.candidates) {
    if (c.counterevidence.length > 15) {
      c.counterevidence = c.counterevidence.slice(-15);
    }
  }

  saveState(statePath, state);
}

// ── 3-Stage Promotion Lifecycle ──────────────────────────────────────

/**
 * Enable promotion system. Called after scan is done.
 */
export function enablePromotion(statePath: string): void {
  const state = loadState(statePath);
  if (!state.promotionEnabled) {
    state.promotionEnabled = true;
    saveState(statePath, state);
  }
}

/**
 * Process candidate -> emerging promotions. Max 1/day.
 */
export function processEmergingPromotions(statePath: string): void {
  const state = loadState(statePath);
  if (!state.promotionEnabled) return;

  const now = Date.now();
  if (now - state.lastEmergingAt < ONE_DAY_MS) return;

  for (const c of state.candidates) {
    if (c.status !== "active") continue;
    // Already an emerging value?
    if (state.emergingValues.some(ev => ev.candidateId === c.id)) continue;

    const ageDays = (now - c.firstObserved) / ONE_DAY_MS;
    if (ageDays < EMERGING_MIN_AGE_DAYS) continue;
    if (c.promotionReadiness < EMERGING_MIN_READINESS) continue;
    if (c.stabilityScore < EMERGING_MIN_STABILITY) continue;

    // Promote to emerging
    state.emergingValues.push({
      candidateId: c.id,
      displayLabel: c.displayLabel ?? assembleDisplayLabel(c.vector),
      domain: c.vector.domain,
      promotedAt: now,
      lastReinforcedAt: c.lastReinforced,
      counterevidence: [],
    });
    state.lastEmergingAt = now;
    log.info(`candidate promoted to emerging: ${c.displayLabel}`);
    break; // max 1 per day
  }

  saveState(statePath, state);
}

/**
 * Process emerging -> committed promotions. Max 1/14d.
 * Calls birthBelief callback to create belief in self-model.
 */
export function processCommittedPromotions(
  statePath: string,
  birthBelief: (statement: string, category: "value", domain: string, evidence: Array<{ text: string; timestamp: number; type: "outcome"; polarity: "support"; refId: string; weight: number }>, sourceType: "observed") => unknown | null,
): void {
  const state = loadState(statePath);
  if (!state.promotionEnabled) return;

  const now = Date.now();
  if (now - state.lastCommittedAt < 14 * ONE_DAY_MS) return;

  for (const ev of state.emergingValues) {
    const candidate = state.candidates.find(c => c.id === ev.candidateId);
    if (!candidate || candidate.status !== "active") continue;

    const ageDays = (now - candidate.firstObserved) / ONE_DAY_MS;
    if (ageDays < COMMITTED_MIN_AGE_DAYS) continue;
    if (candidate.promotionReadiness < COMMITTED_MIN_READINESS) continue;
    if (candidate.stabilityScore < COMMITTED_MIN_STABILITY) continue;
    if (computeSourceVariety(candidate.evidence) < COMMITTED_MIN_SOURCE_VARIETY) continue;
    if (computeCeScore(candidate.evidence, candidate.counterevidence) > COMMITTED_MAX_CE_SCORE) continue;

    // Same-domain cooldown: 30d
    if (state.lastCommittedDomain === candidate.vector.domain &&
        now - state.lastCommittedAt < 30 * ONE_DAY_MS) continue;

    // Birth belief in self-model via narrow API
    const label = candidate.displayLabel ?? assembleDisplayLabel(candidate.vector);
    const beliefEvidence = candidate.evidence.slice(-3).map(e => ({
      text: e.description,
      timestamp: e.timestamp,
      type: "outcome" as const,
      polarity: "support" as const,
      refId: `value-formation:${candidate.id}`,
      weight: e.weight,
    }));

    const result = birthBelief(label, "value", candidate.vector.domain, beliefEvidence, "observed");
    if (result != null) {
      state.lastCommittedAt = now;
      state.lastCommittedDomain = candidate.vector.domain;
      // Remove from emerging
      state.emergingValues = state.emergingValues.filter(e => e.candidateId !== ev.candidateId);
      state.promotedValueIds.push(candidate.id);
      log.info(`emerging promoted to committed: ${label}`);
      break; // max 1 per cycle
    }
  }

  saveState(statePath, state);
}

/**
 * Process decommitments: contested committed -> emerging, stale emerging -> archived.
 * Calls removeBelief callback to delete belief from self-model.
 */
export function processDecommitments(
  statePath: string,
  removeBelief: (beliefId: string) => void,
): void {
  const state = loadState(statePath);
  const now = Date.now();

  // 1. Contested committed values -> decommit back to emerging
  // Look for promoted candidates whose ceScore > 0.4 sustained over 45d window
  for (const promotedId of [...state.promotedValueIds]) {
    const candidate = state.candidates.find(c => c.id === promotedId);
    if (!candidate) continue;

    const recentCe = candidate.counterevidence.filter(
      ce => now - ce.timestamp < CONTESTED_CE_WINDOW_DAYS * ONE_DAY_MS,
    );
    const ceScore = computeCeScore(candidate.evidence, recentCe);

    if (ceScore > CONTESTED_CE_THRESHOLD) {
      // Decommit: remove belief from self-model
      const label = candidate.displayLabel ?? assembleDisplayLabel(candidate.vector);

      // Find and remove the belief — match by statement containing the display label
      try {
        // We need the belief ID; use the label as the search term
        removeBelief(label);
      } catch { /* non-fatal */ }

      // Move back to emerging
      state.emergingValues.push({
        candidateId: candidate.id,
        displayLabel: label,
        domain: candidate.vector.domain,
        promotedAt: now,
        lastReinforcedAt: candidate.lastReinforced,
        counterevidence: recentCe,
      });

      state.promotedValueIds = state.promotedValueIds.filter(id => id !== promotedId);
      log.info(`committed decommitted to emerging (ceScore=${ceScore.toFixed(2)}): ${label}`);
    }
  }

  // 2. Stale emerging -> archived (30d no reinforcement)
  for (const ev of [...state.emergingValues]) {
    const candidate = state.candidates.find(c => c.id === ev.candidateId);
    if (!candidate) {
      state.emergingValues = state.emergingValues.filter(e => e.candidateId !== ev.candidateId);
      continue;
    }

    const daysSinceReinforcement = (now - candidate.lastReinforced) / ONE_DAY_MS;
    if (daysSinceReinforcement > EMERGING_STALE_DAYS) {
      candidate.status = "archived";
      state.emergingValues = state.emergingValues.filter(e => e.candidateId !== ev.candidateId);
      log.info(`emerging archived (${daysSinceReinforcement.toFixed(0)}d stale): ${candidate.displayLabel}`);
    }
  }

  saveState(statePath, state);
}

// ── Context formatting ──────────────────────────────────────────────

/**
 * Format emerging values for context.ts injection (low priority).
 * Only renders active, non-archived emerging values.
 */
export function formatValueContext(statePath: string): string | null {
  const state = loadState(statePath);
  const activeEmerging = state.emergingValues.filter(ev => {
    const candidate = state.candidates.find(c => c.id === ev.candidateId);
    return candidate && candidate.status === "active";
  });

  if (activeEmerging.length === 0) return null;

  const lines = activeEmerging.slice(0, 3).map(ev => `- Increasingly valuing: "${ev.displayLabel}"`);
  return "## Emerging tendencies (under observation, not yet confirmed)\n" + lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan all pathways for value candidates. Called from nightly reflection.
 */
export function scanForValueCandidates(statePath: string): void {
  const state = loadState(statePath);
  const now = Date.now();

  // Don't scan more than once per day
  if (now - state.lastScanAt < ONE_DAY_MS) return;

  scanExemplarConvergence(statePath, state);
  scanOpinionStability(statePath, state);
  scanRelationalPatterns(statePath, state);
  scanPreferenceBeliefs(statePath, state);

  // Recompute scores for all candidates
  for (const c of state.candidates) {
    c.stabilityScore = computeStabilityScore(c.evidence);
    c.promotionReadiness = computePromotionReadiness(c);
  }

  state.lastScanAt = now;
  saveState(statePath, state);
  log.info(`value scan: ${state.candidates.length} candidates`);
}

/**
 * Reinforce a candidate from a newly extracted exemplar.
 * Called from post-turn exemplar extraction.
 */
export function reinforceFromExemplar(statePath: string, exemplar: PersonalExemplar): void {
  const state = loadState(statePath);

  // Find matching vector
  for (const [patternKey, vector] of Object.entries(BEHAVIOR_TO_VECTOR)) {
    const [expectedType, patternFragment] = patternKey.split(":");
    if (expectedType !== exemplar.behaviorType) continue;
    if (!exemplar.behaviorPattern.includes(patternFragment)) continue;

    // Find existing candidate with this vector
    const existing = state.candidates.find(c =>
      c.vector.domain === vector.domain &&
      c.vector.pattern === vector.pattern &&
      c.vector.polarity === vector.polarity,
    );

    if (existing) {
      existing.evidence.push({
        timestamp: exemplar.createdAt,
        type: "exemplar",
        description: `${exemplar.topic}: ${exemplar.behaviorPattern}`,
        sourceLayer: "cross_source",
        weight: exemplar.quality,
      });
      if (existing.evidence.length > 20) {
        existing.evidence = existing.evidence.slice(-20);
      }
      existing.lastReinforced = Date.now();
      existing.stabilityScore = computeStabilityScore(existing.evidence);
      existing.promotionReadiness = computePromotionReadiness(existing);

      // Also update lastReinforcedAt on corresponding emerging value
      const ev = state.emergingValues.find(e => e.candidateId === existing.id);
      if (ev) ev.lastReinforcedAt = Date.now();

      saveState(statePath, state);
      log.info(`value candidate reinforced from exemplar: ${existing.displayLabel}`);
    }
    break;
  }
}

/**
 * Add strong counterevidence from post-turn feedback.
 * Called when user's explicit feedback or character's self-contradiction
 * matches antonym patterns for active value candidates.
 */
export function addStrongCounterEvidence(statePath: string, feedbackText: string): void {
  if (!feedbackText || feedbackText.length < 3) return;
  const state = loadState(statePath);
  const now = Date.now();

  for (const c of state.candidates.filter(c => c.status === "active")) {
    const antonymPattern = PATTERN_ANTONYMS[c.vector.pattern];
    if (!antonymPattern) continue;
    if (!antonymPattern.test(feedbackText)) continue;

    // 7-day dedup for strong grade
    const recentStrong = c.counterevidence.some(
      ce => ce.grade === "strong" && now - ce.timestamp < 7 * ONE_DAY_MS,
    );
    if (recentStrong) continue;

    c.counterevidence.push({
      timestamp: now,
      type: "behavioral_consistency",
      description: `strong_feedback: ${feedbackText.slice(0, 80)}`,
      sourceLayer: "cross_source",
      weight: 1.0,
      grade: "strong",
    });
    log.info(`counterevidence (strong): feedback for ${c.displayLabel}`);
  }

  // Cap counterevidence
  for (const c of state.candidates) {
    if (c.counterevidence.length > 15) {
      c.counterevidence = c.counterevidence.slice(-15);
    }
  }

  saveState(statePath, state);
}

/**
 * Legacy 4.1B stub — kept for backward compatibility with tests.
 * Real promotion now happens via processEmergingPromotions + processCommittedPromotions.
 */
export function processPromotions(statePath: string): void {
  const state = loadState(statePath);
  if (!state.promotionEnabled) return; // gate still works for legacy tests
}
