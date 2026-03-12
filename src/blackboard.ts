/**
 * Blackboard — typed TTL patch store with consumption semantics.
 *
 * Phase E: Bridge between background processes (heartbeat, reflection)
 * and the conversation loop (TurnDirective).
 *
 * Each read() decays salience by 30%, so a spike influences ~2-3 turns
 * then fades. Patches with salience < 0.05 are GC'd.
 */

export type PatchType =
  | "curiosity_spike"
  | "reflection_insight"
  | "social_signal"
  | "unresolved_commitment"
  | "growth_marker"
  | "identity_followup"
  | "behavioral_prior";

export interface BlackboardPatch {
  source: "heartbeat" | "reflection" | "external";
  type: PatchType;
  payload: Record<string, unknown>;
  salience: number;
  ttl: number;
  createdAt: number;
  consumedCount: number;
}

/** Snapshot of a patch's key fields, safe from mutation. */
export interface PatchSnapshot {
  type: PatchType;
  payload: Record<string, unknown>;
  salience: number;
  createdAt: number;
}

const SALIENCE_DECAY_PER_READ = 0.3;
const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes

class Blackboard {
  private patches: BlackboardPatch[] = [];

  write(patch: Omit<BlackboardPatch, "createdAt" | "consumedCount">): void {
    this.patches.push({ ...patch, createdAt: Date.now(), consumedCount: 0 });
  }

  /** Read and consume — decays salience, increments consumedCount. */
  read(type?: PatchType): BlackboardPatch[] {
    this.gc();
    const result = type ? this.patches.filter(p => p.type === type) : [...this.patches];
    for (const p of result) {
      p.consumedCount++;
      p.salience *= (1 - SALIENCE_DECAY_PER_READ);
    }
    return result;
  }

  /**
   * Peek without consuming — returns snapshots (copies) safe from mutation.
   * GC runs to prune expired patches but that's housekeeping, not consumption.
   */
  peek(type?: PatchType): PatchSnapshot[] {
    this.gc();
    const source = type ? this.patches.filter(p => p.type === type) : this.patches;
    return source.map(p => ({
      type: p.type,
      payload: p.payload,
      salience: p.salience,
      createdAt: p.createdAt,
    }));
  }

  /**
   * Consume only patches matching a predicate — decays salience on matched patches only.
   * Returns snapshots of the consumed patches with their PRE-decay salience.
   */
  consume(type: PatchType, predicate: (p: BlackboardPatch) => boolean): PatchSnapshot[] {
    this.gc();
    const matching = this.patches.filter(p => p.type === type && predicate(p));
    // Snapshot pre-decay salience
    const snapshots: PatchSnapshot[] = matching.map(p => ({
      type: p.type,
      payload: p.payload,
      salience: p.salience,
      createdAt: p.createdAt,
    }));
    // Apply decay to the live patches
    for (const p of matching) {
      p.consumedCount++;
      p.salience *= (1 - SALIENCE_DECAY_PER_READ);
    }
    return snapshots;
  }

  private gc(): void {
    const now = Date.now();
    this.patches = this.patches.filter(p =>
      now - p.createdAt < p.ttl && p.salience > 0.05
    );
  }
}

export const blackboard = new Blackboard();
export { DEFAULT_TTL };
