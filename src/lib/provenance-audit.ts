/**
 * 4.3: Provenance Audit — deterministic narrative continuity verification.
 *
 * Scans all memory categories, beliefs, episodes, and diary for sourceType
 * distribution. Detects narrative contamination (circular provenance chains)
 * and tracks drift trends over time.
 *
 * Zero LLM cost. Runs nightly from heartbeat.
 *
 * Design decisions:
 * - Untagged entries stay untagged (no heuristic force-tagging)
 * - narrativeRatio excludes untagged from denominator
 * - Trend-based alerting, not single-point thresholds
 * - Diary/narrative arcs always exempt from warnings
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { createLogger } from "./logger.js";

const log = createLogger("provenance-audit");

// ── Local Types (for decoupled usage) ────────────────────────────────

/** Provenance source type for memories, beliefs, etc. */
export type ProvenanceType = "observed" | "inferred" | "narrative";

/** Minimal Memory shape needed by this module */
interface MemoryRecord {
  key: string;
  sourceType?: ProvenanceType;
}

/** Minimal SelfBelief shape needed by this module */
interface SelfBeliefRecord {
  statement: string;
  sourceType?: ProvenanceType;
  evidence: Array<{ type: string; text: string; refId: string }>;
}

// ── Types ────────────────────────────────────────────────────────────

export interface ProvenanceDistribution {
  observed: number;
  inferred: number;
  narrative: number;
  untagged: number;
  total: number;
  narrativeRatio: number;  // narrative / (total - untagged)
}

export interface ProvenanceDriftEntry {
  timestamp: number;
  category: string;
  distribution: ProvenanceDistribution;
  driftWarning?: string;
}

export interface ProvenanceAuditState {
  history: ProvenanceDriftEntry[];  // last 30 daily snapshots
  lastAuditDate: string;
  contaminations: string[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_HISTORY = 30;
const MIN_ADAPTIVE_SAMPLES = 7;   // fall back to defaults below this
const MIN_JUMP_SAMPLES = 3;       // for single-day jump adaptive threshold

// Default narrative-ratio thresholds (fallback when < MIN_ADAPTIVE_SAMPLES)
const DEFAULT_NARRATIVE_THRESHOLDS: Record<string, number> = {
  "memory:knowledge": 0.6,
  "memory:emotional": 0.6,
  "memory:user": 0.6,
  "memory:insights": 0.6,
  "memory:commitment": 0.6,
  "memory:core": 0.6,
  "belief": 0.4,
};

// ── Adaptive threshold helpers ──────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Compute adaptive narrative-ratio threshold for a category using IQR
 * outlier detection from its 30-day history.
 * Returns P75 + 1.5xIQR, clamped to [0.3, 0.9].
 * Falls back to DEFAULT_NARRATIVE_THRESHOLDS if < MIN_ADAPTIVE_SAMPLES data points.
 */
function computeAdaptiveNarrativeThreshold(
  history: ProvenanceDriftEntry[],
  category: string,
): number {
  const catEntries = history.filter(e => e.category === category);
  if (catEntries.length < MIN_ADAPTIVE_SAMPLES) {
    return DEFAULT_NARRATIVE_THRESHOLDS[category] ?? 0.5;
  }

  const ratios = catEntries
    .map(e => e.distribution.narrativeRatio)
    .sort((a, b) => a - b);

  const q25 = percentile(ratios, 0.25);
  const q75 = percentile(ratios, 0.75);
  const iqr = q75 - q25;
  const adaptive = q75 + 1.5 * iqr;
  return Math.max(0.3, Math.min(0.9, adaptive));
}

/**
 * Compute baseline mean narrative ratio for a category from its history.
 * Used for rising-trend minimum detection (2B).
 */
function computeCategoryBaselineMean(
  history: ProvenanceDriftEntry[],
  category: string,
): number {
  const catEntries = history.filter(e => e.category === category);
  if (catEntries.length === 0) return 0.1;  // fallback
  return catEntries.reduce((s, e) => s + e.distribution.narrativeRatio, 0) / catEntries.length;
}

/**
 * Compute adaptive single-day jump threshold for a category using IQR
 * from historical daily changes. Falls back to 0.20 if < MIN_JUMP_SAMPLES.
 */
function computeAdaptiveJumpThreshold(
  history: ProvenanceDriftEntry[],
  category: string,
): number {
  const catEntries = history
    .filter(e => e.category === category)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (catEntries.length < MIN_JUMP_SAMPLES) return 0.20;

  // Compute daily changes
  const deltas: number[] = [];
  for (let i = 1; i < catEntries.length; i++) {
    deltas.push(Math.abs(
      catEntries[i].distribution.narrativeRatio -
      catEntries[i - 1].distribution.narrativeRatio,
    ));
  }
  if (deltas.length < MIN_JUMP_SAMPLES) return 0.20;

  deltas.sort((a, b) => a - b);
  const q25 = percentile(deltas, 0.25);
  const q75 = percentile(deltas, 0.75);
  const iqr = q75 - q25;
  return Math.max(0.05, q75 + 1.5 * iqr);  // floor at 0.05 to avoid trivial alerts
}

// Categories exempt from drift warnings (narrative by design)
const EXEMPT_CATEGORIES = new Set(["diary", "narrative", "episode"]);

// ── Distribution scanning ────────────────────────────────────────────

function countSourceTypes(items: Array<{ sourceType?: ProvenanceType }>): ProvenanceDistribution {
  let observed = 0, inferred = 0, narrative = 0, untagged = 0;
  for (const item of items) {
    if (!item.sourceType) untagged++;
    else if (item.sourceType === "observed") observed++;
    else if (item.sourceType === "inferred") inferred++;
    else if (item.sourceType === "narrative") narrative++;
    else untagged++;  // unknown value treated as untagged
  }
  const total = items.length;
  const tagged = total - untagged;
  const narrativeRatio = tagged > 0 ? narrative / tagged : 0;
  return { observed, inferred, narrative, untagged, total, narrativeRatio };
}

/**
 * Scan all memory categories, beliefs, episodes, diary.
 * Return per-category sourceType distribution.
 */
export function auditProvenanceDistribution(statePath: string): ProvenanceDriftEntry[] {
  const now = Date.now();
  const entries: ProvenanceDriftEntry[] = [];

  // Memory categories
  const memoryCategories = ["knowledge", "emotional", "user", "insights", "commitment", "core"];
  for (const cat of memoryCategories) {
    try {
      const memories = readJsonSafe<MemoryRecord[]>(
        path.join(statePath, "memory", `${cat}.json`), [],
      );
      const dist = countSourceTypes(memories);
      entries.push({ timestamp: now, category: `memory:${cat}`, distribution: dist });
    } catch { /* skip */ }
  }

  // Beliefs
  try {
    const selfModelData = readJsonSafe<{ beliefs?: SelfBeliefRecord[] }>(
      path.join(statePath, "brainstem", "self-model.json"),
      { beliefs: [] },
    );
    const beliefs = selfModelData.beliefs ?? [];
    const dist = countSourceTypes(beliefs);
    entries.push({ timestamp: now, category: "belief", distribution: dist });
  } catch { /* skip */ }

  // Diary entries
  try {
    const diary = readJsonSafe<{ entries: Array<{ sourceType?: ProvenanceType }> }>(
      path.join(statePath, "diary.json"), { entries: [] },
    );
    const dist = countSourceTypes(diary.entries);
    entries.push({ timestamp: now, category: "diary", distribution: dist });
  } catch { /* skip */ }

  // Episodes
  try {
    const episodes = readJsonSafe<Array<{ sourceType?: ProvenanceType }>>(
      path.join(statePath, "episodes.json"), [],
    );
    const dist = countSourceTypes(episodes);
    entries.push({ timestamp: now, category: "episode", distribution: dist });
  } catch { /* skip */ }

  return entries;
}

// ── Narrative contamination detection ────────────────────────────────

/**
 * Find beliefs where ALL evidence is type "reflection" AND referenced
 * memories are sourceType "narrative" — circular provenance.
 */
export function detectNarrativeContamination(statePath: string): string[] {
  const warnings: string[] = [];

  try {
    const selfModelData = readJsonSafe<{ beliefs?: SelfBeliefRecord[] }>(
      path.join(statePath, "brainstem", "self-model.json"),
      { beliefs: [] },
    );
    const beliefs = selfModelData.beliefs ?? [];

    // Load all memories for cross-reference
    const allMemories = new Map<string, MemoryRecord>();
    const memoryCategories = ["knowledge", "emotional", "user", "insights", "commitment", "core"];
    for (const cat of memoryCategories) {
      try {
        const memories = readJsonSafe<MemoryRecord[]>(
          path.join(statePath, "memory", `${cat}.json`), [],
        );
        for (const m of memories) allMemories.set(m.key, m);
      } catch { /* skip */ }
    }

    for (const belief of beliefs) {
      if (belief.evidence.length === 0) continue;

      // Check if ALL evidence is reflection type
      const allReflection = belief.evidence.every(e => e.type === "reflection");
      if (!allReflection) continue;

      // Check if any referenced memories are narrative-sourced
      // Look for memory keys in evidence text/refId
      let hasNarrativeRef = false;
      for (const ev of belief.evidence) {
        // Check refId and text for memory key patterns
        for (const [key, mem] of allMemories) {
          if (mem.sourceType === "narrative" &&
              (ev.text.includes(key) || ev.refId.includes(key))) {
            hasNarrativeRef = true;
            break;
          }
        }
        if (hasNarrativeRef) break;
      }

      if (hasNarrativeRef) {
        warnings.push(
          `Belief "${belief.statement}" has all evidence from reflection, and referenced memories are narrative-sourced — circular provenance`,
        );
      }
    }
  } catch { /* non-fatal */ }

  return warnings;
}

// ── Trend-based drift alerting ───────────────────────────────────────

/**
 * Check drift trends. Warn when:
 * (a) narrativeRatio rises for 3 consecutive audits
 * (b) 7-day rolling avg exceeds threshold
 * (c) any category jumps 20%+ in one day
 */
export function checkDriftTrend(history: ProvenanceDriftEntry[]): string[] {
  const warnings: string[] = [];
  if (history.length < 2) return warnings;

  // Group by category
  const byCategory = new Map<string, ProvenanceDriftEntry[]>();
  for (const entry of history) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }

  for (const [category, entries] of byCategory) {
    // Skip exempt categories
    if (EXEMPT_CATEGORIES.has(category)) continue;

    // Sort by timestamp ascending
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const recent = sorted.slice(-7);

    if (recent.length < 2) continue;

    // (a) Rising 3 consecutive times
    if (recent.length >= 3) {
      const last3 = recent.slice(-3);
      const isRising = last3[1].distribution.narrativeRatio > last3[0].distribution.narrativeRatio &&
                        last3[2].distribution.narrativeRatio > last3[1].distribution.narrativeRatio;
      // 2B: Only warn if latest exceeds category's own baseline mean (not a global 0.1)
      const baselineMean = computeCategoryBaselineMean(history, category);
      if (isRising && last3[2].distribution.narrativeRatio > baselineMean) {
        warnings.push(
          `${category} narrative ratio rising 3 consecutive times (${last3.map(e => (e.distribution.narrativeRatio * 100).toFixed(0) + "%").join(" -> ")})`,
        );
      }
    }

    // (b) 7-day rolling avg exceeds adaptive threshold (2A: IQR-based)
    const threshold = computeAdaptiveNarrativeThreshold(history, category);
    const avgRatio = recent.reduce((s, e) => s + e.distribution.narrativeRatio, 0) / recent.length;
    if (avgRatio > threshold) {
      warnings.push(
        `${category} narrative 7-day avg (${(avgRatio * 100).toFixed(0)}%) exceeds threshold (${(threshold * 100).toFixed(0)}%)`,
      );
    }

    // (c) Single-day jump exceeds adaptive threshold (2C: IQR-based, fallback 0.20)
    if (recent.length >= 2) {
      const prev = recent[recent.length - 2].distribution.narrativeRatio;
      const curr = recent[recent.length - 1].distribution.narrativeRatio;
      const jumpThreshold = computeAdaptiveJumpThreshold(history, category);
      if (curr - prev > jumpThreshold) {
        warnings.push(
          `${category} narrative ratio single-day jump ${((curr - prev) * 100).toFixed(0)}% (${(prev * 100).toFixed(0)}% -> ${(curr * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  return warnings;
}

// ── Warning formatting for reflection ────────────────────────────────

/**
 * Format warnings for reflection prompt injection.
 * Max 2 warnings, trend-confirmed only. Diary/narrative always exempt.
 */
export function formatProvenanceWarnings(statePath: string): string {
  try {
    const auditState = readJsonSafe<ProvenanceAuditState>(
      path.join(statePath, "provenance-audit.json"),
      { history: [], lastAuditDate: "", contaminations: [] },
    );

    const warnings: string[] = [];

    // Trend-based drift warnings
    const driftWarnings = checkDriftTrend(auditState.history);
    warnings.push(...driftWarnings);

    // Contamination warnings (add up to remaining capacity under cap of 2)
    if (auditState.contaminations.length > 0) {
      const remaining = 2 - warnings.length;
      if (remaining > 0) {
        warnings.push(...auditState.contaminations.slice(0, remaining));
      }
    }

    if (warnings.length === 0) return "";

    // Cap at 2
    const top = warnings.slice(0, 2);
    return top.map(w => `- ${w}`).join("\n");
  } catch {
    return "";
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────

/**
 * Run full provenance audit: distribution + contamination + trend check.
 * Save to data/provenance-audit.json.
 */
export function runProvenanceAudit(statePath: string): void {
  const auditPath = path.join(statePath, "provenance-audit.json");
  const state = readJsonSafe<ProvenanceAuditState>(auditPath, {
    history: [],
    lastAuditDate: "",
    contaminations: [],
  });

  // Check if already ran today
  const today = new Date().toISOString().split("T")[0];
  if (state.lastAuditDate === today) return;

  // 1. Distribution scan
  const newEntries = auditProvenanceDistribution(statePath);

  // 2. Contamination check
  const contaminations = detectNarrativeContamination(statePath);

  // 3. Add to history — dedup by category for today's entries
  const todayStart = new Date(today).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  // Remove any existing entries from today (in case of double-run despite daily gate)
  state.history = state.history.filter(e =>
    e.timestamp < todayStart || e.timestamp >= todayEnd,
  );
  state.history.push(...newEntries);

  // Trim history to last 30 days (per category)
  const byCategory = new Map<string, ProvenanceDriftEntry[]>();
  for (const entry of state.history) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }
  state.history = [];
  for (const [, entries] of byCategory) {
    const sorted = entries.sort((a, b) => a.timestamp - b.timestamp);
    state.history.push(...sorted.slice(-MAX_HISTORY));
  }

  // 4. Check trends and annotate latest entries
  const driftWarnings = checkDriftTrend(state.history);
  if (driftWarnings.length > 0) {
    for (const entry of newEntries) {
      const relevantWarning = driftWarnings.find(w => w.includes(entry.category));
      if (relevantWarning) {
        entry.driftWarning = relevantWarning;
      }
    }
  }

  state.lastAuditDate = today;
  state.contaminations = contaminations;

  writeJsonAtomic(auditPath, state);
  log.info(`provenance audit: ${newEntries.length} categories scanned, ${contaminations.length} contaminations, ${driftWarnings.length} drift warnings`);
}
