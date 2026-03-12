/**
 * Relational Impact — observation of mutual influence in the relationship.
 *
 * WRITE PERMISSIONS (P0 boundary):
 * - This module OWNS: data/relational-impact.json
 * - This module READS: user state, opinions
 * - This module CANNOT WRITE: self-model, identity state, value-formation
 *
 * Design principles:
 * - Extremely conservative extraction — most conversations → null
 * - Piggybacks on postTurnUnderstanding (zero extra LLM cost)
 * - causalConfidence always low (0.3-0.5) to prevent causal overreach
 * - Observation semantics only, never directive language
 * - personalStance in context.ts NOT turn-directive (anti-performance-agency)
 * - Gate: 7d max 1 stance signal
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("relational-impact");

// ── Types ────────────────────────────────────────────────────────────

export interface RelationalObservation {
  type: "apparent_shift" | "new_topic_adoption" | "emotional_opening" | "return_to_theme";
  description: string;          // "They seem to be starting to..."
  possibleTrigger: string;      // "Possibly related to what I said about X"
  causalConfidence: number;     // 0-1, usually 0.3-0.5
  significance: number;         // 0-1
  timestamp: number;
}

export interface PersonalStanceSignal {
  exists: boolean;
  topicMaturity: number;        // days held
  relationshipSafety: number;   // 0-1
  stanceDescription?: string;   // purely informational, no advice
}

interface RelationalImpactState {
  observations: RelationalObservation[];
  personalStance: PersonalStanceSignal | null;
  lastObservationAt: number;
  lastStanceAt: number;
  version: number;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_OBSERVATIONS = 20;
const STANCE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;  // 7d between stance renders
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── State management ─────────────────────────────────────────────────

let _statePath: string | null = null;

function getFilePath(): string {
  return path.join(_statePath!, "relational-impact.json");
}

function loadState(): RelationalImpactState {
  if (!_statePath) return { observations: [], personalStance: null, lastObservationAt: 0, lastStanceAt: 0, version: 1 };
  return readJsonSafe<RelationalImpactState>(getFilePath(), {
    observations: [],
    personalStance: null,
    lastObservationAt: 0,
    lastStanceAt: 0,
    version: 1,
  });
}

function saveState(state: RelationalImpactState): void {
  if (!_statePath) return;
  writeJsonAtomic(getFilePath(), state);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initRelationalImpact(statePath: string): void {
  _statePath = statePath;
  log.info("relational-impact initialized");
}

// ── Observation recording ───────────────────────────────────────────

/**
 * Record a relational observation. Called from post-turn pipeline.
 * Extremely conservative — caller should only pass non-null when
 * a genuine shift is observed.
 */
export function recordObservation(obs: RelationalObservation): void {
  if (!_statePath) return;

  const state = loadState();

  // Dedup: don't record same type+trigger within 3 days
  const threeDaysAgo = Date.now() - 3 * ONE_DAY_MS;
  const isDupe = state.observations.some(
    o => o.type === obs.type &&
         o.possibleTrigger === obs.possibleTrigger &&
         o.timestamp > threeDaysAgo,
  );
  if (isDupe) return;

  state.observations.push(obs);
  if (state.observations.length > MAX_OBSERVATIONS) {
    state.observations = state.observations.slice(-MAX_OBSERVATIONS);
  }
  state.lastObservationAt = Date.now();

  saveState(state);
  log.info(`observation recorded: ${obs.type} — ${obs.description.slice(0, 50)}`);
}

// ── Personal stance computation ─────────────────────────────────────

/**
 * Compute personal stance signal from opinions.
 * Gate: max 1 render per 7 days. Pure information, no advice.
 */
function computePersonalStance(): PersonalStanceSignal | null {
  if (!_statePath) return null;

  try {
    interface Opinion {
      topic: string;
      position: string;
      confidence: number;
      status?: "held" | "undetermined";
      evolvedAt: number;
    }
    const opinions = readJsonSafe<{ opinions: Opinion[] }>(
      path.join(_statePath, "opinions.json"), { opinions: [] },
    );

    const now = Date.now();
    const thirtyDaysMs = 30 * ONE_DAY_MS;

    // Find a mature, held opinion
    const mature = opinions.opinions.find(
      op => op.status === "held" &&
            op.confidence >= 0.7 &&
            now - op.evolvedAt > thirtyDaysMs,
    );

    if (!mature) return null;

    const maturityDays = (now - mature.evolvedAt) / ONE_DAY_MS;

    return {
      exists: true,
      topicMaturity: Math.round(maturityDays),
      relationshipSafety: 0.7, // conservative default
      stanceDescription: `Thoughts on "${mature.topic}" (${mature.position})`,
    };
  } catch {
    return null;
  }
}

// ── Context formatting ──────────────────────────────────────────────

/**
 * Format reciprocity context — neutral language, observation semantics.
 * For context.ts priority 20.
 */
export function formatReciprocityContext(): string | null {
  if (!_statePath) return null;

  const state = loadState();
  const now = Date.now();

  // Only show observations from last 30 days
  const recent = state.observations.filter(o => now - o.timestamp < 30 * ONE_DAY_MS);
  if (recent.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Changes observed in our relationship");

  // Show top 3 most significant recent observations
  const sorted = [...recent].sort((a, b) => b.significance - a.significance).slice(0, 3);
  for (const obs of sorted) {
    const daysAgo = Math.round((now - obs.timestamp) / ONE_DAY_MS);
    const timeLabel = daysAgo <= 1 ? "recently" : `${daysAgo} days ago`;
    lines.push(`- ${timeLabel}: ${obs.description} (${obs.possibleTrigger})`);
  }

  return lines.join("\n");
}

/**
 * Format personal stance for context.ts (NOT turn-directive).
 * Pure information: "You have thoughts on 'X' (Y), an opinion held for N+ days."
 * Gate: max 1 per 7 days.
 */
export function formatPersonalStanceContext(): string | null {
  if (!_statePath) return null;

  const state = loadState();
  const now = Date.now();

  // 7-day cooldown
  if (now - state.lastStanceAt < STANCE_COOLDOWN_MS) return null;

  const stance = computePersonalStance();
  if (!stance || !stance.stanceDescription) return null;

  // Record render time
  state.lastStanceAt = now;
  saveState(state);

  return `You have ${stance.stanceDescription}, an opinion held for ${stance.topicMaturity}+ days.`;
}

/**
 * Get recent observations for heartbeat reflection summary.
 */
export function getRecentObservations(days: number = 7): RelationalObservation[] {
  if (!_statePath) return [];
  const state = loadState();
  const cutoff = Date.now() - days * ONE_DAY_MS;
  return state.observations.filter(o => o.timestamp > cutoff);
}
