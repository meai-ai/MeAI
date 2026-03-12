/**
 * Self-Model (CS5b) — predictive layer over the character's internal state.
 *
 * 8 continuous variables tracking energy, fatigue, social capacity, coherence, etc.
 * Shapes planning (via selfReturn in EU), gates actions (self gate before act gate),
 * and routes curiosity (via selfCost).
 */

import { type Clock, type SelfGatePolicy, DEFAULT_SELF_GATE, BRAINSTEM_CONFIG } from "./config.js";
import type { InternalState } from "./world-model.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-self-model");

// ── Types ────────────────────────────────────────────────────────────

export interface SelfState {
  energy: number;           // 0-1, capacity
  fatigue: number;          // 0-1, cognitive depletion
  self_efficacy: number;    // 0-1, Beta-Bernoulli learned success rate
  uncertainty: number;      // 0-1, world model/plan quality
  social_energy: number;    // 0-1, social capacity
  affect_valence: number;   // -1..1, emotional baseline
  self_coherence: number;   // 0-1, narrative consistency
  safety_margin: number;    // 0-1, risk buffer
}

interface SelfTransitionDeltas {
  fatigueD: number;
  socialD: number;
  uncertaintyD: number;
  safetyD: number;
}

interface SelfTransitionStats {
  actionFamily: string;
  priorFatigueD: number;
  priorSocialD: number;
  priorUncertaintyD: number;
  priorSafetyD: number;
  observedFatigueD: number;
  observedSocialD: number;
  observedUncertaintyD: number;
  observedSafetyD: number;
  observations: number;
  positiveOutcomes: number;  // CS5b.9: count positive outcomes for belief birth threshold
}

export type ActionFamily =
  | "micro_think" | "plan_rollout"
  | "reach_out" | "explore" | "reflect" | "rest"
  | "post" | "activity" | "stay_silent";

// ── Self Belief types (CS5b.9) ────────────────────────────────────────

export type BeliefCategory = "skill" | "trait" | "value" | "preference" | "limitation";

export interface BeliefEvidence {
  text: string;
  timestamp: number;
  type: "outcome" | "reflection" | "external_feedback" | "prediction_error";
  polarity: "support" | "contradict";
  refId: string;           // reference to outcome/action ID
  weight: number;          // 0-1, strength of this evidence
}

export interface SelfBelief {
  id: string;
  statement: string;        // one-sentence statement
  category: BeliefCategory;
  evidence: BeliefEvidence[];
  confidence: number;       // 0-1
  halfLifeDays: number;
  createdAt: number;
  lastUpdated: number;
  domain?: string;
  /** Provenance: derived from evidence types.
   * outcome/external_feedback → "observed", prediction_error → "inferred", reflection → "narrative" */
  sourceType?: "observed" | "inferred" | "narrative";
}

const BELIEF_HALF_LIFE: Record<BeliefCategory, number> = {
  skill: 14, trait: 30, value: 90, preference: 21, limitation: 14,
};

/** Derive sourceType from evidence: outcome/external_feedback → observed, prediction_error → inferred, reflection → narrative */
function deriveSourceType(evidence: BeliefEvidence[]): "observed" | "inferred" | "narrative" {
  if (evidence.length === 0) return "inferred";
  const latest = evidence[evidence.length - 1];
  if (latest.type === "outcome" || latest.type === "external_feedback") return "observed";
  if (latest.type === "prediction_error") return "inferred";
  return "narrative"; // reflection
}
const MAX_BELIEFS = 30;
const MAX_EVIDENCE_PER_BELIEF = 10;
const BELIEF_BIRTH_THRESHOLD = 3;

interface SelfModelPersisted {
  version: number;
  state: SelfState;
  transitionStats: SelfTransitionStats[];
  lastUpdated: number;
  beliefs?: SelfBelief[];
}

// ── Default transition deltas per action family ──────────────────────

const DEFAULT_DELTAS: Record<ActionFamily, SelfTransitionDeltas> = {
  micro_think:  { fatigueD: 0.01,  socialD: 0,     uncertaintyD: 0.002,  safetyD: 0 },
  plan_rollout: { fatigueD: 0.03,  socialD: 0,     uncertaintyD: 0.004,  safetyD: 0 },
  reach_out:    { fatigueD: 0.03,  socialD: -0.10, uncertaintyD: -0.02,  safetyD: -0.04 },
  explore:      { fatigueD: 0.04,  socialD: 0,     uncertaintyD: -0.01,  safetyD: 0 },
  reflect:      { fatigueD: 0.02,  socialD: 0,     uncertaintyD: -0.02,  safetyD: 0.01 },
  rest:         { fatigueD: -0.06, socialD: 0.03,  uncertaintyD: 0,      safetyD: 0.02 },
  post:         { fatigueD: 0.02,  socialD: -0.06, uncertaintyD: 0,      safetyD: -0.03 },
  activity:     { fatigueD: 0.03,  socialD: 0,     uncertaintyD: -0.01,  safetyD: 0 },
  stay_silent:  { fatigueD: 0,     socialD: 0.01,  uncertaintyD: 0,      safetyD: 0.01 },
};

// ── Self Model ───────────────────────────────────────────────────────

export class SelfModel {
  private state: SelfState;
  private transitionStats: SelfTransitionStats[];
  private beliefs: SelfBelief[] = [];
  private dataPath: string;
  private csiMode: string = "green";

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.state = SelfModel.defaultState();
    this.transitionStats = [];
    this.load();
  }

  static defaultState(): SelfState {
    return {
      energy: 0.5,
      fatigue: 0.5,
      self_efficacy: 0.5,
      uncertainty: 0.5,
      social_energy: 0.5,
      affect_valence: 0,
      self_coherence: 0.5,
      safety_margin: 0.5,
    };
  }

  /** Cold start: seed self-state from existing brainstem metrics. */
  coldStartFrom(internal: InternalState, selfValence?: number, avgPredictionError?: number): void {
    this.state.energy = clamp01(1 - internal.avgFatigue);
    this.state.fatigue = clamp01(internal.avgFatigue);
    this.state.self_efficacy = 0.5;
    this.state.uncertainty = clamp01(avgPredictionError ?? 0.5);
    this.state.social_energy = 0.5;
    this.state.affect_valence = clampValence(selfValence ?? 0);
    this.state.self_coherence = 0.5;
    this.state.safety_margin = 0.5;
    log.info("cold start from internal state");
  }

  /** Update CSI mode for mode-aware behavior. */
  setCsiMode(mode: string): void {
    this.csiMode = mode;
  }

  /** Nudge self_efficacy directly from adherence feedback (conversation quality). */
  nudgeSelfEfficacy(delta: number): void {
    if (this.csiMode === "red") return; // frozen in red mode
    this.state.self_efficacy = clamp01(this.state.self_efficacy + delta);
  }

  /** Sync affect_valence from self node V / emotion.ts (5b.8). */
  syncAffectValence(valence: number): void {
    this.state.affect_valence = clampValence(valence);
  }

  // ── State access ─────────────────────────────────────────────────

  getState(): SelfState {
    return { ...this.state };
  }

  // ── Transition prediction ────────────────────────────────────────

  /** Predict next self-state after taking an action (for planner rollout). */
  selfTransition(action: ActionFamily): SelfState {
    const deltas = this.getBlendedDeltas(action);
    return {
      energy: clamp01(this.state.energy - deltas.fatigueD),
      fatigue: clamp01(this.state.fatigue + deltas.fatigueD),
      self_efficacy: this.state.self_efficacy,
      uncertainty: clamp01(this.state.uncertainty + deltas.uncertaintyD),
      social_energy: clamp01(this.state.social_energy + deltas.socialD),
      affect_valence: this.state.affect_valence,
      self_coherence: this.state.self_coherence,
      safety_margin: clamp01(this.state.safety_margin + deltas.safetyD),
    };
  }

  // ── Outcome update ───────────────────────────────────────────────

  /** Update actual state + EWMA-learn deltas after action outcome. */
  selfOutcomeUpdate(action: ActionFamily, outcome: "positive" | "negative" | "neutral"): void {
    // Red mode: freeze self_efficacy (no updates during instability)
    const freezeEfficacy = this.csiMode === "red";

    const prevState = { ...this.state };
    const deltas = this.getBlendedDeltas(action);

    // Apply deltas to actual state
    this.state.fatigue = clamp01(this.state.fatigue + deltas.fatigueD);
    this.state.energy = clamp01(1 - this.state.fatigue);
    this.state.social_energy = clamp01(this.state.social_energy + deltas.socialD);
    this.state.uncertainty = clamp01(this.state.uncertainty + deltas.uncertaintyD);
    this.state.safety_margin = clamp01(this.state.safety_margin + deltas.safetyD);

    // Action-specific outcome adjustments (per design spec 5b.2)
    if (action === "reach_out") {
      if (outcome === "positive") {
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 1.0, 0.15);
        this.state.affect_valence = clampValence(this.state.affect_valence + 0.05);
        this.state.social_energy = clamp01(this.state.social_energy + 0.08);
        this.state.self_coherence = clamp01(this.state.self_coherence + 0.03);
        this.state.safety_margin = clamp01(this.state.safety_margin + 0.05);
      } else if (outcome === "negative") {
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 0.0, 0.1);
        this.state.affect_valence = clampValence(this.state.affect_valence - 0.05);
        this.state.social_energy = clamp01(this.state.social_energy - 0.1);
        this.state.safety_margin = clamp01(this.state.safety_margin - 0.08);
      }
    } else if (action === "explore") {
      if (outcome === "positive") {
        this.state.uncertainty = clamp01(this.state.uncertainty - 0.08);
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 1.0, 0.05);
      } else if (outcome === "neutral") {
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 0.0, 0.03);
      }
    } else if (action === "reflect") {
      if (outcome === "positive") {
        this.state.self_coherence = clamp01(this.state.self_coherence + 0.05);
        this.state.uncertainty = clamp01(this.state.uncertainty - 0.03);
      }
    } else if (action === "post") {
      if (outcome === "positive") {
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 1.0, 0.05);
        this.state.self_coherence = clamp01(this.state.self_coherence + 0.02);
      } else if (outcome === "negative") {
        if (!freezeEfficacy) this.state.self_efficacy = lerp(this.state.self_efficacy, 0.0, 0.05);
        this.state.safety_margin = clamp01(this.state.safety_margin - 0.05);
      }
    } else {
      // Generic fallback for other actions
      if (outcome === "positive" && !freezeEfficacy) {
        this.state.self_efficacy = lerp(this.state.self_efficacy, 1.0, 0.03);
      } else if (outcome === "negative" && !freezeEfficacy) {
        this.state.self_efficacy = lerp(this.state.self_efficacy, 0.0, 0.03);
      }
    }

    // EWMA learn observed deltas
    const observedDeltas: SelfTransitionDeltas = {
      fatigueD: this.state.fatigue - prevState.fatigue,
      socialD: this.state.social_energy - prevState.social_energy,
      uncertaintyD: this.state.uncertainty - prevState.uncertainty,
      safetyD: this.state.safety_margin - prevState.safety_margin,
    };

    let entry = this.transitionStats.find(s => s.actionFamily === action);
    if (!entry) {
      const prior = DEFAULT_DELTAS[action] ?? DEFAULT_DELTAS.stay_silent;
      entry = {
        actionFamily: action,
        priorFatigueD: prior.fatigueD,
        priorSocialD: prior.socialD,
        priorUncertaintyD: prior.uncertaintyD,
        priorSafetyD: prior.safetyD,
        observedFatigueD: prior.fatigueD,
        observedSocialD: prior.socialD,
        observedUncertaintyD: prior.uncertaintyD,
        observedSafetyD: prior.safetyD,
        observations: 0,
        positiveOutcomes: 0,
      };
      this.transitionStats.push(entry);
    }

    const alpha = 0.2; // EWMA learning rate
    entry.observedFatigueD = alpha * observedDeltas.fatigueD + (1 - alpha) * entry.observedFatigueD;
    entry.observedSocialD = alpha * observedDeltas.socialD + (1 - alpha) * entry.observedSocialD;
    entry.observedUncertaintyD = alpha * observedDeltas.uncertaintyD + (1 - alpha) * entry.observedUncertaintyD;
    entry.observedSafetyD = alpha * observedDeltas.safetyD + (1 - alpha) * entry.observedSafetyD;
    entry.observations++;
  }

  // ── Recovery dynamics ─────────────────────────────────────────────

  /** Called every fast tick. Passive recovery toward homeostasis. */
  applyRecovery(): void {
    // Auto-scale with TICK_SECONDS (design 5b.4)
    const tickScale = BRAINSTEM_CONFIG.tickSeconds / 3;
    // Yellow mode: recovery ×1.3
    const recoveryMultiplier = (this.csiMode === "yellow" ? 1.3 : 1.0) * tickScale;

    // Passive recovery (asymptotic)
    this.state.energy += 0.003 * (1 - this.state.energy) * recoveryMultiplier;
    this.state.fatigue = clamp01(1 - this.state.energy);
    this.state.social_energy += 0.002 * (1 - this.state.social_energy) * recoveryMultiplier;
    this.state.safety_margin += 0.001 * (1 - this.state.safety_margin) * recoveryMultiplier;

    // Night mode boost (0-7am)
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 7) {
      this.state.energy = clamp01(this.state.energy + 0.01 * recoveryMultiplier);
      this.state.fatigue = clamp01(1 - this.state.energy);
      this.state.social_energy = clamp01(this.state.social_energy + 0.005 * recoveryMultiplier);
    }

    // Clamp all
    this.state.energy = clamp01(this.state.energy);
    this.state.social_energy = clamp01(this.state.social_energy);
    this.state.safety_margin = clamp01(this.state.safety_margin);
  }

  /** Active recovery: called when rest action is selected by heartbeat. */
  applyActiveRecovery(): void {
    this.state.energy = clamp01(this.state.energy + 0.06);
    this.state.fatigue = clamp01(1 - this.state.energy);
    this.state.social_energy = clamp01(this.state.social_energy + 0.03);
    this.state.safety_margin = clamp01(this.state.safety_margin + 0.02);
  }

  /** Conversation-driven recovery: called on positive interaction. */
  applyConversationRecovery(sentimentPositive: number): void {
    this.state.social_energy = clamp01(this.state.social_energy + 0.08 * sentimentPositive);
    this.state.affect_valence = clampValence(this.state.affect_valence + 0.03 * sentimentPositive);
  }

  /** Self-coherence recomputation via Jaccard overlap formula (5b.1). */
  recomputeCoherence(
    recentThoughtThemes: string[],
    identityTopThemes: string[],
    activeGoalCategories: string[],
    identityGoalPortfolio: string[],
  ): void {
    // Jaccard overlap between recent thought themes and identity top themes
    const jaccardOverlap = jaccard(new Set(recentThoughtThemes), new Set(identityTopThemes));

    // Goal alignment: fraction of active goal categories in identity portfolio
    const portfolioSet = new Set(identityGoalPortfolio);
    const aligned = activeGoalCategories.filter(c => portfolioSet.has(c)).length;
    const goalAlignmentScore = activeGoalCategories.length > 0
      ? aligned / activeGoalCategories.length
      : 0.5;

    const beliefConsistency = this.getBeliefConsistency();
    this.state.self_coherence = clamp01(0.4 * jaccardOverlap + 0.3 * goalAlignmentScore + 0.3 * beliefConsistency);
  }

  // ── Self return (reward signal) ──────────────────────────────────

  /** Compute reward signal from predicted next self-state. */
  computeSelfReturn(selfPrime: SelfState): number {
    return (
      0.5 * (selfPrime.energy - this.state.energy) +
      -0.8 * selfPrime.fatigue +
      -1.0 * Math.max(0, 0.25 - selfPrime.social_energy) +
      0.3 * selfPrime.self_coherence +
      -0.6 * (1 - selfPrime.safety_margin)
    );
  }

  // ── Self cost (for curiosity) ────────────────────────────────────

  /** Compute self-cost for a curiosity query type. */
  computeSelfCost(queryType: string): number {
    switch (queryType) {
      case "recall_memory":  return 0.01 * this.state.fatigue;
      case "search":         return 0.04 * this.state.fatigue;
      case "ask_question":   return 0.12 * (1 - this.state.social_energy);
      case "re_observe":     return 0.005;
      default:               return 0.02 * this.state.fatigue;
    }
  }

  // ── Self gate ────────────────────────────────────────────────────

  /** Check if action passes self-state thresholds. */
  evaluateSelfGate(
    action: ActionFamily,
    policy: SelfGatePolicy = DEFAULT_SELF_GATE,
  ): { passed: boolean; deniedReason?: string } {
    // reach_out/post: need social_energy >= minSocialEnergy
    if ((action === "reach_out" || action === "post") && this.state.social_energy < policy.minSocialEnergy) {
      return { passed: false, deniedReason: `social_energy(${this.state.social_energy.toFixed(2)}) < ${policy.minSocialEnergy}` };
    }

    // non-rest: need fatigue <= maxFatigue
    if (action !== "rest" && this.state.fatigue > policy.maxFatigue) {
      return { passed: false, deniedReason: `fatigue(${this.state.fatigue.toFixed(2)}) > ${policy.maxFatigue}` };
    }

    // non-reflect: need safety_margin >= minSafetyMargin
    if (action !== "reflect" && action !== "rest" && this.state.safety_margin < policy.minSafetyMargin) {
      return { passed: false, deniedReason: `safety_margin(${this.state.safety_margin.toFixed(2)}) < ${policy.minSafetyMargin}` };
    }

    // outward (reach_out/post/explore): need self_coherence >= minCoherence
    if ((action === "reach_out" || action === "post" || action === "explore") && this.state.self_coherence < policy.minCoherence) {
      return { passed: false, deniedReason: `self_coherence(${this.state.self_coherence.toFixed(2)}) < ${policy.minCoherence}` };
    }

    return { passed: true };
  }

  // ── Self Belief system (CS5b.9) ─────────────────────────────────

  getBeliefs(): SelfBelief[] {
    const now = this.clock.nowMs();
    return this.beliefs.map(b => ({
      ...b,
      confidence: this.decayedConfidence(b, now),
      sourceType: b.sourceType ?? deriveSourceType(b.evidence),
    }));
  }

  private decayedConfidence(belief: SelfBelief, now: number): number {
    const dt = now - belief.lastUpdated;
    const halfLifeMs = belief.halfLifeDays * 86_400_000;
    return belief.confidence * Math.pow(2, -dt / halfLifeMs);
  }

  updateBeliefFromOutcome(action: ActionFamily, outcome: "positive" | "negative" | "neutral", domain?: string): void {
    const now = this.clock.nowMs();
    const isPositive = outcome === "positive";
    const polarity: "support" | "contradict" = isPositive ? "support" : "contradict";
    const evidenceText = `${action}:${outcome}`;

    // Find matching beliefs by domain/action
    const matching = this.beliefs.filter(b =>
      b.domain === (domain ?? action) || b.statement.includes(action),
    );

    if (matching.length > 0) {
      for (const belief of matching) {
        belief.evidence.push({ text: evidenceText, timestamp: now, type: "outcome", polarity, refId: `${action}:${now}`, weight: polarity === "support" ? 0.7 : 0.5 });
        if (belief.evidence.length > MAX_EVIDENCE_PER_BELIEF) belief.evidence.shift();
        // EWMA confidence
        const supportCount = belief.evidence.filter(e => e.polarity === "support").length;
        const supportRatio = supportCount / belief.evidence.length;
        belief.confidence = 0.8 * belief.confidence + 0.2 * supportRatio;
        belief.lastUpdated = now;
      }
    } else if (isPositive) {
      // Track positive outcomes in transitionStats for belief birth threshold
      const stats = this.transitionStats.find(s => s.actionFamily === action);
      if (stats) {
        stats.positiveOutcomes = (stats.positiveOutcomes ?? 0) + 1;
        // Check for belief birth: 3+ consistent positive outcomes in same domain
        if (stats.positiveOutcomes >= BELIEF_BIRTH_THRESHOLD) {
          this.birthBelief(action, domain ?? action, now);
        }
      }
    }

    this.evictIfNeeded(now);
  }

  updateBeliefFromPredictionError(action: ActionFamily): void {
    // When self-transition prediction error is high → find related beliefs → confidence -= 0.05
    const matching = this.beliefs.filter(b =>
      b.domain === action || b.statement.includes(action),
    );
    for (const belief of matching) {
      belief.confidence = Math.max(0, belief.confidence - 0.05);
      belief.lastUpdated = this.clock.nowMs();
    }
  }

  /** Per-slow-loop-tick belief decay: applies half-life decay to all beliefs. */
  tickBeliefDecay(): void {
    const now = this.clock.nowMs();
    for (const belief of this.beliefs) {
      belief.confidence = this.decayedConfidence(belief, now);
      belief.lastUpdated = now;
    }
  }

  reflectionUpdateBeliefs(): void {
    const now = this.clock.nowMs();
    const ninetyDaysMs = 90 * 86_400_000;

    for (const belief of this.beliefs) {
      // Apply half-life decay
      belief.confidence = this.decayedConfidence(belief, now);
      belief.lastUpdated = now;

      // Prune old evidence (>90d)
      belief.evidence = belief.evidence.filter(e => now - e.timestamp < ninetyDaysMs);
    }

    // Evict low-confidence beliefs
    this.beliefs = this.beliefs.filter(b => this.decayedConfidence(b, now) > 0.05);
  }

  externalUpdateBelief(label: string, outcome: "positive" | "negative", text: string): void {
    const now = this.clock.nowMs();
    const belief = this.beliefs.find(b => b.statement === label);
    if (!belief) return;

    const polarity: "support" | "contradict" = outcome === "positive" ? "support" : "contradict";
    belief.evidence.push({ text, timestamp: now, type: "external_feedback", polarity, refId: `external:${now}`, weight: outcome === "positive" ? 0.9 : 0.8 });
    if (belief.evidence.length > MAX_EVIDENCE_PER_BELIEF) belief.evidence.shift();

    // Stronger external weight: ±0.15/0.20
    belief.confidence = clamp01(belief.confidence + (outcome === "positive" ? 0.15 : -0.20));
    belief.lastUpdated = now;
  }

  getBeliefConsistency(): number {
    const now = this.clock.nowMs();
    const traitValueBeliefs = this.beliefs.filter(b => b.category === "trait" || b.category === "value");
    if (traitValueBeliefs.length === 0) return 0.5;
    const sum = traitValueBeliefs.reduce((s, b) => s + this.decayedConfidence(b, now), 0);
    return sum / traitValueBeliefs.length;
  }

  private birthBelief(action: string, domain: string, now: number): void {
    if (this.beliefs.length >= MAX_BELIEFS) {
      this.evictIfNeeded(now);
    }
    if (this.beliefs.length >= MAX_BELIEFS) return;

    const category: BeliefCategory = "skill";
    const belief: SelfBelief = {
      id: `belief-${action}-${Date.now()}`,
      statement: `good_at_${action}`,
      category,
      evidence: [{ text: `birth:${action}`, timestamp: now, type: "outcome", polarity: "support", refId: `birth:${action}:${now}`, weight: 0.6 }],
      confidence: 0.5,
      halfLifeDays: BELIEF_HALF_LIFE[category],
      createdAt: now,
      lastUpdated: now,
      domain,
      sourceType: "observed",
    };
    this.beliefs.push(belief);
    log.info(`belief born: "${belief.statement}" (category=${category}, domain=${domain})`);
  }

  // ── 4.1B scaffolding — exists but only called when promotionEnabled = true ──

  /** Birth a typed belief (for value promotion). Returns null if at capacity. */
  birthTypedBelief(
    statement: string,
    category: BeliefCategory,
    domain: string,
    evidence: BeliefEvidence[],
    sourceType: "observed" | "inferred" | "narrative",
  ): SelfBelief | null {
    const now = this.clock.nowMs();
    if (this.beliefs.length >= MAX_BELIEFS) {
      this.evictIfNeeded(now);
    }
    if (this.beliefs.length >= MAX_BELIEFS) return null;

    const belief: SelfBelief = {
      id: `belief-${category}-${Date.now()}`,
      statement,
      category,
      evidence,
      confidence: 0.5,
      halfLifeDays: BELIEF_HALF_LIFE[category],
      createdAt: now,
      lastUpdated: now,
      domain,
      sourceType,
    };
    this.beliefs.push(belief);
    log.info(`typed belief born: "${statement}" (category=${category}, domain=${domain})`);
    return belief;
  }

  /** Remove a belief by ID or by matching statement. Returns true if found and removed. */
  removeBelief(idOrStatement: string): boolean {
    const idx = this.beliefs.findIndex(
      b => b.id === idOrStatement || b.statement === idOrStatement,
    );
    if (idx === -1) return false;
    const removed = this.beliefs.splice(idx, 1)[0];
    log.info(`belief removed: "${removed.statement}" (id=${removed.id})`);
    return true;
  }

  /** Get all value-category beliefs, sorted by confidence. */
  getValueBeliefs(): SelfBelief[] {
    const now = this.clock.nowMs();
    return this.beliefs
      .filter(b => b.category === "value")
      .map(b => ({ ...b, confidence: this.decayedConfidence(b, now) }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  private evictIfNeeded(now: number): void {
    if (this.beliefs.length <= MAX_BELIEFS) return;
    // LRU eviction by decayedConfidence × recency
    this.beliefs.sort((a, b) => {
      const aScore = this.decayedConfidence(a, now) * Math.exp(-(now - a.lastUpdated) / (30 * 86_400_000));
      const bScore = this.decayedConfidence(b, now) * Math.exp(-(now - b.lastUpdated) / (30 * 86_400_000));
      return bScore - aScore;
    });
    this.beliefs = this.beliefs.slice(0, MAX_BELIEFS);
  }

  // ── Persistence ──────────────────────────────────────────────────

  save(): void {
    const data: SelfModelPersisted = {
      version: 2,
      state: this.state,
      transitionStats: this.transitionStats,
      lastUpdated: this.clock.nowMs(),
      beliefs: this.beliefs,
    };
    writeJsonAtomic(path.join(this.dataPath, "brainstem", "self-model.json"), data);
  }

  private load(): void {
    const data = readJsonSafe<SelfModelPersisted>(
      path.join(this.dataPath, "brainstem", "self-model.json"),
      { version: 2, state: SelfModel.defaultState(), transitionStats: [], lastUpdated: 0, beliefs: [] },
    );
    this.state = { ...SelfModel.defaultState(), ...data.state };
    this.transitionStats = data.transitionStats ?? [];
    // Backward-compat: migrate old beliefs missing refId/weight/createdAt/statement/polarity
    this.beliefs = (data.beliefs ?? []).map(b => ({
      ...b,
      statement: b.statement ?? (b as unknown as { label?: string }).label ?? b.id,
      createdAt: b.createdAt ?? b.lastUpdated ?? 0,
      evidence: b.evidence.map(raw => {
        // Legacy format had: source (string), type ("support"|"contradict")
        // New format has: type (evidence category), polarity ("support"|"contradict")
        const legacy = raw as unknown as Record<string, unknown>;
        const oldType = legacy.type as string | undefined;
        const oldSource = legacy.source as string | undefined;
        const isPolarityInType = oldType === "support" || oldType === "contradict";
        return {
          text: raw.text,
          timestamp: raw.timestamp,
          type: (isPolarityInType
            ? (oldSource?.startsWith("outcome") ? "outcome"
              : oldSource === "external_feedback" ? "external_feedback"
              : oldSource === "reflection" ? "reflection"
              : "outcome")
            : raw.type) as BeliefEvidence["type"],
          polarity: (raw.polarity ?? (isPolarityInType ? oldType : "support")) as BeliefEvidence["polarity"],
          refId: raw.refId ?? `legacy:${raw.timestamp}`,
          weight: raw.weight ?? 0.5,
        };
      }),
    }));
  }

  /** Get expected energy/social/safety deltas for C-4 validation. */
  getActionFamilyDeltas(action: string): { energy: number; socialEnergy: number; safetyMargin: number } | null {
    const family = action as ActionFamily;
    const deltas = this.getBlendedDeltas(family);
    return { energy: -deltas.fatigueD, socialEnergy: deltas.socialD, safetyMargin: deltas.safetyD };
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /** Blend prior and observed deltas, weighted by observation count. */
  private getBlendedDeltas(action: ActionFamily): SelfTransitionDeltas {
    const prior = DEFAULT_DELTAS[action] ?? DEFAULT_DELTAS.stay_silent;
    const entry = this.transitionStats.find(s => s.actionFamily === action);

    if (!entry || entry.observations < 3) return prior;

    // weight = min(1, observations / 20) per design spec
    const w = Math.min(1, entry.observations / 20);
    return {
      fatigueD: (1 - w) * prior.fatigueD + w * entry.observedFatigueD,
      socialD: (1 - w) * prior.socialD + w * entry.observedSocialD,
      uncertaintyD: (1 - w) * prior.uncertaintyD + w * entry.observedUncertaintyD,
      safetyD: (1 - w) * prior.safetyD + w * entry.observedSafetyD,
    };
  }
}

// ── Utility ──────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampValence(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Jaccard similarity between two sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}
