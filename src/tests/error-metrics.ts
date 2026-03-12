/**
 * Error metrics tests.
 *
 * Verify: increment accumulation, flush persistence, window reset,
 * empty format returns empty string.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  initErrorMetrics,
  incrementError,
  getErrorSummary,
  flushErrorMetrics,
  formatErrorMetricsContext,
} from "../lib/error-metrics.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import fs from "node:fs";
import path from "node:path";

export function runErrorMetricsTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    // 1. increment_accumulates_correctly
    {
      initErrorMetrics(env.statePath);
      incrementError("heartbeat", "pulse");
      incrementError("heartbeat", "pulse");
      incrementError("loop", "emotion");
      const summary = getErrorSummary();
      tests.push(assert(
        "increment_accumulates_correctly",
        summary["heartbeat:pulse"] === 2 && summary["loop:emotion"] === 1,
        `heartbeat:pulse=${summary["heartbeat:pulse"]}, loop:emotion=${summary["loop:emotion"]}`,
      ));
    }

    // 2. flush_writes_valid_json
    {
      flushErrorMetrics();
      const filePath = path.join(env.statePath, "error-metrics.json");
      const data = readJsonSafe<any>(filePath, null);
      tests.push(assert(
        "flush_writes_valid_json",
        data !== null && typeof data.counters === "object" && typeof data.lastReset === "number" && data.windowMs === 86400000,
        `counters=${JSON.stringify(data?.counters)}, windowMs=${data?.windowMs}`,
      ));
    }

    // 3. format_returns_nonempty_with_errors
    {
      const ctx = formatErrorMetricsContext();
      tests.push(assert(
        "format_returns_nonempty_with_errors",
        ctx.startsWith("errors(24h):") && ctx.includes("heartbeat:pulse=2"),
        `ctx="${ctx}"`,
      ));
    }

    // 4. format_returns_empty_when_no_errors
    {
      // Re-init with clean state
      initErrorMetrics(env.statePath + "-clean");
      const ctx = formatErrorMetricsContext();
      tests.push(assert(
        "format_returns_empty_when_no_errors",
        ctx === "",
        `ctx="${ctx}"`,
      ));
    }

    // 5. reload_preserves_counters
    {
      // Re-init from the flushed state
      initErrorMetrics(env.statePath);
      const summary = getErrorSummary();
      tests.push(assert(
        "reload_preserves_counters",
        summary["heartbeat:pulse"] === 2,
        `after reload: heartbeat:pulse=${summary["heartbeat:pulse"]}`,
      ));
    }

    // 6. window_reset_clears_counters
    {
      // Simulate expired window by writing lastReset 25h in the past
      const filePath = path.join(env.statePath, "error-metrics.json");
      const staleState = { counters: { "test:stale": 5 }, lastReset: Date.now() - 25 * 60 * 60 * 1000, windowMs: 86400000 };
      fs.writeFileSync(filePath, JSON.stringify(staleState));
      initErrorMetrics(env.statePath);
      // Counters loaded from file (not yet reset — reset happens on flush)
      const beforeFlush = getErrorSummary();
      const hadStale = beforeFlush["test:stale"] === 5;
      // Flush triggers window check → clears counters
      flushErrorMetrics();
      const afterFlush = getErrorSummary();
      tests.push(assert(
        "window_reset_clears_counters",
        hadStale && Object.keys(afterFlush).length === 0,
        `before flush: stale=${beforeFlush["test:stale"]}, after flush: keys=${Object.keys(afterFlush).length}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Error Metrics", tests };
}
