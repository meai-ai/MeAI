/**
 * Entertainment state tracker — what the character is currently consuming.
 *
 * Tracks what shows, podcasts, music, and books she's actively
 * watching/listening/reading, so she can naturally reference them
 * in conversation.
 *
 * This is separate from interests.ts (which discovers NEW content)
 * and curiosity.ts (which explores topics). This tracks what she's
 * actually consuming day to day.
 *
 * State persists in entertainment-state.json.
 */

import fs from "node:fs";
import path from "node:path";
import { pstDateStr } from "./lib/pst-date.js";
import { getCharacter } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface EntertainmentState {
  // Currently following
  currentShows: Array<{
    title: string;          // "Severance S2"
    status: string;         // e.g. "on episode 4" | "just started watching"
    reaction?: string;      // e.g. "this show is amazing"
  }>;
  currentPodcasts: Array<{
    title: string;          // "All-In Podcast"
    recentEpisode?: string; // e.g. "E174 about AI agents"
  }>;
  currentMusic: string | null;  // e.g. "on repeat: Seve — Tez Cadey"
  currentBook: string | null;   // e.g. "reading 'Thinking in Bets'"

  // Recently consumed (last 5)
  recentlyWatched: Array<{
    title: string;
    reaction: string;       // e.g. "cried watching it" | "it was okay" | "loved it"
    date: string;           // ISO date
  }>;
  recentlyListened: Array<{
    title: string;
    reaction: string;
    date: string;
  }>;

  lastUpdated: string;
}

// ── Class ────────────────────────────────────────────────────────────

export class EntertainmentEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.dataPath, "entertainment-state.json");
  }

  loadEntertainmentState(): EntertainmentState {
    if (!this.dataPath) return defaultState();
    const p = this.getStatePath();
    if (!fs.existsSync(p)) return defaultState();
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as EntertainmentState;
    } catch {
      return defaultState();
    }
  }

  saveEntertainmentState(state: EntertainmentState): void {
    if (!this.dataPath) return;
    state.lastUpdated = pstDateStr();
    fs.writeFileSync(this.getStatePath(), JSON.stringify(state, null, 2) + "\n");
  }

  // ── Updates ──────────────────────────────────────────────────────────

  /** Start watching a new show */
  startWatching(title: string, status?: string): void {
    const state = this.loadEntertainmentState();
    // Check if already watching
    const existing = state.currentShows.find(s => s.title === title);
    if (existing) {
      if (status) existing.status = status;
      this.saveEntertainmentState(state);
      return;
    }
    state.currentShows.push({ title, status: status ?? "started watching" });
    // Cap at 3 current shows
    if (state.currentShows.length > 3) {
      const finished = state.currentShows.shift()!;
      state.recentlyWatched.push({
        title: finished.title,
        reaction: finished.reaction ?? "it was okay",
        date: pstDateStr(),
      });
    }
    this.saveEntertainmentState(state);
  }

  /** Update music */
  updateMusic(music: string | null): void {
    const state = this.loadEntertainmentState();
    state.currentMusic = music;
    this.saveEntertainmentState(state);
  }

  /** Update book */
  updateBook(book: string | null): void {
    const state = this.loadEntertainmentState();
    state.currentBook = book;
    this.saveEntertainmentState(state);
  }

  // ── Formatting ───────────────────────────────────────────────────────

  /** Format entertainment state for system prompt context */
  formatEntertainmentContext(): string {
    const state = this.loadEntertainmentState();
    const lines: string[] = [];

    // Shows
    if (state.currentShows.length > 0) {
      const shows = state.currentShows.map(s => `${s.title} (${s.status})`).join(", ");
      lines.push(`Currently watching: ${shows}`);
    }

    // Music
    if (state.currentMusic) {
      lines.push(`Listening to: ${state.currentMusic}`);
    }

    // Podcasts
    if (state.currentPodcasts.length > 0) {
      const podcasts = state.currentPodcasts
        .map(p => p.recentEpisode ? `${p.title} (${p.recentEpisode})` : p.title)
        .join(", ");
      lines.push(`Regular podcasts: ${podcasts}`);
    }

    // Book
    if (state.currentBook) {
      lines.push(`Currently reading: ${state.currentBook}`);
    }

    if (lines.length === 0) return "";
    return lines.join("\n");
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: EntertainmentEngine | null = null;

export function initEntertainment(statePath: string): EntertainmentEngine {
  _singleton = new EntertainmentEngine(statePath);
  return _singleton;
}

function _get(): EntertainmentEngine {
  if (!_singleton) throw new Error("initEntertainment() not called");
  return _singleton;
}

export function loadEntertainmentState(): EntertainmentState { return _get().loadEntertainmentState(); }
export function saveEntertainmentState(state: EntertainmentState): void { _get().saveEntertainmentState(state); }
export function startWatching(title: string, status?: string): void { _get().startWatching(title, status); }
export function updateMusic(music: string | null): void { _get().updateMusic(music); }
export function updateBook(book: string | null): void { _get().updateBook(book); }
export function formatEntertainmentContext(): string { return _get().formatEntertainmentContext(); }

// ── Module-level helpers ─────────────────────────────────────────────

function defaultState(): EntertainmentState {
  // Seed from character.yaml hobbies if available
  const char = getCharacter();
  const h = char.hobbies as Record<string, Record<string, unknown>>;
  const entertainment = h.entertainment ?? {};

  return {
    currentShows: (entertainment.initial_shows as EntertainmentState["currentShows"]) ?? [],
    currentPodcasts: (entertainment.initial_podcasts as EntertainmentState["currentPodcasts"]) ?? [],
    currentMusic: (entertainment.initial_music as string) ?? null,
    currentBook: null,
    recentlyWatched: [],
    recentlyListened: [],
    lastUpdated: pstDateStr(),
  };
}
