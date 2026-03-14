/**
 * Researcher Self-Model — self-efficacy + self-beliefs.
 *
 * Standalone module (no brainstem dependency).
 * Persists to {botDataDir}/self-model.json.
 *
 * Self-Efficacy: Beta-Bernoulli per action family.
 *   P(success | action) = alpha / (alpha + beta)
 *   Starts at prior (alpha=1, beta=1) → 0.5
 *   Success → alpha++, Failure → beta++
 *   Natural recovery: every 24h without activity, drift 0.02 toward 0.5
 *
 * Self-Beliefs: list of beliefs with confidence + half-life decay.
 *   Max 30 beliefs. Floor at 0.15.
 *   Half-life decay: confidence halves every halfLifeDays if not reinforced.
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("self-model");

// ── Types ──────────────────────────────────────────────────────────

export interface EfficacyEntry {
  alpha: number;       // success count + prior
  beta: number;        // failure count + prior
  lastUpdated: number; // timestamp
}

export interface SelfBelief {
  text: string;
  confidence: number;  // 0-1, floor at BELIEF_FLOOR
  halfLifeDays: number;
  lastReinforced: number;
  createdAt: number;
}

export interface SelfModelState {
  efficacy: Record<string, EfficacyEntry>;
  beliefs: SelfBelief[];
  lastRecoveryCheck: number;
}

// ── Constants ──────────────────────────────────────────────────────

const BELIEF_FLOOR = 0.15;
const BELIEF_CAP = 30;
const EFFICACY_RECOVERY_RATE = 0.02; // per 24h toward prior 0.5
const RECOVERY_INTERVAL = 24 * 60 * 60 * 1000;

// ── State ──────────────────────────────────────────────────────────

let _state: SelfModelState = {
  efficacy: {},
  beliefs: [],
  lastRecoveryCheck: Date.now(),
};
let _persistPath = "";

// ── Init / Persist ─────────────────────────────────────────────────

export function initSelfModel(botDataDir: string): void {
  _persistPath = path.join(botDataDir, "self-model.json");
  if (fs.existsSync(_persistPath)) {
    try {
      _state = JSON.parse(fs.readFileSync(_persistPath, "utf-8")) as SelfModelState;
      log.info(`Loaded self-model: ${Object.keys(_state.efficacy).length} efficacy entries, ${_state.beliefs.length} beliefs`);
    } catch {
      log.warn("Failed to load self-model, starting fresh");
    }
  }

  // Run recovery/decay on load
  applyNaturalRecovery();
  applyBeliefDecay();
  persist();

  // Continuous recovery: run every 4 hours during operation
  _recoveryTimer = setInterval(() => {
    applyNaturalRecovery();
    applyBeliefDecay();
    persist();
    log.info("Periodic self-model recovery/decay applied");
  }, 4 * 60 * 60 * 1000);
}

let _recoveryTimer: ReturnType<typeof setInterval> | null = null;

export function stopSelfModel(): void {
  if (_recoveryTimer) {
    clearInterval(_recoveryTimer);
    _recoveryTimer = null;
  }
  persist(); // final save
}

function persist(): void {
  if (!_persistPath) return;
  try {
    const dir = path.dirname(_persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = _persistPath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(_state, null, 2));
    fs.renameSync(tmp, _persistPath);
  } catch (err) {
    log.warn("Failed to persist self-model:", err);
  }
}

// ── Self-Efficacy (Beta-Bernoulli) ─────────────────────────────────

function getOrCreateEfficacy(actionFamily: string): EfficacyEntry {
  if (!_state.efficacy[actionFamily]) {
    _state.efficacy[actionFamily] = { alpha: 1, beta: 1, lastUpdated: Date.now() };
  }
  return _state.efficacy[actionFamily];
}

/** P(success) for an action family */
export function getEfficacy(actionFamily: string): number {
  const e = getOrCreateEfficacy(actionFamily);
  return e.alpha / (e.alpha + e.beta);
}

/** Record a success for an action family */
export function recordSuccess(actionFamily: string): void {
  const e = getOrCreateEfficacy(actionFamily);
  e.alpha += 1;
  e.lastUpdated = Date.now();
  log.info(`Efficacy ${actionFamily}: success → P=${(e.alpha / (e.alpha + e.beta)).toFixed(2)}`);
  persist();
}

/** Record a failure for an action family */
export function recordFailure(actionFamily: string): void {
  const e = getOrCreateEfficacy(actionFamily);
  e.beta += 1;
  e.lastUpdated = Date.now();
  log.info(`Efficacy ${actionFamily}: failure → P=${(e.alpha / (e.alpha + e.beta)).toFixed(2)}`);
  persist();
}

/** Record a partial result (counts as 0.5 success + 0.5 failure) */
export function recordPartial(actionFamily: string): void {
  const e = getOrCreateEfficacy(actionFamily);
  e.alpha += 0.5;
  e.beta += 0.5;
  e.lastUpdated = Date.now();
  persist();
}

/** Get all efficacy scores */
export function getAllEfficacy(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [k, e] of Object.entries(_state.efficacy)) {
    result[k] = e.alpha / (e.alpha + e.beta);
  }
  return result;
}

/** Natural recovery: drift toward prior (0.5) for inactive action families */
function applyNaturalRecovery(): void {
  const now = Date.now();
  const elapsed = now - _state.lastRecoveryCheck;
  if (elapsed < RECOVERY_INTERVAL) return;

  const periods = Math.floor(elapsed / RECOVERY_INTERVAL);
  for (const [family, e] of Object.entries(_state.efficacy)) {
    const inactiveDays = (now - e.lastUpdated) / RECOVERY_INTERVAL;
    if (inactiveDays < 2) continue; // Only recover if inactive >48h

    const currentP = e.alpha / (e.alpha + e.beta);
    const drift = EFFICACY_RECOVERY_RATE * Math.min(periods, 7);
    const targetP = 0.5;
    const newP = currentP + (targetP - currentP) * drift;

    // Adjust alpha/beta to match new probability while keeping total count
    const total = e.alpha + e.beta;
    e.alpha = newP * total;
    e.beta = (1 - newP) * total;
    log.info(`Efficacy ${family}: natural recovery ${currentP.toFixed(2)} → ${newP.toFixed(2)}`);
  }

  _state.lastRecoveryCheck = now;
}

// ── Self-Beliefs ───────────────────────────────────────────────────

/** Seed initial beliefs (only adds if not already present) */
export function seedBeliefs(beliefs: Array<{ text: string; halfLifeDays: number }>): void {
  const now = Date.now();
  for (const b of beliefs) {
    const exists = _state.beliefs.find(existing => existing.text === b.text);
    if (!exists) {
      _state.beliefs.push({
        text: b.text,
        confidence: 0.6, // start moderate
        halfLifeDays: b.halfLifeDays,
        lastReinforced: now,
        createdAt: now,
      });
    }
  }

  // Enforce cap: evict lowest confidence + oldest
  while (_state.beliefs.length > BELIEF_CAP) {
    let worstIdx = 0;
    let worstScore = Infinity;
    for (let i = 0; i < _state.beliefs.length; i++) {
      const score = _state.beliefs[i].confidence + (_state.beliefs[i].lastReinforced / 1e15);
      if (score < worstScore) {
        worstScore = score;
        worstIdx = i;
      }
    }
    _state.beliefs.splice(worstIdx, 1);
  }

  persist();
}

/** Reinforce a belief (increase confidence) */
export function reinforceBelief(text: string, partial = false): void {
  const belief = _state.beliefs.find(b => b.text === text);
  if (!belief) return;

  const boost = partial ? 0.05 : 0.1;
  belief.confidence = Math.min(1.0, belief.confidence + boost);
  belief.lastReinforced = Date.now();
  log.info(`Belief reinforced: "${text}" → ${belief.confidence.toFixed(2)}`);
  persist();
}

/** Weaken a belief (decrease confidence, floor at BELIEF_FLOOR) */
export function weakenBelief(text: string): void {
  const belief = _state.beliefs.find(b => b.text === text);
  if (!belief) return;

  belief.confidence = Math.max(BELIEF_FLOOR, belief.confidence - 0.1);
  log.info(`Belief weakened: "${text}" → ${belief.confidence.toFixed(2)}`);
  persist();
}

/** Get all beliefs */
export function getBeliefs(): SelfBelief[] {
  return [..._state.beliefs];
}

/** Get belief confidence by text (returns null if not found) */
export function getBeliefConfidence(text: string): number | null {
  const belief = _state.beliefs.find(b => b.text === text);
  return belief ? belief.confidence : null;
}

/** Apply half-life decay to all beliefs */
function applyBeliefDecay(): void {
  const now = Date.now();
  for (const belief of _state.beliefs) {
    const daysSinceReinforced = (now - belief.lastReinforced) / (24 * 60 * 60 * 1000);
    if (daysSinceReinforced < 1) continue; // No decay within 24h

    const halfLives = daysSinceReinforced / belief.halfLifeDays;
    const decayFactor = Math.pow(0.5, halfLives);
    const decayed = belief.confidence * decayFactor;
    belief.confidence = Math.max(BELIEF_FLOOR, decayed);
  }
}

// ── Context Formatting (for system prompt) ─────────────────────────

export function formatSelfModelContext(): string {
  const efficacy = getAllEfficacy();
  const beliefs = getBeliefs().filter(b => b.confidence > 0.3);

  if (Object.keys(efficacy).length === 0 && beliefs.length === 0) return "";

  const lines = ["## Self-Awareness"];

  if (Object.keys(efficacy).length > 0) {
    lines.push("Competence levels:");
    for (const [family, p] of Object.entries(efficacy)) {
      const label = p > 0.7 ? "confident" : p > 0.4 ? "moderate" : "low confidence";
      lines.push(`- ${family}: ${label} (${(p * 100).toFixed(0)}%)`);
    }
  }

  if (beliefs.length > 0) {
    lines.push("Core beliefs:");
    for (const b of beliefs.sort((a, c) => c.confidence - a.confidence).slice(0, 5)) {
      lines.push(`- ${b.text} (${(b.confidence * 100).toFixed(0)}%)`);
    }
  }

  return lines.join("\n");
}
