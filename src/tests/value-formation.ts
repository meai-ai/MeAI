/**
 * Value formation tests (4.1A + 4.1B).
 *
 * Verify candidate creation, structured schema, anti-monoculture,
 * promotion gating, source variety scoring, display labels,
 * 3-stage lifecycle, counterevidence, decommitment.
 */

import { assert, assertRange, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  scanForValueCandidates,
  isCandidateDiverse,
  computePromotionReadiness,
  computeSourceVariety,
  computeCeScore,
  processPromotions,
  enablePromotion,
  processEmergingPromotions,
  processCommittedPromotions,
  processDecommitments,
  scanCounterEvidence,
  addStrongCounterEvidence,
  formatValueContext,
  type ValueCandidate,
  type ValueFormationState,
  type CounterEvidence,
} from "../lib/value-formation.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import fs from "node:fs";
import path from "node:path";

export function runValueFormationTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    // 1. exemplar_convergence_detected
    {
      // Write 3+ exemplars of the same type with quality >= 0.8
      const exemplars = [
        { id: "ex_1", topic: "work pressure", behaviorType: "cared", behaviorPattern: "asked about specific situation first, acknowledged the emotion", evidence: { situationSnippet: "...", responseSnippet: "..." }, quality: 0.85, createdAt: Date.now() - 10 * 86400000 },
        { id: "ex_2", topic: "family conflict", behaviorType: "cared", behaviorPattern: "asked about specific situation first", evidence: { situationSnippet: "...", responseSnippet: "..." }, quality: 0.9, createdAt: Date.now() - 7 * 86400000 },
        { id: "ex_3", topic: "exam anxiety", behaviorType: "cared", behaviorPattern: "asked about specific situation first, brought up related past details", evidence: { situationSnippet: "...", responseSnippet: "..." }, quality: 0.82, createdAt: Date.now() - 3 * 86400000 },
      ];
      fs.writeFileSync(
        path.join(env.statePath, "exemplars.json"),
        JSON.stringify(exemplars),
      );

      scanForValueCandidates(env.statePath);
      const state = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );

      tests.push(assert(
        "exemplar_convergence_detected",
        state.candidates.length > 0,
        `candidates=${state.candidates.length}`,
      ));
    }

    // 2. opinion_stability_detected
    {
      fs.writeFileSync(
        path.join(env.statePath, "opinions.json"),
        JSON.stringify({
          opinions: [{
            topic: "caring about friends",
            position: "care should start from specific situations",
            confidence: 0.8,
            status: "held",
            evolvedAt: Date.now() - 45 * 86400000,
            lastChallenged: Date.now() - 10 * 86400000,
            evidence: [],
          }],
        }),
      );

      // Reset lastScanAt to allow re-scan
      const stateBefore = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );
      stateBefore.lastScanAt = 0;
      fs.writeFileSync(path.join(env.statePath, "value-formation.json"), JSON.stringify(stateBefore));

      scanForValueCandidates(env.statePath);
      const stateAfter = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );

      const opinionCandidate = stateAfter.candidates.find(c => c.source === "opinion_stability");
      tests.push(assert(
        "opinion_stability_detected",
        opinionCandidate != null,
        `opinion candidate found: ${opinionCandidate?.displayLabel ?? "none"}`,
      ));
    }

    // 3. candidate_uses_structured_schema
    {
      const state = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );
      const candidate = state.candidates[0];
      tests.push(assert(
        "candidate_uses_structured_schema",
        candidate != null &&
        typeof candidate.vector === "object" &&
        typeof candidate.vector.domain === "string" &&
        typeof candidate.vector.pattern === "string" &&
        typeof candidate.vector.polarity === "string" &&
        typeof candidate.vector.strength === "number",
        `vector=${JSON.stringify(candidate?.vector)}`,
      ));
    }

    // 4. anti_monoculture_blocks_concentration
    {
      const existing: ValueCandidate[] = [
        { id: "c1", vector: { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.5 }, source: "exemplar_convergence", evidence: [], counterevidence: [], firstObserved: Date.now(), lastReinforced: Date.now(), stabilityScore: 0.5, promotionReadiness: 0.3, status: "active" },
        { id: "c2", vector: { domain: "care", pattern: "concreteness", polarity: "prefer", strength: 0.5 }, source: "exemplar_convergence", evidence: [], counterevidence: [], firstObserved: Date.now(), lastReinforced: Date.now(), stabilityScore: 0.5, promotionReadiness: 0.3, status: "active" },
        { id: "c3", vector: { domain: "care", pattern: "callback", polarity: "prefer", strength: 0.5 }, source: "exemplar_convergence", evidence: [], counterevidence: [], firstObserved: Date.now(), lastReinforced: Date.now(), stabilityScore: 0.5, promotionReadiness: 0.3, status: "active" },
        { id: "c4", vector: { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.5 }, source: "exemplar_convergence", evidence: [], counterevidence: [], firstObserved: Date.now(), lastReinforced: Date.now(), stabilityScore: 0.5, promotionReadiness: 0.3, status: "active" },
      ];
      const newCandidate: ValueCandidate = {
        id: "c5", vector: { domain: "care", pattern: "patience", polarity: "prefer", strength: 0.5 },
        source: "exemplar_convergence", evidence: [], counterevidence: [], firstObserved: Date.now(), lastReinforced: Date.now(),
        stabilityScore: 0.5, promotionReadiness: 0.3, status: "active",
      };
      const diverse = isCandidateDiverse(newCandidate, existing);
      tests.push(assert(
        "anti_monoculture_blocks_concentration",
        diverse === false,
        `isCandidateDiverse=${diverse} (expected false, care already at 3/4)`,
      ));
    }

    // 5. promotion_disabled_by_default (legacy test still works)
    {
      const state = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );
      tests.push(assert(
        "promotion_disabled_by_default",
        state.promotionEnabled === false,
        `promotionEnabled=${state.promotionEnabled}`,
      ));

      processPromotions(env.statePath);
      const stateAfter = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );
      tests.push(assert(
        "promotion_disabled_by_default_2",
        stateAfter.promotedValueIds.length === 0,
        `promotedValueIds=${stateAfter.promotedValueIds.length}`,
      ));
    }

    // 6. candidate_not_promoted_from_single_source_type
    {
      const candidate: ValueCandidate = {
        id: "test", vector: { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.5 },
        source: "relational_pattern",
        evidence: [
          { timestamp: Date.now() - 30 * 86400000, type: "relational_pattern", description: "test", sourceLayer: "relational", weight: 0.5 },
          { timestamp: Date.now() - 15 * 86400000, type: "relational_pattern", description: "test2", sourceLayer: "relational", weight: 0.6 },
        ],
        counterevidence: [],
        firstObserved: Date.now() - 30 * 86400000,
        lastReinforced: Date.now(),
        stabilityScore: 0.5,
        promotionReadiness: 0,
        status: "active",
      };
      candidate.promotionReadiness = computePromotionReadiness(candidate);

      tests.push(assert(
        "candidate_not_promoted_from_single_source_type",
        candidate.promotionReadiness < 0.5,
        `promotionReadiness=${candidate.promotionReadiness.toFixed(3)} (limited by sourceVariety)`,
      ));
    }

    // 7. relational_only_evidence_cannot_reach_high_readiness
    {
      const candidate: ValueCandidate = {
        id: "test2", vector: { domain: "closeness", pattern: "callback", polarity: "prefer", strength: 0.7 },
        source: "relational_pattern",
        evidence: Array.from({ length: 15 }, (_, i) => ({
          timestamp: Date.now() - (90 - i * 5) * 86400000,
          type: "relational_pattern" as const,
          description: `pattern ${i}`,
          sourceLayer: "relational" as const,
          weight: 0.7,
        })),
        counterevidence: [],
        firstObserved: Date.now() - 90 * 86400000,
        lastReinforced: Date.now(),
        stabilityScore: 0.8,
        promotionReadiness: 0,
        status: "active",
      };
      candidate.stabilityScore = 0.8;
      candidate.promotionReadiness = computePromotionReadiness(candidate);

      tests.push(assertRange(
        "relational_only_evidence_cannot_reach_high_readiness",
        candidate.promotionReadiness, 0, 0.8,
        "relational-only readiness",
      ));
    }

    // 8. display_label_template_assembled
    {
      const state = readJsonSafe<ValueFormationState>(
        path.join(env.statePath, "value-formation.json"),
        { candidates: [], lastScanAt: 0, promotionEnabled: false, promotedValueIds: [], emergingValues: [], lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null },
      );
      const withLabel = state.candidates.find(c => c.displayLabel);
      tests.push(assert(
        "display_label_template_assembled",
        withLabel != null && typeof withLabel.displayLabel === "string" && withLabel.displayLabel.length > 0,
        `displayLabel="${withLabel?.displayLabel}"`,
      ));
    }

    // ── 4.1B Tests: Identity Stability + Decommitment ──────────────

    // 9. candidate_cannot_reach_committed_before_60d
    {
      // Create a fresh env for this test
      const env2 = setupTestEnvironment();
      try {
        // Write a mature candidate (30 days old — should NOT reach committed)
        const thirtyDayCandidate: ValueFormationState = {
          candidates: [{
            id: "vc_30d",
            vector: { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.7 },
            source: "exemplar_convergence",
            evidence: Array.from({ length: 8 }, (_, i) => ({
              timestamp: Date.now() - (30 - i * 3) * 86400000,
              type: "exemplar" as const,
              description: `evidence ${i}`,
              sourceLayer: "cross_source" as const,
              weight: 0.8,
            })),
            counterevidence: [],
            firstObserved: Date.now() - 30 * 86400000,
            lastReinforced: Date.now(),
            stabilityScore: 0.8,
            promotionReadiness: 0.9,
            displayLabel: "tends toward authentic self-disclosure in relationships",
            status: "active",
          }],
          lastScanAt: Date.now(),
          promotionEnabled: true,
          promotedValueIds: [],
          emergingValues: [{
            candidateId: "vc_30d",
            displayLabel: "tends toward authentic self-disclosure in relationships",
            domain: "honesty",
            promotedAt: Date.now() - 15 * 86400000,
            lastReinforcedAt: Date.now(),
            counterevidence: [],
          }],
          lastEmergingAt: Date.now() - 2 * 86400000,
          lastCommittedAt: 0,
          lastCommittedDomain: null,
        };
        fs.writeFileSync(
          path.join(env2.statePath, "value-formation.json"),
          JSON.stringify(thirtyDayCandidate),
        );

        let birthCalled = false;
        processCommittedPromotions(env2.statePath, () => { birthCalled = true; return {}; });

        tests.push(assert(
          "candidate_cannot_reach_committed_before_60d",
          birthCalled === false,
          `birthCalled=${birthCalled} (30d old, needs 60d)`,
        ));
      } finally {
        env2.cleanup();
      }
    }

    // 10. emerging_promotion_max_one_per_day
    {
      const env3 = setupTestEnvironment();
      try {
        const multiCandidate: ValueFormationState = {
          candidates: [
            {
              id: "vc_a", vector: { domain: "care", pattern: "empathy", polarity: "prefer", strength: 0.7 },
              source: "exemplar_convergence",
              evidence: Array.from({ length: 5 }, (_, i) => ({
                timestamp: Date.now() - (20 - i * 3) * 86400000,
                type: "exemplar" as const, description: `ev ${i}`, sourceLayer: "cross_source" as const, weight: 0.8,
              })),
              counterevidence: [], firstObserved: Date.now() - 20 * 86400000, lastReinforced: Date.now(),
              stabilityScore: 0.6, promotionReadiness: 0.6, displayLabel: "test_a", status: "active",
            },
            {
              id: "vc_b", vector: { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.7 },
              source: "exemplar_convergence",
              evidence: Array.from({ length: 5 }, (_, i) => ({
                timestamp: Date.now() - (20 - i * 3) * 86400000,
                type: "exemplar" as const, description: `ev ${i}`, sourceLayer: "cross_source" as const, weight: 0.8,
              })),
              counterevidence: [], firstObserved: Date.now() - 20 * 86400000, lastReinforced: Date.now(),
              stabilityScore: 0.6, promotionReadiness: 0.6, displayLabel: "test_b", status: "active",
            },
          ],
          lastScanAt: Date.now(),
          promotionEnabled: true,
          promotedValueIds: [],
          emergingValues: [],
          lastEmergingAt: 0,
          lastCommittedAt: 0,
          lastCommittedDomain: null,
        };
        fs.writeFileSync(path.join(env3.statePath, "value-formation.json"), JSON.stringify(multiCandidate));

        processEmergingPromotions(env3.statePath);
        const after = readJsonSafe<ValueFormationState>(
          path.join(env3.statePath, "value-formation.json"),
          multiCandidate,
        );

        tests.push(assert(
          "emerging_promotion_max_one_per_day",
          after.emergingValues.length === 1,
          `emergingValues=${after.emergingValues.length} (expected 1)`,
        ));
      } finally {
        env3.cleanup();
      }
    }

    // 11. counterevidence_erodes_to_decommitment
    {
      const env4 = setupTestEnvironment();
      try {
        const removeState = { called: false, label: "" };
        const mockRemove = (label: string) => { removeState.called = true; removeState.label = label; };

        const contestedState: ValueFormationState = {
          candidates: [{
            id: "vc_contested",
            vector: { domain: "grounding", pattern: "concreteness", polarity: "prefer", strength: 0.7 },
            source: "exemplar_convergence",
            evidence: [
              { timestamp: Date.now() - 60 * 86400000, type: "exemplar", description: "ev1", sourceLayer: "cross_source", weight: 0.5 },
            ],
            counterevidence: [
              { timestamp: Date.now() - 10 * 86400000, type: "behavioral_consistency", description: "ce1", sourceLayer: "cross_source", weight: 1.0, grade: "strong" },
              { timestamp: Date.now() - 5 * 86400000, type: "behavioral_consistency", description: "ce2", sourceLayer: "cross_source", weight: 1.0, grade: "strong" },
            ],
            firstObserved: Date.now() - 90 * 86400000,
            lastReinforced: Date.now() - 5 * 86400000, // recent reinforcement so it doesn't get archived
            stabilityScore: 0.5,
            promotionReadiness: 0.8,
            displayLabel: "communication tends to start from specific situations",
            status: "active",
          }],
          lastScanAt: Date.now(),
          promotionEnabled: true,
          promotedValueIds: ["vc_contested"],
          emergingValues: [],
          lastEmergingAt: 0,
          lastCommittedAt: Date.now() - 60 * 86400000,
          lastCommittedDomain: "grounding",
        };
        fs.writeFileSync(path.join(env4.statePath, "value-formation.json"), JSON.stringify(contestedState));

        processDecommitments(env4.statePath, mockRemove);

        const after = readJsonSafe<ValueFormationState>(
          path.join(env4.statePath, "value-formation.json"),
          contestedState,
        );

        tests.push(assert(
          "counterevidence_erodes_to_decommitment",
          removeState.called === true,
          `removeCalled=${removeState.called}, removedLabel="${removeState.label}"`,
        ));

        tests.push(assert(
          "decommitment_moves_to_emerging",
          after.emergingValues.length === 1 && after.promotedValueIds.length === 0,
          `emerging=${after.emergingValues.length}, promoted=${after.promotedValueIds.length}`,
        ));
      } finally {
        env4.cleanup();
      }
    }

    // 12. stale_emerging_archived
    {
      const env5 = setupTestEnvironment();
      try {
        const staleState: ValueFormationState = {
          candidates: [{
            id: "vc_stale",
            vector: { domain: "playfulness", pattern: "humor", polarity: "prefer", strength: 0.5 },
            source: "exemplar_convergence",
            evidence: [{ timestamp: Date.now() - 60 * 86400000, type: "exemplar", description: "old", sourceLayer: "cross_source", weight: 0.5 }],
            counterevidence: [],
            firstObserved: Date.now() - 60 * 86400000,
            lastReinforced: Date.now() - 35 * 86400000, // 35d ago = stale
            stabilityScore: 0.3,
            promotionReadiness: 0.3,
            displayLabel: "lightness comes from using humor to defuse",
            status: "active",
          }],
          lastScanAt: Date.now(),
          promotionEnabled: true,
          promotedValueIds: [],
          emergingValues: [{
            candidateId: "vc_stale",
            displayLabel: "lightness comes from using humor to defuse",
            domain: "playfulness",
            promotedAt: Date.now() - 35 * 86400000,
            lastReinforcedAt: Date.now() - 35 * 86400000,
            counterevidence: [],
          }],
          lastEmergingAt: Date.now() - 35 * 86400000,
          lastCommittedAt: 0,
          lastCommittedDomain: null,
        };
        fs.writeFileSync(path.join(env5.statePath, "value-formation.json"), JSON.stringify(staleState));

        processDecommitments(env5.statePath, () => {});

        const after = readJsonSafe<ValueFormationState>(
          path.join(env5.statePath, "value-formation.json"),
          staleState,
        );

        tests.push(assert(
          "stale_emerging_archived",
          after.emergingValues.length === 0,
          `emergingValues=${after.emergingValues.length} (expected 0)`,
        ));

        const candidate = after.candidates.find(c => c.id === "vc_stale");
        tests.push(assert(
          "archived_status_set",
          candidate?.status === "archived",
          `status=${candidate?.status}`,
        ));
      } finally {
        env5.cleanup();
      }
    }

    // 13. archived_not_in_formatValueContext
    {
      const env6 = setupTestEnvironment();
      try {
        const archivedState: ValueFormationState = {
          candidates: [{
            id: "vc_arch",
            vector: { domain: "restraint", pattern: "patience", polarity: "prefer", strength: 0.5 },
            source: "exemplar_convergence", evidence: [], counterevidence: [],
            firstObserved: Date.now() - 60 * 86400000, lastReinforced: Date.now() - 40 * 86400000,
            stabilityScore: 0.3, promotionReadiness: 0.3, displayLabel: "test archived",
            status: "archived",
          }],
          lastScanAt: Date.now(), promotionEnabled: true, promotedValueIds: [],
          emergingValues: [{
            candidateId: "vc_arch", displayLabel: "test archived", domain: "restraint",
            promotedAt: Date.now() - 40 * 86400000, lastReinforcedAt: Date.now() - 40 * 86400000,
            counterevidence: [],
          }],
          lastEmergingAt: 0, lastCommittedAt: 0, lastCommittedDomain: null,
        };
        fs.writeFileSync(path.join(env6.statePath, "value-formation.json"), JSON.stringify(archivedState));

        const ctx = formatValueContext(env6.statePath);
        tests.push(assert(
          "archived_not_in_formatValueContext",
          ctx === null,
          `context=${ctx === null ? "null" : ctx.slice(0, 40)}`,
        ));
      } finally {
        env6.cleanup();
      }
    }

    // 14. ceScore_computation_correct
    {
      const evidence = [
        { timestamp: 0, type: "exemplar" as const, description: "", sourceLayer: "cross_source" as const, weight: 0.8 },
        { timestamp: 0, type: "exemplar" as const, description: "", sourceLayer: "cross_source" as const, weight: 0.8 },
      ];
      const ce: CounterEvidence[] = [
        { timestamp: 0, type: "behavioral_consistency", description: "", sourceLayer: "cross_source", weight: 1.0, grade: "strong" },
      ];
      // ceScore = 1.0 / (0.8 + 0.8 + 1.0) = 0.385
      const score = computeCeScore(evidence, ce);
      tests.push(assertRange(
        "ceScore_computation_correct",
        score, 0.35, 0.42,
        `ceScore=${score.toFixed(3)}`,
      ));
    }

    // 15. sourceVariety_exported_and_correct
    {
      const relOnly = [
        { timestamp: 0, type: "relational_pattern" as const, description: "", sourceLayer: "relational" as const, weight: 0.5 },
        { timestamp: 0, type: "relational_pattern" as const, description: "", sourceLayer: "relational" as const, weight: 0.5 },
      ];
      tests.push(assert(
        "sourceVariety_relational_only_capped",
        computeSourceVariety(relOnly) <= 0.1,
        `sourceVariety=${computeSourceVariety(relOnly)}`,
      ));

      const mixed = [
        { timestamp: 0, type: "exemplar" as const, description: "", sourceLayer: "cross_source" as const, weight: 0.5 },
        { timestamp: 0, type: "relational_pattern" as const, description: "", sourceLayer: "relational" as const, weight: 0.5 },
      ];
      tests.push(assert(
        "sourceVariety_mixed_reaches_0.2",
        computeSourceVariety(mixed) >= 0.2,
        `sourceVariety=${computeSourceVariety(mixed)}`,
      ));
    }

    // 16. end_to_end_60d_committed — full positive path: candidate→emerging→committed
    {
      const env7 = setupTestEnvironment();
      try {
        const now = Date.now();
        // Candidate with 65d age, high scores, cross-source evidence, low ceScore
        const e2eState: ValueFormationState = {
          candidates: [{
            id: "vc_e2e",
            vector: { domain: "honesty", pattern: "vulnerability", polarity: "prefer", strength: 0.7 },
            source: "exemplar_convergence",
            evidence: [
              { timestamp: now - 65 * 86400000, type: "exemplar", description: "a", sourceLayer: "cross_source", weight: 0.8 },
              { timestamp: now - 55 * 86400000, type: "opinion_held", description: "b", sourceLayer: "cross_source", weight: 0.7 },
              { timestamp: now - 45 * 86400000, type: "exemplar", description: "c", sourceLayer: "cross_source", weight: 0.8 },
              { timestamp: now - 35 * 86400000, type: "relational_pattern", description: "d", sourceLayer: "relational", weight: 0.6 },
              { timestamp: now - 25 * 86400000, type: "exemplar", description: "e", sourceLayer: "cross_source", weight: 0.8 },
              { timestamp: now - 15 * 86400000, type: "exemplar", description: "f", sourceLayer: "cross_source", weight: 0.9 },
              { timestamp: now - 5 * 86400000, type: "behavioral_consistency", description: "g", sourceLayer: "cross_source", weight: 0.7 },
            ],
            counterevidence: [],
            firstObserved: now - 65 * 86400000,
            lastReinforced: now - 5 * 86400000,
            stabilityScore: 0.75,
            promotionReadiness: 0.85,
            displayLabel: "tends toward authentic self-disclosure in relationships",
            status: "active",
          }],
          lastScanAt: now,
          promotionEnabled: true,
          promotedValueIds: [],
          emergingValues: [{
            candidateId: "vc_e2e",
            displayLabel: "tends toward authentic self-disclosure in relationships",
            domain: "honesty",
            promotedAt: now - 50 * 86400000, // already promoted to emerging 50d ago
            lastReinforcedAt: now - 5 * 86400000,
            counterevidence: [],
          }],
          lastEmergingAt: now - 50 * 86400000,
          lastCommittedAt: 0,
          lastCommittedDomain: null,
        };
        fs.writeFileSync(path.join(env7.statePath, "value-formation.json"), JSON.stringify(e2eState));

        const birthState = { called: false, label: "" };
        const mockBirth = (stmt: string, _cat: "value", _dom: string, _ev: unknown[], _src: "observed") => {
          birthState.called = true;
          birthState.label = stmt;
          return { id: "test", statement: stmt };
        };
        processCommittedPromotions(env7.statePath, mockBirth);

        tests.push(assert(
          "end_to_end_60d_committed",
          birthState.called === true && birthState.label.includes("authentic self-disclosure"),
          `committed=${birthState.called}, label=${birthState.label.slice(0, 30)}`,
        ));
      } finally {
        env7.cleanup();
      }
    }

    // 17. strong_counterevidence_from_feedback
    {
      const env8 = setupTestEnvironment();
      try {
        const now = Date.now();
        const ceState: ValueFormationState = {
          candidates: [{
            id: "vc_strong",
            vector: { domain: "care", pattern: "concreteness", polarity: "prefer", strength: 0.6 },
            source: "exemplar_convergence",
            evidence: [{ timestamp: now - 30 * 86400000, type: "exemplar", description: "x", sourceLayer: "cross_source", weight: 0.8 }],
            counterevidence: [],
            firstObserved: now - 30 * 86400000,
            lastReinforced: now - 5 * 86400000,
            stabilityScore: 0.5,
            promotionReadiness: 0.5,
            displayLabel: "caring for people should start from specific situations",
            status: "active",
          }],
          lastScanAt: now,
          promotionEnabled: true,
          promotedValueIds: [],
          emergingValues: [],
          lastEmergingAt: 0,
          lastCommittedAt: 0,
          lastCommittedDomain: null,
        };
        fs.writeFileSync(path.join(env8.statePath, "value-formation.json"), JSON.stringify(ceState));

        addStrongCounterEvidence(env8.statePath, "What you just said was too vague, can you be more specific?");

        const after = readJsonSafe<ValueFormationState>(
          path.join(env8.statePath, "value-formation.json"),
          ceState,
        );
        const candidate = after.candidates.find(c => c.id === "vc_strong");
        const strongCe = candidate?.counterevidence.find(ce => ce.grade === "strong");

        tests.push(assert(
          "strong_counterevidence_from_feedback",
          strongCe != null && strongCe.grade === "strong",
          `strongCe=${strongCe ? "found" : "missing"}`,
        ));
      } finally {
        env8.cleanup();
      }
    }

  } finally {
    env.cleanup();
  }

  return { name: "Value Formation (4.1A+B)", tests };
}
