/**
 * Decision provenance tests.
 *
 * Verify: evaluateRules returns allRuleResults (even when first rule blocks),
 * GateResult.allowed behavior unchanged, BrainstemVeto decomposition populated.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  initActionGate,
  checkProactiveGate,
  checkSocialGate,
  type GateResult,
} from "../lib/action-gate.js";
import { computeVeto } from "../brainstem/governance.js";
import fs from "node:fs";
import path from "node:path";

export function runDecisionProvenanceTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initActionGate(env.statePath);

    // 1. evaluateRules_returns_allRuleResults
    {
      // With neutral state, all rules should pass
      const result = checkProactiveGate();
      tests.push(assert(
        "evaluateRules_returns_allRuleResults",
        Array.isArray(result.allRuleResults) && result.allRuleResults!.length > 0,
        `allRuleResults has ${result.allRuleResults?.length ?? 0} entries`,
      ));
    }

    // 2. allRuleResults_populated_even_on_block
    {
      // Set up a blocking state: emotion depleted
      fs.writeFileSync(
        path.join(env.statePath, "emotion-state.json"),
        JSON.stringify({ mood: "exhausted", cause: "test", energy: 1, valence: 1 }),
      );
      const result = checkProactiveGate();
      // Should be blocked but still have allRuleResults
      tests.push(assert(
        "allRuleResults_populated_even_on_block",
        !result.allowed && Array.isArray(result.allRuleResults) && result.allRuleResults!.length > 1,
        `allowed=${result.allowed}, allRuleResults=${result.allRuleResults?.length ?? 0}`,
      ));
    }

    // 3. allowed_behavior_unchanged_regression
    {
      // Restore neutral state
      fs.writeFileSync(
        path.join(env.statePath, "emotion-state.json"),
        JSON.stringify({ mood: "calm", cause: "test", energy: 5, valence: 5 }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "allowed_behavior_unchanged_regression",
        result.allowed === true,
        `allowed=${result.allowed} (should be true with neutral state)`,
      ));
    }

    // 4. social_gate_returns_allRuleResults
    {
      const result = checkSocialGate("hello world");
      tests.push(assert(
        "social_gate_returns_allRuleResults",
        Array.isArray(result.allRuleResults),
        `social gate allRuleResults=${result.allRuleResults?.length ?? 0}`,
      ));
    }

    // 5. veto_decomposition_populated
    {
      const csi = { value: 0.2, mode: "red" as const };
      const selfState = { energy: 0.15, fatigue: 0.8, social_energy: 0.1, self_efficacy: 0.5 };
      const veto = computeVeto(csi, selfState, 0.8, 0.4, 2);

      tests.push(assert(
        "veto_decomposition_populated",
        veto.decomposition !== undefined &&
        veto.decomposition!.csiContribution !== null &&
        veto.decomposition!.selfStateContribution !== null &&
        veto.decomposition!.commitmentContribution !== null,
        `decomposition keys: ${Object.keys(veto.decomposition ?? {}).join(", ")}`,
      ));
    }

    // 6. veto_decomposition_null_fields_when_no_input
    {
      const veto = computeVeto(null, null, 0, null, 0);
      tests.push(assert(
        "veto_decomposition_null_fields_when_no_input",
        veto.decomposition !== undefined &&
        veto.decomposition!.csiContribution === null &&
        veto.decomposition!.selfStateContribution === null,
        `csi=${veto.decomposition?.csiContribution}, self=${veto.decomposition?.selfStateContribution}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Decision Provenance", tests };
}
