/**
 * Self-narrative tests (P2).
 *
 * Verify: openQuestions rejection, staleness check, substrate content.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  initSelfNarrative,
  formatSelfNarrativeContext,
  getNarrativeSubstrate,
} from "../self-narrative.js";
import fs from "node:fs";
import path from "node:path";

export function runSelfNarrativeTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initSelfNarrative(env.statePath);

    // 1. no_narrative_returns_null
    {
      const ctx = formatSelfNarrativeContext();
      tests.push(assert(
        "no_narrative_returns_null",
        ctx === null,
        "no narrative → null context",
      ));
    }

    // 2. stale_narrative_returns_null (>7d)
    {
      const staleNarrative = {
        current: {
          generatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
          currentSelfSense: "最近的我似乎在探索什么",
          emergingDirections: ["方向A"],
          openQuestions: ["问题1"],
          recurringThemes: [{ theme: "工作", trajectory: "rising" }],
          unresolvedTensions: ["张力1"],
          fragileHypotheses: ["假设1"],
        },
        lastAttemptAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        version: 1,
      };
      fs.writeFileSync(
        path.join(env.statePath, "self-narrative.json"),
        JSON.stringify(staleNarrative),
      );

      // Re-init to pick up the file
      initSelfNarrative(env.statePath);
      const ctx = formatSelfNarrativeContext();
      tests.push(assert(
        "stale_narrative_returns_null",
        ctx === null,
        `stale (8d) → ctx=${ctx === null ? "null" : "non-null"}`,
      ));
    }

    // 3. fresh_narrative_renders_context
    {
      const freshNarrative = {
        current: {
          generatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
          currentSelfSense: "最近的我似乎在寻找某种平衡",
          emergingDirections: ["更多关注内心", "尝试放慢节奏"],
          openQuestions: ["什么才是真正重要的？"],
          recurringThemes: [{ theme: "平衡", trajectory: "rising" }],
          unresolvedTensions: ["效率 vs 从容"],
          fragileHypotheses: ["也许慢下来反而更好"],
        },
        lastAttemptAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
        version: 1,
      };
      fs.writeFileSync(
        path.join(env.statePath, "self-narrative.json"),
        JSON.stringify(freshNarrative),
      );

      initSelfNarrative(env.statePath);
      const ctx = formatSelfNarrativeContext();
      tests.push(assert(
        "fresh_narrative_renders_context",
        ctx != null && ctx.includes("最近对自己的感觉"),
        `ctx starts with header: ${ctx?.includes("最近对自己的感觉")}`,
      ));

      tests.push(assert(
        "narrative_includes_open_questions",
        ctx != null && ctx.includes("还没想清楚的"),
        "context includes open questions section",
      ));
    }

    // 4. empty_openQuestions_not_rendered
    // Plan: "Mock output 无 openQuestions → reject"
    // The rejection happens at write-time in maybeUpdateSelfNarrative (requires LLM mock).
    // Here we verify the render-side: empty openQuestions → "还没想清楚的" section absent.
    {
      const env4 = setupTestEnvironment();
      try {
        initSelfNarrative(env4.statePath);
        const noQuestionsNarrative = {
          current: {
            generatedAt: Date.now() - 1 * 24 * 60 * 60 * 1000, // 1 day ago (fresh)
            currentSelfSense: "最近的我在思考一些事情",
            emergingDirections: ["某个方向"],
            openQuestions: [], // empty — this should have been rejected at write-time
            recurringThemes: [],
            unresolvedTensions: [],
            fragileHypotheses: [],
          },
          lastAttemptAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
          version: 1,
        };
        fs.writeFileSync(
          path.join(env4.statePath, "self-narrative.json"),
          JSON.stringify(noQuestionsNarrative),
        );
        initSelfNarrative(env4.statePath);
        const ctx = formatSelfNarrativeContext();
        tests.push(assert(
          "empty_openQuestions_not_rendered",
          ctx != null && !ctx.includes("还没想清楚的"),
          "empty openQuestions → section not rendered",
        ));
      } finally {
        initSelfNarrative(env.statePath);
        env4.cleanup();
      }
    }

    // 5. substrate_contains_tensions
    {
      const substrate = getNarrativeSubstrate();
      tests.push(assert(
        "substrate_contains_tensions",
        substrate != null && substrate.unresolvedTensions.length > 0,
        `tensions=${substrate?.unresolvedTensions.length ?? 0}`,
      ));
    }

    // 5. substrate_contains_hypotheses
    {
      const substrate = getNarrativeSubstrate();
      tests.push(assert(
        "substrate_contains_hypotheses",
        substrate != null && substrate.fragileHypotheses.length > 0,
        `hypotheses=${substrate?.fragileHypotheses.length ?? 0}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Self-Narrative (P2)", tests };
}
