/**
 * Daily Activity Timeline — single source of truth for the character's day.
 *
 * Problem: Three independent LLM calls (heartbeat narration, emotion engine,
 * conversation) each invent conflicting details about her day (4 different
 * lunches in 2 minutes).
 *
 * Solution: A per-day log of concrete facts, generated once per schedule block
 * and enriched by conversation. All systems read from it instead of inventing.
 *
 * Data: `data/timeline/YYYY-MM-DD.json` — array of TimelineEvent per day.
 *
 * Concurrency: All LLM calls that read/write the timeline go through a single
 * async queue (`enqueueTimelineJob`) ensuring sequential execution. Each job
 * sees the timeline state left by the previous one — no concurrent invention.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { createLogger } from "./lib/logger.js";
import { pstDateStr } from "./lib/pst-date.js";
import { getCharacter } from "./character.js";

const log = createLogger("timeline");

// ── Types ────────────────────────────────────────────────────────────

export interface TimelineEvent {
  time: string;          // "12:15"
  category: string;      // from schedule block: "meal", "work", "hobby", etc.
  summary: string;       // e.g. "went to Burma Love with a friend, ordered tea leaf salad and coconut noodles"
  details?: string;      // optional longer description
  people?: string[];     // e.g. ["friend_name"]
  source: "schedule" | "narration" | "conversation";
}

// ── Module state ─────────────────────────────────────────────────────

let timelineDir = "";

export function initTimeline(statePath: string): void {
  timelineDir = path.join(statePath, "timeline");
  fs.mkdirSync(timelineDir, { recursive: true });
  log.info("timeline initialized");
}

// ── Sequential queue ─────────────────────────────────────────────────

let queue = Promise.resolve();

/**
 * Enqueue a timeline job to ensure sequential execution.
 * All LLM calls that read/write the timeline go through this.
 */
export function enqueueTimelineJob<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn, fn); // run even if previous failed
  queue = job.then(() => {}, () => {}); // swallow for chain continuity
  return job;
}

// ── File helpers ─────────────────────────────────────────────────────

function todayKey(): string {
  return pstDateStr();
}

function timelinePath(dateKey?: string): string {
  return path.join(timelineDir, `${dateKey ?? todayKey()}.json`);
}

// ── Public API ───────────────────────────────────────────────────────

/** Load today's timeline events. */
export function getTodayTimeline(): TimelineEvent[] {
  if (!timelineDir) return [];
  return readJsonSafe<TimelineEvent[]>(timelinePath(), []);
}

/** Append an event, deduplicating by time+category. */
export function addTimelineEvent(event: TimelineEvent): void {
  if (!timelineDir) {
    log.warn("addTimelineEvent called before initTimeline — event dropped:", event.category, event.summary?.slice(0, 40));
    return;
  }
  const filePath = timelinePath();
  const events = readJsonSafe<TimelineEvent[]>(filePath, []);

  // Dedup: if same category in the same hour, replace (higher-priority source wins)
  const eventHour = parseInt(event.time.split(":")[0], 10);
  const existing = events.findIndex(e => {
    const eHour = parseInt(e.time.split(":")[0], 10);
    return e.category === event.category && eHour === eventHour;
  });

  if (existing >= 0) {
    // Conversation overrides narration; narration overrides schedule
    const SOURCE_PRIORITY: Record<string, number> = { schedule: 0, narration: 1, conversation: 2 };
    const existingPriority = SOURCE_PRIORITY[events[existing].source] ?? 0;
    const newPriority = SOURCE_PRIORITY[event.source] ?? 0;
    if (newPriority >= existingPriority) {
      events[existing] = event;
      log.info(`timeline: replaced ${event.category} at ${event.time} (source: ${event.source})`);
    } else {
      log.info(`timeline: skipped lower-priority ${event.source} for ${event.category} (existing: ${events[existing].source})`);
      return;
    }
  } else {
    events.push(event);
    log.info(`timeline: added ${event.category} at ${event.time} (source: ${event.source})`);
  }

  writeJsonAtomic(filePath, events);
}

/** Get event for a specific block category at a given hour (if exists). */
export function getBlockEvent(category: string, hour: number): TimelineEvent | null {
  const events = getTodayTimeline();
  return events.find(e => {
    const eHour = parseInt(e.time.split(":")[0], 10);
    return e.category === category && eHour === hour;
  }) ?? null;
}

/** Format today's timeline for system prompt injection. */
export function formatTimelineContext(): string {
  const events = getTodayTimeline();
  if (events.length === 0) return "";

  const lines = events.map(e => {
    let line = `- ${e.time} [${e.category}] ${e.summary}`;
    if (e.people?.length) line += ` (with ${e.people.join(", ")})`;
    return line;
  });

  return `Today's timeline (established facts — conversation must be consistent with these):\n${lines.join("\n")}\n\n⚠️ Strict rules:\n- Nothing you say about activities can contradict "currently doing" and the timeline. If "currently doing" says you're commuting, you can't say you're eating.\n- When ${getCharacter().user.name} asks what you're doing / if you're off work / what you're up to, use the most recent timeline event to answer — be specific (e.g. "dealing with an urgent rebalancing email from the NY client"), not vague (e.g. "wrapping up emails").\n- Don't invent activity details not in the timeline (what you ate, where you went), unless the timeline explicitly mentions them.`;
}
