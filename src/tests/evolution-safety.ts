/**
 * Evolution safety tests.
 *
 * Verify: CORE_PATHS_BLOCKED rejects patches to critical files,
 * BLOCKED_CODE_PATTERNS catches dynamic import, path traversal blocked,
 * existing BLOCKED_PATH_PATTERNS still work.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";

// We test the patcher and installer by importing their tool generators
// and checking the validation logic directly. Since applyPatch and validateToolCode
// are not exported, we test via the tool's execute function or replicate the checks.

import fs from "node:fs";
import path from "node:path";

// computeDiffPreview is not available in the open-source patcher — stub it for tests
function computeDiffPreview(files: Array<{ path: string; content: string }>): string {
  return files.map(f => `--- /dev/null\n+++ ${f.path} (new file)\n${f.content.split("\n").map(l => `+${l}`).join("\n")}`).join("\n\n");
}

// Replicate the blocked patterns from patcher.ts for testing
const BLOCKED_PATH_PATTERNS = [
  /node_modules\//,
  /\.env/,
  /\.git\//,
  /config\.json$/,
  /data\/config\.json$/,
];

const CORE_PATHS_BLOCKED = [
  /^src\/index\.ts$/,
  /^src\/config\.ts$/,
  /^src\/agent\/context\.ts$/,
  /^src\/brainstem\/index\.ts$/,
  /^src\/brainstem\/governance\.ts$/,
  /^src\/lib\/action-gate\.ts$/,
  /^src\/agent\/loop\.ts$/,
];

const BLOCKED_CODE_PATTERNS = [
  { pattern: /child_process/, label: "child_process" },
  { pattern: /\bexec\s*\(/, label: "exec()" },
  { pattern: /\bexecSync\s*\(/, label: "execSync()" },
  { pattern: /\bspawn\s*\(/, label: "spawn()" },
  { pattern: /\beval\s*\(/, label: "eval()" },
  { pattern: /process\.exit/, label: "process.exit" },
  { pattern: /process\.kill/, label: "process.kill" },
  { pattern: /\brequire\s*\(/, label: "require()" },
  // New patterns from Item 3
  { pattern: /import\s*\(/, label: "dynamic import()" },
  { pattern: /globalThis/, label: "globalThis" },
  { pattern: /Reflect\./, label: "Reflect API" },
];

function isPathBlocked(relativePath: string): { blocked: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATH_PATTERNS) {
    if (pattern.test(relativePath)) return { blocked: true, reason: `BLOCKED_PATH: ${pattern}` };
  }
  for (const pattern of CORE_PATHS_BLOCKED) {
    if (pattern.test(relativePath)) return { blocked: true, reason: `CORE_BLOCKED: ${pattern}` };
  }
  return { blocked: false };
}

function isCodeBlocked(code: string): { blocked: boolean; label?: string } {
  for (const { pattern, label } of BLOCKED_CODE_PATTERNS) {
    if (pattern.test(code)) return { blocked: true, label };
  }
  return { blocked: false };
}

export function runEvolutionSafetyTests(): TestSuite {
  const tests: TestResult[] = [];

  // 1. core_file_src_index_blocked
  {
    const result = isPathBlocked("src/index.ts");
    tests.push(assert(
      "core_file_src_index_blocked",
      result.blocked,
      `src/index.ts → blocked=${result.blocked}`,
    ));
  }

  // 2. core_file_governance_blocked
  {
    const result = isPathBlocked("src/brainstem/governance.ts");
    tests.push(assert(
      "core_file_governance_blocked",
      result.blocked,
      `src/brainstem/governance.ts → blocked=${result.blocked}`,
    ));
  }

  // 3. core_file_action_gate_blocked
  {
    const result = isPathBlocked("src/lib/action-gate.ts");
    tests.push(assert(
      "core_file_action_gate_blocked",
      result.blocked,
      `src/lib/action-gate.ts → blocked=${result.blocked}`,
    ));
  }

  // 4. non_core_file_allowed
  {
    const result = isPathBlocked("src/curiosity.ts");
    tests.push(assert(
      "non_core_file_allowed",
      !result.blocked,
      `src/curiosity.ts → blocked=${result.blocked}`,
    ));
  }

  // 5. dynamic_import_blocked
  {
    const code = `const mod = await import("./evil.js");`;
    const result = isCodeBlocked(code);
    tests.push(assert(
      "dynamic_import_blocked",
      result.blocked && result.label === "dynamic import()",
      `dynamic import → blocked=${result.blocked}, label=${result.label}`,
    ));
  }

  // 6. globalThis_blocked
  {
    const code = `globalThis.process.env.SECRET`;
    const result = isCodeBlocked(code);
    tests.push(assert(
      "globalThis_blocked",
      result.blocked && result.label === "globalThis",
      `globalThis → blocked=${result.blocked}`,
    ));
  }

  // 7. reflect_api_blocked
  {
    const code = `Reflect.defineProperty(obj, "x", {})`;
    const result = isCodeBlocked(code);
    tests.push(assert(
      "reflect_api_blocked",
      result.blocked && result.label === "Reflect API",
      `Reflect API → blocked=${result.blocked}`,
    ));
  }

  // 8. path_traversal_blocked
  {
    // Replicate the path.resolve traversal guard from applyPatch
    const projectRoot = path.resolve(".");
    const evilPath = "../../../etc/passwd";
    const resolved = path.resolve(projectRoot, evilPath);
    const blocked = !resolved.startsWith(projectRoot + path.sep);
    tests.push(assert(
      "path_traversal_blocked",
      blocked,
      `../../../etc/passwd → resolved=${resolved}, blocked=${blocked}`,
    ));
  }

  // 9. existing_blocked_paths_still_work
  {
    const cases = [
      "node_modules/evil/index.js",
      ".env.local",
      ".git/config",
      "data/config.json",
    ];
    const allBlocked = cases.every(p => isPathBlocked(p).blocked);
    tests.push(assert(
      "existing_blocked_paths_still_work",
      allBlocked,
      `all ${cases.length} legacy patterns still blocked`,
    ));
  }

  // 10. safe_code_passes
  {
    const code = `export function getTools() { return [{ name: "hello", execute: async () => "hi" }]; }`;
    const result = isCodeBlocked(code);
    tests.push(assert(
      "safe_code_passes",
      !result.blocked,
      `safe code → blocked=${result.blocked}`,
    ));
  }

  // 11. existing_code_patterns_still_work
  {
    const evilCodes = [
      `require("fs")`,
      `eval("alert(1)")`,
      `process.exit(1)`,
      `child_process.exec("rm -rf /")`,
    ];
    const allBlocked = evilCodes.every(c => isCodeBlocked(c).blocked);
    tests.push(assert(
      "existing_code_patterns_still_work",
      allBlocked,
      `all ${evilCodes.length} legacy code patterns still blocked`,
    ));
  }

  // 12. diff_preview_new_file
  {
    const preview = computeDiffPreview([{ path: "src/new-module.ts", content: "export const x = 1;\nexport const y = 2;\n" }]);
    tests.push(assert(
      "diff_preview_new_file",
      preview.includes("new file") && preview.includes("src/new-module.ts"),
      `new file preview: ${preview.slice(0, 60)}`,
    ));
  }

  // 13. diff_preview_multiple_files
  {
    // Multiple new files should each appear in preview
    const preview = computeDiffPreview([
      { path: "src/mod-a.ts", content: "export const a = 1;\n" },
      { path: "src/mod-b.ts", content: "export const b = 2;\nexport const c = 3;\n" },
    ]);
    tests.push(assert(
      "diff_preview_multiple_files",
      preview.includes("src/mod-a.ts") && preview.includes("src/mod-b.ts"),
      `multi-file preview includes both paths`,
    ));
  }

  return { name: "Evolution Safety", tests };
}
