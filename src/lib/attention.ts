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

let dataPath = "";

export function initAttention(statePath: string): void {
  dataPath = statePath;
}

function getStatePath(): string {
  return path.join(dataPath, "attention.json");
}

function loadState(): AttentionState {
  return readJsonSafe<AttentionState>(getStatePath(), {
    currentActivityStart: 0,
    currentActivityType: null,
    flowState: false,
    flowStartedAt: 0,
    lastTransition: Date.now(),
    decisionsToday: 0,
    decisionsDate: pstDateStr(),
  });
}

function saveState(state: AttentionState): void {
  if (!dataPath) return;
  writeJsonAtomic(getStatePath(), state);
}

const ULTRADIAN_CYCLE_MIN = 90;  // 90-minute focus cycle
const ATTENTION_RESIDUE_MIN = 20; // time for attention residue to decay
const FLOW_THRESHOLD_MIN = 25;    // minutes of focused work before flow state

/**
 * Record the start of a new activity.
 */
export function startActivity(activityType: string): void {
  const state = loadState();
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
  saveState(state);
}

/**
 * Check if currently in flow state (should not be interrupted).
 */
export function isInFlowState(): boolean {
  const state = loadState();
  if (!state.currentActivityStart) return false;

  const minutesActive = (Date.now() - state.currentActivityStart) / (60 * 1000);

  // Enter flow after sustained focus
  if (minutesActive >= FLOW_THRESHOLD_MIN && !state.flowState) {
    state.flowState = true;
    state.flowStartedAt = Date.now();
    saveState(state);
  }

  return state.flowState;
}

/**
 * Get position in the ultradian (90-min) cycle. 0-1.
 * 0 = just started, 0.5 = mid-cycle, 1.0 = cycle complete (needs break).
 */
export function getUltradianPosition(): number {
  const state = loadState();
  if (!state.currentActivityStart) return 0;

  const minutesActive = (Date.now() - state.currentActivityStart) / (60 * 1000);
  return Math.min(1, minutesActive / ULTRADIAN_CYCLE_MIN);
}

/**
 * Get attention residue — lingering cognitive load from previous task.
 * Decays over ~20 minutes after task switch.
 * Returns 0-1 (0 = clear mind, 1 = full residue).
 */
export function getAttentionResidue(): number {
  const state = loadState();
  const minutesSinceTransition = (Date.now() - state.lastTransition) / (60 * 1000);
  if (minutesSinceTransition >= ATTENTION_RESIDUE_MIN) return 0;
  return 1 - (minutesSinceTransition / ATTENTION_RESIDUE_MIN);
}

/**
 * Get decision fatigue level (0-1).
 * Higher values = more decisions made today = worse decision quality.
 */
export function getDecisionFatigue(): number {
  const state = loadState();
  const today = pstDateStr();
  if (state.decisionsDate !== today) return 0;
  return Math.min(1, state.decisionsToday / 30); // ~30 decisions = full fatigue
}

/**
 * Should the system suggest a break?
 * True if past the ultradian cycle peak.
 */
export function shouldSuggestBreak(): boolean {
  return getUltradianPosition() >= 0.9;
}

/**
 * Format attention context for heartbeat/vitals.
 */
export function formatAttentionContext(): string {
  const parts: string[] = [];
  const position = getUltradianPosition();
  const flow = isInFlowState();
  const residue = getAttentionResidue();
  const fatigue = getDecisionFatigue();

  if (flow) parts.push("In deep focus state");
  if (position > 0.8) parts.push("Nearly 90 minutes of focus, needs a break");
  if (residue > 0.5) parts.push("Attention hasn't fully switched yet");
  if (fatigue > 0.6) parts.push("Made many decisions today, feeling some decision fatigue");

  return parts.length > 0 ? parts.join("; ") : "";
}
