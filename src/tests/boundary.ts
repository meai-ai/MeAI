/**
 * P0 Boundary tests — verify write-permission boundaries at the import level.
 *
 * These tests read source files and verify that modules do NOT import
 * forbidden dependencies, enforcing the P0 write-permission model:
 *
 * - self-narrative.ts: must NOT import brainstem/self-model
 * - relational-impact.ts: must NOT import brainstem/self-model or call belief mutation
 * - turn-directive.ts: must NOT import value-formation or read emergingValues
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import fs from "node:fs";
import path from "node:path";

export function runBoundaryTests(): TestSuite {
  const tests: TestResult[] = [];
  const srcDir = path.resolve(import.meta.dirname, "..");

  // 1. self-narrative.ts must NOT import brainstem/self-model
  {
    const source = fs.readFileSync(path.join(srcDir, "self-narrative.ts"), "utf-8");
    const importsSelfModel = /import.*from.*["'].*brainstem\/self-model/.test(source);
    tests.push(assert(
      "self_narrative_no_self_model_import",
      importsSelfModel === false,
      `self-narrative.ts imports brainstem/self-model: ${importsSelfModel}`,
    ));
  }

  // 2. self-narrative.ts must NOT import brainstem/index (no brainstem writes)
  {
    const source = fs.readFileSync(path.join(srcDir, "self-narrative.ts"), "utf-8");
    const importsBrainstem = /import.*from.*["'].*brainstem\/index/.test(source);
    tests.push(assert(
      "self_narrative_no_brainstem_import",
      importsBrainstem === false,
      `self-narrative.ts imports brainstem/index: ${importsBrainstem}`,
    ));
  }

  // 3. relational-impact.ts must NOT import brainstem/self-model
  {
    const source = fs.readFileSync(path.join(srcDir, "relational-impact.ts"), "utf-8");
    const importsSelfModel = /import.*from.*["'].*brainstem\/self-model/.test(source);
    tests.push(assert(
      "relational_impact_no_self_model_import",
      importsSelfModel === false,
      `relational-impact.ts imports brainstem/self-model: ${importsSelfModel}`,
    ));
  }

  // 4. relational-impact.ts must NOT call any belief mutation functions
  {
    const source = fs.readFileSync(path.join(srcDir, "relational-impact.ts"), "utf-8");
    const callsBeliefMutation = /brainstemBirthTypedBelief|brainstemRemoveBelief|birthBelief|birthTypedBelief|removeBelief/.test(source);
    tests.push(assert(
      "relational_impact_no_belief_mutation",
      callsBeliefMutation === false,
      `relational-impact.ts calls belief mutation: ${callsBeliefMutation}`,
    ));
  }

  // 5. turn-directive.ts must NOT import value-formation
  {
    const source = fs.readFileSync(path.join(srcDir, "agent", "turn-directive.ts"), "utf-8");
    const importsVF = /import.*from.*["'].*value-formation/.test(source);
    tests.push(assert(
      "turn_directive_no_value_formation_import",
      importsVF === false,
      `turn-directive.ts imports value-formation: ${importsVF}`,
    ));
  }

  // 6. turn-directive.ts must NOT reference emergingValues
  {
    const source = fs.readFileSync(path.join(srcDir, "agent", "turn-directive.ts"), "utf-8");
    const readsEmerging = /emergingValues/.test(source);
    tests.push(assert(
      "turn_directive_no_emergingValues_reference",
      readsEmerging === false,
      `turn-directive.ts references emergingValues: ${readsEmerging}`,
    ));
  }

  // 7. self-narrative.ts must NOT write to value-formation state
  {
    const source = fs.readFileSync(path.join(srcDir, "self-narrative.ts"), "utf-8");
    const writesVF = /import.*from.*["'].*value-formation/.test(source) &&
                     /writeJsonAtomic.*value-formation/.test(source);
    tests.push(assert(
      "self_narrative_no_value_formation_write",
      writesVF === false,
      `self-narrative.ts writes value-formation: ${writesVF}`,
    ));
  }

  // 8. relational-impact.ts must NOT write to self-model state
  {
    const source = fs.readFileSync(path.join(srcDir, "relational-impact.ts"), "utf-8");
    const writesSM = /writeJsonAtomic.*self-model/.test(source);
    tests.push(assert(
      "relational_impact_no_self_model_write",
      writesSM === false,
      `relational-impact.ts writes self-model state: ${writesSM}`,
    ));
  }

  return { name: "P0 Boundary Tests", tests };
}
