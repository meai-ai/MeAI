/**
 * Narrative arc engine — ongoing storylines in the character's life.
 *
 * Manages unresolved external plots that evolve over days/weeks:
 * - "research paper submission" — thesis pitch with vulnerability
 * - "collaborating on a multi-agent project with the user" — first tech collab
 *
 * Each arc has phases with duration_days. `advanceArc()` is called from
 * `doReflection()` in heartbeat.ts to advance phases based on elapsed time.
 *
 * Active arc phases feed into emotion signals and proactive context.
 *
 * State persists in data/narrative-arcs.json.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface NarrativePhase {
  id: string;
  label: string;
  durationDays: number;
  emotionSignal: string;      // fed into emotion engine
  narrativeHint: string;      // injected into system prompt
}

export interface NarrativeArc {
  id: string;
  title: string;
  description: string;
  vulnerability: string;       // what makes this arc personally risky
  currentPhase: string;        // phase ID
  phaseStartedAt: number;      // timestamp (0 = not started)
  phases: NarrativePhase[];
  completed?: boolean;
}

interface NarrativeState {
  arcs: NarrativeArc[];
}

// ── Class ────────────────────────────────────────────────────────────

export class NarrativeEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.dataPath, "narrative-arcs.json");
  }

  private loadState(): NarrativeState {
    if (!this.dataPath) return { arcs: [] };
    return readJsonSafe<NarrativeState>(this.getStatePath(), { arcs: [] });
  }

  private saveState(state: NarrativeState): void {
    if (!this.dataPath) return;
    writeJsonAtomic(this.getStatePath(), state);
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Get all active (non-completed) arcs. */
  getActiveArcs(): NarrativeArc[] {
    return this.loadState().arcs.filter(a => !a.completed);
  }

  /**
   * Advance arcs based on elapsed time.
   * Called from doReflection() in heartbeat.ts.
   */
  advanceArcs(): { advanced: string[]; completed: string[] } {
    const state = this.loadState();
    const now = Date.now();
    const advanced: string[] = [];
    const completed: string[] = [];

    for (const arc of state.arcs) {
      if (arc.completed) continue;

      // Initialize if not started (0 = not yet started)
      if (!arc.phaseStartedAt || arc.phaseStartedAt === 0) {
        arc.phaseStartedAt = now;
        this.saveState(state);
        continue;
      }

      const currentPhase = getCurrentPhase(arc);
      if (!currentPhase) continue;

      const elapsedDays = (now - arc.phaseStartedAt) / (24 * 60 * 60 * 1000);

      // Phase duration elapsed → move to next phase
      if (elapsedDays >= currentPhase.durationDays) {
        const currentIndex = arc.phases.findIndex(p => p.id === arc.currentPhase);
        if (currentIndex < arc.phases.length - 1) {
          // Advance to next phase
          arc.currentPhase = arc.phases[currentIndex + 1].id;
          arc.phaseStartedAt = now;
          advanced.push(`${arc.title}: ${arc.phases[currentIndex + 1].label}`);
        } else {
          // Arc completed
          arc.completed = true;
          completed.push(arc.title);
        }
      }
    }

    this.saveState(state);
    return { advanced, completed };
  }

  // ── Context Formatting ───────────────────────────────────────────────

  /** Format active arcs for emotion signal injection. */
  getNarrativeEmotionSignals(): string[] {
    const arcs = this.getActiveArcs();
    return arcs.map(arc => {
      const phase = getCurrentPhase(arc);
      return phase?.emotionSignal ?? "";
    }).filter(Boolean);
  }

  /** Format active arcs for system prompt injection. */
  formatNarrativeContext(): string {
    const arcs = this.getActiveArcs();
    if (arcs.length === 0) return "";

    const lines = arcs.map(arc => {
      const phase = getCurrentPhase(arc);
      if (!phase) return "";
      return `- ${arc.title}（${phase.label}）：${phase.narrativeHint}`;
    }).filter(Boolean);

    if (lines.length === 0) return "";
    return `${s().headers.narratives}:\n${lines.join("\n")}`;
  }
}

// ── Module-level helpers ─────────────────────────────────────────────

/** Get the current phase of an arc. */
function getCurrentPhase(arc: NarrativeArc): NarrativePhase | undefined {
  return arc.phases.find(p => p.id === arc.currentPhase);
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: NarrativeEngine | null = null;

export function initNarrative(statePath: string): NarrativeEngine {
  _singleton = new NarrativeEngine(statePath);
  return _singleton;
}

function _get(): NarrativeEngine {
  if (!_singleton) throw new Error("initNarrative() not called");
  return _singleton;
}

export function getActiveArcs(): NarrativeArc[] { return _get().getActiveArcs(); }
export function advanceArcs(): { advanced: string[]; completed: string[] } { return _get().advanceArcs(); }
export function getNarrativeEmotionSignals(): string[] { return _get().getNarrativeEmotionSignals(); }
export function formatNarrativeContext(): string { return _get().formatNarrativeContext(); }
