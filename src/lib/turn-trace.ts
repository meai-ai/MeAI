/**
 * Turn Trace — unified per-turn observability record.
 *
 * Each message turn gets a unique turnTraceId that links across:
 * - data/traces/YYYY-MM-DD.jsonl (this module's summary)
 * - data/turn-directive.jsonl (traceId field)
 * - data/context-eval/YYYY-MM-DD.jsonl (traceId field)
 *
 * Hard constraint: trace failure must never affect reply path.
 * All builder methods and finalize() are wrapped in try/catch.
 */

import fs from "node:fs";
import path from "node:path";
import { pstDateStr } from "./pst-date.js";
import { createLogger } from "./logger.js";

const log = createLogger("turn-trace");

// ── Types ────────────────────────────────────────────────────────────

export interface TurnTraceSummary {
  traceId: string;
  ts: number;
  /** Signals snapshot (emotion, body, social) */
  signals?: {
    conversationMode?: string;
    emotionValence?: number;
    bodyFatigue?: number;
    [key: string]: unknown;
  };
  /** Directive summary */
  directive?: {
    conversationGoal?: string;
    slotsCount?: number;
    commitmentsCount?: number;
    authorityLevel?: string;
    stance?: string;
  };
  /** Context plan: which blocks were selected vs available */
  contextPlan?: {
    selectedIds: string[];
    allIds: string[];
  };
  /** Output stats */
  output?: {
    responseLength: number;
    stopReason?: string;
  };
  /** Adherence check results */
  adherence?: {
    score: number;
    replyMode?: string;
    surfacedCommitments?: number;
    surfacedSlots?: number;
  };
  /** Which stages completed */
  stages: string[];
  durationMs?: number;
}

// ── State ────────────────────────────────────────────────────────────

let tracesDir = "";
const RETENTION_DAYS = 7;

// ── Init ─────────────────────────────────────────────────────────────

export function initTurnTrace(statePath: string): void {
  tracesDir = path.join(statePath, "traces");
  fs.mkdirSync(tracesDir, { recursive: true });

  // Async cleanup of old trace files
  cleanOldTraces().catch(() => {});

  log.info("initialized");
}

// ── ID Generation ────────────────────────────────────────────────────

let _counter = 0;

export function generateTurnTraceId(): string {
  const suffix = (++_counter).toString(36).padStart(4, "0").slice(-4);
  return `turn_${Date.now()}_${suffix}`;
}

// ── Builder ──────────────────────────────────────────────────────────

export class TurnTraceBuilder {
  private summary: TurnTraceSummary;
  private startMs: number;

  constructor(traceId: string) {
    this.startMs = Date.now();
    this.summary = {
      traceId,
      ts: this.startMs,
      stages: [],
    };
  }

  get traceId(): string {
    return this.summary.traceId;
  }

  recordSignals(signals: Record<string, unknown>): void {
    try {
      this.summary.signals = {
        conversationMode: signals.conversationMode as string | undefined,
        emotionValence: signals.emotionValence as number | undefined,
        bodyFatigue: signals.bodyFatigue as number | undefined,
      };
      this.summary.stages.push("signals");
    } catch (err) {
      log.warn("recordSignals failed", err);
    }
  }

  recordDirective(directive: {
    conversationGoal?: string;
    mustReferenceSlots?: unknown[];
    openCommitments?: unknown[];
    authorityLevel?: string;
    style?: { stance?: string };
  }): void {
    try {
      this.summary.directive = {
        conversationGoal: directive.conversationGoal,
        slotsCount: directive.mustReferenceSlots?.length ?? 0,
        commitmentsCount: directive.openCommitments?.length ?? 0,
        authorityLevel: directive.authorityLevel,
        stance: directive.style?.stance,
      };
      this.summary.stages.push("directive");
    } catch (err) {
      log.warn("recordDirective failed", err);
    }
  }

  recordContextPlan(selectedIds: string[], allIds: string[]): void {
    try {
      this.summary.contextPlan = { selectedIds, allIds };
      this.summary.stages.push("context");
    } catch (err) {
      log.warn("recordContextPlan failed", err);
    }
  }

  recordOutput(responseLength: number, stopReason?: string): void {
    try {
      this.summary.output = { responseLength, stopReason };
      this.summary.stages.push("output");
    } catch (err) {
      log.warn("recordOutput failed", err);
    }
  }

  recordAdherence(adherence: {
    adherenceScore: number;
    replyMode?: string;
    surfacedCommitments?: string[];
    surfacedSlots?: string[];
  }): void {
    try {
      this.summary.adherence = {
        score: adherence.adherenceScore,
        replyMode: adherence.replyMode,
        surfacedCommitments: adherence.surfacedCommitments?.length ?? 0,
        surfacedSlots: adherence.surfacedSlots?.length ?? 0,
      };
      this.summary.stages.push("adherence");
    } catch (err) {
      log.warn("recordAdherence failed", err);
    }
  }

  finalize(): void {
    try {
      this.summary.durationMs = Date.now() - this.startMs;
      appendTrace(this.summary);
    } catch (err) {
      log.warn("finalize failed", err);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function appendTrace(summary: TurnTraceSummary): void {
  if (!tracesDir) return;
  const today = pstDateStr();
  const filePath = path.join(tracesDir, `${today}.jsonl`);
  try {
    fs.appendFileSync(filePath, JSON.stringify(summary) + "\n", "utf-8");
  } catch (err) {
    log.warn("failed to append trace", err);
  }
}

async function cleanOldTraces(): Promise<void> {
  if (!tracesDir) return;
  try {
    const files = fs.readdirSync(tracesDir);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const dateStr = file.replace(".jsonl", "");
      const fileDate = new Date(dateStr + "T00:00:00-08:00");
      if (fileDate.getTime() < cutoff) {
        fs.unlinkSync(path.join(tracesDir, file));
        log.info(`cleaned old trace: ${file}`);
      }
    }
  } catch {
    // non-fatal
  }
}
