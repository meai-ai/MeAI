/**
 * Curiosity Engine — epistemic/aleatoric uncertainty decomposition,
 * LearningNeed scoring, VOI via planner rollout.
 *
 * Produces ranked curiosity targets that bias heartbeat's explore action.
 */

import { type ConceptGraph, type ConceptNode, mean } from "./graph.js";
import { type Clock } from "./config.js";
import { getPredictionErrorForNode } from "./prediction.js";
import type { WorldModel, ActionType, BeliefState } from "./world-model.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-curiosity");

// ── Types ────────────────────────────────────────────────────────────

export interface UncertaintyDecomposition {
  epistemic: number;    // E_epi: learnable. 0-1
  aleatoric: number;    // E_alea: irreducible. 0-1
  confidence: number;   // 0-1
}

export interface ExplorationAction {
  nodeId: string;
  queryType: "search" | "recall_memory" | "ask_question" | "re_observe";
  suggestedQuery: string;
  estimatedCost: number;
  estimatedEpiReduction: number;
  learningNeed: number;
  voi: number;
  eig: number;
  mi: number;
}

export interface OutcomeRecord {
  actionType: string;
  triggeredBy: {
    clusterConceptIds: string[];
    groundingRefs: Array<{ type: string; id: string; weight: number }>;
    decisionLogId: string;
  };
  outcome: "positive" | "negative" | "neutral" | "pending";
  outcomeSignal: string;
  creditUpdates: Array<{ type: string; id: string; delta: number }>;
  timestamp: number;
}

// ── Exploration count tracker ────────────────────────────────────────

const explorationCounts = new Map<string, number>();

export function recordExploration(conceptId: string): void {
  explorationCounts.set(conceptId, (explorationCounts.get(conceptId) ?? 0) + 1);
}

export function getExplorationCount(conceptId: string): number {
  return explorationCounts.get(conceptId) ?? 0;
}

// ── Information-theoretic curiosity ──────────────────────────────────

/** Digamma approximation via Stirling series. */
function digamma(x: number): number {
  if (x <= 0) return -Infinity;
  let result = 0;
  // Shift x to large value for series convergence
  while (x < 6) { result -= 1 / x; x += 1; }
  result += Math.log(x) - 1 / (2 * x) - 1 / (12 * x * x);
  return result;
}

/** KL divergence between Beta(a',b') and Beta(a,b). Closed-form. */
function klBeta(a1: number, b1: number, a0: number, b0: number): number {
  const lnBeta = (a: number, b: number) =>
    lgamma(a) + lgamma(b) - lgamma(a + b);
  return lnBeta(a0, b0) - lnBeta(a1, b1)
    + (a1 - a0) * digamma(a1) + (b1 - b0) * digamma(b1)
    + (a0 + b0 - a1 - b1) * digamma(a1 + b1);
}

/** Log-gamma approximation (Stirling). */
function lgamma(x: number): number {
  if (x <= 0) return 0;
  return 0.5 * Math.log(2 * Math.PI / x) + x * (Math.log(x + 1 / (12 * x - 1 / (10 * x))) - 1);
}

/**
 * Expected Information Gain via KL-divergence between prior and posterior
 * for Beta-Bernoulli model of positive/negative outcomes.
 */
export function computeEIG(
  nodeId: string,
  outcomes: OutcomeRecord[],
): number {
  const relevant = outcomes.filter(
    o => o.triggeredBy.clusterConceptIds.includes(nodeId),
  );

  if (relevant.length < 3) return 0.8; // cold start: high EIG assumed

  // Prior: Beta(alpha, beta) from observed positive/negative counts
  const positives = relevant.filter(o => o.outcome === "positive").length;
  const negatives = relevant.filter(o => o.outcome === "negative").length;
  const neutrals = relevant.length - positives - negatives;
  const alpha = positives + 1; // +1 for uniform prior
  const beta = negatives + neutrals + 1;

  // EIG = sum over outcomes: P(outcome) * KL(posterior || prior)
  const pPos = alpha / (alpha + beta);
  const pNeg = 1 - pPos;

  // Posterior after observing positive: Beta(alpha+1, beta)
  const klPos = klBeta(alpha + 1, beta, alpha, beta);
  // Posterior after observing negative: Beta(alpha, beta+1)
  const klNeg = klBeta(alpha, beta + 1, alpha, beta);

  const eig = pPos * Math.max(0, klPos) + pNeg * Math.max(0, klNeg);
  return Math.min(1, eig); // normalize to 0-1
}

/**
 * Mutual information between node activation state and outcome quality.
 * Bins activations into [low, mid, high], computes MI.
 */
export function computeMutualInformation(
  nodeId: string,
  graph: ConceptGraph,
  outcomes: OutcomeRecord[],
): number {
  const relevant = outcomes.filter(
    o => o.triggeredBy.clusterConceptIds.includes(nodeId),
  );
  if (relevant.length < 5) return 0;

  // Bin outcomes by activation level of the node at outcome time
  // Since we don't track historical activation, use outcome signal as proxy
  const bins: Record<string, { pos: number; neg: number; total: number }> = {
    low: { pos: 0, neg: 0, total: 0 },
    mid: { pos: 0, neg: 0, total: 0 },
    high: { pos: 0, neg: 0, total: 0 },
  };

  for (let i = 0; i < relevant.length; i++) {
    // Use index as activation proxy (earlier = lower activation window)
    const bin = i < relevant.length / 3 ? "low" : i < (2 * relevant.length) / 3 ? "mid" : "high";
    bins[bin].total++;
    if (relevant[i].outcome === "positive") bins[bin].pos++;
    else bins[bin].neg++;
  }

  // H(outcome) - overall
  const totalPos = Object.values(bins).reduce((s, b) => s + b.pos, 0);
  const totalAll = relevant.length;
  const pPosAll = totalPos / totalAll;
  const hOutcome = pPosAll > 0 && pPosAll < 1
    ? -(pPosAll * Math.log2(pPosAll) + (1 - pPosAll) * Math.log2(1 - pPosAll))
    : 0;

  // H(outcome | activation_bin)
  let hConditional = 0;
  for (const bin of Object.values(bins)) {
    if (bin.total === 0) continue;
    const pBin = bin.total / totalAll;
    const pPosBin = bin.pos / bin.total;
    const hBin = pPosBin > 0 && pPosBin < 1
      ? -(pPosBin * Math.log2(pPosBin) + (1 - pPosBin) * Math.log2(1 - pPosBin))
      : 0;
    hConditional += pBin * hBin;
  }

  return Math.max(0, hOutcome - hConditional);
}

// ── Uncertainty decomposition ────────────────────────────────────────

export function decomposeUncertainty(
  nodeId: string,
  outcomes: OutcomeRecord[],
): UncertaintyDecomposition {
  const relevant = outcomes.filter(
    o => o.triggeredBy.clusterConceptIds.includes(nodeId),
  );

  if (relevant.length < 3) {
    return { epistemic: 0.8, aleatoric: 0.2, confidence: 0.1 };
  }

  // Compute variance decomposition
  const groups = new Map<string, OutcomeRecord[]>();
  for (const o of relevant) {
    const key = o.actionType;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }

  let totalVariance = 0;
  let withinGroupVariance = 0;
  let groupCount = 0;

  for (const [, group] of groups) {
    if (group.length >= 2) {
      const successRate = group.filter(o => o.outcome === "positive").length / group.length;
      withinGroupVariance += successRate * (1 - successRate);
      groupCount++;
    }
  }

  const allSuccessRate = relevant.filter(o => o.outcome === "positive").length / relevant.length;
  totalVariance = allSuccessRate * (1 - allSuccessRate);

  const aleatoricFraction = groupCount > 0
    ? withinGroupVariance / groupCount / Math.max(0.01, totalVariance)
    : 0.5;

  return {
    epistemic: Math.max(0, Math.min(1, 1 - aleatoricFraction)) *
      (relevant.length < 10 ? 0.8 : 1.0),
    aleatoric: Math.max(0, Math.min(1, aleatoricFraction)),
    confidence: Math.min(1, relevant.length / 20),
  };
}

// ── Learning Need Score ──────────────────────────────────────────────

export function computeLearningNeed(
  node: ConceptNode,
  graph: ConceptGraph,
  uncertainty: UncertaintyDecomposition,
  worldModel?: WorldModel,
  eig?: number,
): number {
  const importance = Math.max(
    node.drive,
    node.salience * 0.5,
    node.uncertainty * 0.3,
  );

  // Connectivity bonus
  const neighborCount = graph.edges.filter(
    e => e.source === node.id || e.target === node.id,
  ).length;
  const connectivityBonus = Math.log1p(neighborCount) / Math.log1p(20);

  // Staleness
  const daysSinceExplored = (Date.now() - (node.lastExternalBoostAt || node.lastActivated)) / 86_400_000;
  const stalenessBonus = Math.min(1.5, 1.0 + daysSinceExplored / 7);

  // Prediction error track record
  const predError = getPredictionErrorForNode(node.id);
  const predErrorBonus = predError > 0.4 ? 1.3 : 1.0;

  // World model epistemic error
  const wmBonus = worldModel
    ? (worldModel.getEpistemicError(node.id) > 0.5 ? 1.2 : 1.0)
    : 1.0;

  // Use EIG when available (>= 3 outcomes), fall back to epistemic fraction
  const infoSignal = eig !== undefined ? eig : uncertainty.epistemic;

  return infoSignal * importance * connectivityBonus * stalenessBonus * predErrorBonus * wmBonus;
}

// ── Generate exploration targets ─────────────────────────────────────

export function generateCuriosityTargets(
  graph: ConceptGraph,
  outcomes: OutcomeRecord[],
  worldModel?: WorldModel,
  plannerEU = 0,
  maxTargets = 3,
  selfCostFn?: (queryType: string) => number,
): ExplorationAction[] {
  const nodes = Object.values(graph.nodes).filter(
    n => n.id !== "self" && n.uncertainty > 0.2,
  );

  if (nodes.length === 0) return [];

  // Compute learning need for each (with EIG and MI)
  const scored: Array<{ node: ConceptNode; learningNeed: number; uncertainty: UncertaintyDecomposition; eig: number; mi: number }> = [];

  for (const node of nodes) {
    const uncertainty = decomposeUncertainty(node.id, outcomes);
    const eig = computeEIG(node.id, outcomes);
    const mi = computeMutualInformation(node.id, graph, outcomes);
    const need = computeLearningNeed(node, graph, uncertainty, worldModel, eig);
    scored.push({ node, learningNeed: need, uncertainty, eig, mi });
  }

  // Sort by learning need, take top candidates
  scored.sort((a, b) => b.learningNeed - a.learningNeed);
  const topCandidates = scored.slice(0, maxTargets);

  return topCandidates.map(({ node, learningNeed, uncertainty, eig, mi }) => {
    const queryType = selectQueryType(node, uncertainty);
    const suggestedQuery = generateQuery(node, queryType);
    const cost = queryCost(queryType);

    // VOI: use EIG directly instead of aleatoric complement
    const epiReductionPotential = eig;
    const planImprovementFactor = 1 + Math.max(0, plannerEU);
    const selfCost = selfCostFn ? selfCostFn(queryType) : 0;
    const voi = (learningNeed * epiReductionPotential * planImprovementFactor) / Math.max(0.01, cost)
      + mi * 0.1 - 0.2 * selfCost;

    return {
      nodeId: node.id,
      queryType,
      suggestedQuery,
      estimatedCost: cost,
      estimatedEpiReduction: epiReductionPotential * 0.3,
      learningNeed,
      voi,
      eig,
      mi,
    };
  });
}

// ── Query type selection ─────────────────────────────────────────────

function selectQueryType(
  node: ConceptNode,
  uncertainty: UncertaintyDecomposition,
): ExplorationAction["queryType"] {
  // High aleatoric → just observe
  if (uncertainty.aleatoric > 0.7) return "re_observe";

  // External topic with no memories → search
  if (node.memoryKeys.length === 0 && node.source !== "reflection") return "search";

  // Internal topic with memories → recall
  if (node.memoryKeys.length > 0) return "recall_memory";

  // Person-related
  if (node.acl.entityType === "person") return "ask_question";

  return "search";
}

function generateQuery(node: ConceptNode, queryType: ExplorationAction["queryType"]): string {
  switch (queryType) {
    case "search":
      return node.label;
    case "recall_memory":
      return `${node.label} related memories`;
    case "ask_question":
      return `Question about ${node.label}`;
    case "re_observe":
      return node.label;
  }
}

function queryCost(queryType: ExplorationAction["queryType"]): number {
  switch (queryType) {
    case "search": return 0.15;
    case "recall_memory": return 0.02;
    case "ask_question": return 0.25;
    case "re_observe": return 0.01;
  }
}
