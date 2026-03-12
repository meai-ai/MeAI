/**
 * Beam Search Planner — goal → candidate actions → world model rollout → EU reward.
 *
 * Generates plans with counterfactual explanations. Biases ActionPreference.
 * Budget-controlled by stabilizer policy.
 */

import { type Clock, BRAINSTEM_CONFIG as C, ACTION_COSTS } from "./config.js";
import type { WorldModel, ActionType, BeliefState, TransitionResult } from "./world-model.js";
import type { ConceptGraph } from "./graph.js";
import type { SelfModel, ActionFamily } from "./self-model.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { getCharacter } from "../character.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-planner");

// ── Types ────────────────────────────────────────────────────────────

export interface PlanNode {
  action: ActionType;
  target?: string;
  description: string;
  relatedGoalId: string;
  predictedBelief: BeliefState;
  outcomeDistribution: TransitionResult["outcomeDistribution"];
  expectedUtility: number;
  depth: number;
  parentIndex: number | null;
  childIndices: number[];
}

export interface Plan {
  id: string;
  goalId: string;
  nodes: PlanNode[];
  bestPath: number[];
  totalReturn: number;
  alternatives: Array<{
    path: number[];
    totalReturn: number;
    whyWorse: string;
  }>;
  createdAt: number;
  status: "active" | "completed" | "abandoned" | "replanning";
  currentStepIndex: number;
}

export interface ActionPreference {
  explore: number;
  reach_out: number;
  post: number;
  activity: number;
  reflect: number;
  rest: number;
}

export interface GoalForPlanning {
  id: string;
  description: string;
  priority: number;
  progress: number;
  relatedTopics: string[];
  category: string;
  milestones?: Array<{ description: string; completed: boolean }>;
}

interface RolloutPolicy {
  actionWeights: Record<string, number>;  // learned bias per action type
  contextWeights: Record<string, number>; // csiMode → weight modifier
  updateCount: number;
}

interface PlanCacheEntry {
  goalId: string;
  beliefHash: string;
  bestPath: number[];
  totalReturn: number;
  createdAt: number;
  hitCount: number;
}

interface PlannerState {
  activePlans: Plan[];
  planHistory: Plan[];
  lastPlanAt: number;
  llmCallsToday: number;
  lastLlmDay: number;
  rolloutPolicy?: RolloutPolicy;
  planCache?: PlanCacheEntry[];
}

// ── Belief hashing for plan cache ─────────────────────────────────────

function hashBelief(belief: BeliefState): string {
  const key = `${belief.internal.csiMode}:${Math.round(belief.latent.socialReceptivity * 10)}:${Math.round(belief.latent.infoFreshness * 10)}:${belief.internal.pendingInteractions.length}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function defaultRolloutPolicy(): RolloutPolicy {
  const weights: Record<string, number> = {};
  for (const a of ACTION_WHITELIST) weights[a] = 1.0;
  return { actionWeights: weights, contextWeights: {}, updateCount: 0 };
}

// ── Counterfactual bias ──────────────────────────────────────────────

const counterfactualBias: Record<string, number> = {};

// ── Candidate action generation ──────────────────────────────────────

const ACTION_WHITELIST: ActionType[] = [
  "reach_out", "reflect", "explore", "post", "activity", "stay_silent",
];

function generateCandidateActions(
  goal: GoalForPlanning,
  belief: BeliefState,
  csiMode: string,
): Array<{ type: ActionType; target?: string; description: string }> {
  const candidates: Array<{ type: ActionType; target?: string; description: string }> = [];
  const userName = getCharacter().user?.name ?? "user";

  // Filter by CSI mode
  const allowedActions = csiMode === "red"
    ? (["stay_silent", "reflect"] as ActionType[])
    : ACTION_WHITELIST;

  for (const action of allowedActions) {
    switch (action) {
      case "explore":
        candidates.push({
          type: "explore",
          description: `search for info related to ${goal.description}`,
        });
        break;
      case "reflect":
        candidates.push({
          type: "reflect",
          description: `reflect on progress toward ${goal.description}`,
        });
        break;
      case "reach_out":
        if (belief.internal.pendingInteractions.length > 0 ||
            belief.latent.socialReceptivity > 0.3) {
          candidates.push({
            type: "reach_out",
            target: userName.toLowerCase(),
            description: `discuss ${goal.description} with ${userName}`,
          });
        }
        break;
      case "activity":
        if (goal.milestones?.some(m => !m.completed)) {
          candidates.push({
            type: "activity",
            description: `work on milestone for ${goal.description}`,
          });
        }
        break;
      case "post":
        if (Math.abs(belief.latent.topicViability) > 0.5) {
          candidates.push({
            type: "post",
            description: `share thoughts about ${goal.relatedTopics[0] ?? goal.description}`,
          });
        }
        break;
      case "stay_silent":
        candidates.push({
          type: "stay_silent",
          description: "do nothing and observe",
        });
        break;
    }
  }

  return candidates;
}

// ── Planner ──────────────────────────────────────────────────────────

export class Planner {
  private state: PlannerState;
  private dataPath: string;
  private pendingCortexCandidates?: Array<{ type: ActionType; target?: string; description: string }>;
  private pendingReasoningPaths?: Array<{ steps: string[]; conclusion: string }>;

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.state = this.load();
  }

  setCortexCandidates(
    candidates: Array<{ type: ActionType; target?: string; description: string }>,
    reasoningPaths?: Array<{ steps: string[]; conclusion: string }>,
  ): void {
    this.pendingCortexCandidates = candidates;
    this.pendingReasoningPaths = reasoningPaths;
  }

  getActivePlans(): Plan[] {
    return [...this.state.activePlans];
  }

  // ── Plan generation (MCTS with beam search fallback) ────────

  generatePlan(
    goal: GoalForPlanning,
    belief: BeliefState,
    worldModel: WorldModel,
    graph?: ConceptGraph,
    selfModel?: SelfModel,
  ): Plan | null {
    const now = this.clock.nowMs();

    // Budget check
    if (now - this.state.lastPlanAt < C.plannerMinIntervalMs) return null;
    if (this.state.activePlans.length >= C.plannerMaxActivePlans) return null;

    let candidates = this.pendingCortexCandidates ?? generateCandidateActions(goal, belief, belief.internal.csiMode);
    this.pendingCortexCandidates = undefined;

    // Expand reasoningPaths into additional ToT branch candidates
    const reasoningPaths = this.pendingReasoningPaths;
    this.pendingReasoningPaths = undefined;
    if (reasoningPaths && reasoningPaths.length > 0) {
      for (const rp of reasoningPaths) {
        if (rp.steps.length === 0) continue;
        // Each reasoning path's first step maps to a candidate action type
        const firstStep = rp.steps[0].toLowerCase();
        const matchedAction = ACTION_WHITELIST.find(a => firstStep.includes(a));
        if (matchedAction && !candidates.some(c => c.type === matchedAction && c.description === rp.conclusion)) {
          candidates.push({
            type: matchedAction,
            description: rp.conclusion,
          });
        }
      }
      // Cap total candidates to avoid blowing up search budget
      candidates = candidates.slice(0, 12);
    }

    if (candidates.length === 0) return null;

    // Plan cache lookup
    const bHash = hashBelief(belief);
    const cache = this.state.planCache ?? [];
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const cached = cache.find(
      e => e.goalId === goal.id && e.beliefHash === bHash && (now - e.createdAt) < TWO_HOURS,
    );
    if (cached) {
      cached.hitCount++;
      this.save();
      log.info(`plan cache hit for goal "${goal.description}" (hits=${cached.hitCount})`);
      // Re-use cached plan result
      const cachedPlan: Plan = {
        id: `plan-${now}`,
        goalId: goal.id,
        nodes: [], // empty — cached plans only carry path info
        bestPath: cached.bestPath,
        totalReturn: cached.totalReturn,
        alternatives: [],
        createdAt: now,
        status: "active",
        currentStepIndex: 0,
      };
      this.state.activePlans.push(cachedPlan);
      this.state.lastPlanAt = now;
      this.save();
      return cachedPlan;
    }

    // Credit bonus helper
    const creditBonus = (g?: ConceptGraph): number => {
      if (!g) return 0;
      const goalNode = g.nodes[goal.id];
      return goalNode?.cumulativeCredit ? goalNode.cumulativeCredit * 0.1 : 0;
    };

    // Try MCTS first
    const mctsResult = this.mctsSearch(goal, belief, worldModel, candidates, creditBonus(graph), selfModel);

    // Fallback to beam search if MCTS budget exhausted with < 10 iterations
    let allNodes: PlanNode[];
    let bestPath: { path: number[]; totalReturn: number };
    let alternatives: Array<{ path: number[]; totalReturn: number; whyWorse: string }>;

    if (mctsResult && mctsResult.iterations >= 10) {
      allNodes = mctsResult.planNodes;
      bestPath = mctsResult.bestPath;
      alternatives = mctsResult.alternatives;
    } else {
      const beamResult = this.beamSearch(goal, belief, worldModel, candidates, creditBonus(graph), selfModel);
      if (!beamResult) return null;
      allNodes = beamResult.planNodes;
      bestPath = beamResult.bestPath;
      alternatives = beamResult.alternatives;
    }

    if (bestPath.path.length === 0) return null;

    const plan: Plan = {
      id: `plan-${now}`,
      goalId: goal.id,
      nodes: allNodes,
      bestPath: bestPath.path,
      totalReturn: bestPath.totalReturn,
      alternatives,
      createdAt: now,
      status: "active",
      currentStepIndex: 0,
    };

    this.state.activePlans.push(plan);
    this.state.lastPlanAt = now;

    // Cache the plan result
    if (!this.state.planCache) this.state.planCache = [];
    this.state.planCache.push({
      goalId: goal.id,
      beliefHash: bHash,
      bestPath: bestPath.path,
      totalReturn: bestPath.totalReturn,
      createdAt: now,
      hitCount: 0,
    });

    // Update rollout policy from MCTS result
    if (mctsResult && mctsResult.iterations >= 10 && allNodes.length > 0) {
      this.updateRolloutPolicy(
        bestPath.path.map(i => allNodes[i]).filter(Boolean),
        bestPath.totalReturn,
      );
    }

    this.save();

    log.info(`plan generated for goal "${goal.description}": ${bestPath.path.length} steps, EU=${bestPath.totalReturn.toFixed(2)}`);

    return plan;
  }

  // ── MCTS search ──────────────────────────────────────────────

  private mctsSearch(
    goal: GoalForPlanning,
    belief: BeliefState,
    worldModel: WorldModel,
    rootCandidates: Array<{ type: ActionType; target?: string; description: string }>,
    creditBonus: number,
    selfModel?: SelfModel,
  ): {
    planNodes: PlanNode[];
    bestPath: { path: number[]; totalReturn: number };
    alternatives: Array<{ path: number[]; totalReturn: number; whyWorse: string }>;
    iterations: number;
  } | null {
    interface MCTSNode {
      conceptId: string;
      label: string;
      parent: MCTSNode | null;
      children: MCTSNode[];
      visits: number;
      totalReward: number;
      eu: number;
      untried: Array<{ type: ActionType; target?: string; description: string }>;
      depth: number;
      action: ActionType;
      target?: string;
      description: string;
      belief: BeliefState;
      planNodeIdx: number;
    }

    const ITERATIONS = C.mctsIterations;
    const EXPLORE_C = C.mctsExplorationC;
    const PW_EXP = C.mctsProgressiveWidening;
    const MAX_DEPTH = C.plannerMaxDepth;
    const DISCOUNT = C.plannerDiscount;

    const planNodes: PlanNode[] = [];

    // UCB1 score
    const ucb = (node: MCTSNode, parentVisits: number): number => {
      if (node.visits === 0) return Infinity;
      return (node.totalReward / node.visits) + EXPLORE_C * Math.sqrt(Math.log(parentVisits) / node.visits);
    };

    // Create root
    const root: MCTSNode = {
      conceptId: "root",
      label: "root",
      parent: null,
      children: [],
      visits: 0,
      totalReward: 0,
      eu: 0,
      untried: [...rootCandidates],
      depth: 0,
      action: "stay_silent",
      description: "root",
      belief,
      planNodeIdx: -1,
    };

    let iterationsRun = 0;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      iterationsRun++;

      // SELECT: walk tree using UCB1
      let node = root;
      while (node.children.length > 0 && node.untried.length === 0) {
        // Progressive widening: expand if visits^exp > children count
        const maxChildren = Math.ceil(Math.pow(node.visits + 1, PW_EXP));
        if (node.untried.length > 0 && node.children.length < maxChildren) {
          break; // expand instead
        }
        // Pick child with highest UCB
        let best = node.children[0];
        let bestScore = -Infinity;
        for (const child of node.children) {
          const score = ucb(child, node.visits);
          if (score > bestScore) {
            bestScore = score;
            best = child;
          }
        }
        node = best;
      }

      // EXPAND: add one untried child
      if (node.untried.length > 0 && node.depth < MAX_DEPTH) {
        const candidate = node.untried.shift()!;
        const tr = worldModel.transition(node.depth === 0 ? belief : node.belief, candidate.type);
        const selfReturn = selfModel ? selfModel.computeSelfReturn(selfModel.selfTransition(candidate.type as ActionFamily)) : 0;
        const eu = worldModel.computeExpectedUtility(candidate.type, node.depth === 0 ? belief : node.belief, selfReturn) + creditBonus;

        const planNodeIdx = planNodes.length;
        planNodes.push({
          action: candidate.type,
          target: candidate.target,
          description: candidate.description,
          relatedGoalId: goal.id,
          predictedBelief: tr.nextBelief,
          outcomeDistribution: tr.outcomeDistribution,
          expectedUtility: eu,
          depth: node.depth === 0 && node.conceptId === "root" ? 0 : node.depth + 1,
          parentIndex: node.planNodeIdx >= 0 ? node.planNodeIdx : null,
          childIndices: [],
        });

        // Link parent plan node
        if (node.planNodeIdx >= 0) {
          planNodes[node.planNodeIdx].childIndices.push(planNodeIdx);
        }

        // Generate candidate actions for child
        const childCandidates = node.depth + 1 < MAX_DEPTH
          ? generateCandidateActions(goal, tr.nextBelief, tr.nextBelief.internal.csiMode)
          : [];

        const child: MCTSNode = {
          conceptId: `mcts-${planNodeIdx}`,
          label: candidate.description,
          parent: node,
          children: [],
          visits: 0,
          totalReward: 0,
          eu,
          untried: childCandidates,
          depth: node.depth === 0 && node.conceptId === "root" ? 0 : node.depth + 1,
          action: candidate.type,
          target: candidate.target,
          description: candidate.description,
          belief: tr.nextBelief,
          planNodeIdx,
        };

        // Fix: root children are depth 0
        if (node.conceptId === "root") {
          child.depth = 0;
          planNodes[planNodeIdx].depth = 0;
        }

        node.children.push(child);
        node = child;
      }

      // ROLLOUT: policy-weighted rollout using EU × learned weights
      let rolloutReward = node.eu;
      let rolloutBelief = node.belief;
      let rolloutDepth = node.depth;
      const rPolicy = this.state.rolloutPolicy ?? defaultRolloutPolicy();

      while (rolloutDepth < MAX_DEPTH - 1) {
        rolloutDepth++;
        const rolloutCandidates = generateCandidateActions(goal, rolloutBelief, rolloutBelief.internal.csiMode);
        if (rolloutCandidates.length === 0) break;

        let bestCandidate = rolloutCandidates[0];

        // ε-greedy: 10% random exploration
        if (Math.random() < 0.1) {
          bestCandidate = rolloutCandidates[Math.floor(Math.random() * rolloutCandidates.length)];
        } else {
          // Policy-weighted selection: score = EU × actionWeight
          let bestScore = -Infinity;
          for (const c of rolloutCandidates) {
            const sr = selfModel ? selfModel.computeSelfReturn(selfModel.selfTransition(c.type as ActionFamily)) : 0;
            const eu = worldModel.computeExpectedUtility(c.type, rolloutBelief, sr);
            const weight = rPolicy.actionWeights[c.type] ?? 1.0;
            const score = eu * weight;
            if (score > bestScore) {
              bestScore = score;
              bestCandidate = c;
            }
          }
        }

        const bestSR = selfModel ? selfModel.computeSelfReturn(selfModel.selfTransition(bestCandidate.type as ActionFamily)) : 0;
        const bestEU = worldModel.computeExpectedUtility(bestCandidate.type, rolloutBelief, bestSR);
        rolloutReward += Math.pow(DISCOUNT, rolloutDepth) * bestEU;
        rolloutBelief = worldModel.transition(rolloutBelief, bestCandidate.type).nextBelief;
      }

      // BACKPROPAGATE
      let backNode: MCTSNode | null = node;
      while (backNode !== null) {
        backNode.visits++;
        backNode.totalReward += rolloutReward;
        backNode = backNode.parent;
      }
    }

    // Extract best path: greedy walk from root following highest avg reward
    const extractBestPath = (): { path: number[]; totalReturn: number } => {
      const path: number[] = [];
      let totalReturn = 0;
      let current = root;

      while (current.children.length > 0) {
        let best = current.children[0];
        let bestAvg = -Infinity;
        for (const child of current.children) {
          const avg = child.visits > 0 ? child.totalReward / child.visits : 0;
          if (avg > bestAvg) {
            bestAvg = avg;
            best = child;
          }
        }
        current = best;
        if (current.planNodeIdx >= 0) {
          path.push(current.planNodeIdx);
          totalReturn += Math.pow(DISCOUNT, current.depth) * current.eu;
        }
      }

      return { path, totalReturn };
    };

    const bestPathResult = extractBestPath();

    // Extract alternatives (2nd and 3rd best root children)
    const altPaths: Array<{ path: number[]; totalReturn: number; whyWorse: string }> = [];
    if (root.children.length > 1) {
      const sorted = [...root.children].sort((a, b) => {
        const avgA = a.visits > 0 ? a.totalReward / a.visits : 0;
        const avgB = b.visits > 0 ? b.totalReward / b.visits : 0;
        return avgB - avgA;
      });
      for (const alt of sorted.slice(1, 4)) {
        if (alt.planNodeIdx < 0) continue;
        const euGap = bestPathResult.totalReturn - (alt.visits > 0 ? alt.totalReward / alt.visits : 0);
        const whyWorse = euGap > 0.5
          ? `path ${alt.action} is ${euGap.toFixed(2)} EU lower than the best path`
          : `path ${alt.action} is close to the best path (${euGap.toFixed(2)} EU gap)`;
        altPaths.push({
          path: [alt.planNodeIdx],
          totalReturn: alt.visits > 0 ? alt.totalReward / alt.visits : 0,
          whyWorse,
        });
      }
    }

    return {
      planNodes,
      bestPath: bestPathResult,
      alternatives: altPaths,
      iterations: iterationsRun,
    };
  }

  // ── Beam search (fallback) ───────────────────────────────────

  private beamSearch(
    goal: GoalForPlanning,
    belief: BeliefState,
    worldModel: WorldModel,
    candidates: Array<{ type: ActionType; target?: string; description: string }>,
    creditBonus: number,
    selfModel?: SelfModel,
  ): {
    planNodes: PlanNode[];
    bestPath: { path: number[]; totalReturn: number };
    alternatives: Array<{ path: number[]; totalReturn: number; whyWorse: string }>;
  } | null {
    const BEAM_WIDTH = C.plannerBeamWidth;
    const MAX_DEPTH = C.plannerMaxDepth;
    const NODE_BUDGET = C.plannerNodeBudget;

    const allNodes: PlanNode[] = [];
    let nodesExpanded = 0;

    const beam: number[][] = [[]];
    const depth0Indices: number[] = [];

    for (const candidate of candidates) {
      if (nodesExpanded >= NODE_BUDGET) break;

      const tr = worldModel.transition(belief, candidate.type);
      const sr0 = selfModel ? selfModel.computeSelfReturn(selfModel.selfTransition(candidate.type as ActionFamily)) : 0;
      const eu = worldModel.computeExpectedUtility(candidate.type, belief, sr0) + creditBonus;

      const nodeIdx = allNodes.length;
      allNodes.push({
        action: candidate.type,
        target: candidate.target,
        description: candidate.description,
        relatedGoalId: goal.id,
        predictedBelief: tr.nextBelief,
        outcomeDistribution: tr.outcomeDistribution,
        expectedUtility: eu,
        depth: 0,
        parentIndex: null,
        childIndices: [],
      });
      depth0Indices.push(nodeIdx);
      nodesExpanded++;
    }

    beam[0] = depth0Indices;

    for (let d = 1; d < MAX_DEPTH && nodesExpanded < NODE_BUDGET; d++) {
      const parentIndices = beam[d - 1]
        .sort((a, b) => allNodes[b].expectedUtility - allNodes[a].expectedUtility)
        .slice(0, BEAM_WIDTH);

      const depthIndices: number[] = [];

      for (const parentIdx of parentIndices) {
        const parentNode = allNodes[parentIdx];
        const parentCandidates = generateCandidateActions(
          goal, parentNode.predictedBelief, parentNode.predictedBelief.internal.csiMode,
        );

        for (const candidate of parentCandidates.slice(0, BEAM_WIDTH)) {
          if (nodesExpanded >= NODE_BUDGET) break;

          const tr = worldModel.transition(parentNode.predictedBelief, candidate.type);
          const srD = selfModel ? selfModel.computeSelfReturn(selfModel.selfTransition(candidate.type as ActionFamily)) : 0;
          const eu = worldModel.computeExpectedUtility(candidate.type, parentNode.predictedBelief, srD);

          const nodeIdx = allNodes.length;
          allNodes.push({
            action: candidate.type,
            target: candidate.target,
            description: candidate.description,
            relatedGoalId: goal.id,
            predictedBelief: tr.nextBelief,
            outcomeDistribution: tr.outcomeDistribution,
            expectedUtility: eu,
            depth: d,
            parentIndex: parentIdx,
            childIndices: [],
          });

          parentNode.childIndices.push(nodeIdx);
          depthIndices.push(nodeIdx);
          nodesExpanded++;
        }
      }

      beam[d] = depthIndices;
    }

    const paths = this.tracePaths(allNodes);
    if (paths.length === 0) return null;

    paths.sort((a, b) => b.totalReturn - a.totalReturn);
    const bestPathResult = paths[0];
    const alts = paths.slice(1, 4).map(p => {
      const euGap = bestPathResult.totalReturn - p.totalReturn;
      const altActions = p.path.map(i => allNodes[i]?.action ?? "?").join("→");
      const bestActions = bestPathResult.path.map(i => allNodes[i]?.action ?? "?").join("→");
      const whyWorse = euGap > 0.5
        ? `path ${altActions} is ${euGap.toFixed(2)} EU lower than ${bestActions} (higher risk or lower reward)`
        : `path ${altActions} is close to the best path (${euGap.toFixed(2)} EU gap)`;
      return { path: p.path, totalReturn: p.totalReturn, whyWorse };
    });

    return { planNodes: allNodes, bestPath: bestPathResult, alternatives: alts };
  }

  // ── Plan execution ─────────────────────────────────────────────

  advancePlan(planId: string, outcome: "positive" | "negative" | "neutral"): void {
    const plan = this.state.activePlans.find(p => p.id === planId);
    if (!plan) return;

    if (outcome === "positive") {
      plan.currentStepIndex++;
      if (plan.currentStepIndex >= plan.bestPath.length) {
        plan.status = "completed";
        this.archivePlan(plan);
      }
    } else if (outcome === "negative") {
      // Track consecutive failures
      plan.status = "replanning";
    }

    this.save();
  }

  replanIfNeeded(
    goals: GoalForPlanning[],
    belief: BeliefState,
    worldModel: WorldModel,
    selfModel?: SelfModel,
  ): Plan | null {
    const replanning = this.state.activePlans.filter(p => p.status === "replanning");
    if (replanning.length === 0) return null;

    const plan = replanning[0];
    // Archive and remove the failed plan
    this.state.activePlans = this.state.activePlans.filter(p => p.id !== plan.id);
    this.archivePlan(plan);

    // Find the original goal
    const goal = goals.find(g => g.id === plan.goalId);
    if (!goal) {
      this.save();
      return null;
    }

    // Bypass interval check for re-planning
    const savedLastPlanAt = this.state.lastPlanAt;
    this.state.lastPlanAt = 0;
    const newPlan = this.generatePlan(goal, belief, worldModel, undefined, selfModel);
    if (!newPlan) {
      this.state.lastPlanAt = savedLastPlanAt;
    }

    log.info(`replanned goal "${goal.description}": ${newPlan ? "success" : "failed"}`);
    return newPlan;
  }

  abandonStalePlans(): void {
    const now = this.clock.nowMs();
    for (const plan of this.state.activePlans) {
      if (now - plan.createdAt > C.plannerTimeoutMs) {
        plan.status = "abandoned";
        this.archivePlan(plan);
      }
    }
    this.state.activePlans = this.state.activePlans.filter(
      p => p.status === "active" || p.status === "replanning",
    );
    this.save();
  }

  // ── Counterfactual bias ──────────────────────────────────────────

  applyCounterfactualBias(regretByAction: Record<string, number>): void {
    for (const [action, regret] of Object.entries(regretByAction)) {
      // Actions with high regret get penalized
      counterfactualBias[action] = (counterfactualBias[action] ?? 0) - regret * 0.1;
    }
    log.info(`counterfactual bias applied: ${Object.entries(counterfactualBias).map(([a, b]) => `${a}=${b > 0 ? "+" : ""}${b.toFixed(3)}`).join(", ")}`);
  }

  // ── ActionPreference computation ───────────────────────────────

  computeActionPreference(
    graphState: { avgU: number; avgD: number; avgV: number; avgF: number; energyUtil: number },
  ): ActionPreference {
    const pref: ActionPreference = {
      explore: 0,
      reach_out: 0,
      post: 0,
      activity: 0,
      reflect: 0,
      rest: 0,
    };

    // From graph state
    if (graphState.avgU > 0.5) pref.explore += 0.3;
    if (graphState.avgD > 0.4) pref.activity += 0.3;
    if (Math.abs(graphState.avgV) > 0.3) pref.post += 0.2;
    if (graphState.avgF > 0.4 || graphState.energyUtil < 0.3) pref.rest += 0.3;

    // Apply counterfactual bias from past regret analysis
    for (const [action, bias] of Object.entries(counterfactualBias)) {
      if (action in pref) {
        (pref as unknown as Record<string, number>)[action] += bias;
      }
    }

    // From active plans: bias toward current step
    for (const plan of this.state.activePlans) {
      if (plan.status !== "active" || plan.currentStepIndex >= plan.bestPath.length) continue;
      const currentNode = plan.nodes[plan.bestPath[plan.currentStepIndex]];
      if (!currentNode) continue;

      const action = currentNode.action;
      if (action in pref) {
        (pref as unknown as Record<string, number>)[action] += 0.3;
      }
    }

    return pref;
  }

  evaluateCurrentPlan(belief: BeliefState): number {
    // Return EU of best active plan, or 0 if none
    if (this.state.activePlans.length === 0) return 0;
    return Math.max(...this.state.activePlans.map(p => p.totalReturn), 0);
  }

  // ── Internal ───────────────────────────────────────────────────

  private tracePaths(
    nodes: PlanNode[],
  ): Array<{ path: number[]; totalReturn: number }> {
    const paths: Array<{ path: number[]; totalReturn: number }> = [];
    const DISCOUNT = C.plannerDiscount;

    // Find all leaf nodes (no children)
    const leaves = nodes
      .map((n, i) => ({ node: n, idx: i }))
      .filter(({ node }) => node.childIndices.length === 0);

    for (const { idx } of leaves) {
      const path: number[] = [];
      let current = idx;
      let totalReturn = 0;

      while (current !== -1 && current !== null && current !== undefined) {
        path.unshift(current);
        const node = nodes[current];
        totalReturn += Math.pow(DISCOUNT, node.depth) * node.expectedUtility;
        current = node.parentIndex as number;
      }

      paths.push({ path, totalReturn });
    }

    return paths;
  }

  private updateRolloutPolicy(bestPathNodes: PlanNode[], bestPathReturn: number): void {
    if (!this.state.rolloutPolicy) this.state.rolloutPolicy = defaultRolloutPolicy();
    const policy = this.state.rolloutPolicy;
    const lr = 0.01;

    // Compute average return for normalization
    const avgReturn = bestPathNodes.length > 0
      ? bestPathNodes.reduce((s, n) => s + n.expectedUtility, 0) / bestPathNodes.length
      : 1;
    const normalizedReturn = avgReturn > 0 ? bestPathReturn / (avgReturn * bestPathNodes.length || 1) : 1;

    for (const node of bestPathNodes) {
      const w = policy.actionWeights[node.action] ?? 1.0;
      policy.actionWeights[node.action] = Math.max(0.5, Math.min(2.0, w + lr * normalizedReturn));
    }

    // Normalize weights to mean = 1.0
    const keys = Object.keys(policy.actionWeights);
    const sum = keys.reduce((s, k) => s + policy.actionWeights[k], 0);
    const mean = sum / keys.length;
    if (mean > 0) {
      for (const k of keys) policy.actionWeights[k] /= mean;
    }

    policy.updateCount++;
  }

  private archivePlan(plan: Plan): void {
    this.state.planHistory.push(plan);
    if (this.state.planHistory.length > 20) this.state.planHistory.shift();
  }

  private save(): void {
    // Evict stale plan cache entries (>4 hours, max 20)
    if (this.state.planCache) {
      const FOUR_HOURS = 4 * 60 * 60 * 1000;
      const now = this.clock.nowMs();
      this.state.planCache = this.state.planCache
        .filter(e => (now - e.createdAt) < FOUR_HOURS)
        .slice(-20);
    }
    writeJsonAtomic(
      path.join(this.dataPath, "brainstem", "plans.json"),
      this.state,
    );
  }

  private load(): PlannerState {
    return readJsonSafe<PlannerState>(
      path.join(this.dataPath, "brainstem", "plans.json"),
      {
        activePlans: [],
        planHistory: [],
        lastPlanAt: 0,
        llmCallsToday: 0,
        lastLlmDay: 0,
      },
    );
  }
}
