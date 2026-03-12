/**
 * Relational impact tests (P3).
 *
 * Verify: null observations → no context, soft signal no directive words,
 * observation recording, stance cooldown.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  initRelationalImpact,
  recordObservation,
  formatReciprocityContext,
  formatPersonalStanceContext,
  getRecentObservations,
} from "../relational-impact.js";
import fs from "node:fs";
import path from "node:path";

export function runRelationalImpactTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initRelationalImpact(env.statePath);

    // 1. no_observations_no_context
    {
      const ctx = formatReciprocityContext();
      tests.push(assert(
        "no_observations_no_context",
        ctx === null,
        "no observations → null reciprocity context",
      ));
    }

    // 2. observation_recorded
    {
      recordObservation({
        type: "emotional_opening",
        description: "对方似乎开始表达更多的脆弱面",
        possibleTrigger: "可能和最近的安全感积累有关",
        causalConfidence: 0.35,
        significance: 0.5,
        timestamp: Date.now(),
      });

      const recent = getRecentObservations(7);
      tests.push(assert(
        "observation_recorded",
        recent.length === 1,
        `observations=${recent.length}`,
      ));
    }

    // 3. reciprocity_context_rendered
    {
      const ctx = formatReciprocityContext();
      tests.push(assert(
        "reciprocity_context_rendered",
        ctx != null && ctx.includes("我们关系中的变化"),
        `ctx includes header: ${ctx?.includes("我们关系中的变化")}`,
      ));
    }

    // 4. soft_signal_no_directive_words
    {
      const ctx = formatReciprocityContext();
      const directiveWords = /可以|建议|试试|应该|必须|需要/;
      tests.push(assert(
        "soft_signal_no_directive_words",
        ctx == null || !directiveWords.test(ctx),
        `no directive words in reciprocity context`,
      ));
    }

    // 5. observation_dedup_within_3d
    {
      // Record same observation again — should be deduped
      recordObservation({
        type: "emotional_opening",
        description: "对方似乎开始表达更多的脆弱面",
        possibleTrigger: "可能和最近的安全感积累有关",
        causalConfidence: 0.35,
        significance: 0.5,
        timestamp: Date.now(),
      });

      const recent = getRecentObservations(7);
      tests.push(assert(
        "observation_dedup_within_3d",
        recent.length === 1, // still 1, not 2
        `observations=${recent.length} (expected 1 after dedup)`,
      ));
    }

    // 6. ten_null_rounds_no_context (simulate by having old observations only)
    {
      const env2 = setupTestEnvironment();
      try {
        initRelationalImpact(env2.statePath);
        // No observations recorded — simulate 10 empty turns
        const ctx = formatReciprocityContext();
        tests.push(assert(
          "ten_null_rounds_no_context",
          ctx === null,
          "empty state → null context",
        ));
      } finally {
        // Restore original state path
        initRelationalImpact(env.statePath);
        env2.cleanup();
      }
    }

    // 7. personal_stance_with_mature_opinion
    {
      // Write a mature opinion
      fs.writeFileSync(
        path.join(env.statePath, "opinions.json"),
        JSON.stringify({
          opinions: [{
            topic: "AI与创造力",
            position: "AI能增强而不是替代人的创造力",
            confidence: 0.8,
            status: "held",
            evolvedAt: Date.now() - 45 * 24 * 60 * 60 * 1000,
          }],
        }),
      );

      const stanceCtx = formatPersonalStanceContext();
      tests.push(assert(
        "personal_stance_with_mature_opinion",
        stanceCtx != null && stanceCtx.includes("AI与创造力"),
        `stance=${stanceCtx?.slice(0, 60) ?? "null"}`,
      ));
    }

    // 8. personal_stance_cooldown_7d
    {
      // Second call should be null (cooldown)
      const stanceCtx2 = formatPersonalStanceContext();
      tests.push(assert(
        "personal_stance_cooldown_7d",
        stanceCtx2 === null,
        "stance cooldown: second call within 7d → null",
      ));
    }

    // 9. stance_no_directive_words
    {
      // Check the stance we got in test 7 — it should not contain advice
      // Re-init to reset cooldown for this check
      const env3 = setupTestEnvironment();
      try {
        initRelationalImpact(env3.statePath);
        fs.writeFileSync(
          path.join(env3.statePath, "opinions.json"),
          JSON.stringify({
            opinions: [{
              topic: "教育方式",
              position: "自由探索对成长很重要",
              confidence: 0.85,
              status: "held",
              evolvedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
            }],
          }),
        );

        const stanceCtx = formatPersonalStanceContext();
        const directiveWords = /可以|建议|试试|应该|必须|需要/;
        tests.push(assert(
          "stance_no_directive_words",
          stanceCtx == null || !directiveWords.test(stanceCtx),
          "stance has no directive words",
        ));
      } finally {
        initRelationalImpact(env.statePath);
        env3.cleanup();
      }
    }

  } finally {
    env.cleanup();
  }

  return { name: "Relational Impact (P3)", tests };
}
