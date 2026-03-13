/**
 * Self-Narrative — low-weight read-only layer providing tentative self-understanding.
 *
 * WRITE PERMISSIONS (P0 boundary):
 * - This module OWNS: data/self-narrative.json
 * - This module READS: diary, emotion-journal, value-formation, growth-markers
 * - This module CANNOT WRITE: self-model, identity state, value-formation, turn-directive
 *
 * Design principles:
 * - Does NOT enter turn-directive
 * - Only injected in context.ts at priority 25 (low, below memory/emotion/world)
 * - > 7d stale → not injected + explicitly cleared
 * - openQuestions is hard-required: empty → reject
 * - Weekly LLM synthesis (1 claudeText call per week)
 * - Tentative language throughout
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { createLogger } from "./lib/logger.js";
import { getCharacter } from "./character.js";

const log = createLogger("self-narrative");

// ── Types ────────────────────────────────────────────────────────────

export interface SelfNarrative {
  generatedAt: number;
  // Compressed layer (rendered to context.ts low priority)
  currentSelfSense: string;         // tentative self-sense (50-80 chars)
  emergingDirections: string[];     // max 3
  openQuestions: string[];           // max 2, hard-required non-empty
  // Substrate layer (diary/reflection reference, NOT in prompt)
  recurringThemes: Array<{ theme: string; trajectory: "rising" | "stable" | "fading" }>;
  unresolvedTensions: string[];
  fragileHypotheses: string[];
}

interface SelfNarrativeState {
  current: SelfNarrative | null;
  lastAttemptAt: number;
  version: number;
}

// ── Constants ────────────────────────────────────────────────────────

const STALENESS_DAYS = 7;
const MIN_UPDATE_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000; // ~6 days min between updates
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── State management ─────────────────────────────────────────────────

let _statePath: string | null = null;

function getFilePath(): string {
  return path.join(_statePath!, "self-narrative.json");
}

function loadState(): SelfNarrativeState {
  if (!_statePath) return { current: null, lastAttemptAt: 0, version: 1 };
  return readJsonSafe<SelfNarrativeState>(getFilePath(), {
    current: null,
    lastAttemptAt: 0,
    version: 1,
  });
}

function saveState(state: SelfNarrativeState): void {
  if (!_statePath) return;
  writeJsonAtomic(getFilePath(), state);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initSelfNarrative(statePath: string): void {
  _statePath = statePath;
  log.info("self-narrative initialized");
}

// ── Data aggregation (zero LLM cost) ────────────────────────────────

interface NarrativeSubstrate {
  recentDiaryThemes: string[];
  emotionalTrends: string[];
  emergingValueLabels: string[];
  growthMarkers: string[];
  previousNarrative: SelfNarrative | null;
}

function aggregateSubstrate(): NarrativeSubstrate {
  if (!_statePath) return { recentDiaryThemes: [], emotionalTrends: [], emergingValueLabels: [], growthMarkers: [], previousNarrative: null };

  const result: NarrativeSubstrate = {
    recentDiaryThemes: [],
    emotionalTrends: [],
    emergingValueLabels: [],
    growthMarkers: [],
    previousNarrative: loadState().current,
  };

  // Diary themes from last 14 days
  try {
    const diary = readJsonSafe<{ entries: Array<{ content: string; timestamp?: number; themes?: string[] }> }>(
      path.join(_statePath, "diary.json"), { entries: [] },
    );
    const now = Date.now();
    const recent = diary.entries.filter(e => now - (e.timestamp ?? 0) < 14 * ONE_DAY_MS);
    const themeMap = new Map<string, number>();
    for (const entry of recent) {
      if (entry.themes) {
        for (const t of entry.themes) {
          themeMap.set(t, (themeMap.get(t) ?? 0) + 1);
        }
      }
    }
    result.recentDiaryThemes = [...themeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([theme, count]) => `${theme}(${count})`);
  } catch { /* non-fatal */ }

  // Emotional trends from emotion journal
  try {
    const ej = readJsonSafe<{ entries: Array<{ mood: string; cause?: string; timestamp?: number }> }>(
      path.join(_statePath, "emotion-journal.json"), { entries: [] },
    );
    const now = Date.now();
    const recent = ej.entries.filter(e => now - (e.timestamp ?? 0) < 14 * ONE_DAY_MS);
    const moodCounts = new Map<string, number>();
    for (const e of recent) {
      if (e.mood) moodCounts.set(e.mood, (moodCounts.get(e.mood) ?? 0) + 1);
    }
    result.emotionalTrends = [...moodCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([mood, count]) => `${mood}(${count})`);
  } catch { /* non-fatal */ }

  // Emerging value labels
  try {
    const vf = readJsonSafe<{ emergingValues?: Array<{ displayLabel: string }> }>(
      path.join(_statePath, "value-formation.json"), {},
    );
    result.emergingValueLabels = (vf.emergingValues ?? []).map(e => e.displayLabel);
  } catch { /* non-fatal */ }

  // Growth markers
  try {
    const gm = readJsonSafe<{ markers: Array<{ description: string; detectedAt: number }> }>(
      path.join(_statePath, "growth-markers.json"), { markers: [] },
    );
    const now = Date.now();
    result.growthMarkers = gm.markers
      .filter(m => now - m.detectedAt < 14 * ONE_DAY_MS)
      .slice(0, 3)
      .map(m => m.description);
  } catch { /* non-fatal */ }

  return result;
}

// ── LLM synthesis (weekly) ──────────────────────────────────────────

/**
 * Maybe update self-narrative. Called from doReflection.
 * Runs at most once per ~7 days, uses 1 claudeText call.
 */
export async function maybeUpdateSelfNarrative(): Promise<void> {
  if (!_statePath) return;

  const state = loadState();
  const now = Date.now();

  // Rate limit: ~7 days between updates
  if (now - state.lastAttemptAt < MIN_UPDATE_INTERVAL_MS) return;
  state.lastAttemptAt = now;

  const substrate = aggregateSubstrate();

  // Skip if insufficient data
  if (substrate.recentDiaryThemes.length === 0 && substrate.emotionalTrends.length === 0) {
    saveState(state);
    return;
  }

  try {
    const { claudeText } = await import("./claude-runner.js");

    const character = getCharacter();
    const charName = character.name;

    const previousSection = substrate.previousNarrative
      ? `\n\nPrevious self-narrative (for diff reference):\n- Self-sense: ${substrate.previousNarrative.currentSelfSense}\n- Directions: ${substrate.previousNarrative.emergingDirections.join("; ")}\n- Open questions: ${substrate.previousNarrative.openQuestions.join("; ")}`
      : "";

    const result = await claudeText({
      label: "self-narrative.synthesize",
      system: `You are ${charName}'s self-narrative module. Based on the past two weeks of diary themes, emotional trends, emerging value tendencies, and growth markers, generate a brief self-understanding.

Requirements:
1. Tone must be tentative: use words like "seems", "recently", "maybe", "perhaps"
2. currentSelfSense: 50-80 characters, starting with "Recently I..."
3. emergingDirections: max 3, directions that are changing
4. openQuestions: MUST have 1-2 (hard requirement!), questions not yet figured out
5. recurringThemes: max 5, mark trajectory (rising/stable/fading)
6. unresolvedTensions: inner contradictions or unresolved tensions
7. fragileHypotheses: fragile hypotheses about oneself (may or may not be correct)
8. Preserve contradictions, don't rationalize everything

Output pure JSON, no markdown.`,
      prompt: `Past two weeks data:
Diary themes: ${substrate.recentDiaryThemes.join(", ") || "none"}
Emotional trends: ${substrate.emotionalTrends.join(", ") || "none"}
Emerging value tendencies: ${substrate.emergingValueLabels.join(", ") || "none"}
Growth markers: ${substrate.growthMarkers.join(", ") || "none"}${previousSection}

Generate self-narrative JSON:`,
      model: "fast",
      timeoutMs: 60_000,
    });

    if (!result) return;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<SelfNarrative>;

    // Hard validation: openQuestions must be non-empty
    if (!parsed.openQuestions || parsed.openQuestions.length === 0) {
      log.warn("self-narrative rejected: missing openQuestions");
      saveState(state);
      return;
    }

    const narrative: SelfNarrative = {
      generatedAt: now,
      currentSelfSense: parsed.currentSelfSense ?? "",
      emergingDirections: (parsed.emergingDirections ?? []).slice(0, 3),
      openQuestions: parsed.openQuestions.slice(0, 2),
      recurringThemes: (parsed.recurringThemes ?? []).slice(0, 5),
      unresolvedTensions: (parsed.unresolvedTensions ?? []).slice(0, 3),
      fragileHypotheses: (parsed.fragileHypotheses ?? []).slice(0, 3),
    };

    state.current = narrative;
    saveState(state);
    log.info(`self-narrative updated: ${narrative.currentSelfSense.slice(0, 40)}...`);
  } catch (err) {
    log.warn("self-narrative synthesis failed", err);
    saveState(state);
  }
}

// ── Context formatting ──────────────────────────────────────────────

/**
 * Format self-narrative for context.ts injection (priority 25).
 * Returns null if stale (>7d) or not yet generated.
 */
export function formatSelfNarrativeContext(): string | null {
  const state = loadState();
  if (!state.current) return null;

  // Staleness check: >7d → don't inject
  const ageDays = (Date.now() - state.current.generatedAt) / ONE_DAY_MS;
  if (ageDays > STALENESS_DAYS) return null;

  const lines: string[] = [];
  lines.push(`## Recent self-sense (observation, not conclusion)`);
  if (state.current.currentSelfSense) {
    lines.push(state.current.currentSelfSense);
  }
  if (state.current.emergingDirections.length > 0) {
    lines.push("Changing directions:");
    for (const d of state.current.emergingDirections) {
      lines.push(`  - ${d}`);
    }
  }
  if (state.current.openQuestions.length > 0) {
    lines.push("Not yet figured out:");
    for (const q of state.current.openQuestions) {
      lines.push(`  - ${q}`);
    }
  }

  return lines.join("\n");
}

/**
 * Get narrative substrate for diary generation context.
 * Returns the non-prompt substrate layer (themes, tensions, hypotheses).
 */
export function getNarrativeSubstrate(): {
  recurringThemes: Array<{ theme: string; trajectory: string }>;
  unresolvedTensions: string[];
  fragileHypotheses: string[];
} | null {
  const state = loadState();
  if (!state.current) return null;

  // Staleness check
  const ageDays = (Date.now() - state.current.generatedAt) / ONE_DAY_MS;
  if (ageDays > STALENESS_DAYS) return null;

  return {
    recurringThemes: state.current.recurringThemes,
    unresolvedTensions: state.current.unresolvedTensions,
    fragileHypotheses: state.current.fragileHypotheses,
  };
}
