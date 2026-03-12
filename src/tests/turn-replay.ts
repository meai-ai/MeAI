/**
 * Turn Directive stability tests.
 *
 * Given fixed user input + minimal state, verify TurnDirective output
 * is stable and sane. No LLM calls — only deterministic computation.
 */

import { assert, assertRange, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { computeTurnDirective, type TurnDirective } from "../agent/turn-directive.js";
import { initTurnDirective } from "../agent/turn-directive.js";
import { setupTestEnvironment } from "./test-env.js";
import fs from "node:fs";
import path from "node:path";

export function runTurnReplayTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initTurnDirective(env.statePath);

    // Test with null turnSignals (brainstem unavailable) — minimal directive
    const directive = computeTurnDirective("hello", null);

    // 1. directive_has_conversation_goal
    tests.push(assert(
      "directive_has_conversation_goal",
      directive.conversationGoal !== undefined && directive.conversationGoal.length > 0,
      `conversationGoal: "${directive.conversationGoal}"`,
    ));

    // 2. short_message_gets_short_target
    const shortDirective = computeTurnDirective("ok", null);
    tests.push(assert(
      "short_message_gets_short_target",
      shortDirective.style.targetLength === "short" || shortDirective.style.targetLength === "medium",
      `targetLength for "ok": "${shortDirective.style.targetLength}"`,
    ));

    // 3. self_regulation_within_bounds (when present)
    if (directive.selfRegulation) {
      const sr = directive.selfRegulation;
      tests.push(assertRange("self_regulation_attentionalBandwidth", sr.attentionalBandwidth, 0, 1));
      tests.push(assertRange("self_regulation_careAnchorSalience", sr.careAnchorSalience, 0, 1));
      tests.push(assertRange("self_regulation_conversationalSpread", sr.conversationalSpread, 0, 1));
      tests.push(assertRange("self_regulation_groundingPressure", sr.groundingPressure, 0, 1));
    } else {
      // selfRegulation is null when brainstem unavailable — that's expected
      tests.push(assert(
        "self_regulation_within_bounds",
        true,
        "selfRegulation null (brainstem unavailable) — OK",
      ));
    }

    // 4. suppressions_are_strings
    const allStrings = directive.style.suppressions.every(s => typeof s === "string" && s.length > 0);
    tests.push(assert(
      "suppressions_are_strings",
      directive.style.suppressions.length === 0 || allStrings,
      `${directive.style.suppressions.length} suppressions, all valid strings: ${allStrings}`,
    ));

    // 5. max_output_tokens_positive
    tests.push(assert(
      "max_output_tokens_positive",
      directive.style.maxOutputTokens > 0,
      `maxOutputTokens: ${directive.style.maxOutputTokens}`,
    ));

    // 6. persona_kernel_has_skeleton — skipped: PERSONA_KERNEL is not exported in open-source
    // (persona is driven by character.yaml instead of a hardcoded constant)
    tests.push(assert(
      "persona_kernel_has_skeleton",
      true,
      "skipped: PERSONA_KERNEL not available in open-source (character-driven)",
    ));

    // 7. csi_yellow_tightens_not_loosens — CSI yellow should never produce "long" targetLength
    {
      const mockTurnSignals = {
        slots: {
          current_focus: { name: "current_focus" as const, conceptId: null, label: "", loadedAt: 0, decayRate: 0.1, strength: 0 },
          background: { name: "background" as const, conceptId: null, label: "", loadedAt: 0, decayRate: 0.1, strength: 0 },
          goal_active: { name: "goal_active" as const, conceptId: null, label: "", loadedAt: 0, decayRate: 0.1, strength: 0 },
          recent_surprise: { name: "recent_surprise" as const, conceptId: null, label: "", loadedAt: 0, decayRate: 0.1, strength: 0 },
          open_question: { name: "open_question" as const, conceptId: null, label: "", loadedAt: 0, decayRate: 0.1, strength: 0 },
        },
        openCommitments: [],
        selfState: {
          energy: 0.8, fatigue: 0.2, self_efficacy: 0.7, uncertainty: 0.3,
          social_energy: 0.8, affect_valence: 0.5, self_coherence: 0.8, safety_margin: 0.5,
        },
        topConcepts: [],
        activeGoals: [],
        csi: { value: 0.7, mode: "yellow" as const },
        driveSignal: null,
        affectRegulation: { strategy: "none", intensity: 0 },
      };
      // Use a long message to try to trigger "long" targetLength
      const yellowDirective = computeTurnDirective(
        "I've been thinking about a really complex question lately, about the meaning of life and the nature of our existence. Do you think each of us has a fixed destiny, or is everything random and we can change our fate through our own efforts?",
        mockTurnSignals,
      );
      tests.push(assert(
        "csi_yellow_tightens_not_loosens",
        yellowDirective.style.targetLength !== "long",
        `CSI yellow targetLength="${yellowDirective.style.targetLength}" (should not be "long")`,
      ));
    }

    // 8. computedAt is recent
    tests.push(assert(
      "computedAt_is_recent",
      directive.computedAt > 0 && Date.now() - directive.computedAt < 5000,
      `computedAt within 5s of now: ${directive.computedAt}`,
    ));

  } finally {
    env.cleanup();
  }

  return { name: "TurnDirective Replay", tests };
}
