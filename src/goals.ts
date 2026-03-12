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
  relatedTopics?: string[];
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
  }

  abandonGoal(goalId: string): void {
    const state = this.loadState();
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal) return;
    goal.status = "abandoned";
    goal.updatedAt = Date.now();
    this.saveState(state);
  }

  formatGoalContext(): string {
    const goals = this.getActiveGoals();
    if (goals.length === 0) return "";

    const lines = goals.map(g => {
      const progressPct = Math.round(g.progress * 100);
      const milestonesDone = g.milestones.filter(m => m.completed).length;
      const milestonesTotal = g.milestones.length;
      const milestoneStr = milestonesTotal > 0 ? `（${milestonesDone}/${milestonesTotal} milestones）` : "";
      return `- [${g.category}] ${g.description}: ${progressPct}%${milestoneStr}`;
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

/** Review stale/orphaned goals (called during wake-up consolidation). */
export function reviewGoals(): { stalled: string[]; orphaned: string[]; demoted: string[] } {
  const goals = _get().getGoals();
  const now = Date.now();
  const stalled: string[] = [];
  const orphaned: string[] = [];
  const demoted: string[] = [];

  for (const goal of goals) {
    if (goal.status !== "active") continue;

    // Stalled > 14 days
    const lastAction = goal.updatedAt;
    const daysSinceAction = (now - lastAction) / 86_400_000;
    if (daysSinceAction > 14 && goal.progress < 0.9) {
      goal.priority = Math.max(0, (goal.priority ?? 0.5) - 0.2);
      goal.updatedAt = now;
      stalled.push(goal.id);
    }
  }

  return { stalled, orphaned, demoted };
}
