/**
 * Unified test runner for all brainstem test suites.
 *
 * Runs: G2 (benchmarks) + G2b (ablation) + G3 (invariants) + G4 (adversarial)
 * Usage: npx tsx src/brainstem/tests/run-all.ts
 */

import { runAllBenchmarks } from "./benchmarks.js";
import { runAllAblations } from "./ablation.js";
import { runAllInvariants } from "./invariants.js";
import { runAllAdversarial } from "./adversarial.js";
import { formatSuiteResults, type TestSuite } from "../test-helpers.js";

const start = Date.now();

console.log("=" .repeat(60));
console.log("  Brainstem Test Suite — Full Run");
console.log("=" .repeat(60));

const allSuites: TestSuite[] = [];

console.log("\n[1/4] Running behavioral benchmarks (G2)...");
allSuites.push(...runAllBenchmarks());

console.log("[2/4] Running ablation tests (G2b)...");
allSuites.push(...runAllAblations());

console.log("[3/4] Running property-based invariants (G3)...");
allSuites.push(...runAllInvariants());

console.log("[4/4] Running adversarial tests (G4)...");
allSuites.push(...runAllAdversarial());

console.log(formatSuiteResults(allSuites));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const totalTests = allSuites.flatMap(s => s.tests);
const passed = totalTests.filter(t => t.passed).length;
const failed = totalTests.filter(t => !t.passed).length;

console.log(`\nCompleted in ${elapsed}s`);

process.exit(failed > 0 ? 1 : 0);
