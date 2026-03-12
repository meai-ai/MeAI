/**
 * Simulation harness — lifecycle and staleness tests via timestamp manipulation.
 *
 * Tests time-dependent behaviors by directly manipulating JSON state file timestamps.
 * No Date.now() mocking needed.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  scanForValueCandidates,
  processPromotions,
  enablePromotion,
  processEmergingPromotions,
  processCommittedPromotions,
  processDecommitments,
  addStrongCounterEvidence,
  formatValueContext,
  type ValueFormationState,
} from "../lib/value-formation.js";
import {
  initSelfNarrative,
  formatSelfNarrativeContext,
} from "../self-narrative.js";
import {
  initActionGate,
  checkProactiveGate,
} from "../lib/action-gate.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import fs from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function runSimulationTests(): TestSuite {
  const tests: TestResult[] = [];

  // ── 1. value_lifecycle_60d ──────────────────────────────────────────
  // candidate → emerging (14d) → committed (60d)
  {
    const env = setupTestEnvironment();
    try {
      const now = Date.now();

      // Write exemplars from ~20 days ago (>14d for promotion)
      const exemplars = Array.from({ length: 5 }, (_, i) => ({
        id: `ex_${i}`,
        topic: "caring about friends",
        behaviorType: "cared",
        behaviorPattern: "asked about specific situation first",
        evidence: { situationSnippet: "...", responseSnippet: "..." },
        quality: 0.85 + i * 0.02,
        createdAt: now - (20 + i * 2) * DAY_MS,
      }));
      fs.writeFileSync(path.join(env.statePath, "exemplars.json"), JSON.stringify(exemplars));

      // Stable opinion from 50 days ago
      fs.writeFileSync(path.join(env.statePath, "opinions.json"), JSON.stringify({
        opinions: [{
          topic: "caring about friends", position: "care should start from specific situations", confidence: 0.85,
          status: "held", evolvedAt: now - 50 * DAY_MS, lastChallenged: now - 20 * DAY_MS, evidence: [],
        }],
      }));

      // Step 1: Scan for candidates
      scanForValueCandidates(env.statePath);
      let state = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );

      tests.push(assert(
        "lifecycle_candidate_created",
        state.candidates.length > 0,
        `candidates=${state.candidates.length}`,
      ));

      // Step 2: Age the candidate to >14d and boost readiness
      if (state.candidates.length > 0) {
        state.candidates[0].firstObserved = now - 15 * DAY_MS;
        state.candidates[0].lastReinforced = now - DAY_MS;
        state.candidates[0].stabilityScore = 0.6;
        state.candidates[0].promotionReadiness = 0.55;
        fs.writeFileSync(path.join(env.statePath, "value-formation.json"), JSON.stringify(state));

        enablePromotion(env.statePath);
        processEmergingPromotions(env.statePath);

        state = readJsonSafe<ValueFormationState>(
          path.join(env.statePath, "value-formation.json"),
          state,
        );

        tests.push(assert(
          "lifecycle_emerging_promoted",
          state.emergingValues.length > 0,
          `emerging=${state.emergingValues.length}`,
        ));
      } else {
        tests.push(assert("lifecycle_emerging_promoted", false, "no candidates to promote"));
      }

    } finally {
      env.cleanup();
    }
  }

  // ── 2. counterevidence_erosion ──────────────────────────────────────
  // active candidate + strong CE (matching antonym pattern) → counterevidence added
  {
    const env = setupTestEnvironment();
    try {
      const now = Date.now();

      // Write an active candidate with empathy pattern
      // addStrongCounterEvidence targets active candidates and matches PATTERN_ANTONYMS
      const state: any = {
        candidates: [{
          id: "cand_1",
          vector: { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.8 },
          source: "exemplar_convergence",
          evidence: [
            { timestamp: now - 90 * DAY_MS, type: "exemplar", description: "caring", sourceLayer: "relational", weight: 0.8 },
          ],
          counterevidence: [],
          firstObserved: now - 120 * DAY_MS,
          lastReinforced: now - 10 * DAY_MS,
          stabilityScore: 0.9,
          promotionReadiness: 0.9,
          displayLabel: "empathetic care",
          status: "active",
        }],
        emergingValues: [],
        committed: [],
        lastScanAt: now,
        promotionEnabled: true,
        promotedValueIds: [],
        lastEmergingAt: now - 30 * DAY_MS,
        lastCommittedAt: 0,
        lastCommittedDomain: null,
      };
      fs.writeFileSync(path.join(env.statePath, "value-formation.json"), JSON.stringify(state));

      // Add strong counter-evidence with text matching empathy antonym
      addStrongCounterEvidence(env.statePath, "I realized I'm actually quite cold sometimes, not truly empathizing");

      const updated = readJsonSafe<any>(path.join(env.statePath, "value-formation.json"), state);
      const ceCount = updated.candidates?.[0]?.counterevidence?.length ?? 0;

      tests.push(assert(
        "counterevidence_added_to_candidate",
        ceCount > 0,
        `counterevidence count=${ceCount}`,
      ));

    } finally {
      env.cleanup();
    }
  }

  // ── 3. emerging_staleness ──────────────────────────────────────────
  // 30d with no reinforcement → archived
  {
    const env = setupTestEnvironment();
    try {
      const now = Date.now();

      // Need a candidate (referenced by EmergingValue.candidateId) + matching emerging value
      const state: any = {
        candidates: [{
          id: "cand_stale",
          vector: { domain: "care", pattern: "callback", polarity: "prefer", strength: 0.5 },
          source: "exemplar_convergence",
          evidence: [{ timestamp: now - 40 * DAY_MS, type: "exemplar", description: "old", sourceLayer: "relational", weight: 0.5 }],
          counterevidence: [],
          firstObserved: now - 60 * DAY_MS,
          lastReinforced: now - 35 * DAY_MS, // >30d without reinforcement
          stabilityScore: 0.4,
          promotionReadiness: 0.3,
          displayLabel: "follow-up inquiry",
          status: "active",
        }],
        emergingValues: [{
          candidateId: "cand_stale",
          displayLabel: "follow-up inquiry",
          domain: "care",
          promotedAt: now - 40 * DAY_MS,
          lastReinforcedAt: now - 35 * DAY_MS,
          counterevidence: [],
        }],
        committed: [],
        lastScanAt: now,
        promotionEnabled: true,
        promotedValueIds: [],
        lastEmergingAt: now - 40 * DAY_MS,
        lastCommittedAt: 0,
        lastCommittedDomain: null,
      };
      fs.writeFileSync(path.join(env.statePath, "value-formation.json"), JSON.stringify(state));

      // processDecommitments handles stale emerging → archived
      processDecommitments(env.statePath, () => {});

      const updated = readJsonSafe<any>(path.join(env.statePath, "value-formation.json"), state);

      // Stale emerging (>30d no reinforcement) should be archived and removed from emergingValues
      const candidate = updated.candidates?.find((c: any) => c.id === "cand_stale");
      tests.push(assert(
        "stale_emerging_archived",
        candidate?.status === "archived" && (updated.emergingValues?.length ?? 0) === 0,
        `status=${candidate?.status}, emergingValues=${updated.emergingValues?.length ?? 0}`,
      ));

    } finally {
      env.cleanup();
    }
  }

  // ── 4. narrative_staleness ─────────────────────────────────────────
  // 8d old → formatSelfNarrativeContext returns null
  {
    const env = setupTestEnvironment();
    try {
      const now = Date.now();

      fs.writeFileSync(
        path.join(env.statePath, "self-narrative.json"),
        JSON.stringify({
          current: {
            generatedAt: now - 8 * DAY_MS,
            currentSelfSense: "test self-awareness",
            emergingDirections: ["direction A"],
            openQuestions: ["question 1"],
            recurringThemes: [{ theme: "testing", trajectory: "stable" }],
            unresolvedTensions: [],
            fragileHypotheses: [],
          },
          lastAttemptAt: now - 8 * DAY_MS,
          version: 1,
        }),
      );

      initSelfNarrative(env.statePath);
      const ctx = formatSelfNarrativeContext();

      tests.push(assert(
        "narrative_8d_stale_returns_null",
        ctx === null,
        `8d stale → ctx=${ctx === null ? "null" : `"${ctx?.slice(0, 30)}..."`}`,
      ));

      // Verify fresh narrative IS rendered
      fs.writeFileSync(
        path.join(env.statePath, "self-narrative.json"),
        JSON.stringify({
          current: {
            generatedAt: now - DAY_MS,
            currentSelfSense: "fresh self-awareness",
            emergingDirections: ["direction B"],
            openQuestions: ["question 2"],
            recurringThemes: [],
            unresolvedTensions: [],
            fragileHypotheses: [],
          },
          lastAttemptAt: now - DAY_MS,
          version: 1,
        }),
      );
      initSelfNarrative(env.statePath);
      const freshCtx = formatSelfNarrativeContext();

      tests.push(assert(
        "narrative_1d_fresh_returns_content",
        freshCtx !== null && freshCtx.length > 0,
        `1d fresh → ctx=${freshCtx === null ? "null" : `length=${freshCtx.length}`}`,
      ));

    } finally {
      env.cleanup();
    }
  }

  // ── 5. gate_full_chain ─────────────────────────────────────────────
  // evaluateRules returns complete allRuleResults
  {
    const env = setupTestEnvironment();
    try {
      initActionGate(env.statePath);

      const result = checkProactiveGate();

      tests.push(assert(
        "gate_full_chain_allRuleResults",
        Array.isArray(result.allRuleResults) && result.allRuleResults!.length >= 3,
        `allRuleResults=${result.allRuleResults?.length ?? 0}, all passed=${result.allRuleResults?.every(r => r.passed)}`,
      ));

      // Verify each rule result has name and passed fields
      const valid = (result.allRuleResults ?? []).every(r => typeof r.name === "string" && typeof r.passed === "boolean");
      tests.push(assert(
        "gate_full_chain_rule_format",
        valid,
        `all rules have name+passed fields`,
      ));

    } finally {
      env.cleanup();
    }
  }

  return { name: "Simulation Harness", tests };
}
