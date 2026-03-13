/**
 * Intent Capture — track plans and commitments from conversation.
 *
 * v1 design principles: high precision, low recall. Better to miss weak intents
 * than to capture noise.
 * - capture → store → show → light schedule injection
 * - No automatic completion detection (v2 will use LLM semantic comparison)
 * - scheduled expired → rollback to pending → expired after schedule cycle
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";

// ── Types ────────────────────────────────────────────────────────────

export interface Intent {
  id: string;              // "intent_1709817600000_a3f2"
  what: string;            // the commitment or plan
  when: string | null;     // "weekend" | "tomorrow" | null (original natural language)
  deadline: string | null; // parsed ISO date "2026-03-08"
  priority: "high" | "medium" | "low";
  status: "pending" | "scheduled" | "expired";
  createdAt: number;
  scheduledDate?: string;  // which day it was scheduled for
  scheduleCount: number;   // markScheduled() increments each time
  context?: string;        // contextual note
  url?: string;            // associated URL from conversation or memory
}

// ── Module state ─────────────────────────────────────────────────────

let _statePath = "";
let _intents: Intent[] = [];

function getIntentsPath(): string {
  return path.join(_statePath, "intents.json");
}

function load(): void {
  _intents = readJsonSafe<Intent[]>(getIntentsPath(), []);
}

function save(): void {
  writeJsonAtomic(getIntentsPath(), _intents);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initIntents(statePath: string): void {
  _statePath = statePath;
  load();
  expireStaleIntents();
  console.log(`[intents] Initialized with ${_intents.length} intents (${_intents.filter(i => i.status === "pending").length} pending)`);
}

// ── Deadline parsing ─────────────────────────────────────────────────

function parseDeadline(when: string | null): string | null {
  if (!when) return null;
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));

  if (/weekend/i.test(when)) {
    // Next Saturday
    const dayOfWeek = pst.getDay();
    const daysUntilSat = dayOfWeek <= 6 ? (6 - dayOfWeek) || 7 : 1;
    const sat = new Date(pst);
    sat.setDate(sat.getDate() + (daysUntilSat === 0 ? 7 : daysUntilSat));
    return sat.toISOString().slice(0, 10);
  }
  if (/tomorrow/i.test(when)) {
    const tomorrow = new Date(pst);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  }
  if (/next week/i.test(when)) {
    const dayOfWeek = pst.getDay();
    const daysUntilMon = (8 - dayOfWeek) % 7 || 7;
    const mon = new Date(pst);
    mon.setDate(mon.getDate() + daysUntilMon);
    return mon.toISOString().slice(0, 10);
  }
  return null;
}

// ── Dedup normalization ──────────────────────────────────────────────

function normalize(s: string): string {
  return s.replace(/[,.!?;:'"()\s]+/g, " ").trim().toLowerCase();
}

function isDuplicate(what: string): boolean {
  const normNew = normalize(what);
  if (normNew.length < 3) return false;
  return _intents.some(i => {
    if (i.status === "expired") return false;
    const normExisting = normalize(i.what);
    // Substring overlap > 70%
    const shorter = normNew.length < normExisting.length ? normNew : normExisting;
    const longer = normNew.length >= normExisting.length ? normNew : normExisting;
    if (longer.includes(shorter)) return true;
    // Character overlap ratio
    const overlap = [...shorter].filter(c => longer.includes(c)).length;
    return overlap / shorter.length > 0.7;
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function addIntent(opts: {
  what: string;
  when?: string | null;
  priority?: "high" | "medium" | "low";
  context?: string;
  url?: string;
}): Intent | null {
  expireStaleIntents();
  if (isDuplicate(opts.what)) {
    console.log(`[intents] Skipped duplicate: "${opts.what}"`);
    return null;
  }

  // If no URL provided, try to find one from memory store
  let url = opts.url;
  if (!url) {
    try {
      const { getStoreManager } = require("./memory/store-manager.js");
      const memories = getStoreManager().loadAll();
      const whatLower = opts.what.toLowerCase();
      const keywords = whatLower.replace(/[^\w\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
      for (const m of memories) {
        const text = `${m.key} ${m.value}`.toLowerCase();
        if (keywords.some(kw => text.includes(kw))) {
          const urlMatch = m.value.match(/https?:\/\/[^\s,)]+/);
          if (urlMatch) {
            url = urlMatch[0];
            console.log(`[intents] Found URL from memory "${m.key}": ${url}`);
            break;
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  const intent: Intent = {
    id: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    what: opts.what,
    when: opts.when ?? null,
    deadline: parseDeadline(opts.when ?? null),
    priority: opts.priority ?? "medium",
    status: "pending",
    createdAt: Date.now(),
    scheduleCount: 0,
    context: opts.context,
    url,
  };

  _intents.push(intent);
  save();
  console.log(`[intents] Added: "${intent.what}" (deadline=${intent.deadline ?? "none"}, priority=${intent.priority})`);
  return intent;
}

export function getPendingIntents(): Intent[] {
  expireStaleIntents();
  return _intents.filter(i => i.status === "pending");
}

export function markScheduled(id: string, date: string): void {
  const intent = _intents.find(i => i.id === id);
  if (!intent) return;
  intent.status = "scheduled";
  intent.scheduledDate = date;
  intent.scheduleCount++;
  save();
  console.log(`[intents] Scheduled: "${intent.what}" → ${date} (count=${intent.scheduleCount})`);
}

// ── Expiration ───────────────────────────────────────────────────────

export function expireStaleIntents(): void {
  const now = Date.now();
  const todayStr = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    .toISOString().slice(0, 10);
  let changed = false;

  for (const intent of _intents) {
    if (intent.status === "expired") continue;

    // pending + deadline passed → expired
    if (intent.status === "pending" && intent.deadline) {
      if (intent.deadline < todayStr) {
        intent.status = "expired";
        changed = true;
        console.log(`[intents] Expired (deadline passed): "${intent.what}"`);
        continue;
      }
    }

    // pending + no deadline + >3 days old → expired (tightened from 7d)
    if (intent.status === "pending" && !intent.deadline) {
      if (now - intent.createdAt > 3 * 24 * 60 * 60 * 1000) {
        intent.status = "expired";
        changed = true;
        console.log(`[intents] Expired (3d no deadline): "${intent.what}"`);
        continue;
      }
    }

    // scheduled + scheduledDate is yesterday → expire immediately
    // Most intents are one-shot actions; if they weren't fulfilled on the scheduled day,
    // they're stale. Only high-priority intents with explicit deadlines survive.
    if (intent.status === "scheduled" && intent.scheduledDate) {
      if (intent.scheduledDate < todayStr) {
        if (intent.priority === "high" && intent.deadline && intent.deadline >= todayStr) {
          // High-priority with future deadline → rollback to pending for re-scheduling
          intent.status = "pending";
          changed = true;
          console.log(`[intents] Rolled back to pending (high-pri, deadline ${intent.deadline}): "${intent.what}"`);
        } else {
          intent.status = "expired";
          changed = true;
          console.log(`[intents] Expired (scheduled day passed): "${intent.what}"`);
        }
        continue;
      }
    }
  }

  if (changed) save();
}

// ── Formatting ───────────────────────────────────────────────────────

/** For schedule generation — concise list of pending intents with context */
export function formatIntentsForSchedule(): string {
  expireStaleIntents();
  const pending = _intents.filter(i => i.status === "pending");
  if (pending.length === 0) return "";

  return pending.map(i => {
    const deadline = i.deadline ? ` (by ${i.deadline})` : i.when ? ` (${i.when})` : "";
    const prio = i.priority === "high" ? " [high priority]" : "";
    const ctx = i.context ? ` — ${i.context}` : "";
    return `- ${i.what}${deadline}${prio}${ctx}`;
  }).join("\n");
}

/** For conversation prompt — dense format, capped at 5 pending + 3 scheduled */
export function formatIntentContext(): string {
  expireStaleIntents();

  // Sort by priority (high > medium > low), then by recency
  const prioOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortByPriority = (a: Intent, b: Intent) =>
    (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1) || b.createdAt - a.createdAt;

  const pending = _intents.filter(i => i.status === "pending").sort(sortByPriority).slice(0, 5);
  const scheduled = _intents.filter(i => i.status === "scheduled").sort(sortByPriority).slice(0, 3);

  if (pending.length === 0 && scheduled.length === 0) return "";

  const formatItem = (i: Intent) => {
    const deadline = i.deadline ? `(by ${i.deadline})` : i.when ? `(${i.when})` : "";
    return `${i.what}${deadline}`;
  };

  const parts: string[] = [];
  if (pending.length > 0) {
    parts.push(`[pending] ${pending.map(formatItem).join(" | ")}`);
  }
  if (scheduled.length > 0) {
    parts.push(`[scheduled] ${scheduled.map(i => `${i.what}(${i.scheduledDate})`).join(" | ")}`);
  }

  return `## Commitments\n${parts.join("\n")}\nNaturally check progress on scheduled items; don't repeatedly bring up pending items.`;
}
