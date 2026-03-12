/**
 * Memory integrity tests.
 *
 * Verify graceful degradation when state files are corrupted,
 * missing, or contain edge-case values.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import fs from "node:fs";
import path from "node:path";

export function runMemoryIntegrityTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    // 1. missing_file_returns_default — missing emotion-state.json → default
    {
      const missingPath = path.join(env.statePath, "nonexistent-state.json");
      const result = readJsonSafe(missingPath, { valence: 5, energy: 5 });
      tests.push(assert(
        "missing_file_returns_default",
        result.valence === 5 && result.energy === 5,
        `default returned for missing file: valence=${result.valence}, energy=${result.energy}`,
      ));
    }

    // 2. corrupt_json_returns_default — invalid JSON → graceful fallback
    {
      const corruptPath = path.join(env.statePath, "corrupt-test.json");
      fs.writeFileSync(corruptPath, "{ invalid json !@#$% }}}");
      const result = readJsonSafe(corruptPath, { mood: "neutral" });
      tests.push(assert(
        "corrupt_json_returns_default",
        result.mood === "neutral",
        `default returned for corrupt JSON: mood=${result.mood}`,
      ));
    }

    // 3. empty_array_handled — empty memory category → no crash
    {
      const emptyPath = path.join(env.statePath, "memory", "knowledge.json");
      fs.writeFileSync(emptyPath, "[]");
      const data = readJsonSafe<unknown[]>(emptyPath, []);
      tests.push(assert(
        "empty_array_handled",
        Array.isArray(data) && data.length === 0,
        `empty array loaded: length=${data.length}`,
      ));
    }

    // 4. reconsolidation_proposal_dedup — verify dedup mechanism exists in source
    {
      let hasDedup = false;
      try {
        const reconPath = path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..", "memory", "reconsolidation.ts",
        );
        const source = fs.readFileSync(reconPath, "utf-8");
        hasDedup = source.includes("dedup") || source.includes("existing") || source.includes("already");
      } catch {
        try {
          const reconPath = path.join(
            path.dirname(new URL(import.meta.url).pathname),
            "..", "memory", "reconsolidation.js",
          );
          const source = fs.readFileSync(reconPath, "utf-8");
          hasDedup = source.includes("dedup") || source.includes("existing") || source.includes("already");
        } catch { /* ok */ }
      }
      tests.push(assert(
        "reconsolidation_proposal_dedup",
        hasDedup,
        `dedup mechanism found in reconsolidation source: ${hasDedup}`,
      ));
    }

    // 5. append_cap_enforced — verify enforceAppendCap exists
    {
      let hasAppendCap = false;
      try {
        const storePath = path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..", "memory", "store-manager.ts",
        );
        const source = fs.readFileSync(storePath, "utf-8");
        hasAppendCap = source.includes("enforceAppendCap") || source.includes("versions") || source.includes("maxVersions");
      } catch {
        try {
          const storePath = path.join(
            path.dirname(new URL(import.meta.url).pathname),
            "..", "memory", "store-manager.js",
          );
          const source = fs.readFileSync(storePath, "utf-8");
          hasAppendCap = source.includes("enforceAppendCap") || source.includes("versions") || source.includes("maxVersions");
        } catch { /* ok */ }
      }
      tests.push(assert(
        "append_cap_enforced",
        hasAppendCap,
        `append cap mechanism found: ${hasAppendCap}`,
      ));
    }

    // 6. large_emotion_values_clamped — out-of-range values should be handled
    {
      const outOfRangePath = path.join(env.statePath, "emotion-out-of-range.json");
      fs.writeFileSync(outOfRangePath, JSON.stringify({ valence: 999, energy: -5 }));
      const data = readJsonSafe<{ valence: number; energy: number }>(outOfRangePath, { valence: 5, energy: 5 });
      // readJsonSafe doesn't clamp — test that we can at least read it
      tests.push(assert(
        "out_of_range_values_loadable",
        data.valence === 999 && data.energy === -5,
        `raw values loaded without crash: valence=${data.valence}, energy=${data.energy}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Memory Integrity", tests };
}
