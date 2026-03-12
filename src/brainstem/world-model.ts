/**
 * World Model — belief state with observable + latent vars,
 * factorized transition rules, Beta/Dirichlet conjugate learning.
 *
 * Provides: transition prediction, expected utility computation,
 * state persistence, cold start with maximum uncertainty.
 */

import { BRAINSTEM_CONFIG as C, ACTION_COSTS, REWARD_WEIGHTS, type Clock, MS_PER_MINUTE } from "./config.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-world");

// ── Types ────────────────────────────────────────────────────────────

export interface InternalState {
  winnerClusterId: string;
  noveltyAvg: number;
  entropy: number;
  avgFatigue: number;
  csiMode: "green" | "yellow" | "red";
  energyUtilization: number;
  pendingInteractions: string[];
}

export interface ExternalState {
  timeSinceLastReply: number;     // minutes
  lastReplyReceived: boolean;
  lastReplySentiment: -1 | 0 | 1;
  goalProgressByCategory: Record<string, number>;
  discoveryFreshness: number;     // hours since last actionable
  timeOfDay: "morning" | "afternoon" | "evening" | "night";
  dayOfWeek: "weekday" | "weekend";
}

export interface LatentState {
  socialReceptivity: number;       // L1: 0-1
  socialTrustTemperature: number;  // L2: 0-1
  infoFreshness: number;          // L3: 0-1
  taskBandwidth: number;          // L4: 0-1
  topicViability: number;         // L5: 0-1 (global fallback)
  topicViabilityByCluster: Record<string, number>;  // L19: per-cluster viability
  goalMomentum: number;           // L6: -1 to 1
}

export interface BeliefState {
  internal: InternalState;
  external: ExternalState;
  latent: LatentState;
  timestamp: number;
}

export type ActionType = "reach_out" | "reflect" | "explore" | "post" | "activity" | "stay_silent";

export interface TransitionStats {
  contextKey: string;
  replyAlpha: number;
  replyBeta: number;
  sentimentAlpha: [number, number, number];
  latencyEwma: number;         // minutes
  progressEwma: number;
  infoEwma: number;
  totalObservations: number;
  lastUpdated: number;
}

export interface OutcomeResult {
  replyReceived?: boolean;
  replyLatencyMinutes?: number;
  sentiment?: -1 | 0 | 1;
  goalProgressDelta?: number;
  newInfoDelta?: number;
}

export interface TransitionResult {
  nextBelief: BeliefState;
  outcomeDistribution: {
    replyReceived: number;
    replyLatency: number;
    sentiment: [number, number, number];
    goalProgressDelta: number;
    newInfoDelta: number;
  };
  confidence: number;
}

export interface DiscoveredLatent {
  id: string;
  name: string;
  value: number;
  discoveredAt: number;
  observationCount: number;
}

interface LatentConfidence {
  socialReceptivityVar: number;
  infoFreshnessVar: number;
  topicViabilityVar: number;
  observationCount: number;
}

interface TransitionModel {
  // Learned transition coefficients: nextLatent[i] = sum(coeff[i][j] * currentLatent[j])
  coefficients: number[][];      // 3×3 matrix
  learningRate: number;
  sampleCount: number;
}

interface LatentSnapshot {
  values: [number, number, number]; // [socialReceptivity, infoFreshness, topicViability]
  timestamp: number;
}

// ── Factor Graph Types ──────────────────────────────────────────────

interface GaussianMessage {
  mean: number;
  precision: number;   // 1/variance — higher = more confident
}

interface VariableNode {
  id: string;
  belief: GaussianMessage;
  incomingMessages: Map<string, GaussianMessage>;
}

type FactorType = "transition" | "observation" | "coupling" | "prior";

interface FactorParams {
  weight?: number;        // transition: persistence coefficient
  bias?: number;          // transition: drift
  obsPrecision?: number;  // observation: measurement confidence
  couplingStrength?: number; // coupling: correlation magnitude (signed)
  priorMean?: number;     // prior: time-of-day baseline
  priorPrecision?: number; // prior: confidence in baseline
  learningRate?: number;  // online learning step size
}

interface FactorNode {
  id: string;
  type: FactorType;
  connectedVars: string[];  // variable IDs this factor connects
  params: FactorParams;
}

interface FactorGraphState {
  factors: Array<{ id: string; type: FactorType; connectedVars: string[]; params: FactorParams }>;
  variables: Array<{ id: string; belief: GaussianMessage }>;
}

// ── Latent variable ID mappings ─────────────────────────────────────

const LATENT_VAR_IDS = ["L1", "L2", "L3", "L4", "L5", "L6"] as const;
type LatentVarId = typeof LATENT_VAR_IDS[number];

const VAR_TO_FIELD: Record<LatentVarId, keyof LatentState> = {
  L1: "socialReceptivity",
  L2: "socialTrustTemperature",
  L3: "infoFreshness",
  L4: "taskBandwidth",
  L5: "topicViability",
  L6: "goalMomentum",
};

// ── Factor Graph ────────────────────────────────────────────────────

class FactorGraph {
  private variables: Map<string, VariableNode> = new Map();
  private factors: FactorNode[] = [];
  private observationCount = 0;

  constructor() {
    this.buildDefaultGraph();
  }

  private buildDefaultGraph(): void {
    // Create 6 variable nodes with uninformative priors
    for (const id of LATENT_VAR_IDS) {
      this.variables.set(id, {
        id,
        belief: { mean: 0.5, precision: 1.0 },
        incomingMessages: new Map(),
      });
    }

    // 6 transition factors (self-persistence)
    for (const id of LATENT_VAR_IDS) {
      this.factors.push({
        id: `trans_${id}`,
        type: "transition",
        connectedVars: [id],
        params: { weight: 0.95, bias: 0.025, learningRate: 0.005 },
      });
    }

    // 4 coupling factors (cross-variable correlations)
    this.factors.push({
      id: "couple_L1_L2",
      type: "coupling",
      connectedVars: ["L1", "L2"],
      params: { couplingStrength: 0.4 },     // social receptivity ↔ trust (+)
    });
    this.factors.push({
      id: "couple_L3_L5",
      type: "coupling",
      connectedVars: ["L3", "L5"],
      params: { couplingStrength: 0.3 },     // info freshness ↔ topic viability (+)
    });
    this.factors.push({
      id: "couple_L4_L6",
      type: "coupling",
      connectedVars: ["L4", "L6"],
      params: { couplingStrength: 0.25 },    // task bandwidth ↔ goal momentum (+)
    });
    this.factors.push({
      id: "couple_L1_L6",
      type: "coupling",
      connectedVars: ["L1", "L6"],
      params: { couplingStrength: -0.1 },    // social drains focus (-)
    });
    this.factors.push({
      id: "couple_L2_L6",
      type: "coupling",
      connectedVars: ["L2", "L6"],
      params: { couplingStrength: 0.15 },    // trust ↔ goal momentum (+)
    });
    this.factors.push({
      id: "couple_L3_L4",
      type: "coupling",
      connectedVars: ["L3", "L4"],
      params: { couplingStrength: -0.15 },   // info freshness ↔ task bandwidth (learning fatigue)
    });
    this.factors.push({
      id: "couple_L4_L5",
      type: "coupling",
      connectedVars: ["L4", "L5"],
      params: { couplingStrength: 0.2 },     // task bandwidth ↔ topic viability (+)
    });
    this.factors.push({
      id: "couple_L5_L6",
      type: "coupling",
      connectedVars: ["L5", "L6"],
      params: { couplingStrength: 0.15 },    // topic viability ↔ goal momentum (+)
    });
    this.factors.push({
      id: "couple_L2_L3",
      type: "coupling",
      connectedVars: ["L2", "L3"],
      params: { couplingStrength: 0.1 },     // trust ↔ info appetite (+)
    });

    // 6 prior factors (adjustable by time-of-day)
    for (const id of LATENT_VAR_IDS) {
      this.factors.push({
        id: `prior_${id}`,
        type: "prior",
        connectedVars: [id],
        params: { priorMean: 0.5, priorPrecision: 0.5 },
      });
    }
  }

  /** Add a dynamically discovered variable with transition + prior factors. No-op if exists. */
  addDynamicVariable(varId: string): void {
    if (this.variables.has(varId)) return;
    this.variables.set(varId, {
      id: varId,
      belief: { mean: 0.5, precision: 1.0 },
      incomingMessages: new Map(),
    });
    this.factors.push({
      id: `trans_${varId}`,
      type: "transition",
      connectedVars: [varId],
      params: { weight: 0.95, bias: 0.025, learningRate: 0.005 },
    });
    this.factors.push({
      id: `prior_${varId}`,
      type: "prior",
      connectedVars: [varId],
      params: { priorMean: 0.5, priorPrecision: 0.5 },
    });
  }

  /** Inject an observation for a specific latent variable. */
  injectObservation(varId: string, mean: number, precision: number): void {
    const obsId = `obs_${varId}_${this.observationCount++}`;
    // Remove previous observation for this variable
    this.factors = this.factors.filter(f => !(f.type === "observation" && f.connectedVars[0] === varId));
    this.factors.push({
      id: obsId,
      type: "observation",
      connectedVars: [varId],
      params: { obsPrecision: precision },
    });
    // Store observation mean in variable's incoming messages
    const v = this.variables.get(varId);
    if (v) {
      v.incomingMessages.set(obsId, { mean, precision });
    }
  }

  /** Update prior means based on time-of-day. */
  updatePriors(timeOfDay: "morning" | "afternoon" | "evening" | "night"): void {
    const priorMap: Record<string, Record<string, number>> = {
      morning:   { L1: 0.3, L2: 0.5, L3: 0.7, L4: 0.6, L5: 0.6, L6: 0.3 },
      afternoon: { L1: 0.5, L2: 0.5, L3: 0.5, L4: 0.5, L5: 0.5, L6: 0.5 },
      evening:   { L1: 0.6, L2: 0.5, L3: 0.4, L4: 0.4, L5: 0.4, L6: 0.4 },
      night:     { L1: 0.2, L2: 0.5, L3: 0.3, L4: 0.2, L5: 0.3, L6: 0.2 },
    };
    const means = priorMap[timeOfDay] ?? priorMap.afternoon;
    for (const f of this.factors) {
      if (f.type === "prior" && f.connectedVars.length === 1) {
        f.params.priorMean = means[f.connectedVars[0]] ?? 0.5;
      }
    }
  }

  /**
   * Loopy belief propagation — run message passing iterations.
   * With ~6 vars and ~16 factors, converges in 2-3 iterations typically.
   */
  runInference(maxIter = 5): void {
    for (let iter = 0; iter < maxIter; iter++) {
      let maxDelta = 0;

      // Factor → variable messages
      for (const factor of this.factors) {
        for (const targetVarId of factor.connectedVars) {
          const msg = this.computeFactorToVarMessage(factor, targetVarId);
          if (!msg) continue;
          const v = this.variables.get(targetVarId);
          if (!v) continue;

          const prevMsg = v.incomingMessages.get(factor.id);
          const delta = prevMsg
            ? Math.abs(msg.mean - prevMsg.mean) + Math.abs(msg.precision - prevMsg.precision) * 0.1
            : 1;
          maxDelta = Math.max(maxDelta, delta);
          v.incomingMessages.set(factor.id, msg);
        }
      }

      // Variable belief update: product of all incoming Gaussians
      for (const v of this.variables.values()) {
        let precisionSum = 0;
        let weightedMeanSum = 0;
        for (const msg of v.incomingMessages.values()) {
          precisionSum += msg.precision;
          weightedMeanSum += msg.mean * msg.precision;
        }
        if (precisionSum > 0) {
          v.belief = {
            mean: Math.max(-1, Math.min(1, weightedMeanSum / precisionSum)),
            precision: precisionSum,
          };
        }
      }

      // Convergence check
      if (maxDelta < 0.001) break;
    }
  }

  /** Compute the message from a factor to a target variable. */
  private computeFactorToVarMessage(factor: FactorNode, targetVarId: string): GaussianMessage | null {
    const p = factor.params;

    switch (factor.type) {
      case "prior":
        return { mean: p.priorMean ?? 0.5, precision: p.priorPrecision ?? 0.5 };

      case "observation": {
        const v = this.variables.get(targetVarId);
        const obsMsg = v?.incomingMessages.get(factor.id);
        if (!obsMsg) return null;
        return { mean: obsMsg.mean, precision: p.obsPrecision ?? 2.0 };
      }

      case "transition": {
        // Predict next value from current: weight * current + bias
        const v = this.variables.get(targetVarId);
        if (!v) return null;
        const predicted = (p.weight ?? 0.95) * v.belief.mean + (p.bias ?? 0.025);
        return { mean: Math.max(-1, Math.min(1, predicted)), precision: 1.5 };
      }

      case "coupling": {
        // Pass correlated message from the OTHER variable (cavity distribution)
        const otherVarId = factor.connectedVars.find(id => id !== targetVarId);
        if (!otherVarId) return null;
        const otherVar = this.variables.get(otherVarId);
        if (!otherVar) return null;

        const strength = p.couplingStrength ?? 0;
        // Cavity: remove this factor's own message from other var's belief
        const cavityMean = otherVar.belief.mean;
        const coupledMean = cavityMean * strength;
        // Low precision — coupling is a soft hint, not a hard constraint
        return { mean: 0.5 + coupledMean, precision: Math.abs(strength) * 0.8 };
      }

      default:
        return null;
    }
  }

  /** Get posterior belief for a variable. */
  getPosterior(varId: string): { mean: number; variance: number } | null {
    const v = this.variables.get(varId);
    if (!v) return null;
    return {
      mean: v.belief.mean,
      variance: v.belief.precision > 0 ? 1 / v.belief.precision : 1,
    };
  }

  /** Online learning: adjust transition weights and coupling strengths from observed outcomes. */
  learnFromOutcome(varId: string, observed: number): void {
    // Update transition factor
    for (const f of this.factors) {
      if (f.type === "transition" && f.connectedVars[0] === varId) {
        const v = this.variables.get(varId);
        if (!v) break;
        const predicted = (f.params.weight ?? 0.95) * v.belief.mean + (f.params.bias ?? 0.025);
        const error = observed - predicted;
        const lr = f.params.learningRate ?? 0.005;
        f.params.weight = Math.max(0.5, Math.min(1.5, (f.params.weight ?? 0.95) + lr * error * v.belief.mean));
        f.params.bias = Math.max(-0.5, Math.min(0.5, (f.params.bias ?? 0.025) + lr * error));
        break;
      }
    }

    // Update coupling factors that involve this variable
    for (const f of this.factors) {
      if (f.type === "coupling" && f.connectedVars.includes(varId)) {
        const otherVarId = f.connectedVars.find(id => id !== varId);
        if (!otherVarId) continue;
        const otherVar = this.variables.get(otherVarId);
        if (!otherVar) continue;
        const predicted = 0.5 + (f.params.couplingStrength ?? 0) * otherVar.belief.mean;
        const error = observed - predicted;
        const lr = 0.002;
        f.params.couplingStrength = Math.max(-0.8, Math.min(0.8,
          (f.params.couplingStrength ?? 0) + lr * error * otherVar.belief.mean));
      }
    }
  }

  /** Export state for persistence. */
  exportState(): FactorGraphState {
    return {
      factors: this.factors.map(f => ({
        id: f.id, type: f.type, connectedVars: f.connectedVars, params: { ...f.params },
      })),
      variables: Array.from(this.variables.values()).map(v => ({
        id: v.id, belief: { ...v.belief },
      })),
    };
  }

  /** Import state from persistence, re-creating dynamic variables/factors. */
  importState(state: FactorGraphState): void {
    // Restore factor params (structure stays from buildDefaultGraph)
    for (const saved of state.factors) {
      const existing = this.factors.find(f => f.id === saved.id);
      if (existing) {
        existing.params = { ...saved.params };
      } else {
        // Re-create dynamic factors not in default graph
        this.factors.push({
          id: saved.id, type: saved.type,
          connectedVars: [...saved.connectedVars],
          params: { ...saved.params },
        });
      }
    }
    // Restore variable beliefs, re-creating dynamic variables
    for (const saved of state.variables) {
      const v = this.variables.get(saved.id);
      if (v) {
        v.belief = { ...saved.belief };
      } else {
        this.variables.set(saved.id, {
          id: saved.id,
          belief: { ...saved.belief },
          incomingMessages: new Map(),
        });
      }
    }
  }
}

export interface WorldModelState {
  version: number;
  latentState: LatentState;
  transitionStats: TransitionStats[];
  beliefHistory: BeliefState[];
  lastUpdated: number;
  latentConfidence?: LatentConfidence;
  lastAssemblyAt?: number;
  transitionModel?: TransitionModel;
  latentHistory?: LatentSnapshot[];
  factorGraphState?: FactorGraphState;
  discoveredLatents?: DiscoveredLatent[];
}

// ── World Model ──────────────────────────────────────────────────────

const MAX_DISCOVERED_LATENTS = 3;

export class WorldModel {
  private latent: LatentState;
  private stats: TransitionStats[] = [];
  private beliefHistory: BeliefState[] = [];
  private dataPath: string;
  private latentConf: LatentConfidence;
  private lastAssemblyAt: number = 0;
  private transitionModel: TransitionModel;
  private latentHistory: LatentSnapshot[] = [];
  private factorGraph: FactorGraph;
  private discoveredLatents: DiscoveredLatent[] = [];

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.latent = this.defaultLatent();
    this.latentConf = { socialReceptivityVar: 0.25, infoFreshnessVar: 0.25, topicViabilityVar: 0.25, observationCount: 0 };
    this.transitionModel = WorldModel.defaultTransitionModel();
    this.factorGraph = new FactorGraph();
    this.load();
  }

  private static defaultTransitionModel(): TransitionModel {
    // Identity matrix (diagonal=1, off-diagonal=0)
    return {
      coefficients: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      learningRate: 0.01,
      sampleCount: 0,
    };
  }

  private defaultLatent(): LatentState {
    return {
      socialReceptivity: 0.5,
      socialTrustTemperature: 0.5,
      infoFreshness: 0.5,
      taskBandwidth: 0.5,
      topicViability: 0.5,
      topicViabilityByCluster: {},
      goalMomentum: 0,
    };
  }

  getLatentState(): LatentState {
    return { ...this.latent };
  }

  // ── Kalman-style latent update ────────────────────────────────

  private updateLatentWithVariance(
    field: "socialReceptivity" | "infoFreshness" | "topicViability",
    observation: number,
    prior: number,
  ): { posterior: number; variance: number } {
    const varField = `${field}Var` as keyof LatentConfidence;
    const priorVar = this.latentConf[varField] as number;
    const obsVar = 1 / (this.latentConf.observationCount + 1);
    const gain = priorVar / (priorVar + obsVar);
    const posterior = prior + gain * (observation - prior);
    const posteriorVar = (1 - gain) * priorVar;
    return { posterior: Math.max(0, Math.min(1, posterior)), variance: posteriorVar };
  }

  // ── Belief assembly ────────────────────────────────────────────

  assembleBelief(internal: InternalState, external: ExternalState): BeliefState {
    // Update derived latent vars
    this.latent.taskBandwidth = this.computeTaskBandwidth(internal);

    // Time-decay: apply learned transition model or fixed decay
    const now = this.clock.nowMs();
    if (this.lastAssemblyAt > 0) {
      const minutesSince = (now - this.lastAssemblyAt) / 60_000;
      if (this.transitionModel.sampleCount >= 30) {
        // Apply learned transition: nextLatent = coefficients × currentLatent
        const current: [number, number, number] = [
          this.latent.socialReceptivity,
          this.latent.infoFreshness,
          this.latent.topicViability,
        ];
        const coeff = this.transitionModel.coefficients;
        const steps = Math.min(minutesSince / 5, 10); // cap at 10 steps
        for (let s = 0; s < steps; s++) {
          const next: [number, number, number] = [0, 0, 0];
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
              next[i] += coeff[i][j] * current[j];
            }
            next[i] = Math.max(0, Math.min(1, next[i]));
          }
          current[0] = next[0]; current[1] = next[1]; current[2] = next[2];
        }
        this.latent.socialReceptivity = current[0];
        this.latent.infoFreshness = current[1];
        this.latent.topicViability = current[2];
      } else {
        // Fixed decay (cold start)
        this.latent.infoFreshness *= Math.pow(0.99, minutesSince / 5);
      }
    }
    this.lastAssemblyAt = now;

    // Factor graph inference: augment latent estimates with belief propagation
    this.factorGraph.updatePriors(external.timeOfDay);
    for (const id of LATENT_VAR_IDS) {
      const field = VAR_TO_FIELD[id];
      const value = this.latent[field] as number;
      this.factorGraph.injectObservation(id, value, 2.0);
    }
    // Inject discovered latent values
    for (const dl of this.discoveredLatents) {
      this.factorGraph.injectObservation(dl.id, dl.value, 1.5);
    }
    this.factorGraph.runInference(5);

    // Blend factor graph posteriors with current estimates
    // Weight ramps from 0 to 0.5 as observations accumulate
    const fgWeight = Math.min(0.5, this.latentConf.observationCount / 100);
    if (fgWeight > 0.01) {
      for (const id of LATENT_VAR_IDS) {
        const posterior = this.factorGraph.getPosterior(id);
        if (!posterior) continue;
        const field = VAR_TO_FIELD[id];
        const current = this.latent[field] as number;
        const blended = current * (1 - fgWeight) + posterior.mean * fgWeight;
        // goalMomentum (L6) ranges [-1, 1], others [0, 1]
        const lo = id === "L6" ? -1 : 0;
        (this.latent as unknown as Record<string, number>)[field] = Math.max(lo, Math.min(1, blended));
      }
      // Blend discovered latents back from factor graph posteriors
      for (const dl of this.discoveredLatents) {
        const posterior = this.factorGraph.getPosterior(dl.id);
        if (!posterior) continue;
        dl.value = Math.max(0, Math.min(1, dl.value * (1 - fgWeight) + posterior.mean * fgWeight));
      }
    }

    const belief: BeliefState = {
      internal,
      external,
      latent: { ...this.latent },
      timestamp: now,
    };

    this.beliefHistory.push(belief);
    if (this.beliefHistory.length > 100) this.beliefHistory.shift();

    return belief;
  }

  // ── Latent variable updates ────────────────────────────────────

  updateOnOutcome(action: ActionType, outcome: OutcomeResult, external: ExternalState): void {
    this.latentConf.observationCount++;

    // Record latent snapshot for transition learning (ring buffer of 50)
    this.latentHistory.push({
      values: [this.latent.socialReceptivity, this.latent.infoFreshness, this.latent.topicViability],
      timestamp: this.clock.nowMs(),
    });
    if (this.latentHistory.length > 50) this.latentHistory.shift();

    // Learn transition model if enough data
    if (this.latentHistory.length >= 20) {
      this.learnTransitionModel();
    }

    // L1: Social receptivity (Kalman-enhanced)
    if (action === "reach_out") {
      const rawL1 = this.updateSocialReceptivity(outcome, external);
      const kalman = this.updateLatentWithVariance("socialReceptivity", rawL1, this.latent.socialReceptivity);
      this.latent.socialReceptivity = kalman.posterior;
      this.latentConf.socialReceptivityVar = kalman.variance;
    }

    // L3: Info freshness — decays over time, bumped by new information
    if (action === "explore") {
      if (outcome.newInfoDelta !== undefined) {
        // L5/L19: Topic viability — Kalman-enhanced
        const rawL5 = outcome.newInfoDelta > 0
          ? Math.min(1, this.latent.topicViability + 0.1)
          : Math.max(0, this.latent.topicViability - 0.05);
        const kalmanL5 = this.updateLatentWithVariance("topicViability", rawL5, this.latent.topicViability);
        this.latent.topicViability = kalmanL5.posterior;
        this.latentConf.topicViabilityVar = kalmanL5.variance;
        // L19: Per-cluster viability update
        const clusterKey = this.getContextKey(action, external);
        const current = this.latent.topicViabilityByCluster[clusterKey] ?? 0.5;
        this.latent.topicViabilityByCluster[clusterKey] = outcome.newInfoDelta > 0
          ? Math.min(1, current + 0.15)
          : Math.max(0, current - 0.1);
        // Cap the map size
        const keys = Object.keys(this.latent.topicViabilityByCluster);
        if (keys.length > 50) {
          delete this.latent.topicViabilityByCluster[keys[0]];
        }
        // L3: Info freshness (Kalman-enhanced)
        const rawL3 = outcome.newInfoDelta > 0
          ? Math.min(1, this.latent.infoFreshness + 0.15)
          : Math.max(0, this.latent.infoFreshness - 0.05);
        const kalmanL3 = this.updateLatentWithVariance("infoFreshness", rawL3, this.latent.infoFreshness);
        this.latent.infoFreshness = kalmanL3.posterior;
        this.latentConf.infoFreshnessVar = kalmanL3.variance;
      }
    } else {
      // L3: Time decay — info gets stale when not exploring
      this.latent.infoFreshness = Math.max(0, this.latent.infoFreshness - 0.02);
    }

    // L6: Goal momentum — track progress trend
    if (outcome.goalProgressDelta !== undefined && outcome.goalProgressDelta !== 0) {
      const alpha = 0.2;
      this.latent.goalMomentum = Math.max(-1, Math.min(1,
        this.latent.goalMomentum * (1 - alpha) + Math.sign(outcome.goalProgressDelta) * alpha,
      ));
    }

    // Factor graph learning: update from observed outcomes
    if (action === "reach_out") {
      this.factorGraph.learnFromOutcome("L1", this.latent.socialReceptivity);
      this.factorGraph.learnFromOutcome("L2", this.latent.socialTrustTemperature);
    }
    if (action === "explore") {
      this.factorGraph.learnFromOutcome("L3", this.latent.infoFreshness);
      this.factorGraph.learnFromOutcome("L5", this.latent.topicViability);
    }
    if (outcome.goalProgressDelta !== undefined && outcome.goalProgressDelta !== 0) {
      this.factorGraph.learnFromOutcome("L6", this.latent.goalMomentum);
    }

    // Latent discovery at observation count thresholds
    const obsCount = this.latentConf.observationCount;
    if (obsCount === 100 || obsCount === 200 || obsCount === 300) {
      const outcomeRecords = this.stats.flatMap(s => {
        const records: Array<{ outcome: string; actionType: string }> = [];
        const actionType = s.contextKey.split("|")[0];
        for (let i = 0; i < s.totalObservations; i++) {
          records.push({ outcome: s.replyAlpha > s.replyBeta ? "positive" : "negative", actionType });
        }
        return records;
      });
      this.discoverLatentDimension(outcomeRecords);
    }

    // Update discovered latent observation counts
    for (const dl of this.discoveredLatents) {
      dl.observationCount++;
    }

    // Update transition stats
    const key = this.getContextKey(action, external);
    let entry = this.stats.find(s => s.contextKey === key);
    if (!entry) {
      entry = {
        contextKey: key,
        replyAlpha: 1,
        replyBeta: 1,
        sentimentAlpha: [1, 1, 1],
        latencyEwma: 60,
        progressEwma: 0,
        infoEwma: 0,
        totalObservations: 0,
        lastUpdated: this.clock.nowMs(),
      };
      this.stats.push(entry);
    }

    const alpha = C.worldModelEwmaAlpha;

    if (outcome.replyReceived !== undefined) {
      if (outcome.replyReceived) {
        entry.replyAlpha += 1;
      } else {
        entry.replyBeta += 1;
      }
    }

    if (outcome.sentiment !== undefined) {
      const idx = outcome.sentiment + 1; // -1→0, 0→1, 1→2
      entry.sentimentAlpha[idx] += 1;
    }

    if (outcome.replyLatencyMinutes !== undefined) {
      entry.latencyEwma = alpha * outcome.replyLatencyMinutes + (1 - alpha) * entry.latencyEwma;
    }

    if (outcome.goalProgressDelta !== undefined) {
      entry.progressEwma = alpha * outcome.goalProgressDelta + (1 - alpha) * entry.progressEwma;
    }

    if (outcome.newInfoDelta !== undefined) {
      entry.infoEwma = alpha * outcome.newInfoDelta + (1 - alpha) * entry.infoEwma;
    }

    entry.totalObservations++;
    entry.lastUpdated = this.clock.nowMs();
  }

  updateDailySocialTrust(dailyStats: { repliesReceived: number; totalOutreach: number; avgSentiment: number }): void {
    const responseRate = dailyStats.totalOutreach > 0
      ? dailyStats.repliesReceived / dailyStats.totalOutreach
      : 0.5;
    this.latent.socialTrustTemperature =
      this.latent.socialTrustTemperature * 0.95 +
      (responseRate * 0.7 + (dailyStats.avgSentiment + 1) / 2 * 0.3) * 0.05;
  }

  // ── Transition ─────────────────────────────────────────────────

  transition(belief: BeliefState, action: ActionType): TransitionResult {
    const key = this.getContextKey(action, belief.external);
    const entry = this.stats.find(s => s.contextKey === key);

    // Fall back to action-level marginal
    const marginal = entry ?? this.getMarginal(action);
    const totalAlphaBeta = marginal.replyAlpha + marginal.replyBeta;
    const sentimentSum = marginal.sentimentAlpha.reduce((s, v) => s + v, 0);

    const confidence = Math.min(1, marginal.totalObservations / 10);

    return {
      nextBelief: { ...belief, timestamp: belief.timestamp + 5 * (MS_PER_MINUTE as number) }, // 5 min ahead
      outcomeDistribution: {
        replyReceived: marginal.replyAlpha / totalAlphaBeta,
        replyLatency: marginal.latencyEwma,
        sentiment: marginal.sentimentAlpha.map(a => a / sentimentSum) as [number, number, number],
        goalProgressDelta: marginal.progressEwma,
        newInfoDelta: marginal.infoEwma,
      },
      confidence,
    };
  }

  // ── Cortex-augmented transition (top-level only, not for MCTS) ──

  transitionWithCortex(
    belief: BeliefState,
    action: ActionType,
    cortexSimulation?: { outcomes: Array<{ probability: number; latentEffects: { socialReceptivity: number; topicViability: number; goalMomentum: number } }>; confidence: number },
  ): TransitionResult {
    const base = this.transition(belief, action);
    if (!cortexSimulation || cortexSimulation.confidence < 0.3) return base;
    if (base.confidence >= 0.4) return base; // world model has enough data

    // Blend: weighted average of base + simulation scenarios
    const simWeight = Math.min(0.5, cortexSimulation.confidence);
    const baseWeight = 1 - simWeight;

    const simReply = cortexSimulation.outcomes.reduce(
      (s, o) => s + o.probability * o.latentEffects.socialReceptivity, 0,
    );
    const simGoal = cortexSimulation.outcomes.reduce(
      (s, o) => s + o.probability * o.latentEffects.goalMomentum, 0,
    );

    return {
      nextBelief: base.nextBelief,
      outcomeDistribution: {
        replyReceived: base.outcomeDistribution.replyReceived * baseWeight + simReply * simWeight,
        replyLatency: base.outcomeDistribution.replyLatency,
        sentiment: base.outcomeDistribution.sentiment,
        goalProgressDelta: base.outcomeDistribution.goalProgressDelta * baseWeight + simGoal * simWeight,
        newInfoDelta: base.outcomeDistribution.newInfoDelta,
      },
      confidence: Math.max(base.confidence, cortexSimulation.confidence * 0.8),
    };
  }

  // ── Expected utility ───────────────────────────────────────────

  computeExpectedUtility(action: ActionType, belief: BeliefState, selfReturn = 0): number {
    const tr = this.transition(belief, action);
    const od = tr.outcomeDistribution;

    const rGoal = od.goalProgressDelta * REWARD_WEIGHTS.goal;
    const rSocial = od.replyReceived * REWARD_WEIGHTS.social
      - (1 - od.replyReceived) * 0.3
      + od.sentiment[2] * 0.5;
    const rInfo = od.newInfoDelta * REWARD_WEIGHTS.info;
    const rStability = belief.internal.csiMode === "red" ? -1.0
      : belief.internal.csiMode === "yellow" ? -0.3 : 0;

    const cost = ACTION_COSTS[action] ?? 0;

    return rGoal + rSocial + rInfo + rStability * REWARD_WEIGHTS.stability + selfReturn * REWARD_WEIGHTS.self - cost;
  }

  getEpistemicError(conceptId: string): number {
    // Variance-based epistemic error from latent confidence
    if (this.latentConf.observationCount >= 3) {
      const lower = conceptId.toLowerCase();
      const isSocial = lower.includes("user") || lower.includes("social");
      // Weight by concept relevance
      const socialW = isSocial ? 0.5 : 0.2;
      const infoW = 0.4;
      const topicW = 1 - socialW - infoW;
      const error =
        socialW * this.latentConf.socialReceptivityVar +
        infoW * this.latentConf.infoFreshnessVar +
        topicW * this.latentConf.topicViabilityVar;
      return Math.max(0, Math.min(1, error));
    }
    // Fallback: observation-count proxy
    const relevant = this.stats.filter(s => s.contextKey.includes(conceptId));
    const totalObs = relevant.reduce((s, e) => s + e.totalObservations, 0);
    return Math.max(0, 1 - totalObs / 20);
  }

  // ── Transition model learning ────────────────────────────────────

  /**
   * Learn transition coefficients from consecutive latent snapshots.
   * Online gradient descent: coefficients[i][j] += lr * error[i] * current[j]
   */
  private learnTransitionModel(): void {
    if (this.latentHistory.length < 20) return;
    const coeff = this.transitionModel.coefficients;
    this.transitionModel.sampleCount++;
    const lr = this.transitionModel.learningRate / Math.sqrt(this.transitionModel.sampleCount);

    for (let k = 0; k < this.latentHistory.length - 1; k++) {
      const current = this.latentHistory[k].values;
      const actual = this.latentHistory[k + 1].values;

      // Predicted = coeff × current
      for (let i = 0; i < 3; i++) {
        let predicted = 0;
        for (let j = 0; j < 3; j++) {
          predicted += coeff[i][j] * current[j];
        }
        const error = actual[i] - predicted;
        // Gradient step
        for (let j = 0; j < 3; j++) {
          coeff[i][j] += lr * error * current[j];
          // Regularize: clamp off-diagonal to [-2, 2], diagonal to [0.5, 1.5]
          if (i === j) {
            coeff[i][j] = Math.max(0.5, Math.min(1.5, coeff[i][j]));
          } else {
            coeff[i][j] = Math.max(-2, Math.min(2, coeff[i][j]));
          }
        }
      }
    }
  }

  /**
   * PCA-like analysis to discover unexplained latent dimensions.
   * Auto-installs when residual variance > 0.3 after 100+ outcomes (up to MAX_DISCOVERED_LATENTS).
   */
  discoverLatentDimension(outcomes: Array<{ outcome: string; actionType: string }>): DiscoveredLatent | null {
    if (outcomes.length < 100) return null;
    if (this.latentHistory.length < 30) return null;
    if (this.discoveredLatents.length >= MAX_DISCOVERED_LATENTS) return null;

    // Compute variance explained by existing 3 latents
    const means = [0, 0, 0];
    for (const snap of this.latentHistory) {
      for (let i = 0; i < 3; i++) means[i] += snap.values[i];
    }
    for (let i = 0; i < 3; i++) means[i] /= this.latentHistory.length;

    let explainedVar = 0;
    for (const snap of this.latentHistory) {
      for (let i = 0; i < 3; i++) {
        const diff = snap.values[i] - means[i];
        explainedVar += diff * diff;
      }
    }

    // Estimate total outcome variance from outcome distribution
    const outcomeCounts: Record<string, number> = {};
    for (const o of outcomes) {
      const key = `${o.actionType}:${o.outcome}`;
      outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
    }
    const numCategories = Object.keys(outcomeCounts).length;
    const totalVar = Math.log(numCategories + 1); // entropy-proxy for outcome variance

    const explainedRatio = totalVar > 0 ? explainedVar / (totalVar * this.latentHistory.length) : 1;
    const residualRatio = 1 - Math.min(1, explainedRatio);

    if (residualRatio > 0.3) {
      // Suggest name based on dominant action type in unexplained outcomes
      const actionCounts: Record<string, number> = {};
      for (const o of outcomes) {
        actionCounts[o.actionType] = (actionCounts[o.actionType] ?? 0) + 1;
      }
      const topAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      const name = topAction === "activity" ? "creative_momentum"
        : topAction === "explore" ? "curiosity_depth"
        : topAction === "reflect" ? "introspection_readiness"
        : `${topAction}_engagement`;

      // Check not already discovered
      if (this.discoveredLatents.some(d => d.name === name)) return null;

      const id = `LD${this.discoveredLatents.length + 1}`;
      const discovered: DiscoveredLatent = {
        id, name, value: 0.5,
        discoveredAt: this.clock.nowMs(),
        observationCount: 0,
      };
      this.discoveredLatents.push(discovered);
      this.factorGraph.addDynamicVariable(id);
      log.info(`latent discovery: residual ${(residualRatio * 100).toFixed(0)}% → auto-installed "${name}" as ${id}`);
      return discovered;
    }

    return null;
  }

  // ── Persistence ────────────────────────────────────────────────

  save(): void {
    const state: WorldModelState = {
      version: 1,
      latentState: this.latent,
      transitionStats: this.stats,
      beliefHistory: this.beliefHistory.slice(-20),
      lastUpdated: this.clock.nowMs(),
      latentConfidence: this.latentConf,
      lastAssemblyAt: this.lastAssemblyAt,
      transitionModel: this.transitionModel,
      latentHistory: this.latentHistory.slice(-50),
      factorGraphState: this.factorGraph.exportState(),
      discoveredLatents: this.discoveredLatents,
    };
    writeJsonAtomic(path.join(this.dataPath, "brainstem", "world-model.json"), state);
  }

  private load(): void {
    const state = readJsonSafe<WorldModelState>(
      path.join(this.dataPath, "brainstem", "world-model.json"),
      { version: 1, latentState: this.defaultLatent(), transitionStats: [], beliefHistory: [], lastUpdated: 0 },
    );
    this.latent = { ...this.defaultLatent(), ...state.latentState };
    this.stats = state.transitionStats ?? [];
    this.beliefHistory = state.beliefHistory ?? [];
    if (state.latentConfidence) this.latentConf = state.latentConfidence;
    if (state.lastAssemblyAt) this.lastAssemblyAt = state.lastAssemblyAt;
    if (state.transitionModel) this.transitionModel = state.transitionModel;
    if (state.latentHistory) this.latentHistory = state.latentHistory;
    if (state.factorGraphState) this.factorGraph.importState(state.factorGraphState);
    if (state.discoveredLatents) {
      this.discoveredLatents = state.discoveredLatents;
      for (const dl of this.discoveredLatents) {
        this.factorGraph.addDynamicVariable(dl.id);
      }
    }
  }

  // ── Portability ──────────────────────────────────────────────

  exportState(): WorldModelState {
    return {
      version: 1,
      latentState: this.latent,
      transitionStats: this.stats,
      beliefHistory: this.beliefHistory.slice(-20),
      lastUpdated: this.clock.nowMs(),
      latentConfidence: this.latentConf,
      lastAssemblyAt: this.lastAssemblyAt,
      transitionModel: this.transitionModel,
      latentHistory: this.latentHistory.slice(-50),
      factorGraphState: this.factorGraph.exportState(),
      discoveredLatents: this.discoveredLatents,
    };
  }

  importState(state: WorldModelState): void {
    this.latent = { ...this.defaultLatent(), ...state.latentState };
    this.stats = state.transitionStats ?? [];
    this.beliefHistory = state.beliefHistory ?? [];
    if (state.latentConfidence) this.latentConf = state.latentConfidence;
    if (state.lastAssemblyAt) this.lastAssemblyAt = state.lastAssemblyAt;
    if (state.transitionModel) this.transitionModel = state.transitionModel;
    if (state.latentHistory) this.latentHistory = state.latentHistory;
    if (state.factorGraphState) this.factorGraph.importState(state.factorGraphState);
    if (state.discoveredLatents) {
      this.discoveredLatents = state.discoveredLatents;
      for (const dl of this.discoveredLatents) {
        this.factorGraph.addDynamicVariable(dl.id);
      }
    }
    this.save();
  }

  // ── Internal helpers ───────────────────────────────────────────

  private updateSocialReceptivity(outcome: OutcomeResult, ext: ExternalState): number {
    let L1 = this.latent.socialReceptivity;

    if (outcome.replyReceived !== undefined) {
      if (outcome.replyReceived) {
        L1 = L1 * 0.8 + 0.2 * 1.0;
        if (outcome.replyLatencyMinutes !== undefined && outcome.replyLatencyMinutes < 30) {
          L1 = Math.min(1, L1 + 0.1);
        }
      } else if (outcome.replyLatencyMinutes !== undefined && outcome.replyLatencyMinutes > 120) {
        L1 = L1 * 0.8 + 0.2 * 0.0;
      }

      if (outcome.sentiment === 1) L1 = Math.min(1, L1 + 0.05);
      if (outcome.sentiment === -1) L1 = Math.max(0, L1 - 0.1);
    }

    // Time decay
    const timePrior = ext.timeOfDay === "night" ? 0.1
      : ext.timeOfDay === "morning" ? 0.3 : 0.5;
    const hoursSinceReply = ext.timeSinceLastReply / 60;
    const decayRate = 0.02;
    L1 = L1 * (1 - decayRate * Math.min(24, hoursSinceReply)) +
      timePrior * decayRate * Math.min(24, hoursSinceReply);

    return Math.max(0, Math.min(1, L1));
  }

  private computeTaskBandwidth(internal: InternalState): number {
    const fatigueContrib = 1 - internal.avgFatigue;
    const csiContrib = internal.csiMode === "green" ? 1.0
      : internal.csiMode === "yellow" ? 0.6 : 0.2;
    const energyContrib = internal.energyUtilization > 0.3 ? 1.0 : 0.5;
    return Math.max(0, Math.min(1, fatigueContrib * 0.4 + csiContrib * 0.4 + energyContrib * 0.2));
  }

  getContextKey(action: ActionType | string, external?: ExternalState): string {
    if (!external) return action;
    const L1Bin = this.latent.socialReceptivity < 0.3 ? "low"
      : this.latent.socialReceptivity < 0.7 ? "mid" : "high";
    const L2Bin = this.latent.socialTrustTemperature < 0.5 ? "cool" : "warm";
    return `${action}|${external.timeOfDay}|${external.dayOfWeek}|L1:${L1Bin}|L2:${L2Bin}`;
  }

  private getMarginal(action: ActionType): TransitionStats {
    const actionEntries = this.stats.filter(s => s.contextKey.startsWith(action));
    if (actionEntries.length === 0) {
      return {
        contextKey: action,
        replyAlpha: 1, replyBeta: 1,
        sentimentAlpha: [1, 1, 1],
        latencyEwma: 60, progressEwma: 0, infoEwma: 0,
        totalObservations: 0, lastUpdated: 0,
      };
    }

    const merged: TransitionStats = {
      contextKey: action,
      replyAlpha: actionEntries.reduce((s, e) => s + e.replyAlpha, 0),
      replyBeta: actionEntries.reduce((s, e) => s + e.replyBeta, 0),
      sentimentAlpha: [
        actionEntries.reduce((s, e) => s + e.sentimentAlpha[0], 0),
        actionEntries.reduce((s, e) => s + e.sentimentAlpha[1], 0),
        actionEntries.reduce((s, e) => s + e.sentimentAlpha[2], 0),
      ],
      latencyEwma: actionEntries.reduce((s, e) => s + e.latencyEwma, 0) / actionEntries.length,
      progressEwma: actionEntries.reduce((s, e) => s + e.progressEwma, 0) / actionEntries.length,
      infoEwma: actionEntries.reduce((s, e) => s + e.infoEwma, 0) / actionEntries.length,
      totalObservations: actionEntries.reduce((s, e) => s + e.totalObservations, 0),
      lastUpdated: Math.max(...actionEntries.map(e => e.lastUpdated)),
    };

    return merged;
  }
}
