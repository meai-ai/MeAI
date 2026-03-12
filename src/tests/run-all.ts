/**
 * Unified test runner for cross-module integration tests.
 *
 * Runs: turn-replay, state-invariants, proactive-safety, memory-integrity,
 *       provenance-audit, style-learning, value-formation, self-narrative,
 *       relational-impact, boundary, error-metrics, decision-provenance,
 *       evolution-safety, behavioral-snapshot, simulation
 * Usage: npx tsx src/tests/run-all.ts
 */

import { formatSuiteResults, type TestSuite } from "../brainstem/test-helpers.js";
import { runTurnReplayTests } from "./turn-replay.js";
import { runStateInvariantTests } from "./state-invariants.js";
import { runProactiveSafetyTests } from "./proactive-safety.js";
import { runMemoryIntegrityTests } from "./memory-integrity.js";
import { runProvenanceAuditTests } from "./provenance-audit.js";
import { runStyleLearningTests } from "./style-learning.js";
import { runValueFormationTests } from "./value-formation.js";
import { runSelfNarrativeTests } from "./self-narrative.js";
import { runRelationalImpactTests } from "./relational-impact.js";
import { runBoundaryTests } from "./boundary.js";
import { runErrorMetricsTests } from "./error-metrics.js";
import { runDecisionProvenanceTests } from "./decision-provenance.js";
import { runEvolutionSafetyTests } from "./evolution-safety.js";
import { runBehavioralSnapshotTests } from "./behavioral-snapshot.js";
import { runSimulationTests } from "./simulation.js";

const start = Date.now();

console.log("=".repeat(60));
console.log("  Cross-Module Integration Tests — Full Run");
console.log("=".repeat(60));

const allSuites: TestSuite[] = [];

console.log("\n[1/15] Running turn-directive replay tests...");
try {
  allSuites.push(runTurnReplayTests());
} catch (err) {
  console.error("  Turn replay suite FAILED to load:", err);
  allSuites.push({ name: "TurnDirective Replay", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[2/15] Running state invariant tests...");
try {
  allSuites.push(runStateInvariantTests());
} catch (err) {
  console.error("  State invariants suite FAILED to load:", err);
  allSuites.push({ name: "State Invariants", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[3/15] Running proactive safety tests...");
try {
  allSuites.push(runProactiveSafetyTests());
} catch (err) {
  console.error("  Proactive safety suite FAILED to load:", err);
  allSuites.push({ name: "Proactive Safety", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[4/15] Running memory integrity tests...");
try {
  allSuites.push(runMemoryIntegrityTests());
} catch (err) {
  console.error("  Memory integrity suite FAILED to load:", err);
  allSuites.push({ name: "Memory Integrity", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[5/15] Running provenance audit tests...");
try {
  allSuites.push(runProvenanceAuditTests());
} catch (err) {
  console.error("  Provenance audit suite FAILED to load:", err);
  allSuites.push({ name: "Provenance Audit (4.3)", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[6/15] Running style-reaction learning tests...");
try {
  allSuites.push(runStyleLearningTests());
} catch (err) {
  console.error("  Style learning suite FAILED to load:", err);
  allSuites.push({ name: "Style-Reaction Learning (4.2)", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[7/15] Running value formation tests...");
try {
  allSuites.push(runValueFormationTests());
} catch (err) {
  console.error("  Value formation suite FAILED to load:", err);
  allSuites.push({ name: "Value Formation (4.1A+B)", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[8/15] Running self-narrative tests...");
try {
  allSuites.push(runSelfNarrativeTests());
} catch (err) {
  console.error("  Self-narrative suite FAILED to load:", err);
  allSuites.push({ name: "Self-Narrative (P2)", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[9/15] Running relational impact tests...");
try {
  allSuites.push(runRelationalImpactTests());
} catch (err) {
  console.error("  Relational impact suite FAILED to load:", err);
  allSuites.push({ name: "Relational Impact (P3)", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[10/15] Running P0 boundary tests...");
try {
  allSuites.push(runBoundaryTests());
} catch (err) {
  console.error("  Boundary tests suite FAILED to load:", err);
  allSuites.push({ name: "P0 Boundary Tests", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[11/15] Running error metrics tests...");
try {
  allSuites.push(runErrorMetricsTests());
} catch (err) {
  console.error("  Error metrics suite FAILED to load:", err);
  allSuites.push({ name: "Error Metrics", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[12/15] Running decision provenance tests...");
try {
  allSuites.push(runDecisionProvenanceTests());
} catch (err) {
  console.error("  Decision provenance suite FAILED to load:", err);
  allSuites.push({ name: "Decision Provenance", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[13/15] Running evolution safety tests...");
try {
  allSuites.push(runEvolutionSafetyTests());
} catch (err) {
  console.error("  Evolution safety suite FAILED to load:", err);
  allSuites.push({ name: "Evolution Safety", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[14/15] Running behavioral snapshot tests...");
try {
  allSuites.push(runBehavioralSnapshotTests());
} catch (err) {
  console.error("  Behavioral snapshot suite FAILED to load:", err);
  allSuites.push({ name: "Behavioral Snapshot", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log("[15/15] Running simulation harness tests...");
try {
  allSuites.push(runSimulationTests());
} catch (err) {
  console.error("  Simulation suite FAILED to load:", err);
  allSuites.push({ name: "Simulation Harness", tests: [{ name: "suite_load", passed: false, message: `Failed: ${err}` }] });
}

console.log(formatSuiteResults(allSuites));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const totalTests = allSuites.flatMap(s => s.tests);
const passed = totalTests.filter(t => t.passed).length;
const failed = totalTests.filter(t => !t.passed).length;

console.log(`\nCompleted in ${elapsed}s`);

process.exit(failed > 0 ? 1 : 0);
