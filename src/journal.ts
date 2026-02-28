/**
 * Long-form journaling — the character writes diary entries during reflection.
 *
 * Each entry is 300-500 chars, captures the day's highlights, mood, and themes.
 * References past entries for continuity.
 *
 * State persists in diary.json. Last 2-3 entries are injected into
 * the system prompt as "my recent diary" section.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface DiaryEntry {
  date: string;             // ISO date
  content: string;          // 300-500 chars, in the character's voice
  mood: string;             // mood label
  themes: string[];         // e.g. ["work", "friends", "pet"]
  referencedPast?: string[];// dates of past entries referenced
}

interface DiaryState {
  entries: DiaryEntry[];
}

// ── Class ────────────────────────────────────────────────────────────

export class JournalEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.dataPath, "diary.json");
  }

  loadDiary(): DiaryState {
    if (!this.dataPath) return { entries: [] };
    return readJsonSafe<DiaryState>(this.getStatePath(), { entries: [] });
  }

  private saveDiary(state: DiaryState): void {
    if (!this.dataPath) return;
    // Keep last 30 entries (~1 month)
    if (state.entries.length > 30) {
      state.entries = state.entries.slice(-30);
    }
    writeJsonAtomic(this.getStatePath(), state);
  }

  // ── Updates ──────────────────────────────────────────────────────────

  /** Add a new diary entry (called from reflection in heartbeat). */
  addDiaryEntry(entry: DiaryEntry): void {
    const state = this.loadDiary();
    // Don't duplicate entries for the same date
    const existing = state.entries.find(e => e.date === entry.date);
    if (existing) {
      Object.assign(existing, entry);
    } else {
      state.entries.push(entry);
    }
    this.saveDiary(state);
  }

  /** Get recent entries for context injection (last 3). */
  getRecentDiaryEntries(count = 3): DiaryEntry[] {
    const state = this.loadDiary();
    return state.entries.slice(-count);
  }

  // ── Formatting ───────────────────────────────────────────────────────

  /** Format recent diary entries for system prompt. */
  formatDiaryContext(): string {
    const entries = this.getRecentDiaryEntries(3);
    if (entries.length === 0) return "";

    const formatted = entries.map(e => {
      return `[${e.date}] ${e.content}`;
    }).join("\n\n");

    return `${s().headers.my_diary}:\n${formatted}`;
  }

  /** Get past entry dates for LLM to reference when writing new entries. */
  getPastEntryDates(): string[] {
    const state = this.loadDiary();
    return state.entries.map(e => e.date);
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: JournalEngine | null = null;

export function initJournal(statePath: string): JournalEngine {
  _singleton = new JournalEngine(statePath);
  return _singleton;
}

function _get(): JournalEngine {
  if (!_singleton) throw new Error("initJournal() not called");
  return _singleton;
}

export function loadDiary(): DiaryState { return _get().loadDiary(); }
export function addDiaryEntry(entry: DiaryEntry): void { _get().addDiaryEntry(entry); }
export function getRecentDiaryEntries(count = 3): DiaryEntry[] { return _get().getRecentDiaryEntries(count); }
export function formatDiaryContext(): string { return _get().formatDiaryContext(); }
export function getPastEntryDates(): string[] { return _get().getPastEntryDates(); }
