/**
 * Hobby progression tracker — makes the character's hobbies real.
 *
 * Instead of hobbies being static labels in IDENTITY.md, this module
 * tracks actual progress across days/weeks:
 * - Pottery: current project, sessions, milestones
 * - Tennis: matches, partners, improvement
 * - Drums: current song, practice hours, level
 * - Cooking: recent dishes, new recipes, specialties
 * - Running: frequency, routes, pace
 * - Vibe coding: current project, recent completions
 *
 * State persists in hobby-progress.json and feeds into:
 * 1. world.ts — schedule generation knows when she last practiced
 * 2. emotion.ts — hobby milestones trigger positive mood
 * 3. proactive.ts — share exciting hobby moments with the user
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";
import { getCharacter, s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface HobbyProgress {
  pottery: {
    sessionsTotal: number;
    currentProject: string | null;   // e.g. "working on a teapot"
    projectStatus: string;           // e.g. "glazed and waiting for kiln" | "shaping initial form"
    lastSession: string;             // ISO date
    milestones: string[];            // e.g. ["first bowl finally came out straight"]
  };
  tennis: {
    matchesThisMonth: number;
    lastPlayed: string;              // ISO date
    recentPartner: string | null;    // e.g. "played with Mia"
    note: string | null;             // e.g. "backhand improving"
  };
  drums: {
    currentSong: string | null;      // e.g. "practicing Hotel California"
    practiceThisWeek: number;        // sessions
    lastPractice: string;            // ISO date
    level: string;                   // e.g. "beginner" | "can keep rhythm" | "can play simple songs"
  };
  cooking: {
    recentDishes: string[];          // last 5 dishes
    newRecipe: string | null;        // e.g. "trying to make braised beef"
    specialties: string[];           // e.g. ["beef stew", "pasta"]
  };
  running: {
    runsThisWeek: number;
    lastRun: string;                 // ISO date
    usualRoute: string;              // e.g. "along Marina Green"
    recentPace: string | null;       // e.g. "about 6min/km"
  };
  vibeCoding: {
    currentProject: string | null;   // e.g. "building a portfolio dashboard"
    recentCompletions: string[];     // e.g. ["pet weight tracker", "podcast notes organizer"]
    lastCoded: string;               // ISO date
  };
  lastUpdated: string;               // ISO date
  meta?: Record<string, HobbyMeta>;
}

export interface HobbyMeta {
  skillLevel: number;        // 0-100
  abandonmentRisk: number;   // 0-1
  lastActive: string;        // ISO date
  totalSessions: number;
  /** 8.1: Skill progression tracking */
  progression?: SkillProgression;
}

/** 8.1: Detailed skill progression for each hobby. */
export interface SkillProgression {
  focusArea: string;             // e.g. "practicing backhand slice"
  nextChallenge: string;         // e.g. "want to learn topspin"
  confidenceLevel: number;       // 0-1
  recentBreakthroughs: string[]; // e.g. ["can finally rally 10 shots in a row"]
  frustrations: string[];        // e.g. ["backhand always goes out"]
}

// ── Class ────────────────────────────────────────────────────────────

export class HobbiesEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.dataPath, "hobby-progress.json");
  }

  loadHobbyProgress(): HobbyProgress {
    if (!this.dataPath) return defaultProgress();
    const p = this.getStatePath();
    if (!fs.existsSync(p)) return defaultProgress();
    return readJsonSafe<HobbyProgress>(p, defaultProgress());
  }

  saveHobbyProgress(progress: HobbyProgress): void {
    if (!this.dataPath) return;
    progress.lastUpdated = pstDateStr();
    writeJsonAtomic(this.getStatePath(), progress);
  }

  // ── Updates ──────────────────────────────────────────────────────────

  /** Record a pottery session */
  recordPotterySession(detail?: string): void {
    const progress = this.loadHobbyProgress();
    progress.pottery.sessionsTotal++;
    progress.pottery.lastSession = pstDateStr();
    if (detail) {
      progress.pottery.projectStatus = detail;
    }
    this.saveHobbyProgress(progress);
  }

  /** Record a tennis match */
  recordTennisMatch(partner?: string, note?: string): void {
    const progress = this.loadHobbyProgress();
    progress.tennis.matchesThisMonth++;
    progress.tennis.lastPlayed = pstDateStr();
    if (partner) progress.tennis.recentPartner = partner;
    if (note) progress.tennis.note = note;
    this.saveHobbyProgress(progress);
  }

  /** Record drum practice */
  recordDrumPractice(song?: string): void {
    const progress = this.loadHobbyProgress();
    progress.drums.practiceThisWeek++;
    progress.drums.lastPractice = pstDateStr();
    if (song) progress.drums.currentSong = song;
    this.saveHobbyProgress(progress);
  }

  /** Record a run */
  recordRun(pace?: string): void {
    const progress = this.loadHobbyProgress();
    progress.running.runsThisWeek++;
    progress.running.lastRun = pstDateStr();
    if (pace) progress.running.recentPace = pace;
    this.saveHobbyProgress(progress);
  }

  /** Record cooking */
  recordCooking(dish: string): void {
    const progress = this.loadHobbyProgress();
    progress.cooking.recentDishes.push(dish);
    // Keep last 5
    if (progress.cooking.recentDishes.length > 5) {
      progress.cooking.recentDishes = progress.cooking.recentDishes.slice(-5);
    }
    this.saveHobbyProgress(progress);
  }

  // ── Skill & Abandonment Tracking ─────────────────────────────────────

  /** Decay skill levels and increase abandonment risk for inactive hobbies */
  updateHobbyDecay(): void {
    const progress = this.loadHobbyProgress();
    const today = pstDateStr();

    if (!progress.meta) progress.meta = {};

    const hobbies = ["pottery", "tennis", "drums", "cooking", "running", "vibeCoding"];
    for (const hobby of hobbies) {
      if (!progress.meta[hobby]) {
        progress.meta[hobby] = { skillLevel: 30, abandonmentRisk: 0, lastActive: today, totalSessions: 0 };
      }
      const meta = progress.meta[hobby];
      const daysSince = daysBetween(meta.lastActive, today);

      // Abandonment risk grows with inactivity
      if (daysSince > 3) {
        meta.abandonmentRisk = Math.min(1, meta.abandonmentRisk + (daysSince - 3) * 0.05);
      } else {
        meta.abandonmentRisk = Math.max(0, meta.abandonmentRisk - 0.1);
      }

      // Skill decays after 14 days without practice
      if (daysSince > 14) {
        meta.skillLevel = Math.max(0, meta.skillLevel - (daysSince - 14) * 0.5);
      }
    }

    this.saveHobbyProgress(progress);
  }

  /** Record a hobby session, improving skill and reducing abandonment risk */
  recordHobbySession(hobbyKey: string): void {
    const progress = this.loadHobbyProgress();
    if (!progress.meta) progress.meta = {};
    const today = pstDateStr();

    if (!progress.meta[hobbyKey]) {
      progress.meta[hobbyKey] = { skillLevel: 30, abandonmentRisk: 0, lastActive: today, totalSessions: 0 };
    }

    const meta = progress.meta[hobbyKey];
    meta.lastActive = today;
    meta.totalSessions++;
    meta.skillLevel = Math.min(100, meta.skillLevel + 1.5); // slow skill gain
    meta.abandonmentRisk = Math.max(0, meta.abandonmentRisk - 0.2);

    this.saveHobbyProgress(progress);
  }

  // ── Formatting ───────────────────────────────────────────────────────

  /** Format hobby progress for schedule generation context */
  formatHobbyContext(): string {
    const p = this.loadHobbyProgress();
    const today = pstDateStr();
    const lines: string[] = [];

    const h = getCharacter().hobbies as Record<string, Record<string, unknown>>;

    // Pottery
    const potteryLabel = (h.pottery?.label as string) ?? "Pottery";
    const daysSincePottery = daysBetween(p.pottery.lastSession, today);
    lines.push(`${potteryLabel}: ${p.pottery.sessionsTotal} sessions total, ${p.pottery.currentProject ?? "no current project"} (${p.pottery.projectStatus}), ${daysSincePottery} days since last session`);

    // Tennis — with 8.1 skill progression
    const tennisLabel = (h.tennis?.label as string) ?? "Tennis";
    const daysSinceTennis = daysBetween(p.tennis.lastPlayed, today);
    let tennisLine = `${tennisLabel}: ${p.tennis.matchesThisMonth} matches this month, ${daysSinceTennis} days since last${p.tennis.note ? `, ${p.tennis.note}` : ""}`;
    const tennisProg = p.meta?.tennis?.progression;
    if (tennisProg?.focusArea) tennisLine += `, ${tennisProg.focusArea}`;
    if (tennisProg?.recentBreakthroughs?.length) tennisLine += `, recent breakthrough: ${tennisProg.recentBreakthroughs[tennisProg.recentBreakthroughs.length - 1]}`;
    lines.push(tennisLine);

    // Drums — with 8.1 skill progression
    const drumsLabel = (h.drums?.label as string) ?? "Drums";
    const daysSinceDrums = daysBetween(p.drums.lastPractice, today);
    let drumsLine = `${drumsLabel}: ${p.drums.currentSong ? `practicing ${p.drums.currentSong}` : "not practicing anything"}, ${daysSinceDrums} days since last practice, ${p.drums.level}`;
    const drumsProg = p.meta?.drums?.progression;
    if (drumsProg?.focusArea) drumsLine += `, ${drumsProg.focusArea}`;
    lines.push(drumsLine);

    // Running
    const runningLabel = (h.running?.label as string) ?? "Running";
    const daysSinceRun = daysBetween(p.running.lastRun, today);
    lines.push(`${runningLabel}: ${p.running.runsThisWeek} runs this week, ${daysSinceRun} days since last run`);

    // Cooking
    if (p.cooking.recentDishes.length > 0) {
      const cookingLabel = (h.cooking?.label as string) ?? "Recent dishes";
      lines.push(`${cookingLabel}: ${p.cooking.recentDishes.join(", ")}`);
    }

    // Vibe coding
    if (p.vibeCoding.currentProject) {
      lines.push(`Vibe coding: working on ${p.vibeCoding.currentProject}`);
    }

    return lines.join("\n");
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: HobbiesEngine | null = null;

export function initHobbies(statePath: string): HobbiesEngine {
  _singleton = new HobbiesEngine(statePath);
  return _singleton;
}

function _get(): HobbiesEngine {
  if (!_singleton) throw new Error("initHobbies() not called");
  return _singleton;
}

export function loadHobbyProgress(): HobbyProgress { return _get().loadHobbyProgress(); }
export function saveHobbyProgress(progress: HobbyProgress): void { _get().saveHobbyProgress(progress); }
export function recordPotterySession(detail?: string): void { _get().recordPotterySession(detail); }
export function recordTennisMatch(partner?: string, note?: string): void { _get().recordTennisMatch(partner, note); }
export function recordDrumPractice(song?: string): void { _get().recordDrumPractice(song); }
export function recordRun(pace?: string): void { _get().recordRun(pace); }
export function recordCooking(dish: string): void { _get().recordCooking(dish); }
export function updateHobbyDecay(): void { _get().updateHobbyDecay(); }
export function recordHobbySession(hobbyKey: string): void { _get().recordHobbySession(hobbyKey); }
export function formatHobbyContext(): string { return _get().formatHobbyContext(); }

// ── Module-level helpers ─────────────────────────────────────────────

function defaultProgress(): HobbyProgress {
  const today = pstDateStr();
  const h = getCharacter().hobbies as Record<string, Record<string, unknown>>;

  const pottery = h.pottery ?? {};
  const tennis = h.tennis ?? {};
  const drums = h.drums ?? {};
  const cooking = h.cooking ?? {};
  const running = h.running ?? {};
  const vibeCoding = h.vibe_coding ?? {};

  return {
    pottery: {
      sessionsTotal: (pottery.initial_sessions as number) ?? 0,
      currentProject: (pottery.initial_project as string) ?? null,
      projectStatus: (pottery.initial_status as string) ?? "",
      lastSession: today,
      milestones: (pottery.milestones as string[]) ?? [],
    },
    tennis: {
      matchesThisMonth: (tennis.initial_matches_per_month as number) ?? 0,
      lastPlayed: today,
      recentPartner: null,
      note: (tennis.initial_note as string) ?? null,
    },
    drums: {
      currentSong: (drums.initial_song as string) ?? null,
      practiceThisWeek: 0,
      lastPractice: today,
      level: (drums.initial_level as string) ?? "",
    },
    cooking: {
      recentDishes: (cooking.recent_dishes as string[]) ?? [],
      newRecipe: null,
      specialties: (cooking.specialties as string[]) ?? [],
    },
    running: {
      runsThisWeek: 0,
      lastRun: today,
      usualRoute: (running.usual_route as string) ?? "",
      recentPace: (running.usual_pace as string) ?? null,
    },
    vibeCoding: {
      currentProject: (vibeCoding.initial_project as string) ?? null,
      recentCompletions: (vibeCoding.recent_completions as string[]) ?? [],
      lastCoded: today,
    },
    lastUpdated: today,
  };
}

function daysBetween(dateStr1: string, dateStr2: string): number {
  try {
    const d1 = new Date(dateStr1);
    const d2 = new Date(dateStr2);
    return Math.abs(Math.floor((d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000)));
  } catch {
    return 0;
  }
}
