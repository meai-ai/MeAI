/**
 * Thought Gate + Slow Loop — 60s cycle, cluster competition, micro-thought generation.
 *
 * Three gates: Thought (→ micro-thought), Reflect (→ reflection),
 * Act (→ proactive message). Includes snapshot isolation for concurrent safety.
 */

import {
  type ConceptGraph,
  type ClusterInfo,
  type ScoredCluster,
  type GroundingRef,
  findClusters,
  scoreClusters,
  computeGroundingForCluster,
  groundingAgePenaltyFactor,
  computeEntropy,
  enableClusterBudget,
  mean,
  normalizeId,
} from "./graph.js";
import { type BrainstemState, type MicroThoughtRecord } from "./bootstrap.js";
import { BRAINSTEM_CONFIG as C, type Clock, type ResourceGovernor, DEFAULT_ACT_TARGETS, ACL_DEFAULTS } from "./config.js";
import { type DerivedState, type ControlPolicy, type AnchorTag, assignAnchorTag, ConsciousnessStabilizer } from "./stabilizer.js";
import type { GroundingEvidencePacket } from "./governance.js";
import { generatePredictions } from "./prediction.js";
import { type WorkingMemory, loadSlot } from "./working-memory.js";
import { claudeText } from "../claude-runner.js";
import { getCharacter } from "../character.js";
import { createLogger } from "../lib/logger.js";
import { tokenize } from "../memory/search.js";

const log = createLogger("brainstem-thought");

/** Get the person target ID from config (first person-type act target). */
function getPersonTargetId(): string {
  const personTarget = DEFAULT_ACT_TARGETS.find(t => t.type === "person");
  return personTarget?.id ?? "user";
}

// ── Types ────────────────────────────────────────────────────────────

export interface ThoughtCandidate {
  concepts: string[];
  labels: string[];
  salience: number;
  avgActivation: number;
  avgValence: number;
  avgUncertainty: number;
  grounding: GroundingRef[];
  groundingStrength: number;
  score: number;
}

export interface ThoughtState {
  candidates: ThoughtCandidate[];
  winner: ThoughtCandidate | null;
  updatedAt: number;
}

export interface ActGateArm {
  armed: boolean;
  reason: string;
  grounding: GroundingRef[];
  targetId: string;
  microThoughtId: string;
  concepts: string[];
  evidencePacket?: import("./governance.js").GroundingEvidencePacket;
}

export interface ThoughtExplanation {
  topFactors: string[];
  groundingSummary: string;
  whyNotAct: string | null;
  consistencyCheck: string;
}

export interface SlowLoopDecisionLog {
  tick: number;
  timestamp: number;
  top3Clusters: Array<{
    labels: string[];
    score: number;
    groundingPenalty: number;
    meanA: number;
    meanS: number;
    meanU: number;
    meanD: number;
    meanF: number;
    meanV: number;
    size: number;
  }>;
  winner: { labels: string[]; score: number; incumbentEMA: number; dwellTicks: number };
  dethrone: { happened: boolean; reason?: string; challengerScore?: number };
  thoughtGate: { passed: boolean; rejectedReason?: string; triggerType?: string };
  reflectGate: { armed: boolean; reason?: string };
  actGate: { armed: boolean; reason?: string };
  selfGate?: { passed: boolean; deniedReason?: string; snapshot: Partial<import("./self-model.js").SelfState> };
  socialGate?: {
    passed: boolean;
    reason?: string;
    throttled?: boolean;
    restricted?: "waiting_reply" | null;
    cooldownMultiplier?: number;
    snapshot?: {
      responsivenessEwma: number;
      outboundCount7d: number;
      inboundCount7d: number;
      pendingType: string | null;
    };
  };
  energy: { utilization: number; sumProtected: number; bgAllocation: number };
  rawMetrics?: { noveltyAvg: number; rotationRate: number; entropy: number };
  budget: { used: number; limit: number; scaleFactor: number };
  stabilizer: {
    csi: number;
    prevCsi: number;
    mode: string;
    subMetrics: Record<string, number>;
    rampActive: boolean;
    rampProgress: number;
    csiTrend: number;
    transitionReason?: Record<string, unknown>;
    anchorTag?: string;
  };
}

// ── Slow Loop Context ────────────────────────────────────────────────

export interface SlowLoopContext {
  graph: ConceptGraph;
  state: BrainstemState;
  clock: Clock;
  stabilizer: ConsciousnessStabilizer;
  governor: ResourceGovernor;
  getMemories: () => Array<{ key: string; timestamp: number }>;
  getGoals: () => Array<{ id: string; priority: number; progress: number; relatedTopics: string[] }>;
  getDiscoveries: () => Array<{ query: string; timestamp: number; category: string }>;
  isConversationActive: () => boolean;
  isQuietHours: () => boolean;
  hasPendingInteraction: (targetId: string) => boolean;
  isConceptSuppressed?: (conceptId: string) => boolean;
  selfModel?: { evaluateSelfGate: (action: import("./self-model.js").ActionFamily, policy?: import("./config.js").SelfGatePolicy) => { passed: boolean; deniedReason?: string }; getState: () => import("./self-model.js").SelfState };
  socialModel?: {
    evaluateSocialGate: (targetId: string, actionType: string, isFollowUp?: boolean) => { passed: boolean; reason?: string; cooldownMultiplier: number };
    getTargetState: (targetId: string) => { responsivenessEwma: number; outboundCount7d: number; inboundCount7d: number; pendingType: string | null; lastOutboundTopics: string[] } | undefined;
  };
  workingMemory?: WorkingMemory;
  onThought: (thought: MicroThoughtRecord) => void;
  onReflectArm: () => void;
  onActArm: (arm: ActGateArm) => void;
  onDecisionLog: (log: SlowLoopDecisionLog) => void;
  onMetrics: (metrics: Record<string, number | string | boolean>) => void;
  /** Cortex unified budget: check + track an LLM call. Returns false if budget exceeded. */
  cortexBudgetCheck?: (api: "verbalize" | "sanity", estimatedTokens: number) => boolean;
}

// ── Slow Loop State ──────────────────────────────────────────────────

let incumbentWinnerId: string | null = null;
let incumbentScoreEMA = 0;
let incumbentSince = 0;
let incumbentDwellTicks = 0;
let winnerHistory: Array<{ id: string; timestamp: number }> = [];
let noveltyScores: number[] = [];
let thoughtBudgetUsed = 0;
let thoughtBudgetResetAt = 0;
let lastReflectAt = 0;
let lastActArmPerTarget = new Map<string, number>();
let actArmsToday = new Map<string, number>();
let lastActArmDay = 0;
let slowLoopTickCount = 0;
let valTrendWindow: number[] = [];
let lastTopClusterScore = 0;
let lastInhibitionAt = 0;

// ── Reset (for testing) ─────────────────────────────────────────────

export function resetSlowLoopState(): void {
  incumbentWinnerId = null;
  incumbentScoreEMA = 0;
  incumbentSince = 0;
  incumbentDwellTicks = 0;
  winnerHistory = [];
  noveltyScores = [];
  thoughtBudgetUsed = 0;
  thoughtBudgetResetAt = 0;
  lastReflectAt = 0;
  lastActArmPerTarget = new Map();
  actArmsToday = new Map();
  lastActArmDay = 0;
  slowLoopTickCount = 0;
  valTrendWindow = [];
  lastTopClusterScore = 0;
  lastInhibitionAt = 0;
}

// ── Main slow loop tick ──────────────────────────────────────────────

export async function slowLoopTick(ctx: SlowLoopContext): Promise<void> {
  const { graph, state, clock, stabilizer, governor } = ctx;
  const now = clock.nowMs();
  slowLoopTickCount++;

  if (!governor.acquireSlowLoop()) return; // only 1 at a time

  try {
    // Snapshot isolation: work on a frozen copy
    const snapshot = structuredClone(graph) as ConceptGraph;

    // 1. Find clusters
    const clusters = findClusters(snapshot);

    // 2. Score clusters
    const policy = stabilizer.getPolicy();
    const wV = 0.1 * (policy.wVScale);
    // L1: Check if valence has been rising for 3+ ticks
    const valenceRising = valTrendWindow.length >= 3 &&
      valTrendWindow.slice(-3).every((v, i, arr) => i === 0 || v > arr[i - 1]);
    const scored = scoreClusters(clusters, snapshot, wV, valenceRising);

    // 3. Compute grounding for top clusters
    const memories = ctx.getMemories();
    const goals = ctx.getGoals();
    const discoveries = ctx.getDiscoveries();
    const memTimestamps = new Map<string, number>();
    for (const m of memories) memTimestamps.set(m.key, m.timestamp);

    // Build recentGroundedMemories map from recent thought history
    const recentGroundedMemories = new Map<string, number>();
    for (const t of state.thoughtHistory.slice(-10)) {
      for (const g of t.grounding) {
        if (g.type === "memory") {
          recentGroundedMemories.set(g.id, (recentGroundedMemories.get(g.id) ?? 0) + 1);
        }
      }
    }

    for (const cluster of scored.slice(0, 5)) {
      const gr = computeGroundingForCluster(
        cluster, snapshot, memories, goals, discoveries, clock, recentGroundedMemories,
      );
      cluster.grounding = gr.grounding;
      cluster.groundingStrength = gr.groundingStrength;

      // Apply grounding age penalty
      const nodesDrive = cluster.nodes.map(id => snapshot.nodes[id]?.drive ?? 0);
      const nodesSalience = cluster.nodes.map(id => snapshot.nodes[id]?.salience ?? 0);
      const penalty = groundingAgePenaltyFactor(
        cluster.grounding, nodesDrive, nodesSalience, clock, memTimestamps,
        snapshot, cluster.nodes,
      );
      cluster.score *= penalty;
    }

    // Re-sort after penalty
    scored.sort((a, b) => b.score - a.score);

    // 4. Update cluster budget maps for boostNode
    if (scored.length > 0) {
      const nodeToCluster = new Map<string, string>();
      const nodeFamilyKey = new Map<string, string>();
      for (let i = 0; i < scored.length; i++) {
        const clusterId = String(i);
        const familyKey = scored[i].labels.slice(0, 3).join("|") + "|" +
          (scored[i].grounding[0]?.type ?? "none");
        for (const nodeId of scored[i].nodes) {
          nodeToCluster.set(nodeId, clusterId);
          nodeFamilyKey.set(nodeId, familyKey);
        }
      }
      enableClusterBudget(nodeToCluster, nodeFamilyKey);
    }

    // 5. Winner competition with EMA hysteresis + dwell protection
    const topCluster = scored[0] ?? null;
    // L3: Track previous top cluster score for spike trigger
    const prevTopScore = lastTopClusterScore;
    lastTopClusterScore = topCluster?.score ?? 0;
    let dethroned = false;
    let dethroneReason: string | undefined;

    if (topCluster) {
      const clusterId = topCluster.labels.join("+");

      if (!incumbentWinnerId) {
        // First winner
        incumbentWinnerId = clusterId;
        incumbentScoreEMA = topCluster.score;
        incumbentSince = now;
        incumbentDwellTicks = 0;
      } else if (clusterId !== incumbentWinnerId) {
        // Challenger
        const effectiveMargin = C.dethroneMargin + policy.dethroneMarginDelta;
        const dwellOk = (now - incumbentSince) >= C.winnerMinDwellMs;
        const spikeOverride = topCluster.score - incumbentScoreEMA > C.spikeThreshold;

        if (topCluster.score > incumbentScoreEMA + effectiveMargin &&
            (dwellOk || spikeOverride) &&
            (!policy.externalOnlyDethrone)) {
          // Dethrone
          dethroned = true;
          dethroneReason = spikeOverride ? "spike_override" : "score_margin";
          incumbentWinnerId = clusterId;
          incumbentSince = now;
          incumbentDwellTicks = 0;
        }
      }

      // Update EMA — accelerate decay after long dwell to prevent thought monopoly.
      // After 20 ticks (~10 min), the EMA decays 3x faster, making dethrone easier.
      const dwellDecay = incumbentDwellTicks > 20 ? C.dethroneEmaAlpha * 3 : C.dethroneEmaAlpha;
      const effectiveAlpha = Math.min(dwellDecay, 0.9);
      incumbentScoreEMA = incumbentScoreEMA * (1 - effectiveAlpha) +
        topCluster.score * effectiveAlpha;
      incumbentDwellTicks++;
    }

    // Track winner history for rotation rate
    if (incumbentWinnerId) {
      winnerHistory.push({ id: incumbentWinnerId, timestamp: now });
      // Keep 1 hour
      winnerHistory = winnerHistory.filter(w => now - w.timestamp < C.rotationWindowMs);
    }

    // 6. Lateral inhibition on top losers (L2: overlap guard + 90s dedup)
    if (topCluster && scored.length > 1 && now - lastInhibitionAt >= 90_000) {
      lastInhibitionAt = now;
      const winnerNodeSet = new Set(topCluster.nodes);
      const losers = scored.slice(1, 3);
      for (const loser of losers) {
        const strengthRatio = loser.score / Math.max(0.01, topCluster.score);
        const deltaF = 0.01 * strengthRatio;
        const deltaA = 0.02 * strengthRatio;

        // Apply to LIVE graph (incremental patches), skip nodes shared with winner
        for (const nodeId of loser.nodes) {
          if (winnerNodeSet.has(nodeId)) continue; // L2: overlap guard
          const liveNode = graph.nodes[nodeId];
          if (liveNode) {
            liveNode.fatigue = Math.min(1, liveNode.fatigue + deltaF);
            liveNode.activation = Math.max(0, liveNode.activation * (1 - deltaA));
          }
        }
      }
    }

    // 7. Compute derived state for stabilizer
    const rotationRate = countRotations(winnerHistory);
    const noveltyScore = computeNoveltyScore(topCluster, state.thoughtHistory);
    noveltyScores.push(noveltyScore);
    if (noveltyScores.length > 10) noveltyScores.shift();
    const noveltyAvg = mean(noveltyScores);

    const clusterGroundingCoverage = scored.length > 0
      ? scored.filter(c => c.groundingStrength > 0.3).length / scored.length
      : 0;

    const energyUtilization = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0) / C.energyMax;
    const avgFatigue = mean(Object.values(graph.nodes).map(n => n.fatigue));
    const avgV = mean(Object.values(graph.nodes).map(n => Math.abs(n.valence)));
    valTrendWindow.push(avgV);
    if (valTrendWindow.length > C.valenceTrendTicks) valTrendWindow.shift();

    const derived: DerivedState = {
      winnerGroundingStrength: topCluster?.groundingStrength ?? 0,
      clusterGroundingCoverage,
      noveltyAvg,
      rotationRate,
      entropy: computeEntropy(graph),
      valenceHistory: [...valTrendWindow],
      avgPredictionError: state.avgPredictionError,
      energyUtilization,
      avgFatigue,
      timestamp: now,
    };

    // 8. Update stabilizer
    const prevCsi = stabilizer.getCSI();
    const stabResult = stabilizer.update(derived);
    const updatedPolicy = stabResult.policy;

    // 9. Thought gate
    let thoughtGatePassed = false;
    let rejectedReason: string | undefined;
    let triggerType: string | undefined;
    let generatedThought: MicroThoughtRecord | null = null;

    if (topCluster && !updatedPolicy.freezeVerbalization && !ctx.isQuietHours()) {
      const gateResult = evaluateThoughtGate(
        topCluster, state, noveltyScore, updatedPolicy, ctx, now,
      );
      thoughtGatePassed = gateResult.passed;
      rejectedReason = gateResult.reason;
      triggerType = gateResult.trigger;

      if (thoughtGatePassed) {
        generatedThought = await generateMicroThought(topCluster, state, clock, ctx.isConversationActive(), ctx.cortexBudgetCheck);
        if (generatedThought) {
          state.thoughtHistory.push(generatedThought);
          if (state.thoughtHistory.length > 30) state.thoughtHistory.shift();
          ctx.onThought(generatedThought);

          // Generate predictions from thought (CS1)
          const preds = generatePredictions(generatedThought, graph, clock);
          state.predictions.push(...preds);
          if (state.predictions.length > C.predictionBufferSize) {
            state.predictions = state.predictions.slice(-C.predictionBufferSize);
          }

          // Working memory: load surprise / goal slots from thought
          if (ctx.workingMemory && generatedThought) {
            if (generatedThought.trigger === "high_uncertainty" || generatedThought.trigger === "prediction_error") {
              loadSlot(ctx.workingMemory, "recent_surprise", generatedThought.concepts[0] ?? generatedThought.id, generatedThought.content, now);
            }
            const goalGrounding = generatedThought.grounding.find(g => g.type === "goal");
            if (goalGrounding) {
              loadSlot(ctx.workingMemory, "goal_active", goalGrounding.id, goalGrounding.id, now);
            }
          }

          // D2: Post-thought grounding uplift — link concept nodes to grounding memories
          for (const gRef of generatedThought.grounding) {
            if (gRef.type === "memory" || gRef.type === "goal") {
              for (const cId of generatedThought.concepts) {
                const node = graph.nodes[cId];
                if (node && !node.memoryKeys.includes(gRef.id)) {
                  node.memoryKeys.push(gRef.id);
                }
              }
            }
          }
        }
      }
    } else {
      rejectedReason = updatedPolicy.freezeVerbalization ? "frozen"
        : ctx.isQuietHours() ? "quiet_hours"
        : !topCluster ? "no_cluster"
        : "unknown";
    }

    // 10. Reflect gate
    let reflectArmed = false;
    let reflectReason: string | undefined;
    if (updatedPolicy.reflectGateEnabled) {
      const rResult = evaluateReflectGate(state, topCluster, now);
      reflectArmed = rResult.armed;
      reflectReason = rResult.reason;
      if (reflectArmed) {
        lastReflectAt = now;
        ctx.onReflectArm();
      }
    }

    // 11. Act gate
    let actArmed = false;
    let actReason: string | undefined;
    let selfGateLog: SlowLoopDecisionLog["selfGate"] | undefined;
    let socialGateLog: SlowLoopDecisionLog["socialGate"] | undefined;
    if (generatedThought && updatedPolicy.mode !== "red") {
      const aResult = await evaluateActGate(generatedThought, graph, ctx, now);
      actArmed = aResult.armed;
      actReason = aResult.reason;
      if (aResult.selfGateResult) {
        selfGateLog = aResult.selfGateResult;
      }
      if (aResult.socialGateResult) {
        socialGateLog = aResult.socialGateResult;
      }
      if (actArmed && aResult.arm) {
        ctx.onActArm(aResult.arm);
      }
    }

    // 12. Future simulation (CS4) — every 5th slow-loop tick
    if (slowLoopTickCount % 5 === 0 && topCluster) {
      await createHypotheticalNode(topCluster, graph, state, clock);
    }

    // 13. Log decision
    const decisionLog: SlowLoopDecisionLog = {
      tick: slowLoopTickCount,
      timestamp: now,
      top3Clusters: scored.slice(0, 3).map(c => ({
        labels: c.labels,
        score: c.score,
        groundingPenalty: 1,
        meanA: c.avgA,
        meanS: c.avgS,
        meanU: c.avgU,
        meanD: c.avgD,
        meanF: c.avgF,
        meanV: c.avgV,
        size: c.size,
      })),
      winner: {
        labels: topCluster?.labels ?? [],
        score: topCluster?.score ?? 0,
        incumbentEMA: incumbentScoreEMA,
        dwellTicks: incumbentDwellTicks,
      },
      dethrone: { happened: dethroned, reason: dethroneReason, challengerScore: topCluster?.score },
      thoughtGate: { passed: thoughtGatePassed, rejectedReason, triggerType },
      reflectGate: { armed: reflectArmed, reason: reflectReason },
      actGate: { armed: actArmed, reason: actReason },
      selfGate: selfGateLog,
      socialGate: socialGateLog,
      energy: {
        utilization: energyUtilization,
        sumProtected: 0,
        bgAllocation: C.bgFloorFrac * C.energyMax,
      },
      rawMetrics: { noveltyAvg, rotationRate, entropy: computeEntropy(graph) },
      budget: {
        used: thoughtBudgetUsed,
        limit: computeThoughtBudgetLimit(updatedPolicy, energyUtilization, noveltyAvg, avgFatigue),
        scaleFactor: updatedPolicy.thoughtBudgetScale,
      },
      stabilizer: {
        csi: stabResult.csi,
        prevCsi,
        mode: updatedPolicy.mode,
        subMetrics: stabResult.subMetrics as unknown as Record<string, number>,
        rampActive: stabilizer.isRampActive(),
        rampProgress: stabilizer.getRampProgress(),
        csiTrend: stabResult.csi - prevCsi,
        anchorTag: generatedThought?.anchor,
      },
    };

    ctx.onDecisionLog(decisionLog);

    // 14. Metrics
    ctx.onMetrics({
      "llmCalls/hour": thoughtBudgetUsed,
      winnerRotationRate: rotationRate,
      noveltyAvg,
      noveltyScore,
      energyUtilization,
      avgFatigue,
      predictionError: state.avgPredictionError,
      graphSize: Object.keys(graph.nodes).length,
      graphEdges: graph.edges.length,
      csi: stabResult.csi,
      csiMode: updatedPolicy.mode,
    });

  } finally {
    governor.releaseSlowLoop();
  }
}

// ── Thought gate evaluation ──────────────────────────────────────────

function evaluateThoughtGate(
  cluster: ScoredCluster,
  state: BrainstemState,
  noveltyScore: number,
  policy: ControlPolicy,
  ctx: SlowLoopContext,
  now: number,
): { passed: boolean; reason?: string; trigger?: string } {
  // Pre-conditions
  if (cluster.score < C.thoughtScoreMin) {
    return { passed: false, reason: "low_score" };
  }

  if (noveltyScore < 0.35) {
    return { passed: false, reason: "not_novel" };
  }

  if (cluster.grounding.length === 0) {
    return { passed: false, reason: "no_grounding" };
  }

  if (policy.minGroundingWeight > 0 && cluster.groundingStrength < policy.minGroundingWeight) {
    return { passed: false, reason: "no_grounding" };
  }

  if (ctx.isConversationActive()) {
    return { passed: false, reason: "conversation_active" };
  }

  // Budget check
  const limit = computeThoughtBudgetLimit(
    policy,
    Object.values(ctx.graph.nodes).reduce((s, n) => s + n.activation, 0) / C.energyMax,
    mean(noveltyScores),
    mean(Object.values(ctx.graph.nodes).map(n => n.fatigue)),
  );

  // Reset budget hourly
  if (now - thoughtBudgetResetAt > 3_600_000) {
    thoughtBudgetUsed = 0;
    thoughtBudgetResetAt = now;
  }

  if (thoughtBudgetUsed >= limit) {
    return { passed: false, reason: "budget_exceeded" };
  }

  // Trigger check (at least one)
  let trigger: string | undefined;

  // Stable attractor: winner held 3+ consecutive ticks with low variance
  if (incumbentDwellTicks >= 3) {
    trigger = "stable_attractor";
  }

  // Cluster spike (L3: actual score delta comparison)
  if (cluster.score - lastTopClusterScore > C.spikeThreshold) {
    trigger = trigger ?? "activation_spike";
  }

  // High uncertainty
  if (cluster.avgU > 0.7) {
    trigger = trigger ?? "high_uncertainty";
  }

  // High valence
  if (Math.abs(cluster.avgV) > 0.6) {
    trigger = trigger ?? "high_valence";
  }

  // Prediction error
  if (state.avgPredictionError > 0.7 && state.predictionErrors.length >= 5) {
    trigger = trigger ?? "prediction_error";
  }

  if (!trigger) {
    return { passed: false, reason: "no_trigger" };
  }

  thoughtBudgetUsed++;
  return { passed: true, trigger };
}

// ── Micro-thought generation ─────────────────────────────────────────

async function generateMicroThought(
  cluster: ScoredCluster,
  state: BrainstemState,
  clock: Clock,
  conversationActive: boolean,
  cortexBudgetCheck?: (api: "verbalize" | "sanity", estimatedTokens: number) => boolean,
): Promise<MicroThoughtRecord | null> {
  const now = clock.nowMs();
  const anchor = assignAnchorTag(cluster.grounding[0], undefined);
  const charName = getCharacter().name;

  // Determine if self-referential
  const hasSelf = cluster.nodes.includes("self");

  // Build structSig and semSigText
  const structSig = cluster.nodes.slice(0, 6);
  const semSigText = cluster.labels.slice(0, 3).join(", ") + " | " +
    (cluster.grounding[0]?.type ?? "none") + " | " +
    (cluster.grounding[0]?.id ?? "none");

  // Epistemic language constraint by anchor
  let toneHint = "";
  if (anchor === "inferred") toneHint = "Use speculative tone (maybe, seems like, might).";
  if (anchor === "speculative") toneHint = "Use hypothetical tone (if, could it be, perhaps).";

  const perspectiveHint = hasSelf
    ? `You are ${charName}. From "I" perspective, say in one sentence what you're thinking right now.`
    : "Describe this thought in one sentence.";

  const prompt = `Currently active concepts in mind: ${cluster.labels.join(", ")}
${cluster.grounding.length > 0 ? `Related memory/goal: ${cluster.grounding[0].type}:${cluster.grounding[0].id}` : ""}
${perspectiveHint}${toneHint}
Requirements: 15-30 characters, one sentence. No explanation, just say it.`;

  let content: string;
  // Cortex unified budget: check verbalize slot before LLM call
  if (cortexBudgetCheck && !cortexBudgetCheck("verbalize", 110)) {
    content = `[${cluster.labels.slice(0, 3).join(", ")}]`;
  } else {
    try {
      content = await claudeText({
        label: "brainstem.innerMonologue",
        system: `You are ${charName}'s inner monologue generator. Output one brief inner thought.`,
        prompt,
        model: "fast",
        timeoutMs: 15_000,
      });
      content = content.trim();
      if (content.length > 60) content = content.slice(0, 60);
      if (content.length === 0) return null;
    } catch {
      // Fallback: use labels
      content = `[${cluster.labels.slice(0, 3).join(", ")}]`;
    }
  }

  // Output alignment check
  const contentTokens = tokenize(content);
  const labelTokens = cluster.labels.flatMap(l => tokenize(l));
  const overlap = contentTokens.filter(t => labelTokens.includes(t)).length / Math.max(1, contentTokens.length);
  if (overlap < 0.15 && content.length > 10) {
    // LLM hallucinated a different topic — use fallback
    content = `[${cluster.labels.slice(0, 3).join(", ")}]`;
  }

  const trigger = detectTrigger(cluster, state);

  // H2: Safety red line — high-risk content detection
  // Financial/medical/legal concepts with weak grounding → auto-downgrade anchor
  let safeAnchor = anchor;
  if (isHighRiskContent(cluster.labels, content)) {
    if (anchor !== "grounded" || cluster.groundingStrength < 0.6) {
      safeAnchor = "speculative";
      log.info(`safety downgrade: high-risk content "${cluster.labels[0]}" anchor ${anchor}→speculative`);
    }
  }

  const thought: MicroThoughtRecord = {
    id: `thought-${now}`,
    content,
    structSig,
    semSigText,
    timestamp: now,
    trigger,
    grounding: cluster.grounding.map(g => ({ type: g.type, id: g.id, weight: g.weight })),
    concepts: cluster.nodes,
    anchor: safeAnchor,
  };

  log.info(`micro-thought: "${content}" (${anchor}, ${trigger})`);

  return thought;
}

function detectTrigger(
  cluster: ScoredCluster,
  state: BrainstemState,
): MicroThoughtRecord["trigger"] {
  if (incumbentDwellTicks >= 3) return "stable_attractor";
  if (Math.abs(cluster.avgV) > 0.6) return "high_valence";
  if (cluster.avgU > 0.7) return "high_uncertainty";
  if (state.avgPredictionError > 0.7) return "prediction_error";
  return "activation_spike";
}

// ── Reflect gate ─────────────────────────────────────────────────────

function evaluateReflectGate(
  state: BrainstemState,
  winner: ScoredCluster | null,
  now: number,
): { armed: boolean; reason?: string } {
  // Rate limit
  if (now - lastReflectAt < C.reflectMaxPerHours * 3_600_000) {
    return { armed: false };
  }

  if (!winner) return { armed: false };

  // Trigger 1: Same concept in ≥3 of last 5 micro-thoughts AND pragmatic error elevated
  const last5 = state.thoughtHistory.slice(-5);
  if (last5.length >= 3) {
    const conceptCounts = new Map<string, number>();
    for (const t of last5) {
      for (const c of t.concepts) {
        conceptCounts.set(c, (conceptCounts.get(c) ?? 0) + 1);
      }
    }
    const recurring = [...conceptCounts.entries()].filter(([, count]) => count >= 3);
    if (recurring.length > 0 && state.avgPredictionError > 0.5) {
      return { armed: true, reason: `recurring concept "${recurring[0][0]}" + prediction error` };
    }
  }

  // Trigger 2: Belief conflict (opposing valence on connected nodes)
  if (winner) {
    const nodes = winner.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = state.graph?.nodes?.[nodes[i]];
        const b = state.graph?.nodes?.[nodes[j]];
        if (a && b) {
          // Opposing valence: one positive, one negative, both significant
          if (a.valence * b.valence < 0 && Math.abs(a.valence) > 0.3 && Math.abs(b.valence) > 0.3) {
            return { armed: true, reason: `belief conflict: "${a.label}" (V=${a.valence.toFixed(2)}) vs "${b.label}" (V=${b.valence.toFixed(2)})` };
          }
        }
      }
    }
  }

  // Trigger 3: Persistent prediction error
  if (state.avgPredictionError > 0.8 && state.predictionErrors.length >= 10) {
    return { armed: true, reason: "persistent prediction error" };
  }

  return { armed: false };
}

// ── Act gate ─────────────────────────────────────────────────────────

async function evaluateActGate(
  thought: MicroThoughtRecord,
  graph: ConceptGraph,
  ctx: SlowLoopContext,
  now: number,
): Promise<{ armed: boolean; reason?: string; arm?: ActGateArm; selfGateResult?: { passed: boolean; deniedReason?: string; snapshot: Partial<import("./self-model.js").SelfState> }; socialGateResult?: SlowLoopDecisionLog["socialGate"] }> {
  if (ctx.isQuietHours()) return { armed: false, reason: "quiet_hours" };
  if (thought.anchor === "speculative") return { armed: false, reason: "speculative_anchor" };

  const personId = getPersonTargetId();

  // Check suppression: concepts that were repeatedly rejected should not trigger
  if (ctx.isConceptSuppressed) {
    const suppressed = thought.concepts.some(id => ctx.isConceptSuppressed!(id));
    if (suppressed) return { armed: false, reason: "concept_suppressed" };
  }

  // CS8: Social gate — runs FIRST, before self gate
  let socialGateResult: SlowLoopDecisionLog["socialGate"] | undefined;
  if (ctx.socialModel) {
    const policy = ctx.stabilizer.getPolicy();
    if (policy.socialGateEnabled) {
      const hasPerson = thought.concepts.some(id => id.includes(personId));
      const targetId = hasPerson ? personId : "self";
      // Detect follow-up: thought concepts overlap with last outbound topics
      const targetState = ctx.socialModel.getTargetState(targetId);
      const lastTopics = targetState?.lastOutboundTopics ?? [];
      const isFollowUp = lastTopics.length > 0 &&
        thought.concepts.some(c => lastTopics.includes(c));
      const sr = ctx.socialModel.evaluateSocialGate(targetId, "reach_out", isFollowUp);
      // Enrich with full social state snapshot for decision log
      socialGateResult = {
        passed: sr.passed,
        reason: sr.reason,
        throttled: sr.cooldownMultiplier > 1,
        restricted: sr.reason === "pending_reply" ? "waiting_reply" : null,
        cooldownMultiplier: sr.cooldownMultiplier,
        snapshot: targetState ? {
          responsivenessEwma: targetState.responsivenessEwma,
          outboundCount7d: targetState.outboundCount7d,
          inboundCount7d: targetState.inboundCount7d,
          pendingType: targetState.pendingType,
        } : undefined,
      };
      if (!sr.passed) {
        return { armed: false, reason: `social_gate_${sr.reason}`, socialGateResult };
      }
      // Apply cooldown multiplier (effective through the remaining gate checks)
      // Note: cooldownMultiplier > 1 means the target's per-target cooldown is extended
    }
  }

  // CS5b: Self gate check — evaluate before proceeding to target matching
  if (ctx.selfModel) {
    const policy = ctx.stabilizer.getPolicy();
    // Determine action type from thought context
    const hasPerson = thought.concepts.some(id => id.includes(personId));
    const actionType: import("./self-model.js").ActionFamily = hasPerson ? "reach_out" : "explore";
    const selfGateResult = ctx.selfModel.evaluateSelfGate(actionType, policy.selfGate);
    const snapshot = ctx.selfModel.getState();
    if (!selfGateResult.passed) {
      return {
        armed: false,
        reason: `self_gate_${selfGateResult.deniedReason}`,
        selfGateResult: { ...selfGateResult, snapshot: { energy: snapshot.energy, fatigue: snapshot.fatigue, social_energy: snapshot.social_energy, safety_margin: snapshot.safety_margin } },
        socialGateResult,
      };
    }
  }

  // Check grounding: must be goal-type or involve act target
  const hasGoalGrounding = thought.grounding.some(g => g.type === "goal");
  const maxA = Math.max(...thought.concepts.map(id => graph.nodes[id]?.activation ?? 0));

  // Reset daily caps
  const day = Math.floor(now / 86_400_000);
  if (day !== lastActArmDay) {
    actArmsToday.clear();
    lastActArmDay = day;
  }

  let personMatched = false;

  for (const target of DEFAULT_ACT_TARGETS) {
    // Per-target activation threshold
    const threshold = target.type === "person" ? C.actGateMaxActivation : C.actGateSelfActivation;
    if (maxA < threshold) continue;

    // Skip "self" if a person target already matched (person takes priority)
    if (target.id === "self" && personMatched) continue;

    // Check if thought involves this target's concept patterns
    // Empty conceptPatterns (self target) matches any concept
    const matchesTarget = target.conceptPatterns.length === 0 ||
      thought.concepts.some(
        id => target.conceptPatterns.some(p => id.startsWith(p)),
      ) || hasGoalGrounding;

    if (!matchesTarget) continue;

    // Pending interaction gate
    if (target.requiresPendingInteraction && !ctx.hasPendingInteraction(target.id)) {
      continue;
    }

    // Per-target cooldown (CS8: multiplied by social gate cooldown if applicable)
    const lastArm = lastActArmPerTarget.get(target.id) ?? 0;
    const effectiveCooldownMs = target.cooldownMinutes * 60_000 * (socialGateResult?.cooldownMultiplier ?? 1.0);
    if (now - lastArm < effectiveCooldownMs) {
      continue;
    }

    // Daily cap
    const todayCount = actArmsToday.get(target.id) ?? 0;
    if (todayCount >= target.dailyCap) {
      continue;
    }

    // Must-not MN-7: no valence-only trigger
    if (thought.trigger === "high_valence" && !hasGoalGrounding && maxA < 0.8) {
      continue;
    }

    // LLM sanity check: ask a fast model if acting now is appropriate
    // Cortex unified budget: check sanity slot
    if (ctx.cortexBudgetCheck && !ctx.cortexBudgetCheck("sanity", 50)) {
      log.info(`act gate sanity check skipped: budget exceeded for target=${target.id}`);
      continue;
    }
    try {
      const hour = new Date().getHours();
      const sanityPrompt = `Thought: ${thought.content}\nTarget: ${target.id} (${target.type})\nTrigger: ${thought.trigger}\nBasis: ${thought.grounding[0]?.type ?? "none"}\nCurrent time: ${hour}:00\nIn conversation: ${ctx.isConversationActive() ? "yes" : "no"}`;
      const sanityResult = await claudeText({
        label: "brainstem.sanityCheck",
        system: "Judge whether it's appropriate to proactively reach out or perform an action right now. Only answer YES or NO.",
        prompt: sanityPrompt,
        model: "fast",
        timeoutMs: 10_000,
      });
      if (!sanityResult.trim().toUpperCase().startsWith("YES")) {
        log.info(`act gate sanity check rejected: target=${target.id}, response="${sanityResult.trim()}"`);
        continue;
      }
      log.info(`act gate sanity check passed: target=${target.id}`);
    } catch (err) {
      log.warn("act gate sanity check error, skipping arm", err);
      continue;
    }

    // Arm!
    if (target.type === "person") personMatched = true;
    lastActArmPerTarget.set(target.id, now);
    actArmsToday.set(target.id, todayCount + 1);

    // Build full grounding evidence packet
    const gatesPassed: string[] = ["not_quiet_hours", "not_speculative", "activation_threshold", "target_match", "cooldown_ok", "daily_cap_ok", "valence_check", "llm_sanity_check"];
    const fullGrounding = thought.grounding.map(g => ({
      type: g.type as GroundingRef["type"],
      id: g.id,
      weight: g.weight,
      evidence: { sourceNodeIds: [], why: "memoryKeys" as const, rawScoreParts: {} },
    }));

    const evidencePacket: GroundingEvidencePacket = {
      microThoughtId: thought.id,
      microThoughtContent: thought.content,
      triggerType: thought.trigger,
      anchor: thought.anchor,
      targetId: target.id,
      targetType: target.type,
      groundingRefs: thought.grounding.map(g => ({
        type: g.type as "memory" | "goal" | "discovery",
        id: g.id,
        weight: g.weight,
        sourceNodeIds: g.type === "memory" ?
          thought.concepts.filter(c => graph.nodes[c]?.memoryKeys?.includes(g.id)) : [],
        why: g.type === "goal" ? "goalMatch" : g.type === "discovery" ? "discoveryMatch" : "memoryKeys",
        rawScoreParts: { weight: g.weight },
      })),
      clusterConceptIds: thought.concepts,
      maxActivation: maxA,
      meanValence: thought.concepts.reduce(
        (sum, id) => sum + (graph.nodes[id]?.valence ?? 0), 0,
      ) / Math.max(1, thought.concepts.length),
      gatesPassed,
      selfAnnex: ctx.selfModel ? (() => {
        const ss = ctx.selfModel.getState();
        return {
          snapshot: { energy: ss.energy, social_energy: ss.social_energy, safety_margin: ss.safety_margin, fatigue: ss.fatigue },
          why_now: `social_energy=${ss.social_energy.toFixed(2)}, safety=${ss.safety_margin.toFixed(2)}, fatigue=${ss.fatigue.toFixed(2)}`,
        };
      })() : undefined,
      timestamp: now,
    };

    return {
      armed: true,
      reason: `target="${target.id}", grounding=${thought.grounding[0]?.type}`,
      arm: {
        armed: true,
        reason: `thought="${thought.content}", target="${target.id}"`,
        grounding: fullGrounding,
        targetId: target.id,
        microThoughtId: thought.id,
        concepts: thought.concepts,
        evidencePacket,
      },
      socialGateResult,
    };
  }

  return { armed: false, reason: "no_matching_target" };
}

// ── Future simulation (CS4) ──────────────────────────────────────────

async function createHypotheticalNode(
  winner: ScoredCluster,
  graph: ConceptGraph,
  state: BrainstemState,
  clock: Clock,
): Promise<void> {
  // Rate limit
  const hypotheticals = state.hypotheticalNodes.filter(id => graph.nodes[id]);
  if (hypotheticals.length >= C.maxHypotheticalNodes) {
    // Evict oldest
    const oldest = hypotheticals[0];
    delete graph.nodes[oldest];
    graph.edges = graph.edges.filter(e => e.source !== oldest && e.target !== oldest);
    state.hypotheticalNodes = hypotheticals.slice(1);
  }

  // Evict expired hypotheticals
  const now = clock.nowMs();
  for (const id of [...state.hypotheticalNodes]) {
    const node = graph.nodes[id];
    if (!node) continue;
    if (now - node.lastActivated > C.hypotheticalTTLMs && node.activation < 0.1) {
      delete graph.nodes[id];
      graph.edges = graph.edges.filter(e => e.source !== id && e.target !== id);
      state.hypotheticalNodes = state.hypotheticalNodes.filter(x => x !== id);
    }
  }

  // Determine hypothetical strategy from winner cluster
  const personId = getPersonTargetId();
  const goalGrounding = winner.grounding.find(g => g.type === "goal");
  const personConcept = winner.nodes.find(id => id.includes(personId));
  const mainLabel = graph.nodes[winner.nodes[0]]?.label ?? winner.labels[0] ?? "";

  let strategy: string;
  let templateLabel: string;
  let hypotheticalId: string;
  let initialActivation = 0;

  if (personConcept) {
    strategy = "plan";
    templateLabel = `Plan for ${graph.nodes[personConcept]?.label ?? personConcept}`;
    hypotheticalId = normalizeId(`${personConcept}-plan`);
  } else if (goalGrounding) {
    strategy = "next_step";
    templateLabel = `Next step for ${goalGrounding.id}`;
    hypotheticalId = normalizeId(`${goalGrounding.id}-next`);
    initialActivation = 0.1; // seed from goal drive
  } else if (winner.avgU > 0.5) {
    strategy = "resolution";
    templateLabel = `Resolve ${mainLabel}`;
    hypotheticalId = normalizeId(`${winner.nodes[0]}-resolution`);
  } else if (winner.avgV > 0.3 && winner.grounding.length > 0) {
    // Consequence: what happens if this positive trend continues
    strategy = "consequence";
    templateLabel = `What happens after ${mainLabel}`;
    hypotheticalId = normalizeId(`${winner.nodes[0]}-consequence`);
  } else if (winner.avgV < -0.3) {
    // What-if: what if the negative state were resolved
    strategy = "what_if";
    templateLabel = `What if ${mainLabel} were resolved`;
    hypotheticalId = normalizeId(`${winner.nodes[0]}-whatif`);
  } else if (winner.nodes.length >= 3) {
    // Combination: merge two cluster concepts into a new idea
    const l1 = graph.nodes[winner.nodes[0]]?.label ?? "";
    const l2 = graph.nodes[winner.nodes[1]]?.label ?? "";
    strategy = "combination";
    templateLabel = `Intersection of ${l1} and ${l2}`;
    // Prevent combo-of-combo chains: strip existing -combo suffixes before joining
    const n0 = winner.nodes[0].replace(/-combo.*$/, "");
    const n1 = winner.nodes[1].replace(/-combo.*$/, "");
    hypotheticalId = normalizeId(`${n0}-${n1}-combo`);
  } else {
    return; // no viable strategy
  }

  if (graph.nodes[hypotheticalId]) return; // already exists

  // LLM-generated label (fall back to template on error/timeout)
  let label = templateLabel;
  try {
    const prompt = `Current concept cluster: ${winner.labels.join(", ")}
Strategy: ${strategy}
Template: ${templateLabel}

Describe this hypothetical thought as a short noun phrase (3-8 words). Output the phrase directly, no explanation.`;
    const llmLabel = await claudeText({
      label: "brainstem.nameThought",
      system: "You are a concept namer. Output only one short noun phrase.",
      prompt,
      model: "fast",
      timeoutMs: 8_000,
    });
    const trimmed = llmLabel.trim();
    if (trimmed.length >= 2 && trimmed.length <= 20) {
      label = trimmed;
    }
  } catch {
    // use template label
  }

  // Seed activation from grounding strength
  if (winner.groundingStrength > 0.5) {
    initialActivation = Math.max(initialActivation, 0.1 * winner.groundingStrength);
  }

  const node = {
    id: hypotheticalId,
    label,
    activation: initialActivation,
    fatigue: 0,
    salience: 0.3,
    uncertainty: strategy === "what_if" ? 0.6 : 0.2,
    valence: strategy === "what_if" ? winner.avgV * 0.3 : 0,
    drive: strategy === "next_step" ? 0.2 : 0,
    inputSatiation: 0,
    lastExternalBoostAt: 0,
    lastActivated: now,
    source: "simulation" as const,
    termVector: tokenize(label),
    memoryKeys: [],
    stableSince: 0,
    anchorText: label,
    parentId: null,
    depth: 2,
    acl: ACL_DEFAULTS.topic,
    knowledgeTier: "stm" as const,
    cumulativeCredit: 0,
    domain: "general" as const,
  };

  graph.nodes[hypotheticalId] = node;
  state.hypotheticalNodes.push(hypotheticalId);

  // Connect to winner cluster
  for (const winId of winner.nodes.slice(0, 3)) {
    if (graph.edges.length < C.maxEdges) {
      graph.edges.push({
        source: winId,
        target: hypotheticalId,
        type: "semantic",
        weight: 0.3,
      });
    }
  }

  log.info(`hypothetical (${strategy}): "${label}" [${hypotheticalId}]`);
}

// ── TF-IDF Cosine Similarity ─────────────────────────────────────────

/** Build a TF vector (term → frequency) from tokens. */
function buildTfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  // Normalize by max frequency
  const maxTf = Math.max(1, ...tf.values());
  for (const [k, v] of tf) tf.set(k, v / maxTf);
  return tf;
}

/** Build IDF map from a corpus of token arrays. */
function buildIdfMap(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    const unique = new Set(doc);
    for (const t of unique) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = corpus.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1); // smoothed IDF
  }
  return idf;
}

/** Cosine similarity between two TF-IDF vectors. */
function cosineSimilarity(
  tfA: Map<string, number>,
  tfB: Map<string, number>,
  idf: Map<string, number>,
): number {
  let dot = 0, magA = 0, magB = 0;
  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  for (const term of allTerms) {
    const w = idf.get(term) ?? 1;
    const a = (tfA.get(term) ?? 0) * w;
    const b = (tfB.get(term) ?? 0) * w;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ── Helpers ──────────────────────────────────────────────────────────

function computeNoveltyScore(
  cluster: ScoredCluster | null,
  thoughtHistory: MicroThoughtRecord[],
): number {
  if (!cluster) return 0;
  const currentSig = new Set(cluster.nodes.slice(0, 6));

  // Structural novelty (Jaccard on ID sets)
  let minStructDist = 1.0;
  for (const t of thoughtHistory.slice(-10)) {
    const prevSig = new Set(t.structSig);
    let intersection = 0;
    for (const id of currentSig) if (prevSig.has(id)) intersection++;
    const union = currentSig.size + prevSig.size - intersection;
    const dist = union > 0 ? 1 - intersection / union : 1;
    minStructDist = Math.min(minStructDist, dist);
  }
  const structNovelty = minStructDist;

  // Semantic novelty (TF-IDF cosine similarity, Jaccard fallback)
  const recent = thoughtHistory.slice(-10);
  const currentTokens = tokenize(cluster.labels.join(" "));
  let semanticNovelty: number;

  if (recent.length >= 2) {
    // Build IDF from corpus of recent thoughts + current cluster
    const corpus = recent.map(t => tokenize(t.semSigText));
    corpus.push(currentTokens);
    const idf = buildIdfMap(corpus);

    const currentTf = buildTfVector(currentTokens);
    let maxSim = 0;
    for (const t of recent) {
      const prevTf = buildTfVector(tokenize(t.semSigText));
      const sim = cosineSimilarity(currentTf, prevTf, idf);
      maxSim = Math.max(maxSim, sim);
    }
    semanticNovelty = 1 - maxSim; // cosine distance
  } else {
    // Jaccard fallback when insufficient history
    let minSemDist = 1.0;
    for (const t of recent) {
      const prevTokens = tokenize(t.semSigText);
      const inter = currentTokens.filter(tok => prevTokens.includes(tok)).length;
      const uni = new Set([...currentTokens, ...prevTokens]).size;
      const dist = uni > 0 ? 1 - inter / uni : 1;
      minSemDist = Math.min(minSemDist, dist);
    }
    semanticNovelty = minSemDist;
  }

  // Combined: 60% structural + 40% semantic
  return 0.6 * structNovelty + 0.4 * semanticNovelty;
}

function computeThoughtBudgetLimit(
  policy: ControlPolicy,
  energyUtilization: number,
  noveltyAvg: number,
  avgFatigue: number,
): number {
  let budget = C.thoughtBudgetBase;

  // Energy/fatigue scaling
  if (energyUtilization > 0.6 && noveltyAvg > 0.5) {
    budget *= 1.5;
  } else if (avgFatigue > 0.4 || energyUtilization < 0.3) {
    budget *= 0.5;
  }

  // Stabilizer scaling
  budget *= policy.thoughtBudgetScale;

  return Math.max(C.thoughtBudgetFloor, Math.min(C.thoughtBudgetCeiling, budget));
}

// ── H2: High-risk content detection ──────────────────────────────────

const HIGH_RISK_KEYWORDS = [
  // Financial
  "invest", "stock", "crypto", "trading", "finance", "fund", "portfolio", "futures",
  // Medical
  "diagnos", "prescri", "medic", "treatment", "symptom", "disease", "surgery",
  // Legal
  "legal", "lawsuit", "contract", "copyright", "litigation", "infringement",
];

function isHighRiskContent(labels: string[], content: string): boolean {
  const combined = labels.join(" ").toLowerCase() + " " + content.toLowerCase();
  return HIGH_RISK_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()));
}

function countRotations(history: Array<{ id: string; timestamp: number }>): number {
  let rotations = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].id !== history[i - 1].id) rotations++;
  }
  return rotations;
}

// ── Exports for slow loop state queries ──────────────────────────────

export function getRecentThoughts(state: BrainstemState, n: number): MicroThoughtRecord[] {
  return state.thoughtHistory.slice(-n);
}

export function getNoveltyAvg(): number {
  return mean(noveltyScores);
}

export function getWinnerRotationRate(): number {
  return countRotations(winnerHistory);
}
