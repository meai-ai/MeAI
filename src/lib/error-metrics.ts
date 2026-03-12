/**
 * Lightweight error counter — tracks error counts by module:category
 * over a rolling 24h window. Persists to data/error-metrics.json.
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";

interface ErrorMetricsState {
  counters: Record<string, number>;
  lastReset: number;
  windowMs: number;
}

const WINDOW_MS = 86_400_000; // 24 hours

let _statePath = "";
const counters = new Map<string, number>();
let lastReset = Date.now();

function filePath(): string {
  return path.join(_statePath, "error-metrics.json");
}

export function initErrorMetrics(statePath: string): void {
  _statePath = statePath;
  const state = readJsonSafe<ErrorMetricsState>(filePath(), {
    counters: {},
    lastReset: Date.now(),
    windowMs: WINDOW_MS,
  });
  counters.clear();
  for (const [k, v] of Object.entries(state.counters)) {
    if (v > 0) counters.set(k, v);
  }
  lastReset = state.lastReset;
}

export function incrementError(module: string, category: string): void {
  const key = `${module}:${category}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function getErrorSummary(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function flushErrorMetrics(): void {
  const now = Date.now();
  if (now - lastReset >= WINDOW_MS) {
    counters.clear();
    lastReset = now;
  }
  const state: ErrorMetricsState = {
    counters: Object.fromEntries(counters),
    lastReset,
    windowMs: WINDOW_MS,
  };
  writeJsonAtomic(filePath(), state);
}

export function formatErrorMetricsContext(): string {
  if (counters.size === 0) return "";
  const parts = [...counters.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  return `errors(24h): ${parts.join(", ")}`;
}
