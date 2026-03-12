/**
 * Lightweight state event bus — decoupled pub/sub for cross-module state changes.
 *
 * Modules emit typed events instead of directly importing each other.
 * Brainstem subscribes to all state changes in one place (Step 8).
 */

import { createLogger } from "./logger.js";

const log = createLogger("state-bus");

// ── Event types ─────────────────────────────────────────────────────

export type StateEvent =
  | { type: "commitment:new"; key: string; what: string; deadline?: number }
  | { type: "commitment:fulfilled"; key: string }
  | { type: "emotion:updated"; valence: number; cause: string }
  | { type: "episode:added"; topic: string; significance: number }
  | { type: "user:mood_changed"; mood: number }
  | { type: "goal:progress"; goalId: string; delta: number }
  | { type: "memory:saved"; category: string; key: string }
  | { type: "activity:started"; activity: string }
  | { type: "activity:completed"; activity: string; outcome?: string };

// ── Bus implementation ──────────────────────────────────────────────

type Listener = (event: StateEvent) => void;

const listeners: Map<string, Set<Listener>> = new Map();

/** Subscribe to events of a specific type. Returns an unsubscribe function. */
export function onState(type: StateEvent["type"], fn: Listener): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(fn);
  return () => { set!.delete(fn); };
}

/** Subscribe to ALL events (for logging/debugging). */
export function onAnyState(fn: Listener): () => void {
  let set = listeners.get("*");
  if (!set) {
    set = new Set();
    listeners.set("*", set);
  }
  set.add(fn);
  return () => { set!.delete(fn); };
}

/** Emit a state event to all subscribers. */
export function emitState(event: StateEvent): void {
  // Type-specific listeners
  const typeListeners = listeners.get(event.type);
  if (typeListeners) {
    for (const fn of typeListeners) {
      try { fn(event); } catch (err) {
        log.warn(`state-bus listener error for ${event.type}`, err);
      }
    }
  }

  // Wildcard listeners
  const anyListeners = listeners.get("*");
  if (anyListeners) {
    for (const fn of anyListeners) {
      try { fn(event); } catch (err) {
        log.warn(`state-bus wildcard listener error`, err);
      }
    }
  }
}

/** Remove all listeners (useful for tests). */
export function clearStateBus(): void {
  listeners.clear();
}
