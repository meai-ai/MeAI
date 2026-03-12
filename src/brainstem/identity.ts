/**
 * Identity Regularizer — personality slow variables, valence event accounting,
 * preferences carrier, IdentityTrajectory, narrative self.
 *
 * Constrains micro-thought style and goal generation to maintain personality coherence.
 */

import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { type Clock, BRAINSTEM_CONFIG as C } from "./config.js";
import type { ConceptGraph, ConceptNode } from "./graph.js";
import type { MicroThoughtRecord } from "./bootstrap.js";
import { claudeText } from "../claude-runner.js";
import { getCharacter } from "../character.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-identity");

// ── Types ────────────────────────────────────────────────────────────

export type AnchorTag = "grounded" | "inferred" | "speculative";

export interface IdentityProfile {
  topThemes: Array<{ label: string; frequency: number }>;
  valenceBaseline: number;
  preferredAnchorDist: Record<AnchorTag, number>;
  goalPortfolio: { categories: Record<string, number> };
  communicationStyle: string[];
  coreValues: string[];
  updatedAt: number;
}

export interface Preference {
  id: string;
  description: string;
  affectsScoring: boolean;
  source: "identity" | "user_request" | "learned";
  updatedAt: number;
}

export interface IdentitySnapshot {
  month: string;
  topThemes: string[];
  goalCompletions: string[];
  valenceRange: { min: number; max: number; median: number };
  keyInsights: string[];
}

export interface IdentityTrajectory {
  snapshots: IdentitySnapshot[];
  emergingInterests: string[];
  fadingInterests: string[];
  stableCore: string[];
}

export interface IdentityNarrative {
  coreBeliefs: Array<{ belief: string; strength: number; since: string }>;
  quarterlyArcs: Array<{
    quarter: string;         // "2026-Q1"
    theme: string;
    keyMoments: string[];
    growth: string;
  }>;
  coherenceScore: number;    // 0-1
  lastCoherenceCheck: number;
}

export interface ValenceEvent {
  source: "external_event" | "prediction_error" | "spreading" | "replay" | "baseline_drift";
  delta: number;
  conceptId?: string;
  timestamp: number;
}

interface IdentityState {
  profile: IdentityProfile;
  preferences: Preference[];
  trajectory: IdentityTrajectory;
  narrative: IdentityNarrative;
  valenceHistory: ValenceEvent[];
  lastExternalValenceAt: number;
  lastSnapshotMonth: string;
}

// ── Identity Regularizer ─────────────────────────────────────────────

export class IdentityRegularizer {
  private state: IdentityState;
  private dataPath: string;

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.state = this.load();
  }

  getProfile(): IdentityProfile {
    return { ...this.state.profile };
  }

  getTrajectory(): IdentityTrajectory {
    return { ...this.state.trajectory };
  }

  getPreferences(): Preference[] {
    return [...this.state.preferences];
  }

  // ── Valence energy conservation ──────────────────────────────

  recordValenceEvent(event: ValenceEvent): boolean {
    // Enforce per-source limits
    const maxDelta = this.getMaxDelta(event.source);
    if (Math.abs(event.delta) > maxDelta) {
      event.delta = Math.sign(event.delta) * maxDelta;
    }

    if (event.source === "external_event") {
      this.state.lastExternalValenceAt = event.timestamp;
    }

    this.state.valenceHistory.push(event);
    // Keep last 200 events
    if (this.state.valenceHistory.length > 200) {
      this.state.valenceHistory = this.state.valenceHistory.slice(-200);
    }

    this.save();
    return true;
  }

  private getMaxDelta(source: ValenceEvent["source"]): number {
    switch (source) {
      case "external_event": return 1.0; // no limit
      case "prediction_error": return 0.05;
      case "spreading": return 0.02;
      case "replay": return 0.03;
      case "baseline_drift": return 0.005;
    }
  }

  // Drift prevention: no external V-source for >30 min AND |V| increasing → regress
  computeValenceDriftCorrection(currentValence: number): number {
    const now = this.clock.nowMs();
    const minsSinceExternal = (now - this.state.lastExternalValenceAt) / 60_000;

    if (minsSinceExternal > 30 && Math.abs(currentValence) > Math.abs(this.state.profile.valenceBaseline)) {
      // Force regression toward baseline
      return 0.005 * (this.state.profile.valenceBaseline - currentValence);
    }
    return 0;
  }

  // ── Profile update (daily, during wake-up consolidation) ─────

  updateProfile(
    recentThoughts: MicroThoughtRecord[],
    graph: ConceptGraph,
  ): void {
    // Top themes from last 7 days
    const themeCounts = new Map<string, number>();
    const cutoff = this.clock.nowMs() - 7 * 86_400_000;
    const recentRelevant = recentThoughts.filter(t => t.timestamp > cutoff);

    for (const thought of recentRelevant) {
      for (const concept of thought.concepts) {
        const node = graph.nodes[concept];
        if (node && node.id !== "self") {
          themeCounts.set(node.label, (themeCounts.get(node.label) ?? 0) + 1);
        }
      }
    }

    this.state.profile.topThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, frequency]) => ({ label, frequency }));

    // Valence baseline (7-day median)
    const recentValences = this.state.valenceHistory
      .filter(e => e.timestamp > cutoff)
      .map(e => e.delta);
    if (recentValences.length > 0) {
      recentValences.sort((a, b) => a - b);
      this.state.profile.valenceBaseline = recentValences[Math.floor(recentValences.length / 2)];
    }

    // Anchor distribution
    const anchorCounts: Record<AnchorTag, number> = { grounded: 0, inferred: 0, speculative: 0 };
    for (const thought of recentRelevant) {
      if (thought.anchor && thought.anchor in anchorCounts) {
        anchorCounts[thought.anchor as AnchorTag]++;
      }
    }
    const total = Object.values(anchorCounts).reduce((s, v) => s + v, 0) || 1;
    this.state.profile.preferredAnchorDist = {
      grounded: anchorCounts.grounded / total,
      inferred: anchorCounts.inferred / total,
      speculative: anchorCounts.speculative / total,
    };

    this.state.profile.updatedAt = this.clock.nowMs();
    this.save();
  }

  // ── Monthly trajectory snapshot ──────────────────────────────

  computeMonthlySnapshot(
    month: string,
    thoughts: MicroThoughtRecord[],
    goalCompletions: string[],
    insights: string[],
  ): void {
    if (this.state.lastSnapshotMonth === month) return;

    // Valence range
    const valences = this.state.valenceHistory.map(e => e.delta);
    const valenceRange = valences.length > 0
      ? {
        min: Math.min(...valences),
        max: Math.max(...valences),
        median: valences.sort((a, b) => a - b)[Math.floor(valences.length / 2)],
      }
      : { min: 0, max: 0, median: 0 };

    // Top themes this month
    const themeCounts = new Map<string, number>();
    for (const thought of thoughts) {
      for (const concept of thought.concepts) {
        themeCounts.set(concept, (themeCounts.get(concept) ?? 0) + 1);
      }
    }
    const topThemes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label]) => label);

    const snapshot: IdentitySnapshot = {
      month,
      topThemes,
      goalCompletions,
      valenceRange,
      keyInsights: insights.slice(0, 5),
    };

    this.state.trajectory.snapshots.push(snapshot);
    // Keep last 12 months
    if (this.state.trajectory.snapshots.length > 12) {
      this.state.trajectory.snapshots.shift();
    }

    // Compute trends
    this.computeTrends();

    // Quarterly arc + coherence check
    this.generateQuarterlyArc(month, this.state.trajectory.snapshots).catch(
      err => log.warn("quarterly arc error in snapshot", err),
    );
    this.checkCoherence(thoughts);

    this.state.lastSnapshotMonth = month;
    this.save();
  }

  private computeTrends(): void {
    const snapshots = this.state.trajectory.snapshots;
    if (snapshots.length < 2) return;

    const recent = snapshots.slice(-3);
    const older = snapshots.slice(-6, -3);

    if (older.length === 0) return;

    const recentThemes = new Set(recent.flatMap(s => s.topThemes));
    const olderThemes = new Set(older.flatMap(s => s.topThemes));

    // Emerging: in recent but not in older
    this.state.trajectory.emergingInterests = [...recentThemes].filter(t => !olderThemes.has(t));

    // Fading: in older but not in recent
    this.state.trajectory.fadingInterests = [...olderThemes].filter(t => !recentThemes.has(t));

    // Stable core: in ≥70% of all snapshots
    const allThemeCounts = new Map<string, number>();
    for (const s of snapshots) {
      for (const t of s.topThemes) {
        allThemeCounts.set(t, (allThemeCounts.get(t) ?? 0) + 1);
      }
    }
    this.state.trajectory.stableCore = [...allThemeCounts.entries()]
      .filter(([, count]) => count >= snapshots.length * 0.7)
      .map(([theme]) => theme);
  }

  // ── Quarterly arc generation ─────────────────────────────────

  async generateQuarterlyArc(month: string, snapshots: IdentitySnapshot[]): Promise<void> {
    // Only trigger on quarter boundaries (month ends in 03, 06, 09, 12)
    const monthNum = parseInt(month.split("-")[1], 10);
    if (![3, 6, 9, 12].includes(monthNum)) return;

    const year = month.split("-")[0];
    const quarter = `${year}-Q${Math.ceil(monthNum / 3)}`;

    // Skip if we already have this quarter
    if (this.state.narrative.quarterlyArcs.some(a => a.quarter === quarter)) return;

    // Need at least 1 snapshot
    const lastSnapshots = snapshots.slice(-3);
    if (lastSnapshots.length === 0) return;

    const char = getCharacter();
    const charName = char.name;

    try {
      const snapshotSummary = lastSnapshots.map(s =>
        `${s.month}: themes=${s.topThemes.join(", ")}, completions=${s.goalCompletions.join(", ") || "none"}, insights=${s.keyInsights.join("; ") || "none"}`,
      ).join("\n");

      const result = await claudeText({
        system: `You are ${charName}'s self-narrative generator. Extract themes, key moments, and growth from quarterly snapshots.`,
        prompt: `Quarter ${quarter} monthly snapshots:
${snapshotSummary}

Existing core beliefs: ${this.state.narrative.coreBeliefs.map(b => b.belief).join(", ") || "none yet"}

Please respond in JSON:
{
  "theme": "This quarter's theme (one sentence)",
  "keyMoments": ["key moment 1", "key moment 2"],
  "growth": "Growth summary (one sentence)",
  "coreBeliefs": ["belief 1", "belief 2", "belief 3"]
}`,
        model: "fast",
        timeoutMs: 20_000,
      });

      const parsed = JSON.parse(result.trim().match(/\{[\s\S]*\}/)?.[0] ?? "{}");

      this.state.narrative.quarterlyArcs.push({
        quarter,
        theme: parsed.theme ?? `${quarter}`,
        keyMoments: (parsed.keyMoments ?? []).slice(0, 5),
        growth: parsed.growth ?? "",
      });

      // Keep last 8 quarters
      if (this.state.narrative.quarterlyArcs.length > 8) {
        this.state.narrative.quarterlyArcs.shift();
      }

      // Update core beliefs from arc
      if (Array.isArray(parsed.coreBeliefs)) {
        for (const belief of parsed.coreBeliefs.slice(0, 5)) {
          const existing = this.state.narrative.coreBeliefs.find(b => b.belief === belief);
          if (existing) {
            existing.strength = Math.min(1, existing.strength + 0.1);
          } else {
            this.state.narrative.coreBeliefs.push({
              belief,
              strength: 0.5,
              since: quarter,
            });
          }
        }
        // Decay beliefs not mentioned
        for (const b of this.state.narrative.coreBeliefs) {
          if (!parsed.coreBeliefs.includes(b.belief)) {
            b.strength = Math.max(0, b.strength - 0.1);
          }
        }
        // Remove beliefs with strength 0
        this.state.narrative.coreBeliefs = this.state.narrative.coreBeliefs
          .filter(b => b.strength > 0)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, 7);
      }

      this.save();
      log.info(`quarterly arc: ${quarter}, theme="${parsed.theme}"`);
    } catch (err) {
      log.warn("quarterly arc generation error", err);
    }
  }

  /** Check coherence between recent thoughts and core beliefs. */
  checkCoherence(recentThoughts: MicroThoughtRecord[]): number {
    const beliefs = this.state.narrative.coreBeliefs;
    if (beliefs.length === 0 || recentThoughts.length === 0) return 1.0;

    // Simple overlap: what % of thoughts align with declared core beliefs
    const beliefKeywords = beliefs.flatMap(b =>
      b.belief.split(/[，、\s]+/).filter(w => w.length >= 2),
    );
    if (beliefKeywords.length === 0) return 1.0;

    let alignedCount = 0;
    for (const thought of recentThoughts) {
      const content = thought.content + " " + thought.concepts.join(" ");
      if (beliefKeywords.some(kw => content.includes(kw))) {
        alignedCount++;
      }
    }

    const coherence = alignedCount / recentThoughts.length;
    this.state.narrative.coherenceScore = coherence;
    this.state.narrative.lastCoherenceCheck = this.clock.nowMs();

    if (coherence < 0.3) {
      log.warn(`identity drift warning: coherence=${coherence.toFixed(2)}, beliefs may be stale`);
    }

    this.save();
    return coherence;
  }

  getNarrative(): IdentityNarrative {
    return { ...this.state.narrative };
  }

  // ── Goal generation constraints ──────────────────────────────

  canProposeGoal(category: string): boolean {
    const portfolio = this.state.profile.goalPortfolio.categories;
    const countInCategory = portfolio[category] ?? 0;
    return countInCategory < 2;
  }

  isConsistentWithValues(goalDescription: string): boolean {
    // Simple keyword check against core values
    const antiPatterns = ["违背", "不尊重", "忽视"];
    return !antiPatterns.some(p => goalDescription.includes(p));
  }

  updateGoalPortfolio(category: string, delta: number): void {
    if (!this.state.profile.goalPortfolio.categories[category]) {
      this.state.profile.goalPortfolio.categories[category] = 0;
    }
    this.state.profile.goalPortfolio.categories[category] += delta;
    this.save();
  }

  // ── Format for system prompt ─────────────────────────────────

  formatIdentityContext(): string {
    const profile = this.state.profile;
    const trajectory = this.state.trajectory;
    const lines: string[] = [];

    if (profile.topThemes.length > 0) {
      const themes = profile.topThemes.slice(0, 5).map(t => t.label).join(", ");
      lines.push(`Recent topics of interest: ${themes}`);
    }

    if (trajectory.emergingInterests.length > 0) {
      lines.push(`Growing interests: ${trajectory.emergingInterests.join(", ")}`);
    }

    if (trajectory.fadingInterests.length > 0) {
      lines.push(`Fading interests: ${trajectory.fadingInterests.join(", ")}`);
    }

    if (trajectory.stableCore.length > 0) {
      lines.push(`Enduring concerns: ${trajectory.stableCore.join(", ")}`);
    }

    // Last snapshot's key insights
    const lastSnapshot = trajectory.snapshots[trajectory.snapshots.length - 1];
    if (lastSnapshot?.keyInsights?.length > 0) {
      const insights = lastSnapshot.keyInsights.slice(0, 3).join("; ");
      lines.push(`Last month's self-observations: ${insights}`);
    }

    // Core beliefs (top 3 by strength)
    const narrative = this.state.narrative;
    if (narrative.coreBeliefs.length > 0) {
      const topBeliefs = narrative.coreBeliefs.slice(0, 3).map(b => b.belief).join(", ");
      lines.push(`Core beliefs: ${topBeliefs}`);
    }

    // Latest quarterly arc theme
    if (narrative.quarterlyArcs.length > 0) {
      const latestArc = narrative.quarterlyArcs[narrative.quarterlyArcs.length - 1];
      lines.push(`This quarter's theme: ${latestArc.theme}`);
    }

    // Coherence warning
    if (narrative.coherenceScore < 0.3 && narrative.lastCoherenceCheck > 0) {
      lines.push("Warning: recent thoughts diverge from core beliefs — reflection needed");
    }

    return lines.join("\n");
  }

  // ── Persistence ──────────────────────────────────────────────

  save(): void {
    writeJsonAtomic(
      path.join(this.dataPath, "brainstem", "identity.json"),
      this.state,
    );
  }

  restoreState(partial: Partial<IdentityState>): void {
    Object.assign(this.state, partial);
  }

  private load(): IdentityState {
    return readJsonSafe<IdentityState>(
      path.join(this.dataPath, "brainstem", "identity.json"),
      {
        profile: {
          topThemes: [],
          valenceBaseline: 0,
          preferredAnchorDist: { grounded: 0.5, inferred: 0.3, speculative: 0.2 },
          goalPortfolio: { categories: {} },
          communicationStyle: [],
          coreValues: [],
          updatedAt: 0,
        },
        preferences: [],
        narrative: {
          coreBeliefs: [],
          quarterlyArcs: [],
          coherenceScore: 1.0,
          lastCoherenceCheck: 0,
        },
        trajectory: {
          snapshots: [],
          emergingInterests: [],
          fadingInterests: [],
          stableCore: [],
        },
        valenceHistory: [],
        lastExternalValenceAt: 0,
        lastSnapshotMonth: "",
      },
    );
  }
}
