/**
 * Memory Reconsolidation — "update on read" mechanism.
 *
 * When memories are retrieved during conversation or heartbeat reflection,
 * stale ones are evaluated by gpt-4o-mini and optionally updated in place.
 *
 * Gate filter (zero LLM cost) → batch LLM judgment → write-back (replace/append).
 */

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Memory } from "../types.js";
import type { MemoryCategory } from "./store-manager.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("reconsolidation");

// ── Age thresholds per category (ms) ─────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export const RECONSOLIDATION_AGE_THRESHOLDS: Record<MemoryCategory, number> = {
  knowledge: 5 * DAY_MS,
  emotional: 14 * DAY_MS,
  character: 21 * DAY_MS,
  insights: 10 * DAY_MS,
  commitment: 7 * DAY_MS,
  core: Infinity,
  system: Infinity,
};

// ── Write strategy per category ──────────────────────────────────────

export const WRITE_STRATEGY: Record<MemoryCategory, "replace" | "append"> = {
  knowledge: "replace",
  insights: "replace",
  emotional: "append",
  character: "append",
  commitment: "replace",  // commitments get status updates, not appended notes
  core: "replace",   // never reached (Infinity threshold)
  system: "replace",  // never reached
};

// ── Types ─────────────────────────────────────────────────────────────

export interface ReconsolidationJudgment {
  key: string;
  shouldUpdate: boolean;
  updateType: "context_refresh" | "factual_update" | "perspective_evolution";
  newValue: string;
  confidence: number;
  reason: string;
}

export interface ReconsolidationLogEntry {
  ts: number;
  key: string;
  category: MemoryCategory;
  ageDays: number;
  decision: "refresh" | "noop";
  updated: boolean;
  confidence: number;
  reason: string;
  trigger: "context_refresh" | "factual_update" | "perspective_evolution";
  durationMs: number;
}

// ── Gate filter (zero LLM cost) ──────────────────────────────────────

export function shouldReconsolidate(memory: Memory, category: MemoryCategory): boolean {
  const threshold = RECONSOLIDATION_AGE_THRESHOLDS[category];
  if (threshold === Infinity) return false;

  const age = Date.now() - memory.timestamp;
  if (age < threshold) return false;

  if (memory.lastReconsolidatedAt && Date.now() - memory.lastReconsolidatedAt < DAY_MS) {
    return false;
  }

  if (memory.value.length > 1500) return false;

  // sourceType gate — observed memories are facts, don't reconsolidate
  if (memory.sourceType === "observed") return false;

  return true;
}

// ── LLM judgment (batch, single call) ────────────────────────────────

const JUDGE_SYSTEM = `You are a memory update evaluator. You will receive 1-3 memories and the current conversation context.
For each memory, judge whether its content needs to be updated based on the current context.

Criteria:
- factual_update: facts are outdated (e.g., time, numbers, status changes)
- perspective_evolution: viewpoint/attitude has evolved
- context_refresh: needs additional context information

Output a strict JSON array, nothing else. Each element:
{"key":"memory key","shouldUpdate":true/false,"updateType":"factual_update"|"perspective_evolution"|"context_refresh","newValue":"full updated content (if shouldUpdate=true)","confidence":0.0-1.0,"reason":"brief reason"}

If no update is needed, shouldUpdate=false, newValue is an empty string.`;

export async function judgeReconsolidation(
  candidates: Array<{ memory: Memory; category: MemoryCategory }>,
  context: string,
  openaiApiKey: string,
): Promise<ReconsolidationJudgment[]> {
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const memoriesText = candidates
    .map((c, i) => `${i + 1}. [${c.category}] ${c.memory.key}: ${c.memory.value}`)
    .join("\n");

  const userPrompt = `Current context: ${context.slice(0, 500)}\n\nMemories to evaluate:\n${memoriesText}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 800,
  });

  const text = response.choices[0]?.message?.content ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.warn("no JSON array in judge response");
    return [];
  }

  try {
    return JSON.parse(jsonMatch[0]) as ReconsolidationJudgment[];
  } catch (err) {
    log.warn("failed to parse judge response", err);
    return [];
  }
}

// ── Write-back strategy ──────────────────────────────────────────────

export function applyWriteStrategy(
  memory: Memory,
  judgment: ReconsolidationJudgment,
  strategy: "replace" | "append",
): Memory {
  const now = Date.now();
  const revision = {
    timestamp: now,
    reason: judgment.reason,
    oldValue: memory.value,
    newValue: judgment.newValue,
    trigger: judgment.updateType,
  };

  // Keep at most 5 revisions
  const history = [...(memory.revisionHistory ?? []), revision].slice(-5);

  const newValue = strategy === "replace"
    ? judgment.newValue
    : `${memory.value} (later understanding: ${judgment.newValue})`;

  return {
    ...memory,
    value: newValue,
    lastReconsolidatedAt: now,
    reconsolidationCount: (memory.reconsolidationCount ?? 0) + 1,
    revisionHistory: history,
  };
}

// ── JSONL logging ────────────────────────────────────────────────────

export function logReconsolidation(statePath: string, entry: ReconsolidationLogEntry): void {
  const logPath = path.join(statePath, "memory", "reconsolidation.jsonl");
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.warn("failed to write reconsolidation log", err);
  }
}

// ── Shadow-Write Proposal System ─────────────────────────────────────

export interface ReconsolidationProposal {
  id: string;
  key: string;
  category: MemoryCategory;
  originalValue: string;
  proposedValue: string;
  updateType: "context_refresh" | "factual_update" | "perspective_evolution";
  confidence: number;
  reason: string;
  sourceType?: "observed" | "inferred" | "narrative";
  createdAt: number;
  status: "pending" | "merged" | "discarded";
}

let _proposalsPath = "";

export function initReconsolidationProposals(statePath: string): void {
  _proposalsPath = path.join(statePath, "memory", "reconsolidation-proposals.json");
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h + s.charCodeAt(i)) % 1e8;
  }
  return String(h);
}

export function loadProposals(): ReconsolidationProposal[] {
  if (!_proposalsPath) return [];
  try {
    if (!fs.existsSync(_proposalsPath)) return [];
    const data = JSON.parse(fs.readFileSync(_proposalsPath, "utf-8"));
    return Array.isArray(data) ? data : (data.proposals ?? []);
  } catch {
    return [];
  }
}

export function saveProposals(proposals: ReconsolidationProposal[]): void {
  if (!_proposalsPath) return;
  try {
    const dir = path.dirname(_proposalsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(_proposalsPath, JSON.stringify({ proposals }, null, 2), "utf-8");
  } catch (err) {
    log.warn("failed to save proposals", err);
  }
}

export function createProposal(
  memory: Memory,
  judgment: ReconsolidationJudgment,
  category: MemoryCategory,
): ReconsolidationProposal {
  return {
    id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    key: judgment.key,
    category,
    originalValue: memory.value,
    proposedValue: judgment.newValue,
    updateType: judgment.updateType,
    confidence: judgment.confidence,
    reason: judgment.reason,
    sourceType: memory.sourceType,
    createdAt: Date.now(),
    status: "pending",
  };
}

export function addProposal(proposal: ReconsolidationProposal): void {
  const proposals = loadProposals();
  // Finer dedup: composite key = key:updateType:hash(proposedValue).slice(0,8)
  const valueHash = simpleHash(proposal.proposedValue).slice(0, 8);
  const compositeKey = `${proposal.key}:${proposal.updateType}:${valueHash}`;
  const existingIdx = proposals.findIndex(p => {
    const pHash = simpleHash(p.proposedValue).slice(0, 8);
    return `${p.key}:${p.updateType}:${pHash}` === compositeKey && p.status === "pending";
  });

  if (existingIdx >= 0) {
    // Replace existing with same composite key
    proposals[existingIdx] = proposal;
  } else {
    proposals.push(proposal);
  }
  saveProposals(proposals);
}

// ── APPEND cap ────────────────────────────────────────────────────────

const MAX_APPEND_VERSIONS = 3;

export function enforceAppendCap(value: string): string {
  const marker = " (later understanding: ";
  const parts = value.split(marker);
  if (parts.length <= MAX_APPEND_VERSIONS) return value;
  // Keep base + last (MAX_APPEND_VERSIONS - 1) appends
  return [parts[0], ...parts.slice(-(MAX_APPEND_VERSIONS - 1))].join(marker);
}
