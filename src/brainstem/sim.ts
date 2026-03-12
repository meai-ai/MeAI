/**
 * Offline Simulation Harness — deterministic simulation runner for CI/regression.
 *
 * Uses injected Clock for deterministic time. No real LLM calls —
 * mock verbalizer returns "[sim] " + labels. Runs 1000× faster than real-time.
 */

import { type Clock, BRAINSTEM_CONFIG as C, mulberry32 } from "./config.js";
import {
  type ConceptGraph,
  type ConceptNode,
  type ConceptSource,
  tickGraph,
  boostNode,
  findClusters,
  scoreClusters,
  computeEntropy,
  recomputeDrive,
  createNode,
} from "./graph.js";
import { createDefaultState, bootstrapGraph, type BrainstemState } from "./bootstrap.js";
import { ConsciousnessStabilizer, type DerivedState } from "./stabilizer.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-sim");

// ── Types ────────────────────────────────────────────────────────────

export interface SimEvent {
  atMs: number;
  type: "boost" | "goalChange" | "pendingInteraction" | "timeJump";
  nodeId?: string;
  amount?: number;
  source?: ConceptSource;
  goalId?: string;
  progress?: number;
  targetId?: string;
  active?: boolean;
  durationMs?: number;
}

export interface SimScript {
  events: SimEvent[];
}

export interface SimMetrics {
  tick: number;
  timestamp: number;
  topNodes: Array<{ id: string; activation: number }>;
  winnerLabels: string[];
  winnerScore: number;
  entropy: number;
  energyUtilization: number;
  avgFatigue: number;
  microThoughtCount: number;
  rotationCount: number;
}

export interface SimResult {
  metrics: SimMetrics[];
  microThoughts: Array<{ tick: number; labels: string[]; content: string }>;
  totalTicks: number;
  duration: number;
  finalState: BrainstemState;
}

export interface SweepConfig {
  paramName: string;
  range: { min: number; max: number; step: number };
  script: SimScript;
}

export interface SweepResult {
  paramName: string;
  values: Array<{
    value: number;
    metrics: {
      avgEntropy: number;
      avgRotation: number;
      avgFatigue: number;
      microThoughtCount: number;
    };
  }>;
  recommendation: { value: number; reason: string };
}

// ── Deterministic Clock ──────────────────────────────────────────────

class SimClock implements Clock {
  private time: number;

  constructor(startMs: number = 0) {
    this.time = startMs;
  }

  nowMs(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  set(ms: number): void {
    this.time = ms;
  }
}

// ── Simulation Runner ────────────────────────────────────────────────

export function runSimulation(
  script: SimScript,
  initialState?: Partial<BrainstemState>,
): SimResult {
  const startReal = Date.now();
  const clock = new SimClock(Date.now());
  const rng = mulberry32(42);
  const tickMs = C.tickSeconds * 1000;

  // Initialize state
  const state = createDefaultState();
  if (initialState) {
    Object.assign(state, initialState);
  }

  // If graph is empty, create some default nodes for simulation
  if (Object.keys(state.graph.nodes).length === 0) {
    const defaultNodes = [
      { id: "work", label: "work" },
      { id: "learning", label: "learning" },
      { id: "user", label: "user" },
      { id: "self", label: "self" },
    ];
    for (const n of defaultNodes) {
      state.graph.nodes[n.id] = createNode(n.id, n.label, "goal");
    }
    // Self node special setup
    if (state.graph.nodes["self"]) {
      state.graph.nodes["self"].source = "reflection";
    }
  }

  // Sort events by time
  const sortedEvents = [...script.events].sort((a, b) => a.atMs - b.atMs);
  let eventIdx = 0;

  // Initialize stabilizer for simulation
  const stabilizer = new ConsciousnessStabilizer(clock);

  const metrics: SimMetrics[] = [];
  const microThoughts: SimResult["microThoughts"] = [];
  let lastWinner = "";
  let rotationCount = 0;
  let thoughtCount = 0;

  // Determine simulation end time
  const maxEventTime = sortedEvents.length > 0
    ? Math.max(...sortedEvents.map(e => e.atMs + (e.durationMs ?? 0)))
    : 30 * 60_000; // 30 min default
  const endTime = clock.nowMs() + maxEventTime + 5 * 60_000; // 5 min buffer

  let tick = 0;

  while (clock.nowMs() < endTime) {
    // Process events at current time
    while (eventIdx < sortedEvents.length && sortedEvents[eventIdx].atMs <= clock.nowMs() - (endTime - maxEventTime - 5 * 60_000)) {
      const event = sortedEvents[eventIdx];
      processEvent(event, state, clock, rng);
      eventIdx++;
    }

    // Fast loop tick
    const forces = {};
    tickGraph(state.graph, forces, clock, rng);
    tick++;
    state.tickCount = tick;

    // Slow loop every 20 ticks (~60s at 3s ticks)
    if (tick % 20 === 0) {
      const clusters = findClusters(state.graph);
      const scored = scoreClusters(clusters, state.graph);

      if (scored.length > 0) {
        const winner = scored[0];
        const winnerKey = winner.labels.join("+");

        if (winnerKey !== lastWinner) {
          rotationCount++;
          lastWinner = winnerKey;
        }

        const nodes = Object.values(state.graph.nodes);
        const sumA = nodes.reduce((s, n) => s + n.activation, 0);
        const avgF = nodes.reduce((s, n) => s + n.fatigue, 0) / Math.max(1, nodes.length);
        const entropy = computeEntropy(state.graph);

        // Update stabilizer with derived state
        const derived: DerivedState = {
          winnerGroundingStrength: winner.groundingStrength,
          clusterGroundingCoverage: winner.grounding.length > 0 ? 1 : 0,
          noveltyAvg: 0.5,
          rotationRate: rotationCount / Math.max(1, tick / 20),
          entropy,
          valenceHistory: [],
          avgPredictionError: 0,
          energyUtilization: sumA / C.energyMax,
          avgFatigue: avgF,
          timestamp: clock.nowMs(),
        };
        const stabResult = stabilizer.update(derived);
        const policy = stabResult.policy;

        // Mock micro-thought (no LLM), respecting stabilizer policy
        if (winner.score > 0.3 && !policy.freezeVerbalization) {
          const content = `[sim] ${winner.labels.join(", ")}`;
          microThoughts.push({ tick, labels: winner.labels, content });
          thoughtCount++;
        }

        metrics.push({
          tick,
          timestamp: clock.nowMs(),
          topNodes: nodes
            .sort((a, b) => b.activation - a.activation)
            .slice(0, 5)
            .map(n => ({ id: n.id, activation: n.activation })),
          winnerLabels: winner.labels,
          winnerScore: winner.score,
          entropy,
          energyUtilization: sumA / C.energyMax,
          avgFatigue: avgF,
          microThoughtCount: thoughtCount,
          rotationCount,
        });
      }
    }

    clock.advance(tickMs);
  }

  return {
    metrics,
    microThoughts,
    totalTicks: tick,
    duration: Date.now() - startReal,
    finalState: state,
  };
}

// ── Event Processing ─────────────────────────────────────────────────

function processEvent(
  event: SimEvent,
  state: BrainstemState,
  clock: Clock,
  rng: () => number,
): void {
  switch (event.type) {
    case "boost": {
      if (!event.nodeId) break;
      const node = state.graph.nodes[event.nodeId];
      if (node) {
        boostNode(
          state.graph,
          event.nodeId,
          event.amount ?? 0.3,
          event.source ?? "conversation",
          clock,
        );
      }
      break;
    }

    case "goalChange": {
      // Simulate goal progress change by adjusting drive on related nodes
      if (!event.goalId || event.progress === undefined) break;
      for (const node of Object.values(state.graph.nodes)) {
        if (node.id.includes(event.goalId)) {
          node.drive = Math.max(0, 1 - event.progress);
        }
      }
      break;
    }

    case "pendingInteraction": {
      // Track pending interaction state (used by act gate in full sim)
      log.debug(`pending interaction: ${event.targetId} active=${event.active}`);
      break;
    }

    case "timeJump": {
      // Fast-forward: run ticks without events
      if (event.durationMs && event.durationMs > 0) {
        const jumpTicks = Math.floor(event.durationMs / (C.tickSeconds * 1000));
        const forces = {};
        for (let i = 0; i < jumpTicks; i++) {
          tickGraph(state.graph, forces, clock, rng);
          state.tickCount++;
          (clock as SimClock).advance(C.tickSeconds * 1000);
        }
      }
      break;
    }
  }
}

// ── Parameter Sweep ──────────────────────────────────────────────────

export function runParameterSweep(config: SweepConfig): SweepResult {
  const values: SweepResult["values"] = [];
  const { min, max, step } = config.range;
  const configRecord = C as unknown as Record<string, unknown>;

  // Validate param name exists
  if (!(config.paramName in configRecord)) {
    log.warn(`param sweep: unknown param "${config.paramName}"`);
    return {
      paramName: config.paramName,
      values: [],
      recommendation: { value: min, reason: `Unknown param "${config.paramName}"` },
    };
  }

  const originalValue = configRecord[config.paramName];

  try {
    for (let value = min; value <= max; value += step) {
      // Override config param for this run
      configRecord[config.paramName] = value;

      const result = runSimulation(config.script);

      const avgEntropy = result.metrics.length > 0
        ? result.metrics.reduce((s, m) => s + m.entropy, 0) / result.metrics.length
        : 0;
      const avgRotation = result.metrics.length > 0
        ? result.metrics[result.metrics.length - 1].rotationCount / (result.totalTicks / 20)
        : 0;
      const avgFatigue = result.metrics.length > 0
        ? result.metrics.reduce((s, m) => s + m.avgFatigue, 0) / result.metrics.length
        : 0;

      values.push({
        value,
        metrics: {
          avgEntropy,
          avgRotation,
          avgFatigue,
          microThoughtCount: result.microThoughts.length,
        },
      });
    }
  } finally {
    // ALWAYS restore original value
    configRecord[config.paramName] = originalValue;
  }

  // Find best value (highest entropy + reasonable rotation)
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const m = values[i].metrics;
    const score = m.avgEntropy * 0.4 + (1 - Math.abs(m.avgRotation - 9) / 9) * 0.3
      + (1 - m.avgFatigue) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return {
    paramName: config.paramName,
    values,
    recommendation: {
      value: values[bestIdx]?.value ?? min,
      reason: `Best overall health score (entropy + rotation + fatigue balance)`,
    },
  };
}

// ── Sensitivity Report ───────────────────────────────────────────────

export interface SensitivityReport {
  rankings: Array<{
    paramName: string;
    scoreVariance: number;
    entropyVariance: number;
    recommendation: string;
  }>;
  timestamp: number;
}

const CRITICAL_PARAMS: Array<{ name: string; min: number; max: number; step: number }> = [
  { name: "noiseAmplitude", min: 0.005, max: 0.04, step: 0.005 },
  { name: "spreadFactor", min: 0.05, max: 0.3, step: 0.05 },
  { name: "fatigueGainPerTick", min: 0.01, max: 0.06, step: 0.01 },
  { name: "fatigueRecovery", min: 0.002, max: 0.01, step: 0.002 },
  { name: "dethroneMargin", min: 0.03, max: 0.15, step: 0.02 },
  { name: "replayBoostAmount", min: 0.05, max: 0.3, step: 0.05 },
  { name: "energyMax", min: 5, max: 20, step: 3 },
  { name: "salienceBoostK", min: 0.2, max: 1.0, step: 0.2 },
];

export function runSensitivityReport(script: SimScript): SensitivityReport {
  const rankings: SensitivityReport["rankings"] = [];

  for (const param of CRITICAL_PARAMS) {
    const result = runParameterSweep({
      paramName: param.name,
      range: { min: param.min, max: param.max, step: param.step },
      script,
    });

    if (result.values.length < 2) continue;

    // Compute score variance across sweep values
    const scores = result.values.map(v =>
      v.metrics.avgEntropy * 0.4 +
      (1 - Math.abs(v.metrics.avgRotation - 9) / 9) * 0.3 +
      (1 - v.metrics.avgFatigue) * 0.3,
    );
    const meanScore = scores.reduce((s, v) => s + v, 0) / scores.length;
    const scoreVariance = scores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / scores.length;

    const entropies = result.values.map(v => v.metrics.avgEntropy);
    const meanEntropy = entropies.reduce((s, v) => s + v, 0) / entropies.length;
    const entropyVariance = entropies.reduce((s, v) => s + (v - meanEntropy) ** 2, 0) / entropies.length;

    rankings.push({
      paramName: param.name,
      scoreVariance,
      entropyVariance,
      recommendation: `best=${result.recommendation.value}`,
    });
  }

  // Rank by score variance descending (most sensitive first)
  rankings.sort((a, b) => b.scoreVariance - a.scoreVariance);

  return { rankings, timestamp: Date.now() };
}
