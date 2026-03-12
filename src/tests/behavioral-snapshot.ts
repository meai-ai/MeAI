/**
 * Behavioral snapshot tests.
 *
 * Verify: generateSnapshot produces all sections,
 * diffSnapshots detects changes.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  generateSnapshot,
  saveSnapshot,
  diffSnapshots,
  formatSnapshotSummary,
  type BehavioralSnapshot,
} from "../behavioral-snapshot.js";
import fs from "node:fs";
import path from "node:path";

export function runBehavioralSnapshotTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    // Write fixture data
    fs.writeFileSync(
      path.join(env.statePath, "value-formation.json"),
      JSON.stringify({
        candidates: [
          { id: "c1", vector: { domain: "care", pattern: "empathy" }, evidence: [], counterevidence: [], firstObserved: Date.now() },
          { id: "c2", vector: { domain: "honesty", pattern: "concreteness" }, evidence: [], counterevidence: [], firstObserved: Date.now() },
        ],
        emergingValues: [
          { id: "e1", vector: { domain: "care", pattern: "callback" }, evidence: [], counterevidence: [] },
        ],
        committed: [],
        promotedValueIds: ["p1"],
        decommitLog: [],
        lastScanAt: Date.now(),
        promotionEnabled: true,
      }),
    );

    const now = Date.now();
    fs.writeFileSync(
      path.join(env.statePath, "emotion-journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        data: {
          entries: [
            { mood: "happy", cause: "nice weather", valence: 7, energy: 6, timestamp: now - 86400000 },
            { mood: "anxious", cause: "work pressure", valence: 3, energy: 5, timestamp: now - 172800000 },
            { mood: "calm", cause: "reading", valence: 5, energy: 4, timestamp: now - 259200000 },
            { mood: "happy", cause: "nice weather", valence: 7, energy: 7, timestamp: now - 345600000 },
          ],
        },
      }),
    );

    fs.writeFileSync(
      path.join(env.statePath, "interaction-learning.json"),
      JSON.stringify({
        signals: [
          { type: "proactive_sent", hourBucket: "morning", timestamp: now - 86400000 },
          { type: "proactive_replied", hourBucket: "morning", timestamp: now - 86400000 },
          { type: "proactive_sent", hourBucket: "evening", timestamp: now - 172800000 },
        ],
        responseQuality: [
          { depth: 50, relevance: 0.8, tone: "warm" },
          { depth: 80, relevance: 0.9, tone: "warm" },
        ],
        patterns: [
          { pattern: "follow-up after caring" },
          { pattern: "remember details" },
        ],
        topicPreferences: [
          { topic: "work", engagementScore: 0.8 },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(env.statePath, "self-narrative.json"),
      JSON.stringify({
        current: {
          generatedAt: now - 2 * 86400000,
          currentSelfSense: "Recently exploring balance",
          emergingDirections: ["direction A"],
          openQuestions: ["What matters most?"],
          recurringThemes: [{ theme: "balance", trajectory: "rising" }],
          unresolvedTensions: [],
          fragileHypotheses: [],
        },
        lastAttemptAt: now - 2 * 86400000,
        version: 1,
      }),
    );

    fs.writeFileSync(
      path.join(env.statePath, "error-metrics.json"),
      JSON.stringify({
        counters: { "heartbeat:pulse": 3, "loop:emotion": 1 },
        lastReset: now,
        windowMs: 86400000,
      }),
    );

    // 1. generate_snapshot_all_sections_present
    {
      const snap = generateSnapshot(env.statePath);
      tests.push(assert(
        "generate_snapshot_all_sections_present",
        snap.values !== undefined &&
        snap.emotion !== undefined &&
        snap.response !== undefined &&
        snap.proactive !== undefined &&
        snap.narrative !== undefined,
        `sections: values=${!!snap.values}, emotion=${!!snap.emotion}, response=${!!snap.response}, proactive=${!!snap.proactive}, narrative=${!!snap.narrative}`,
      ));
    }

    // 2. values_section_correct
    {
      const snap = generateSnapshot(env.statePath);
      tests.push(assert(
        "values_section_correct",
        snap.values.candidateCount === 2 && snap.values.emergingCount === 1 && snap.values.committedCount === 0,
        `candidates=${snap.values.candidateCount}, emerging=${snap.values.emergingCount}, committed=${snap.values.committedCount}`,
      ));
    }

    // 3. emotion_section_has_data
    {
      const snap = generateSnapshot(env.statePath);
      tests.push(assert(
        "emotion_section_has_data",
        snap.emotion.avgValence > 0 && snap.emotion.dominantCauses.length > 0,
        `avgValence=${snap.emotion.avgValence}, causes=${snap.emotion.dominantCauses.length}`,
      ));
    }

    // 4. narrative_section_populated
    {
      const snap = generateSnapshot(env.statePath);
      tests.push(assert(
        "narrative_section_populated",
        snap.narrative.currentSelfSense !== null && snap.narrative.staleDays >= 0,
        `selfSense=${snap.narrative.currentSelfSense?.slice(0, 20)}, staleDays=${snap.narrative.staleDays}`,
      ));
    }

    // 5. errors_section_populated
    {
      const snap = generateSnapshot(env.statePath);
      tests.push(assert(
        "errors_section_populated",
        snap.errors !== undefined && snap.errors!.totalCount === 4,
        `totalCount=${snap.errors?.totalCount}`,
      ));
    }

    // 6. diff_detects_changes
    {
      const snapA = generateSnapshot(env.statePath);
      // Modify values
      const vf = JSON.parse(fs.readFileSync(path.join(env.statePath, "value-formation.json"), "utf-8"));
      vf.candidates.push({ id: "c3", vector: { domain: "playfulness" }, evidence: [], counterevidence: [], firstObserved: Date.now() });
      fs.writeFileSync(path.join(env.statePath, "value-formation.json"), JSON.stringify(vf));

      const snapB = generateSnapshot(env.statePath);
      const diff = diffSnapshots(snapA, snapB);
      tests.push(assert(
        "diff_detects_changes",
        "values.candidateCount" in diff && diff["values.candidateCount"].before === 2 && diff["values.candidateCount"].after === 3,
        `diff keys: ${Object.keys(diff).join(", ")}`,
      ));
    }

    // 7. format_summary_nonempty
    {
      const snap = generateSnapshot(env.statePath);
      const summary = formatSnapshotSummary(snap);
      tests.push(assert(
        "format_summary_nonempty",
        summary.length > 50 && summary.includes("Values") && summary.includes("Emotion"),
        `summary length=${summary.length}`,
      ));
    }

    // 8. save_snapshot_creates_file
    {
      const snap = generateSnapshot(env.statePath);
      saveSnapshot(env.statePath, snap);
      const savedPath = path.join(env.statePath, "behavioral-snapshots", `${snap.dateStr}.json`);
      tests.push(assert(
        "save_snapshot_creates_file",
        fs.existsSync(savedPath),
        `file exists at ${savedPath}`,
      ));
    }

    // 9. empty_state_doesnt_crash
    {
      const emptyEnv = setupTestEnvironment();
      try {
        const snap = generateSnapshot(emptyEnv.statePath);
        tests.push(assert(
          "empty_state_doesnt_crash",
          snap.generatedAt > 0 && snap.values.candidateCount === 0,
          "empty state → valid snapshot with zeros",
        ));
      } finally {
        emptyEnv.cleanup();
      }
    }

  } finally {
    env.cleanup();
  }

  return { name: "Behavioral Snapshot", tests };
}
