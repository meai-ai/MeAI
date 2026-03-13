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

// ── TimelineEngine class ─────────────────────────────────────────────

export class TimelineEngine {
  private timelineDir: string;
  private queue = Promise.resolve();

  constructor(statePath: string) {
    this.timelineDir = path.join(statePath, "timeline");
    fs.mkdirSync(this.timelineDir, { recursive: true });
    log.info("timeline initialized");
  }

  /** Enqueue a timeline job to ensure sequential execution. */
  enqueueTimelineJob<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn, fn);
    this.queue = job.then(() => {}, () => {});
    return job;
  }

  private todayKey(): string {
    return pstDateStr();
  }

  private timelinePath(dateKey?: string): string {
    return path.join(this.timelineDir, `${dateKey ?? this.todayKey()}.json`);
  }

  /** Load today's timeline events. */
  getTodayTimeline(): TimelineEvent[] {
    if (!this.timelineDir) return [];
    return readJsonSafe<TimelineEvent[]>(this.timelinePath(), []);
  }

  /** Append an event, deduplicating by time+category. */
  addTimelineEvent(event: TimelineEvent): void {
    if (!this.timelineDir) {
      log.warn("addTimelineEvent called before init — event dropped:", event.category, event.summary?.slice(0, 40));
      return;
    }
    const filePath = this.timelinePath();
    const events = readJsonSafe<TimelineEvent[]>(filePath, []);

    const eventHour = parseInt(event.time.split(":")[0], 10);
    const existing = events.findIndex(e => {
      const eHour = parseInt(e.time.split(":")[0], 10);
      return e.category === event.category && eHour === eventHour;
    });

    if (existing >= 0) {
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

    // Sort chronologically by time string
    events.sort((a, b) => a.time.localeCompare(b.time));

    writeJsonAtomic(filePath, events);
  }

  /** Get event for a specific block category at a given hour (if exists). */
  getBlockEvent(category: string, hour: number): TimelineEvent | null {
    const events = this.getTodayTimeline();
    return events.find(e => {
      const eHour = parseInt(e.time.split(":")[0], 10);
      return e.category === category && eHour === hour;
    }) ?? null;
  }

  /** Format today's timeline for system prompt injection. */
  formatTimelineContext(): string {
    const allEvents = this.getTodayTimeline();
    if (allEvents.length === 0) return "";

    // Keep last 3 events for prompt injection (token budget).
    // Full timeline stays in file for analysis/emotion.
    const events = allEvents.slice(-3);
    const skipped = allEvents.length - events.length;

    const lines = events.map((e) => {
      let line = `${e.time} ${e.summary}`;
      if (Array.isArray(e.people) && e.people.length) line += ` (${e.people.join(", ")})`;
      return line;
    });
    if (skipped > 0) lines.unshift(`(${skipped} earlier entries omitted)`);

    return `[recent] ${lines.join(" -> ")}\nTimeline > schedule. When they conflict, always follow the timeline. Infer location from timeline.`;
  }
}

// ── Singleton backward compat ────────────────────────────────────────

let _singleton: TimelineEngine | null = null;

export function initTimeline(statePath: string): TimelineEngine {
  _singleton = new TimelineEngine(statePath);
  return _singleton;
}

export function enqueueTimelineJob<T>(fn: () => Promise<T>): Promise<T> {
  return _singleton!.enqueueTimelineJob(fn);
}

export function getTodayTimeline(): TimelineEvent[] {
  return _singleton!.getTodayTimeline();
}

export function addTimelineEvent(event: TimelineEvent): void {
  return _singleton!.addTimelineEvent(event);
}

export function getBlockEvent(category: string, hour: number): TimelineEvent | null {
  return _singleton!.getBlockEvent(category, hour);
}

export function formatTimelineContext(): string {
  return _singleton!.formatTimelineContext();
}
