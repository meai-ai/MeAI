/**
 * Goal tracking — gives the character motivations and direction.
 *
 * Tracks active goals across categories, progress, milestones.
 * Goals feed into:
 * 1. activities.ts — checks goals before picking activity type
 * 2. heartbeat.ts — includes goal summary in vitals
 * 3. context.ts — injected into system prompt for natural references
 */

import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import path from "node:path";
import { createLogger } from "./lib/logger.js";
import { s } from "./character.js";

const log = createLogger("goals");

export type GoalHealthStatus = "healthy" | "stalled" | "obsessive";

export type GoalLevel = "life" | "project" | "task";

export interface Goal {
  id: string;
  description: string;
  category: "learning" | "project" | "social" | "health" | "personal";
  status: "active" | "completed" | "abandoned" | "backlog";
  progress: number; // 0-1
  milestones: Array<{ description: string; completed: boolean; completedAt?: number }>;
  motivation: string;
  createdAt: number;
  updatedAt: number;
  origin?: "reflect" | "self_generated";
  priority?: number;           // 0-1
  investment?: number;         // cumulative minutes
  lastAlignedAction?: number;
  relatedTopics?: string[];
  // ── Hierarchy ──
  parentGoalId?: string;       // parent goal ID (null for top-level)
  childGoalIds?: string[];     // child goal IDs
  goalLevel?: GoalLevel;
}

interface GoalState {
  goals: Goal[];
}

// ── Class ────────────────────────────────────────────────────────────

export class GoalsEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  private getStatePath(): string {
    return path.join(this.dataPath, "goals.json");
  }

  private loadState(): GoalState {
    return readJsonSafe<GoalState>(this.getStatePath(), { goals: [] });
  }

  private saveState(state: GoalState): void {
    if (!this.dataPath) return;
    writeJsonAtomic(this.getStatePath(), state);
  }

  getGoals(): Goal[] {
    return this.loadState().goals;
  }

  getActiveGoals(): Goal[] {
    return this.loadState().goals.filter(g => g.status === "active");
  }

  addGoal(goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status">): Goal {
    const state = this.loadState();
    const newGoal: Goal = {
      ...goal,
      id: String(Date.now()),
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.goals.push(newGoal);
    this.saveState(state);
    log.info(`goal added: ${newGoal.description} (${newGoal.category})`);
    return newGoal;
  }

  updateGoalProgress(goalId: string, progress: number, milestoneIndex?: number): void {
    const state = this.loadState();
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal) return;

    goal.progress = Math.max(0, Math.min(1, progress));
    goal.updatedAt = Date.now();

    if (milestoneIndex !== undefined && goal.milestones[milestoneIndex]) {
      goal.milestones[milestoneIndex].completed = true;
      goal.milestones[milestoneIndex].completedAt = Date.now();
    }

    // Auto-complete if all milestones done
    if (goal.milestones.length > 0 && goal.milestones.every(m => m.completed)) {
      goal.status = "completed";
      goal.progress = 1;
    }

    this.saveState(state);

    // Bottom-up: propagate to parent
    if (goal.parentGoalId) this.propagateProgress(goalId);
  }

  abandonGoal(goalId: string): void {
    const state = this.loadState();
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal) return;
    goal.status = "abandoned";
    goal.updatedAt = Date.now();
    this.saveState(state);
  }

  /** Record investment time on a goal. */
  recordGoalInvestment(goalId: string, minutes: number): void {
    const state = this.loadState();
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal) return;
    goal.investment = (goal.investment ?? 0) + minutes;
    goal.lastAlignedAction = Date.now();
    goal.updatedAt = Date.now();
    this.saveState(state);
    log.info(`goal investment: ${goal.description} +${minutes}min (total: ${goal.investment}min)`);
  }

  /** Compute health status for a goal. */
  getGoalHealth(goal: Goal): GoalHealthStatus {
    const investment = goal.investment ?? 0;
    // Stalled: lots of time, no progress
    if (investment > 120 && goal.progress < 0.1) return "stalled";
    // Obsessive: single goal consuming >60% of total investment
    const allGoals = this.getActiveGoals();
    const totalInvestment = allGoals.reduce((sum, g) => sum + (g.investment ?? 0), 0);
    if (totalInvestment > 0 && investment > 300 && investment / totalInvestment > 0.6) return "obsessive";
    return "healthy";
  }

  /** Get the strongest intrinsic drive signal. */
  getDriveSignal(): { topDrive: Goal | null; driveStrength: number } {
    const goals = this.getActiveGoals().filter(g => g.origin === "self_generated");
    if (goals.length === 0) return { topDrive: null, driveStrength: 0 };

    const now = Date.now();
    const scored = goals.map(g => {
      const priority = g.priority ?? 0.5;
      const remaining = 1 - g.progress;
      const daysSinceUpdate = (now - g.updatedAt) / (24 * 60 * 60 * 1000);
      const recencyDecay = Math.exp(-daysSinceUpdate / 14); // 14-day half-life
      let score = priority * remaining * recencyDecay;

      // Suppress stalled/obsessive goals
      const health = this.getGoalHealth(g);
      if (health !== "healthy") score *= 0.3;

      return { goal: g, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return { topDrive: scored[0]?.goal ?? null, driveStrength: scored[0]?.score ?? 0 };
  }

  /** Get children of a goal. */
  getChildGoals(parentId: string): Goal[] {
    return this.loadState().goals.filter(g => g.parentGoalId === parentId && g.status === "active");
  }

  /** Propagate child progress up to parent (bottom-up). */
  propagateProgress(childGoalId: string): void {
    const state = this.loadState();
    const child = state.goals.find(g => g.id === childGoalId);
    if (!child?.parentGoalId) return;

    const parent = state.goals.find(g => g.id === child.parentGoalId);
    if (!parent) return;

    const siblings = state.goals.filter(g => g.parentGoalId === parent.id && g.status !== "abandoned");
    if (siblings.length === 0) return;

    parent.progress = siblings.reduce((s, g) => s + g.progress, 0) / siblings.length;
    parent.updatedAt = Date.now();

    // Auto-complete parent if all children done
    if (siblings.every(g => g.status === "completed")) {
      parent.status = "completed";
      parent.progress = 1;
    }

    this.saveState(state);

    // Recurse up the hierarchy
    if (parent.parentGoalId) this.propagateProgress(parent.id);
  }

  /** Add a child goal under a parent. Enforces budget. */
  addChildGoal(
    parentId: string,
    goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status" | "parentGoalId" | "goalLevel">,
  ): Goal | null {
    const state = this.loadState();
    const parent = state.goals.find(g => g.id === parentId);
    if (!parent) return null;

    const childLevel: GoalLevel = parent.goalLevel === "life" ? "project" : "task";
    const budget = { life: 3, project: 5, task: 15 } as const;
    const activeAtLevel = state.goals.filter(g => g.goalLevel === childLevel && g.status === "active");
    if (activeAtLevel.length >= budget[childLevel]) {
      log.warn(`goal budget exceeded for level ${childLevel} (${activeAtLevel.length}/${budget[childLevel]})`);
      return null;
    }

    const newGoal: Goal = {
      ...goal,
      id: String(Date.now()),
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentGoalId: parentId,
      goalLevel: childLevel,
    };

    // Link parent -> child
    if (!parent.childGoalIds) parent.childGoalIds = [];
    parent.childGoalIds.push(newGoal.id);

    state.goals.push(newGoal);
    this.saveState(state);
    log.info(`child goal added: ${newGoal.description} under ${parent.description}`);
    return newGoal;
  }

  formatGoalContext(): string {
    const goals = this.getActiveGoals();
    if (goals.length === 0) return "";

    const lines = goals.map(g => {
      const progressPct = Math.round(g.progress * 100);
      const milestonesDone = g.milestones.filter(m => m.completed).length;
      const milestonesTotal = g.milestones.length;
      const milestoneStr = milestonesTotal > 0 ? ` (${milestonesDone}/${milestonesTotal} milestones)` : "";
      const investMin = g.investment ?? 0;
      const investStr = investMin > 60 ? ", significant time invested" : "";
      const health = this.getGoalHealth(g);
      const healthStr = health === "stalled" ? " (feels stuck, no progress)"
        : health === "obsessive" ? " (spending too much time on this)" : "";
      return `- [${g.category}] ${g.description}: ${progressPct}%${milestoneStr}${investStr}${healthStr}`;
    });

    return `${s().headers.current_goals}:\n${lines.join("\n")}`;
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: GoalsEngine | null = null;

export function initGoals(statePath: string): GoalsEngine {
  _singleton = new GoalsEngine(statePath);
  return _singleton;
}

function _get(): GoalsEngine {
  if (!_singleton) throw new Error("initGoals() not called");
  return _singleton;
}

export function getGoals(): Goal[] { return _get().getGoals(); }
export function getActiveGoals(): Goal[] { return _get().getActiveGoals(); }
export function addGoal(goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status">): Goal { return _get().addGoal(goal); }
export function updateGoalProgress(goalId: string, progress: number, milestoneIndex?: number): void { _get().updateGoalProgress(goalId, progress, milestoneIndex); }
export function abandonGoal(goalId: string): void { _get().abandonGoal(goalId); }
export function formatGoalContext(): string { return _get().formatGoalContext(); }
export function recordGoalInvestment(goalId: string, minutes: number): void { _get().recordGoalInvestment(goalId, minutes); }
export function getDriveSignal(): { topDrive: Goal | null; driveStrength: number } { return _get().getDriveSignal(); }
export function getGoalHealth(goal: Goal): GoalHealthStatus { return _get().getGoalHealth(goal); }
export function getChildGoals(parentId: string): Goal[] { return _get().getChildGoals(parentId); }
export function propagateProgress(childGoalId: string): void { _get().propagateProgress(childGoalId); }
export function addChildGoal(
  parentId: string,
  goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status" | "parentGoalId" | "goalLevel">,
): Goal | null { return _get().addChildGoal(parentId, goal); }

/** Review stale/orphaned goals (called during wake-up consolidation). */
export function reviewGoals(): { stalled: string[]; orphaned: string[]; demoted: string[] } {
  const engine = _get();
  const goals = engine.getGoals();
  const now = Date.now();
  const stalled: string[] = [];
  const orphaned: string[] = [];
  const demoted: string[] = [];

  for (const goal of goals) {
    if (goal.status !== "active") continue;

    // Stalled > 14 days
    const lastAction = goal.lastAlignedAction ?? goal.updatedAt;
    const daysSinceAction = (now - lastAction) / 86_400_000;
    if (daysSinceAction > 14 && goal.progress < 0.9) {
      goal.priority = Math.max(0, (goal.priority ?? 0.5) - 0.2);
      goal.updatedAt = now;
      stalled.push(goal.id);
    }

    // Orphan: parent completed/abandoned -> auto-complete child
    if (goal.parentGoalId) {
      const parent = goals.find(g => g.id === goal.parentGoalId);
      if (parent && (parent.status === "completed" || parent.status === "abandoned")) {
        goal.status = parent.status;
        goal.updatedAt = now;
        orphaned.push(goal.id);
      }
    }
  }

  // Enforce active budget per level
  const BUDGET: Record<string, number> = { life: 3, project: 5, task: 15 };
  for (const level of ["project", "task"] as GoalLevel[]) {
    const active = goals
      .filter(g => g.goalLevel === level && g.status === "active")
      .sort((a, b) => {
        const sa = (a.priority ?? 0.5) * (1 - a.progress);
        const sb = (b.priority ?? 0.5) * (1 - b.progress);
        return sb - sa;
      });

    if (active.length > BUDGET[level]) {
      for (const g of active.slice(BUDGET[level])) {
        g.status = "backlog";
        g.updatedAt = now;
        demoted.push(g.id);
      }
    }
  }

  return { stalled, orphaned, demoted };
}
