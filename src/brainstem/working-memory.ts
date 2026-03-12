/**
 * Working Memory Slots — explicit short-term memory for tracking
 * what the character is actively holding in mind.
 *
 * 5 named slots with decay: current_focus, background, goal_active,
 * recent_surprise, open_question. Content auto-evicts when strength < 0.05.
 */

// ── Types ────────────────────────────────────────────────────────────

export type SlotName =
  | "current_focus"
  | "background"
  | "goal_active"
  | "recent_surprise"
  | "open_question";

export interface WMSlot {
  name: SlotName;
  conceptId: string | null;
  label: string;
  loadedAt: number;
  decayRate: number;       // per-tick decay
  strength: number;        // 0-1, decays each tick
  metadata?: Record<string, unknown>;
}

export interface CommitLogEntry {
  slotName: SlotName;
  conceptId: string;
  loadedAt: number;
  evictedAt: number;
  reason: string;
}

export interface WorkingMemory {
  slots: Record<SlotName, WMSlot>;
  commitLog: CommitLogEntry[];
}

// ── Decay rates per slot (per tick @ 3s) ─────────────────────────────

const DECAY_RATES: Record<SlotName, number> = {
  current_focus: 0.002,
  background: 0.001,
  goal_active: 0.0005,
  recent_surprise: 0.003,
  open_question: 0.001,
};

// ── Factory ──────────────────────────────────────────────────────────

function createEmptySlot(name: SlotName): WMSlot {
  return {
    name,
    conceptId: null,
    label: "",
    loadedAt: 0,
    decayRate: DECAY_RATES[name],
    strength: 0,
  };
}

export function createWorkingMemory(): WorkingMemory {
  return {
    slots: {
      current_focus: createEmptySlot("current_focus"),
      background: createEmptySlot("background"),
      goal_active: createEmptySlot("goal_active"),
      recent_surprise: createEmptySlot("recent_surprise"),
      open_question: createEmptySlot("open_question"),
    },
    commitLog: [],
  };
}

// ── Operations ───────────────────────────────────────────────────────

/** Load a concept into a named slot. Previous occupant is committed. */
export function loadSlot(
  wm: WorkingMemory,
  slotName: SlotName,
  conceptId: string,
  label: string,
  clock: number,
  metadata?: Record<string, unknown>,
): void {
  const slot = wm.slots[slotName];

  // Commit previous occupant if present
  if (slot.conceptId && slot.conceptId !== conceptId) {
    commitSlot(wm, slotName, "displaced", clock);
  }

  slot.conceptId = conceptId;
  slot.label = label;
  slot.loadedAt = clock;
  slot.strength = 1.0;
  slot.metadata = metadata;
}

/** Decay all slot strengths; evict if strength < 0.05. */
export function tickWorkingMemory(wm: WorkingMemory, clockMs: number): void {
  for (const slot of Object.values(wm.slots)) {
    if (!slot.conceptId) continue;

    slot.strength = Math.max(0, slot.strength - slot.decayRate);

    if (slot.strength < 0.05) {
      commitSlot(wm, slot.name, "decayed", clockMs);
    }
  }
}

/** Move slot content to commitLog, clear slot. */
export function commitSlot(
  wm: WorkingMemory,
  slotName: SlotName,
  reason: string,
  clockMs: number,
): void {
  const slot = wm.slots[slotName];
  if (!slot.conceptId) return;

  wm.commitLog.push({
    slotName,
    conceptId: slot.conceptId,
    loadedAt: slot.loadedAt,
    evictedAt: clockMs,
    reason,
  });

  // Cap commit log
  if (wm.commitLog.length > 50) {
    wm.commitLog = wm.commitLog.slice(-50);
  }

  // Clear slot
  slot.conceptId = null;
  slot.label = "";
  slot.loadedAt = 0;
  slot.strength = 0;
  slot.metadata = undefined;
}

// ── Query ────────────────────────────────────────────────────────────

/** Get all non-empty slots for context formatting. */
export function getActiveSlots(wm: WorkingMemory): WMSlot[] {
  return Object.values(wm.slots).filter(s => s.conceptId !== null);
}

/** Serialize WM slots for persistence (only non-empty slots). */
export function serializeWorkingMemory(wm: WorkingMemory): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, slot] of Object.entries(wm.slots)) {
    if (slot.conceptId) {
      result[name] = {
        conceptId: slot.conceptId,
        label: slot.label,
        loadedAt: slot.loadedAt,
        strength: slot.strength,
        metadata: slot.metadata,
      };
    }
  }
  return result;
}

/** Restore WM slots from persisted data. */
export function restoreWorkingMemory(wm: WorkingMemory, data: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(data)) {
    if (!(name in wm.slots)) continue;
    const slotName = name as SlotName;
    const saved = raw as { conceptId?: string; label?: string; loadedAt?: number; strength?: number; metadata?: Record<string, unknown> };
    if (saved.conceptId && saved.strength && saved.strength > 0.05) {
      const slot = wm.slots[slotName];
      slot.conceptId = saved.conceptId;
      slot.label = saved.label ?? "";
      slot.loadedAt = saved.loadedAt ?? 0;
      slot.strength = saved.strength;
      slot.decayRate = DECAY_RATES[slotName];
      slot.metadata = saved.metadata;
    }
  }
}

/** Format working memory for system prompt. */
export function formatWorkingMemoryContext(wm: WorkingMemory): string {
  const active = getActiveSlots(wm);
  if (active.length === 0) return "";

  const SLOT_LABELS: Record<SlotName, string> = {
    current_focus: "Current focus",
    background: "Background attention",
    goal_active: "Active goal",
    recent_surprise: "Unexpected discovery",
    open_question: "Open question",
  };

  const items = active.map(s =>
    `${SLOT_LABELS[s.name]}: ${s.label} (strength ${(s.strength * 100).toFixed(0)}%)`,
  );

  return `Working memory: ${items.join("; ")}`;
}
