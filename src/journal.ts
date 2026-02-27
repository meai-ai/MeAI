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

// ── Module State ─────────────────────────────────────────────────────

let dataPath = "";

export function initJournal(statePath: string): void {
  dataPath = statePath;
}

// ── Persistence ──────────────────────────────────────────────────────

function getStatePath(): string {
  return path.join(dataPath, "diary.json");
}

export function loadDiary(): DiaryState {
  if (!dataPath) return { entries: [] };
  return readJsonSafe<DiaryState>(getStatePath(), { entries: [] });
}

function saveDiary(state: DiaryState): void {
  if (!dataPath) return;
  // Keep last 30 entries (~1 month)
  if (state.entries.length > 30) {
    state.entries = state.entries.slice(-30);
  }
  writeJsonAtomic(getStatePath(), state);
}

// ── Updates ──────────────────────────────────────────────────────────

/** Add a new diary entry (called from reflection in heartbeat). */
export function addDiaryEntry(entry: DiaryEntry): void {
  const state = loadDiary();
  // Don't duplicate entries for the same date
  const existing = state.entries.find(e => e.date === entry.date);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    state.entries.push(entry);
  }
  saveDiary(state);
}

/** Get recent entries for context injection (last 3). */
export function getRecentDiaryEntries(count = 3): DiaryEntry[] {
  const state = loadDiary();
  return state.entries.slice(-count);
}

// ── Formatting ───────────────────────────────────────────────────────

/** Format recent diary entries for system prompt. */
export function formatDiaryContext(): string {
  const entries = getRecentDiaryEntries(3);
  if (entries.length === 0) return "";

  const formatted = entries.map(e => {
    return `[${e.date}] ${e.content}`;
  }).join("\n\n");

  return `${s().headers.my_diary}:\n${formatted}`;
}

/** Get past entry dates for LLM to reference when writing new entries. */
export function getPastEntryDates(): string[] {
  const state = loadDiary();
  return state.entries.map(e => e.date);
}
