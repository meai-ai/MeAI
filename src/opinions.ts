/**
 * Opinion tracking — the character has evolving viewpoints.
 *
 * Loads opinions from data/opinions.json. The reflection system
 * can evolve opinions based on new conversations and discoveries.
 * Feeds into system prompt so the character can naturally disagree with the user.
 *
 * State persists in data/opinions.json.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { getCharacter } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface Opinion {
  topic: string;
  position: string;
  confidence: number;       // 0-1
  evidence: string[];
  evolvedAt: number;        // timestamp
}

interface OpinionState {
  opinions: Opinion[];
}

// ── Module State ─────────────────────────────────────────────────────

let dataPath = "";

export function initOpinions(statePath: string): void {
  dataPath = statePath;
}

// ── Persistence ──────────────────────────────────────────────────────

function getStatePath(): string {
  return path.join(dataPath, "opinions.json");
}

export function loadOpinions(): Opinion[] {
  if (!dataPath) return [];
  const state = readJsonSafe<OpinionState>(getStatePath(), { opinions: [] });
  return state.opinions;
}

export function saveOpinions(opinions: Opinion[]): void {
  if (!dataPath) return;
  writeJsonAtomic(getStatePath(), { opinions });
}

// ── Updates ──────────────────────────────────────────────────────────

/** Update an existing opinion's confidence or position. */
export function evolveOpinion(topic: string, updates: Partial<Pick<Opinion, "position" | "confidence" | "evidence">>): void {
  const opinions = loadOpinions();
  const existing = opinions.find(o => o.topic === topic);
  if (existing) {
    if (updates.position) existing.position = updates.position;
    if (updates.confidence !== undefined) existing.confidence = Math.max(0, Math.min(1, updates.confidence));
    if (updates.evidence) existing.evidence = [...existing.evidence, ...updates.evidence].slice(-5);
    existing.evolvedAt = Date.now();
  } else {
    // New opinion
    opinions.push({
      topic,
      position: updates.position ?? "",
      confidence: updates.confidence ?? 0.5,
      evidence: updates.evidence ?? [],
      evolvedAt: Date.now(),
    });
  }
  // Keep max 10 opinions
  if (opinions.length > 10) {
    opinions.sort((a, b) => b.evolvedAt - a.evolvedAt);
    opinions.length = 10;
  }
  saveOpinions(opinions);
}

// ── Formatting ───────────────────────────────────────────────────────

/** Format opinions for system prompt — helps the character push back naturally. */
export function formatOpinionContext(): string {
  const opinions = loadOpinions();
  if (opinions.length === 0) return "";

  const lines = opinions.map(o => {
    const conf = o.confidence >= 0.7 ? "strong" : o.confidence >= 0.4 ? "moderate" : "uncertain";
    return `- ${o.topic} (${conf}): ${o.position}`;
  });

  return `My views and positions (if ${getCharacter().user.name} says something you disagree with, feel free to naturally express a different perspective):\n${lines.join("\n")}`;
}
