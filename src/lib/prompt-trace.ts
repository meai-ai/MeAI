/**
 * Prompt Trace — LLM call full-chain tracing.
 *
 * AsyncLocalStorage propagates trace context through async call chains.
 * Buffered JSONL writer with sync flush on process exit.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────

export interface PromptTraceRecord {
  kind: "trace";
  ts: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: string;
  label: string;
  model: string;
  runtime: "api" | "cli";
  durationMs: number;
  firstTokenMs?: number;
  status: "ok" | "timeout" | "api_error" | "cli_error" | "empty_response";
  errorMessage?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  systemChars: number;
  promptChars: number;
  responseChars: number;
  templateHash: string;
  templateVersion?: string;
  instanceHash: string;
  codeVersion: string;
  system: string;
  prompt: string;
  response: string;
}

export interface PromptTraceAnnotation {
  kind: "annotate";
  ts: string;
  spanId: string;
  parsedOk?: boolean;
  parseErrorType?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type TraceEntry = PromptTraceRecord | PromptTraceAnnotation;

export interface TraceContext {
  traceId: string;
  source: string;
  currentSpanId?: string;
}

// ── AsyncLocalStorage ────────────────────────────────────────────────

const traceStore = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(ctx: { traceId: string; source: string }, fn: () => Promise<T>): Promise<T> {
  return traceStore.run({ ...ctx, currentSpanId: undefined }, fn);
}

export function withChildSpan<T>(parentSpanId: string, fn: () => Promise<T>): Promise<T> {
  const prev = traceStore.getStore();
  if (!prev) return fn();
  return traceStore.run({ ...prev, currentSpanId: parentSpanId }, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return traceStore.getStore();
}

// ── Span ID ──────────────────────────────────────────────────────────

let _spanCounter = 0;

export function generateSpanId(): string {
  return `span_${Date.now()}_${(++_spanCounter).toString(36)}`;
}

// ── Code Version ─────────────────────────────────────────────────────

let _codeVersion = "unknown";

try {
  _codeVersion = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 3000 }).trim() || "unknown";
} catch {
  // non-fatal
}

export function getCodeVersion(): string {
  return _codeVersion;
}

// ── Hash ─────────────────────────────────────────────────────────────

export function hashTemplate(label: string, system: string): string {
  const skeleton = system
    .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
    .replace(/\d{1,2}[:]\d{0,2}/g, "TIME")
    .replace(/\d+(\.\d+)?%/g, "PCT")
    .slice(0, 500);
  return createHash("sha1").update(label + "\n" + skeleton).digest("hex").slice(0, 12);
}

export function hashInstance(system: string, prompt: string): string {
  return createHash("sha1").update(system + "\n---\n" + prompt).digest("hex").slice(0, 12);
}

// ── State Path ───────────────────────────────────────────────────────

let _statePath = "data";

const TRACE_RETENTION_DAYS = 7;

export function initPromptTrace(statePath: string): void {
  _statePath = statePath;
  // Clean up old trace files on startup (async, non-blocking)
  setTimeout(() => cleanOldTraces(), 5_000);
}

function cleanOldTraces(): void {
  try {
    const dir = path.join(_statePath, "prompt-traces");
    if (!fs.existsSync(dir)) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - TRACE_RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const file of fs.readdirSync(dir)) {
      // Files are named YYYY-MM-DD.jsonl
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr && file.endsWith(".jsonl")) {
        fs.unlinkSync(path.join(dir, file));
        console.log(`[prompt-trace] Cleaned old trace: ${file}`);
      }
    }
  } catch { /* non-fatal */ }
}

function getFilePath(): string {
  const dir = path.join(_statePath, "prompt-traces");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${date}.jsonl`);
}

// ── Buffered Writer ──────────────────────────────────────────────────

let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

export function tracePrompt(entry: TraceEntry): void {
  try {
    buffer.push(JSON.stringify(entry) + "\n");
    if (buffer.length >= 20) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
  } catch { /* never throw */ }
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = buffer;
  buffer = [];
  try {
    await fs.promises.appendFile(getFilePath(), batch.join(""));
  } catch { /* swallow */ }
  flushing = false;
}

function flushSync(): void {
  try {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    fs.appendFileSync(getFilePath(), batch.join(""));
  } catch { /* swallow */ }
}

process.on("beforeExit", flushSync);
process.on("SIGINT", flushSync);
process.on("SIGTERM", flushSync);

// ── Annotate ─────────────────────────────────────────────────────────

export function annotateTrace(spanId: string, data: {
  parsedOk?: boolean;
  parseErrorType?: string;
  metadata?: Record<string, string | number | boolean | null>;
}): void {
  tracePrompt({ kind: "annotate", ts: new Date().toISOString(), spanId, ...data });
}
