/**
 * Provenance audit tests (4.3).
 *
 * Verify sourceType distribution counting, untagged handling,
 * narrative contamination detection, drift trend alerting.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  auditProvenanceDistribution,
  detectNarrativeContamination,
  checkDriftTrend,
  type ProvenanceDriftEntry,
  type ProvenanceDistribution,
} from "../lib/provenance-audit.js";
import { initJournal, addDiaryEntry, loadDiary } from "../journal.js";
import fs from "node:fs";
import path from "node:path";

export function runProvenanceAuditTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    // 1. distribution_counts_accurate
    {
      fs.writeFileSync(
        path.join(env.statePath, "memory", "knowledge.json"),
        JSON.stringify([
          { key: "a", value: "v", timestamp: 1, confidence: 1, sourceType: "observed" },
          { key: "b", value: "v", timestamp: 2, confidence: 1, sourceType: "inferred" },
          { key: "c", value: "v", timestamp: 3, confidence: 1, sourceType: "narrative" },
          { key: "d", value: "v", timestamp: 4, confidence: 1, sourceType: "observed" },
        ]),
      );

      const entries = auditProvenanceDistribution(env.statePath);
      const knowledgeDist = entries.find(e => e.category === "memory:knowledge")?.distribution;
      tests.push(assert(
        "distribution_counts_accurate",
        knowledgeDist != null &&
        knowledgeDist.observed === 2 &&
        knowledgeDist.inferred === 1 &&
        knowledgeDist.narrative === 1 &&
        knowledgeDist.total === 4,
        `observed=${knowledgeDist?.observed}, inferred=${knowledgeDist?.inferred}, narrative=${knowledgeDist?.narrative}, total=${knowledgeDist?.total}`,
      ));
    }

    // 2. untagged_counted_separately
    {
      fs.writeFileSync(
        path.join(env.statePath, "memory", "emotional.json"),
        JSON.stringify([
          { key: "a", value: "v", timestamp: 1, confidence: 1 },  // no sourceType
          { key: "b", value: "v", timestamp: 2, confidence: 1, sourceType: "observed" },
          { key: "c", value: "v", timestamp: 3, confidence: 1 },  // no sourceType
        ]),
      );

      const entries = auditProvenanceDistribution(env.statePath);
      const dist = entries.find(e => e.category === "memory:emotional")?.distribution;
      tests.push(assert(
        "untagged_counted_separately",
        dist != null && dist.untagged === 2 && dist.observed === 1,
        `untagged=${dist?.untagged}, observed=${dist?.observed}`,
      ));
    }

    // 3. untagged_excluded_from_narrative_ratio_denominator
    {
      // From test 2: 2 untagged, 1 observed, 0 narrative
      const entries = auditProvenanceDistribution(env.statePath);
      const dist = entries.find(e => e.category === "memory:emotional")?.distribution;
      // narrativeRatio = narrative / (total - untagged) = 0 / 1 = 0
      tests.push(assert(
        "untagged_excluded_from_narrative_ratio_denominator",
        dist != null && dist.narrativeRatio === 0,
        `narrativeRatio=${dist?.narrativeRatio} (expected 0)`,
      ));
    }

    // 4. narrative_contamination_detected
    {
      // Write a narrative memory
      fs.writeFileSync(
        path.join(env.statePath, "memory", "knowledge.json"),
        JSON.stringify([
          { key: "insight.test", value: "test insight", timestamp: 1, confidence: 1, sourceType: "narrative" },
        ]),
      );
      // Write a belief with ALL evidence being reflection type, referencing the narrative memory
      fs.writeFileSync(
        path.join(env.statePath, "brainstem", "self-model.json"),
        JSON.stringify({
          version: 2,
          state: {},
          transitionStats: [],
          lastUpdated: Date.now(),
          beliefs: [{
            id: "b1",
            statement: "test belief",
            category: "trait",
            evidence: [{
              text: "reflection on insight.test",
              timestamp: Date.now(),
              type: "reflection",
              polarity: "support",
              refId: "insight.test",
              weight: 0.5,
            }],
            confidence: 0.7,
            halfLifeDays: 30,
            createdAt: Date.now(),
            lastUpdated: Date.now(),
          }],
        }),
      );
      const contaminations = detectNarrativeContamination(env.statePath);
      tests.push(assert(
        "narrative_contamination_detected",
        contaminations.length > 0,
        `contaminations found: ${contaminations.length}`,
      ));
    }

    // 5. observed_not_flagged
    {
      fs.writeFileSync(
        path.join(env.statePath, "memory", "knowledge.json"),
        JSON.stringify([
          { key: "a", value: "v", timestamp: 1, confidence: 1, sourceType: "observed" },
          { key: "b", value: "v", timestamp: 2, confidence: 1, sourceType: "observed" },
        ]),
      );
      // Create history with only observed — should not trigger drift warning
      const history: ProvenanceDriftEntry[] = [
        { timestamp: Date.now() - 6 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 0, untagged: 0, total: 5, narrativeRatio: 0 } },
        { timestamp: Date.now() - 5 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 0, untagged: 0, total: 5, narrativeRatio: 0 } },
        { timestamp: Date.now() - 4 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 0, untagged: 0, total: 5, narrativeRatio: 0 } },
      ];
      const warnings = checkDriftTrend(history);
      tests.push(assert(
        "observed_not_flagged",
        warnings.length === 0,
        `warnings=${warnings.length} (expected 0)`,
      ));
    }

    // 6. diary_always_narrative
    {
      initJournal(env.statePath);
      addDiaryEntry({
        date: "2026-03-10",
        content: "test diary entry",
        mood: "happy",
        themes: ["test"],
      });
      const diary = loadDiary();
      const entry = diary.entries.find(e => e.date === "2026-03-10");
      tests.push(assert(
        "diary_always_narrative",
        entry?.sourceType === "narrative",
        `sourceType=${entry?.sourceType}`,
      ));
    }

    // 7. drift_trend_requires_3_consecutive_rises
    {
      // Single spike should NOT warn
      const history1: ProvenanceDriftEntry[] = [
        { timestamp: Date.now() - 3 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 1, untagged: 0, total: 6, narrativeRatio: 0.17 } },
        { timestamp: Date.now() - 2 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 1, untagged: 0, total: 6, narrativeRatio: 0.17 } },
        { timestamp: Date.now() - 1 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 2, untagged: 0, total: 7, narrativeRatio: 0.29 } },
      ];
      const warnings1 = checkDriftTrend(history1);
      const hasTrendWarning1 = warnings1.some(w => w.includes("连续3次上升"));

      // 3 consecutive rises SHOULD warn
      const history2: ProvenanceDriftEntry[] = [
        { timestamp: Date.now() - 3 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 1, untagged: 0, total: 6, narrativeRatio: 0.17 } },
        { timestamp: Date.now() - 2 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 2, untagged: 0, total: 7, narrativeRatio: 0.29 } },
        { timestamp: Date.now() - 1 * 86400000, category: "memory:knowledge", distribution: { observed: 5, inferred: 0, narrative: 3, untagged: 0, total: 8, narrativeRatio: 0.38 } },
      ];
      const warnings2 = checkDriftTrend(history2);
      const hasTrendWarning2 = warnings2.some(w => w.includes("连续3次上升"));

      tests.push(assert(
        "drift_trend_requires_3_consecutive_rises",
        !hasTrendWarning1 && hasTrendWarning2,
        `single spike warns=${hasTrendWarning1} (expected false), 3 rises warns=${hasTrendWarning2} (expected true)`,
      ));
    }

    // 8. migration_does_not_overwrite_known_sourceType
    {
      // Write memories with known sourceType
      const memories = [
        { key: "x", value: "v", timestamp: 1, confidence: 1, sourceType: "observed" },
      ];
      fs.writeFileSync(
        path.join(env.statePath, "memory", "knowledge.json"),
        JSON.stringify(memories),
      );
      // Run audit
      auditProvenanceDistribution(env.statePath);
      // Re-read — sourceType should still be "observed"
      const after = JSON.parse(fs.readFileSync(path.join(env.statePath, "memory", "knowledge.json"), "utf-8"));
      tests.push(assert(
        "migration_does_not_overwrite_known_sourceType",
        after[0].sourceType === "observed",
        `sourceType after audit=${after[0].sourceType}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Provenance Audit (4.3)", tests };
}
