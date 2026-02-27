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

export interface Goal {
  id: string;
  description: string;
  category: "learning" | "project" | "social" | "health" | "personal";
  status: "active" | "completed" | "abandoned";
  progress: number; // 0-1
  milestones: Array<{ description: string; completed: boolean; completedAt?: number }>;
  motivation: string;
  createdAt: number;
  updatedAt: number;
}

interface GoalState {
  goals: Goal[];
}

let dataPath = "";

export function initGoals(statePath: string): void {
  dataPath = statePath;
}

function getStatePath(): string {
  return path.join(dataPath, "goals.json");
}

function loadState(): GoalState {
  return readJsonSafe<GoalState>(getStatePath(), { goals: [] });
}

function saveState(state: GoalState): void {
  if (!dataPath) return;
  writeJsonAtomic(getStatePath(), state);
}

export function getGoals(): Goal[] {
  return loadState().goals;
}

export function getActiveGoals(): Goal[] {
  return loadState().goals.filter(g => g.status === "active");
}

export function addGoal(goal: Omit<Goal, "id" | "createdAt" | "updatedAt" | "status">): Goal {
  const state = loadState();
  const newGoal: Goal = {
    ...goal,
    id: String(Date.now()),
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.goals.push(newGoal);
  saveState(state);
  log.info(`goal added: ${newGoal.description} (${newGoal.category})`);
  return newGoal;
}

export function updateGoalProgress(goalId: string, progress: number, milestoneIndex?: number): void {
  const state = loadState();
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

  saveState(state);
}

export function abandonGoal(goalId: string): void {
  const state = loadState();
  const goal = state.goals.find(g => g.id === goalId);
  if (!goal) return;
  goal.status = "abandoned";
  goal.updatedAt = Date.now();
  saveState(state);
}

export function formatGoalContext(): string {
  const goals = getActiveGoals();
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
