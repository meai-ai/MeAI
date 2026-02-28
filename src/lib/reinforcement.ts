/**
 * Reinforcement learning — tracks satisfaction and habit strength.
 *
 * Per-activity EWMA satisfaction, frequency tracking, streaks.
 * Used by heartbeat to bias activity selection toward satisfying patterns.
 */

import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { pstDateStr } from "./pst-date.js";
import path from "node:path";

export interface ActivityRecord {
  ewmaSatisfaction: number;   // EWMA (exponential weighted moving average) 0-10
  count30d: number;           // count in last 30 days
  lastDone: number;           // timestamp
  streak: number;             // consecutive days
  lastStreakDate: string;     // ISO date of last streak update
}

export interface ReinforcementState {
  activities: Record<string, ActivityRecord>;
  boredom: Record<string, number>;  // repetition count in last 24h
  lastBoredomReset: number;
}

const EWMA_ALPHA = 0.3; // Smoothing factor — higher = more weight on recent

// ── ReinforcementEngine class ────────────────────────────────────────

export class ReinforcementEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  private getStatePath(): string {
    return path.join(this.dataPath, "reinforcement.json");
  }

  private loadState(): ReinforcementState {
    return readJsonSafe<ReinforcementState>(this.getStatePath(), {
      activities: {},
      boredom: {},
      lastBoredomReset: Date.now(),
    });
  }

  private saveState(state: ReinforcementState): void {
    if (!this.dataPath) return;
    writeJsonAtomic(this.getStatePath(), state);
  }

  /**
   * Record satisfaction after an activity.
   * @param activityType e.g. "explore", "post", "activity", "reach_out"
   * @param satisfaction 0-10 rating
   */
  recordSatisfaction(activityType: string, satisfaction: number): void {
    const state = this.loadState();
    const today = pstDateStr();

    if (!state.activities[activityType]) {
      state.activities[activityType] = {
        ewmaSatisfaction: satisfaction,
        count30d: 0,
        lastDone: Date.now(),
        streak: 0,
        lastStreakDate: "",
      };
    }

    const record = state.activities[activityType];

    // Update EWMA
    record.ewmaSatisfaction = EWMA_ALPHA * satisfaction + (1 - EWMA_ALPHA) * record.ewmaSatisfaction;
    record.count30d++;
    record.lastDone = Date.now();

    // Update streak
    if (record.lastStreakDate === today) {
      // Already counted today
    } else {
      const yesterday = pstDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
      record.streak = record.lastStreakDate === yesterday ? record.streak + 1 : 1;
      record.lastStreakDate = today;
    }

    // Update boredom tracking
    state.boredom[activityType] = (state.boredom[activityType] ?? 0) + 1;

    // Reset boredom counters every 24h
    if (Date.now() - state.lastBoredomReset > 24 * 60 * 60 * 1000) {
      state.boredom = {};
      state.lastBoredomReset = Date.now();
    }

    this.saveState(state);
  }

  /**
   * Get activity selection bias based on satisfaction history.
   * Higher satisfaction + habit strength = higher weight.
   * Returns a Record<string, number> of relative weights.
   */
  getActivityBias(): Record<string, number> {
    const state = this.loadState();
    const bias: Record<string, number> = {};

    for (const [type, record] of Object.entries(state.activities)) {
      // Base weight from satisfaction (0-10 -> 0.5-1.5)
      const satisfactionWeight = 0.5 + (record.ewmaSatisfaction / 10);
      // Streak bonus (up to 0.3)
      const streakBonus = Math.min(0.3, record.streak * 0.05);
      // Boredom penalty (repetition in 24h)
      const boredomCount = state.boredom[type] ?? 0;
      const boredomPenalty = Math.min(0.5, boredomCount * 0.15);

      bias[type] = Math.max(0.1, satisfactionWeight + streakBonus - boredomPenalty);
    }

    return bias;
  }

  /**
   * Get burnout risk (0-1) based on recent activity patterns.
   */
  getBurnoutRisk(): number {
    const state = this.loadState();
    let totalRecent = 0;

    for (const record of Object.values(state.activities)) {
      if (Date.now() - record.lastDone < 7 * 24 * 60 * 60 * 1000) {
        totalRecent += record.count30d;
      }
    }

    // High activity + declining satisfaction = burnout risk
    if (totalRecent > 50) return Math.min(1, (totalRecent - 50) / 50);
    return 0;
  }

  /**
   * Get novelty score — how much the system craves new experiences.
   * Higher when recent activities are repetitive.
   */
  getNoveltyScore(): number {
    const state = this.loadState();
    const totalBoredom = Object.values(state.boredom).reduce((sum, n) => sum + n, 0);
    return Math.min(1, totalBoredom / 10);
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: ReinforcementEngine | null = null;

export function initReinforcement(statePath: string): ReinforcementEngine {
  _singleton = new ReinforcementEngine(statePath);
  return _singleton;
}

export function recordSatisfaction(activityType: string, satisfaction: number): void {
  _singleton!.recordSatisfaction(activityType, satisfaction);
}

export function getActivityBias(): Record<string, number> {
  return _singleton!.getActivityBias();
}

export function getBurnoutRisk(): number {
  return _singleton!.getBurnoutRisk();
}

export function getNoveltyScore(): number {
  return _singleton!.getNoveltyScore();
}
