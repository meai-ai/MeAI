/**
 * Attention model — ultradian rhythm, flow state, decision fatigue.
 *
 * Models the 90-minute focus cycle and attention residue.
 * Used by heartbeat to:
 * - Skip reach_out during flow state
 * - Boost rest probability after 90 min continuous activity
 */

import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { pstDateStr } from "./pst-date.js";
import path from "node:path";

export interface AttentionState {
  currentActivityStart: number;  // timestamp when current activity began
  currentActivityType: string | null;
  flowState: boolean;            // true = deeply focused
  flowStartedAt: number;
  lastTransition: number;        // timestamp of last activity change
  decisionsToday: number;        // count of decisions made today
  decisionsDate: string;         // ISO date for reset
}

const ULTRADIAN_CYCLE_MIN = 90;  // 90-minute focus cycle
const ATTENTION_RESIDUE_MIN = 20; // time for attention residue to decay
const FLOW_THRESHOLD_MIN = 25;    // minutes of focused work before flow state

// ── AttentionEngine class ────────────────────────────────────────────

export class AttentionEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  private getStatePath(): string {
    return path.join(this.dataPath, "attention.json");
  }

  private loadState(): AttentionState {
    return readJsonSafe<AttentionState>(this.getStatePath(), {
      currentActivityStart: 0,
      currentActivityType: null,
      flowState: false,
      flowStartedAt: 0,
      lastTransition: Date.now(),
      decisionsToday: 0,
      decisionsDate: pstDateStr(),
    });
  }

  private saveState(state: AttentionState): void {
    if (!this.dataPath) return;
    writeJsonAtomic(this.getStatePath(), state);
  }

  /**
   * Record the start of a new activity.
   */
  startActivity(activityType: string): void {
    const state = this.loadState();
    const today = pstDateStr();

    // Reset daily counters
    if (state.decisionsDate !== today) {
      state.decisionsToday = 0;
      state.decisionsDate = today;
    }

    state.decisionsToday++;
    state.currentActivityStart = Date.now();
    state.currentActivityType = activityType;
    state.flowState = false;
    state.flowStartedAt = 0;
    state.lastTransition = Date.now();
    this.saveState(state);
  }

  /**
   * Check if currently in flow state (should not be interrupted).
   */
  isInFlowState(): boolean {
    const state = this.loadState();
    if (!state.currentActivityStart) return false;

    const minutesActive = (Date.now() - state.currentActivityStart) / (60 * 1000);

    // Enter flow after sustained focus
    if (minutesActive >= FLOW_THRESHOLD_MIN && !state.flowState) {
      state.flowState = true;
      state.flowStartedAt = Date.now();
      this.saveState(state);
    }

    return state.flowState;
  }

  /**
   * Get position in the ultradian (90-min) cycle. 0-1.
   * 0 = just started, 0.5 = mid-cycle, 1.0 = cycle complete (needs break).
   */
  getUltradianPosition(): number {
    const state = this.loadState();
    if (!state.currentActivityStart) return 0;

    const minutesActive = (Date.now() - state.currentActivityStart) / (60 * 1000);
    return Math.min(1, minutesActive / ULTRADIAN_CYCLE_MIN);
  }

  /**
   * Get attention residue — lingering cognitive load from previous task.
   * Decays over ~20 minutes after task switch.
   * Returns 0-1 (0 = clear mind, 1 = full residue).
   */
  getAttentionResidue(): number {
    const state = this.loadState();
    const minutesSinceTransition = (Date.now() - state.lastTransition) / (60 * 1000);
    if (minutesSinceTransition >= ATTENTION_RESIDUE_MIN) return 0;
    return 1 - (minutesSinceTransition / ATTENTION_RESIDUE_MIN);
  }

  /**
   * Get decision fatigue level (0-1).
   * Higher values = more decisions made today = worse decision quality.
   */
  getDecisionFatigue(): number {
    const state = this.loadState();
    const today = pstDateStr();
    if (state.decisionsDate !== today) return 0;
    return Math.min(1, state.decisionsToday / 30); // ~30 decisions = full fatigue
  }

  /**
   * Should the system suggest a break?
   * True if past the ultradian cycle peak.
   */
  shouldSuggestBreak(): boolean {
    return this.getUltradianPosition() >= 0.9;
  }

  /**
   * Format attention context for heartbeat/vitals.
   */
  formatAttentionContext(): string {
    const parts: string[] = [];
    const position = this.getUltradianPosition();
    const flow = this.isInFlowState();
    const residue = this.getAttentionResidue();
    const fatigue = this.getDecisionFatigue();

    if (flow) parts.push("In deep focus state");
    if (position > 0.8) parts.push("Nearly 90 minutes of focus, needs a break");
    if (residue > 0.5) parts.push("Attention hasn't fully switched yet");
    if (fatigue > 0.6) parts.push("Made many decisions today, feeling some decision fatigue");

    return parts.length > 0 ? parts.join("; ") : "";
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: AttentionEngine | null = null;

export function initAttention(statePath: string): AttentionEngine {
  _singleton = new AttentionEngine(statePath);
  return _singleton;
}

export function startActivity(activityType: string): void {
  _singleton!.startActivity(activityType);
}

export function isInFlowState(): boolean {
  return _singleton!.isInFlowState();
}

export function getUltradianPosition(): number {
  return _singleton!.getUltradianPosition();
}

export function getAttentionResidue(): number {
  return _singleton!.getAttentionResidue();
}

export function getDecisionFatigue(): number {
  return _singleton!.getDecisionFatigue();
}

export function shouldSuggestBreak(): boolean {
  return _singleton!.shouldSuggestBreak();
}

export function formatAttentionContext(): string {
  return _singleton!.formatAttentionContext();
}
