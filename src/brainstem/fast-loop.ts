/**
 * Fast Loop — 3s tick, pure math, no LLM.
 *
 * Each tick: tickGraph, memory replay (every 10th), snapshot (every 5th),
 * prediction validation (every 20th), loop detection (every 100th),
 * drive recompute (every 100th), state persistence (every 100th).
 */

import {
  type ConceptGraph,
  type TickForces,
  type GoalInfo,
  tickGraph,
  boostNode,
  recomputeDrive,
  snapshotActivations,
  mean,
} from "./graph.js";
import { type BrainstemState, type MicroThoughtRecord } from "./bootstrap.js";
import { BRAINSTEM_CONFIG as C, type Clock, type ResourceGovernor } from "./config.js";
import { validatePredictions } from "./prediction.js";
import { updateTemporalCredit, updateEdgeDirections } from "./temporal-credit.js";
import type { ControlPolicy } from "./stabilizer.js";
import { type WorkingMemory, tickWorkingMemory, loadSlot } from "./working-memory.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-fast");

// ── Types ────────────────────────────────────────────────────────────

export interface FastLoopContext {
  graph: ConceptGraph;
  state: BrainstemState;
  clock: Clock;
  rng: () => number;
  getPolicy: () => ControlPolicy;
  getActiveGoals: () => GoalInfo[];
  getMemoriesForReplay: (mode: "similar" | "adjacent" | "goal" | "grounded" | "random" | "counter_evidence", winnerId?: string) => Array<{ key: string; nodeId: string }>;
  isConversationActive: () => boolean;
  governor: ResourceGovernor;
  onPersist: (state: BrainstemState) => void;
  onReplayEvent?: (event: ReplayEvent) => void;
  workingMemory?: WorkingMemory;
}

export interface ReplayEvent {
  timestamp: number;
  winnerId: string;
  replayMode: "similar" | "adjacent" | "goal" | "grounded" | "random" | "counter_evidence";
  memoryKey: string;
  nodeId: string;
  boostAmount: number;
  policyMode: string;
  csi: number;
  isEntrenched: boolean;
}

export interface ReplayDiversityTracker {
  sourceDistribution: Record<string, number>;  // source → replay count
  recencyBins: [number, number, number];        // [recent, mid, old] replay counts
  uniqueNodesReplayed: Set<string>;
  totalReplays: number;
  entrenchedReplays: number;                    // replays that occurred during entrenched mode
  counterEvidenceReplays: number;               // counter_evidence replays (subset of entrenched)
  diversityScore: number;  // 0-1, how diverse replay has been
}

export interface FastLoopMetrics {
  energyClippingTracker: { clippedCount: number; totalCount: number };
  coActivationCounts: Map<string, number>;
  externalInjectionCount: number;
  internalInjectionCount: number;
  externalFamilyKeys: Set<string>;
  replayCooldowns: Map<string, number>;
  activationSnapshots: Array<Record<string, number>>;
  loopDetectorTopHistory: string[];
  winnerHistory: string[];
  lastDriveRecompute: number;
  ticksSinceLastSlowLoop: number;
  lastNoveltyAvg: number;  // L4: updated from slow loop for loop detection
  diversityTracker: ReplayDiversityTracker;
  loopDetectorTriggers: number[];  // timestamps of loop detector firings (for auto-tune rate calc)
}

export function createFastLoopMetrics(): FastLoopMetrics {
  return {
    energyClippingTracker: { clippedCount: 0, totalCount: 0 },
    coActivationCounts: new Map(),
    externalInjectionCount: 0,
    internalInjectionCount: 0,
    externalFamilyKeys: new Set(),
    replayCooldowns: new Map(),
    activationSnapshots: [],
    loopDetectorTopHistory: [],
    winnerHistory: [],
    lastDriveRecompute: 0,
    ticksSinceLastSlowLoop: 0,
    lastNoveltyAvg: 0.5,
    diversityTracker: {
      sourceDistribution: {},
      recencyBins: [0, 0, 0],
      uniqueNodesReplayed: new Set(),
      totalReplays: 0,
      entrenchedReplays: 0,
      counterEvidenceReplays: 0,
      diversityScore: 0.5,
    },
    loopDetectorTriggers: [],
  };
}

export function computeReplayDiversity(tracker: ReplayDiversityTracker): number {
  const sources = Object.values(tracker.sourceDistribution);
  const numSources = sources.length;
  if (numSources === 0) return 0.5;

  // Shannon entropy over source distribution, normalized
  const total = sources.reduce((s, v) => s + v, 0);
  if (total === 0) return 0.5;
  let entropy = 0;
  for (const count of sources) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const normalizedEntropy = numSources > 1 ? entropy / Math.log(numSources) : 0;

  // Recency balance penalty
  const recencyTotal = tracker.recencyBins[0] + tracker.recencyBins[1] + tracker.recencyBins[2];
  const recencyBalance = recencyTotal > 0 && tracker.recencyBins[0] / recencyTotal > 0.7 ? -0.2 : 0;

  // Node coverage
  const totalNodes = Math.max(1, tracker.totalReplays);
  const nodesCoverage = Math.min(1, tracker.uniqueNodesReplayed.size / totalNodes);

  return Math.max(0, Math.min(1, normalizedEntropy * 0.5 + nodesCoverage * 0.3 + (0.2 + recencyBalance)));
}

export function formatReplayDiversityReport(tracker: ReplayDiversityTracker): string {
  const sources = Object.entries(tracker.sourceDistribution)
    .map(([s, c]) => `${s} ${Math.round((c / Math.max(1, tracker.totalReplays)) * 100)}%`)
    .join(", ");
  const [r, m, o] = tracker.recencyBins;
  const total = Math.max(1, r + m + o);
  return `Replay diversity: ${tracker.diversityScore.toFixed(2)} | Sources: ${sources || "none"} | Recency: ${Math.round(r / total * 100)}/${Math.round(m / total * 100)}/${Math.round(o / total * 100)}`;
}

// ── Fast Loop tick ───────────────────────────────────────────────────

export function fastTick(ctx: FastLoopContext, metrics: FastLoopMetrics): void {
  const { graph, state, clock, rng, getPolicy } = ctx;
  const policy = getPolicy();
  const now = clock.nowMs();

  state.tickCount++;
  metrics.ticksSinceLastSlowLoop++;

  // Track top-1 for loop detection
  const nodes = Object.values(graph.nodes).filter(n => n.id !== "self");
  if (nodes.length > 0) {
    nodes.sort((a, b) => b.activation - a.activation);
    const topId = nodes[0].id;
    metrics.loopDetectorTopHistory.push(topId);
    if (metrics.loopDetectorTopHistory.length > 200) {
      metrics.loopDetectorTopHistory.shift();
    }
    // CS6: Track winner history for entrenchment detection
    metrics.winnerHistory.push(topId);
    if (metrics.winnerHistory.length > 200) {
      metrics.winnerHistory.shift();
    }
  }

  // Build forces from emotion sync
  const forces: TickForces = {};
  const self = graph.nodes["self"];
  if (self) {
    self.valence = state.selfValence; // sync from emotion.ts
  }

  // Red mode: force winner fatigue
  if (policy.forceWinnerFatigue > 0 && nodes.length > 0) {
    const topNode = nodes[0];
    topNode.fatigue = Math.max(topNode.fatigue, policy.forceWinnerFatigue);
  }

  // Step 1: tickGraph
  tickGraph(
    graph,
    forces,
    clock,
    rng,
    { noiseScale: policy.noiseScale, spreadScale: policy.spreadScale },
    metrics.energyClippingTracker,
  );

  // Step 1b: Working memory tick + focus tracking
  if (ctx.workingMemory) {
    tickWorkingMemory(ctx.workingMemory, now);
    // Load current winner into focus slot if changed
    if (nodes.length > 0) {
      const winnerId = nodes[0].id;
      const currentFocus = ctx.workingMemory.slots.current_focus;
      if (currentFocus.conceptId !== winnerId) {
        loadSlot(ctx.workingMemory, "current_focus", winnerId, nodes[0].label, now);
      }
    }
  }

  // Step 2: Memory replay (every 10th tick, ~30s)
  if (state.tickCount % 10 === 0) {
    doMemoryReplay(ctx, metrics);
  }

  // Step 3: Snapshot activations (every 5th tick, ~15s)
  if (state.tickCount % 5 === 0) {
    const snap = snapshotActivations(graph);
    metrics.activationSnapshots.push(snap);
    if (metrics.activationSnapshots.length > 10) {
      metrics.activationSnapshots.shift();
    }
  }

  // Step 4: Track co-activations for wake-up consolidation
  if (state.tickCount % 5 === 0) {
    trackCoActivations(graph, metrics);
  }

  // Step 5: Prediction validation (every 20th tick, ~60s)
  if (state.tickCount % 20 === 0 && state.predictions.length > 0) {
    const { errors, epistemicErrors, pragmaticErrors, surprises, confirmed } = validatePredictions(state.predictions, graph, clock);
    if (errors.length > 0) {
      const avgError = mean(errors);
      state.avgPredictionError = state.avgPredictionError * 0.8 + avgError * 0.2;
      state.predictionErrors.push(avgError);
      if (state.predictionErrors.length > 20) state.predictionErrors.shift();
      // Dual-category tracking: epistemic (learnable) vs pragmatic (inherent)
      if (epistemicErrors.length > 0) {
        state.avgEpistemicError = state.avgEpistemicError * 0.8 + mean(epistemicErrors) * 0.2;
      }
      if (pragmaticErrors.length > 0) {
        state.avgPragmaticError = state.avgPragmaticError * 0.8 + mean(pragmaticErrors) * 0.2;
      }
    }

    // Boost U on surprised concepts
    for (const s of surprises) {
      if (graph.nodes[s.concept]) {
        graph.nodes[s.concept].uncertainty = Math.min(1, graph.nodes[s.concept].uncertainty + 0.1);
        graph.nodes[s.concept].salience = Math.min(1, graph.nodes[s.concept].salience + 0.05);
      }
    }

    // L7: Confirmed predictions boost edges (CS2 learning signal)
    for (const c of confirmed) {
      const edges = graph.edges.filter(
        e => e.source === c.concept || e.target === c.concept,
      );
      for (const edge of edges) {
        edge.weight = Math.min(1, edge.weight + 0.005);
      }
      // L17: Promote hypotheticals on prediction confirmation
      if (state.hypotheticalNodes.includes(c.concept)) {
        const node = graph.nodes[c.concept];
        if (node) {
          node.source = node.source === "simulation" ? "reflection" : node.source;
          state.hypotheticalNodes = state.hypotheticalNodes.filter(id => id !== c.concept);
        }
      }
    }
  }

  // Step 6: Temporal credit (every 100th tick, ~5min)
  if (state.tickCount % 100 === 0) {
    if (ctx.governor.requestCpu(10)) {
      updateTemporalCredit(graph, state.activationHistory, clock);
      // CS6b: Piggyback edge direction discovery on CS2's 100-tick scan
      if (!state.edgeDirectionStats) state.edgeDirectionStats = {};
      updateEdgeDirections(graph, state.activationHistory, state.edgeDirectionStats, clock.nowMs());
    }
  }

  // Step 7: Drive recompute (every 100th tick, ~5min)
  if (state.tickCount % 100 === 0) {
    const goals = ctx.getActiveGoals();
    recomputeDrive(graph, goals);
    metrics.lastDriveRecompute = now;
  }

  // Step 8: Loop detection (every 100th tick, ~5min)
  if (state.tickCount % 100 === 0 && metrics.loopDetectorTopHistory.length >= 100) {
    detectLoop(ctx, metrics);
  }

  // Step 9: Track activation history for temporal credit
  if (state.tickCount % 3 === 0) { // every ~9s
    for (const node of Object.values(graph.nodes)) {
      if (node.activation > 0.3) {
        if (!state.activationHistory[node.id]) {
          state.activationHistory[node.id] = [];
        }
        state.activationHistory[node.id].push(now);
        // Keep last 50
        if (state.activationHistory[node.id].length > 50) {
          state.activationHistory[node.id].shift();
        }
      }
    }
  }

  // Step 10: Persist state (every 100th tick, ~5min)
  if (state.tickCount % C.persistIntervalTicks === 0) {
    ctx.onPersist(state);
  }
}

// ── Memory replay ────────────────────────────────────────────────────

function doMemoryReplay(ctx: FastLoopContext, metrics: FastLoopMetrics): void {
  const { graph, state, clock, getPolicy } = ctx;
  const policy = getPolicy();
  const now = clock.nowMs();

  // Check if replay is disabled (Red mode)
  const dist = policy.replayDistribution;
  const totalWeight = dist.similar + dist.adjacent + dist.goal + dist.grounded + dist.random + (dist.counterEvidence ?? 0);
  if (totalWeight <= 0) return;

  if (!ctx.governor.requestIo(3)) return; // budget check

  // Determine winner for similarity-based replay
  const nodes = Object.values(graph.nodes).filter(n => n.id !== "self");
  if (nodes.length === 0) return;
  nodes.sort((a, b) => b.activation - a.activation);
  const winnerId = nodes[0].id;

  // Check entrenchment: has winner held for > 6 min?
  const recentWins = metrics.winnerHistory.slice(-120); // last ~6 min of fast ticks
  const winnerCount = recentWins.filter(id => id === winnerId).length;
  const isEntrenched = recentWins.length >= 60 && winnerCount / recentWins.length > 0.75;

  // Adjust distribution if entrenched (design doc: 40/25/15/15/5 with counter-evidence inside dist)
  let adjustedDist = { ...dist };
  if (isEntrenched && dist.similar > 0.3) {
    adjustedDist = {
      similar: 0.40,
      adjacent: 0.25,
      goal: 0.15,
      grounded: 0,
      random: 0.05,
      counterEvidence: Math.max(0.15, dist.counterEvidence),  // at least 15% in entrenched mode
    };
  }

  // Anti-bias: recency correction
  const tracker = metrics.diversityTracker;
  const recTotal = tracker.recencyBins[0] + tracker.recencyBins[1] + tracker.recencyBins[2];
  if (recTotal > 10 && tracker.recencyBins[0] / recTotal > 0.6) {
    // Too recent-biased: force random mode which pulls from full time range
    adjustedDist = { ...adjustedDist, random: adjustedDist.random + 0.3, similar: adjustedDist.similar * 0.5 };
  }

  // Sample 1-3 memories
  const replayCount = 1 + Math.floor(ctx.rng() * 2); // 1-2 replays
  for (let i = 0; i < replayCount; i++) {
    // Sample replay mode from full distribution (including counter-evidence)
    let mode = sampleReplayModeWithCE(adjustedDist, ctx.rng);

    // Guard: counter-evidence only if winner is memory-grounded AND NOT goal-grounded
    if (mode === "counter_evidence") {
      const winnerNode = graph.nodes[winnerId];
      if (!winnerNode || winnerNode.drive > 0.3 || winnerNode.memoryKeys.length === 0) {
        mode = sampleReplayMode(adjustedDist, ctx.rng); // fallback
      }
    }

    // Anti-bias: source diversity — if any source dominates >50%, avoid it
    const dominantSource = Object.entries(tracker.sourceDistribution)
      .find(([, c]) => tracker.totalReplays > 10 && c / tracker.totalReplays > 0.5);
    if (dominantSource && mode === "similar") {
      // Shift to less-used mode
      mode = "adjacent";
    }

    const candidates = ctx.getMemoriesForReplay(mode, winnerId);

    for (const candidate of candidates.slice(0, 1)) {
      // Check cooldown
      const lastReplay = metrics.replayCooldowns.get(candidate.key);
      if (lastReplay && now - lastReplay < C.replayCooldownMs) {
        continue; // skip this memory
      }

      // Boost the corresponding node (tier-specific boost)
      // Counter-evidence: boost onto neighboring-but-not-winner nodes
      const targetNodeId = mode === "counter_evidence" && winnerId
        ? findCounterEvidenceTarget(graph, winnerId, candidate.nodeId) ?? candidate.nodeId
        : candidate.nodeId;
      if (graph.nodes[targetNodeId]) {
        const tier = graph.nodes[targetNodeId].knowledgeTier;
        const tierBoost = tier === "stm" ? 0.20 : tier === "ltm" ? 0.10 : C.replayBoostAmount;
        boostNode(graph, targetNodeId, tierBoost, "replay", clock);
        // Also boost salience so replayed nodes become cluster seeds
        graph.nodes[candidate.nodeId].salience = Math.min(1, graph.nodes[candidate.nodeId].salience + 0.05);
        metrics.replayCooldowns.set(candidate.key, now);
        metrics.internalInjectionCount++;

        // Update diversity tracker
        const nodeSource = graph.nodes[candidate.nodeId]?.source ?? "unknown";
        tracker.sourceDistribution[nodeSource] = (tracker.sourceDistribution[nodeSource] ?? 0) + 1;
        tracker.uniqueNodesReplayed.add(candidate.nodeId);
        tracker.totalReplays++;
        if (isEntrenched) tracker.entrenchedReplays++;
        if (mode === "counter_evidence") tracker.counterEvidenceReplays++;
        // Classify into recency bin: <1h recent, 1-24h mid, >24h old
        const nodeLastActive = graph.nodes[candidate.nodeId]?.lastActivated ?? 0;
        const ageMs = now - nodeLastActive;
        if (ageMs < 3_600_000) tracker.recencyBins[0]++;
        else if (ageMs < 86_400_000) tracker.recencyBins[1]++;
        else tracker.recencyBins[2]++;
        tracker.diversityScore = computeReplayDiversity(tracker);

        // Emit replay event for controller-replay.jsonl
        ctx.onReplayEvent?.({
          timestamp: now,
          winnerId,
          replayMode: mode,
          memoryKey: candidate.key,
          nodeId: candidate.nodeId,
          boostAmount: C.replayBoostAmount,
          policyMode: policy.mode,
          csi: state.csi,
          isEntrenched,
        });
      }
    }
  }

  // Clean old cooldowns (> 2x cooldown period)
  for (const [key, ts] of metrics.replayCooldowns) {
    if (now - ts > C.replayCooldownMs * 2) {
      metrics.replayCooldowns.delete(key);
    }
  }
}

type ReplayDist = { similar: number; adjacent: number; goal: number; grounded: number; random: number; counterEvidence?: number };

function sampleReplayMode(
  dist: ReplayDist,
  rng: () => number,
): "similar" | "adjacent" | "goal" | "grounded" | "random" {
  const total = dist.similar + dist.adjacent + dist.goal + dist.grounded + dist.random;
  if (total <= 0) return "random";

  let r = rng() * total;
  if (r < dist.similar) return "similar";
  r -= dist.similar;
  if (r < dist.adjacent) return "adjacent";
  r -= dist.adjacent;
  if (r < dist.goal) return "goal";
  r -= dist.goal;
  if (r < dist.grounded) return "grounded";
  return "random";
}

/** Sample from full distribution including counter-evidence. */
function sampleReplayModeWithCE(
  dist: ReplayDist,
  rng: () => number,
): "similar" | "adjacent" | "goal" | "grounded" | "random" | "counter_evidence" {
  const ce = dist.counterEvidence ?? 0;
  const total = dist.similar + dist.adjacent + dist.goal + dist.grounded + dist.random + ce;
  if (total <= 0) return "random";

  let r = rng() * total;
  if (r < ce) return "counter_evidence";
  r -= ce;
  if (r < dist.similar) return "similar";
  r -= dist.similar;
  if (r < dist.adjacent) return "adjacent";
  r -= dist.adjacent;
  if (r < dist.goal) return "goal";
  r -= dist.goal;
  if (r < dist.grounded) return "grounded";
  return "random";
}

// ── Loop detection ───────────────────────────────────────────────────

function detectLoop(ctx: FastLoopContext, metrics: FastLoopMetrics): void {
  const { graph, clock } = ctx;
  const history = metrics.loopDetectorTopHistory;
  const last200 = history.slice(-200);
  if (last200.length < 100) return;

  // Count top-1 occupancy
  const counts = new Map<string, number>();
  for (const id of last200) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return;

  const [dominantId, dominantCount] = dominant;
  const occupancy = dominantCount / last200.length;

  if (occupancy < C.loopDominanceThreshold) return;

  // L4: Also require low novelty to confirm loop
  if (metrics.lastNoveltyAvg >= C.loopNoveltyThreshold) return;

  // Check external diversity
  const externalDiversity = metrics.externalFamilyKeys.size > 0
    ? metrics.externalFamilyKeys.size / Math.max(1, metrics.externalInjectionCount)
    : 0;

  const noEffectiveExternal = metrics.externalInjectionCount === 0 ||
    externalDiversity < C.loopExternalDiversityThreshold;

  if (!noEffectiveExternal) return;

  // Loop detected: force fatigue on dominant node
  const node = graph.nodes[dominantId];
  if (node) {
    node.fatigue = Math.min(1, node.fatigue + 0.3);
    log.info(`loop detected: "${node.label}" dominant at ${(occupancy * 100).toFixed(0)}%, forcing fatigue`);
  }

  // Track trigger timestamp for auto-tune loopDetectorTriggerRate
  metrics.loopDetectorTriggers.push(clock.nowMs());
  // Keep last 7 days
  const cutoff7d = clock.nowMs() - 7 * 86_400_000;
  metrics.loopDetectorTriggers = metrics.loopDetectorTriggers.filter(t => t > cutoff7d);

  // Reset external tracking for next window
  metrics.externalInjectionCount = 0;
  metrics.internalInjectionCount = 0;
  metrics.externalFamilyKeys.clear();
}

// ── Counter-evidence target selection ─────────────────────────────────

/** Find a neighbor of the winner that is NOT the winner itself, preferring the candidate's node. */
function findCounterEvidenceTarget(
  graph: ConceptGraph,
  winnerId: string,
  candidateNodeId: string,
): string | null {
  // Prefer neighbors of the winner that aren't the winner itself
  const neighbors = graph.edges
    .filter(e => e.source === winnerId || e.target === winnerId)
    .map(e => e.source === winnerId ? e.target : e.source)
    .filter(id => id !== winnerId && id !== "self" && graph.nodes[id]);

  if (neighbors.length === 0) return null;

  // If candidate is a neighbor, use it directly
  if (neighbors.includes(candidateNodeId)) return candidateNodeId;

  // Otherwise pick the first neighbor
  return neighbors[0];
}

// ── Co-activation tracking ───────────────────────────────────────────

function trackCoActivations(graph: ConceptGraph, metrics: FastLoopMetrics): void {
  const active = Object.values(graph.nodes)
    .filter(n => n.activation > 0.3 && n.id !== "self")
    .map(n => n.id);

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const key = active[i] < active[j]
        ? `${active[i]}|${active[j]}`
        : `${active[j]}|${active[i]}`;
      metrics.coActivationCounts.set(key, (metrics.coActivationCounts.get(key) ?? 0) + 1);
    }
  }
}
