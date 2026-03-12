/**
 * Shared test environment setup for cross-module integration tests.
 *
 * Creates a temporary directory with minimal state files needed
 * for testing action-gate, turn-directive, emotion, and memory modules.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface TestEnv {
  statePath: string;
  cleanup: () => void;
}

export function setupTestEnvironment(): TestEnv {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "meai-test-"));

  // Create required subdirectories
  fs.mkdirSync(path.join(statePath, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(statePath, "memory"), { recursive: true });
  fs.mkdirSync(path.join(statePath, "brainstem"), { recursive: true });
  fs.mkdirSync(path.join(statePath, "action-audit"), { recursive: true });

  // Default emotion-state.json (neutral)
  fs.writeFileSync(
    path.join(statePath, "emotion-state.json"),
    JSON.stringify({
      mood: "calm",
      cause: "test",
      energy: 5,
      valence: 5,
      behaviorHints: "",
      microEvent: "",
      generatedAt: Date.now(),
    }),
  );

  // Default proactive.json
  fs.writeFileSync(
    path.join(statePath, "proactive.json"),
    JSON.stringify({
      lastSentAt: 0,
      lastUserMessageAt: 0,
      dailyCount: 0,
      dailyDate: "",
    }),
  );

  // Default social.json
  fs.writeFileSync(
    path.join(statePath, "social.json"),
    JSON.stringify({
      lastPostedAt: 0,
      dailyDate: "",
      dailyCount: 0,
      recentPosts: [],
    }),
  );

  // Default memory files (empty arrays)
  for (const cat of ["knowledge", "emotional", "core", "commitment", "insights", "character"]) {
    fs.writeFileSync(
      path.join(statePath, "memory", `${cat}.json`),
      JSON.stringify([]),
    );
  }

  // Minimal brainstem state
  fs.writeFileSync(
    path.join(statePath, "brainstem", "state.json"),
    JSON.stringify({ initialized: true }),
  );

  // Empty session transcript
  fs.writeFileSync(path.join(statePath, "sessions", "main.jsonl"), "");

  // Empty emotion journal
  fs.writeFileSync(
    path.join(statePath, "emotion-journal.json"),
    JSON.stringify({ entries: [], threads: [] }),
  );

  return {
    statePath,
    cleanup: () => {
      try {
        fs.rmSync(statePath, { recursive: true, force: true });
      } catch { /* best effort */ }
    },
  };
}
