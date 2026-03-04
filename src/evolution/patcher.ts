/**
 * Tier 4 Evolution — Codebase patcher with snapshot + dead man's switch.
 *
 * Provides code_patch: the agent proposes file modifications to its own source.
 * Flow:
 * 1. Snapshot entire src/ to evolution/rollback/<timestamp>/
 * 2. Save proposal to evolution/pending/
 * 3. Send Telegram approval message with inline keyboard
 * 4. On approval:
 *    a. Apply file writes
 *    b. Run test_command if provided (e.g., "npx tsc --noEmit")
 *    c. If test fails: auto-rollback, notify user
 *    d. If test passes: start 10-minute dead man's switch
 *    e. If confirmed within 10 min: delete rollback, log to history
 *    f. If not confirmed: rollback, signal restart
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Telegraf } from "telegraf";
import type {
  AppConfig,
  ToolDefinition,
  PatchProposal,
  PatchFile,
  EvolutionEvent,
} from "../types.js";

// Active dead man's switch timers, keyed by patch ID
const activeTimers = new Map<string, NodeJS.Timeout>();

function getProjectRoot(): string {
  // src/ is inside the project root
  return path.resolve(import.meta.dirname, "..", "..");
}

function getPendingDir(config: AppConfig): string {
  return path.join(config.statePath, "evolution", "pending");
}

function getRollbackDir(config: AppConfig): string {
  return path.join(config.statePath, "evolution", "rollback");
}

function getHistoryDir(config: AppConfig): string {
  return path.join(config.statePath, "evolution", "history");
}

function logEvent(config: AppConfig, event: EvolutionEvent): void {
  const historyDir = getHistoryDir(config);
  const filename = `${event.timestamp}-tier${event.tier}-${event.action}.json`;
  fs.writeFileSync(
    path.join(historyDir, filename),
    JSON.stringify(event, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Recursively copy a directory.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Create a snapshot of src/ for rollback.
 */
function createSnapshot(config: AppConfig, patchId: string): string {
  const projectRoot = getProjectRoot();
  const srcDir = path.join(projectRoot, "src");
  const snapshotDir = path.join(getRollbackDir(config), patchId);

  copyDirSync(srcDir, path.join(snapshotDir, "src"));

  return snapshotDir;
}

/**
 * Rollback src/ from a snapshot.
 */
function rollback(config: AppConfig, snapshotDir: string): void {
  const projectRoot = getProjectRoot();
  const srcDir = path.join(projectRoot, "src");
  const snapshotSrcDir = path.join(snapshotDir, "src");

  if (!fs.existsSync(snapshotSrcDir)) {
    console.error("Rollback snapshot not found:", snapshotSrcDir);
    return;
  }

  // Remove current src/ and replace with snapshot
  fs.rmSync(srcDir, { recursive: true, force: true });
  copyDirSync(snapshotSrcDir, srcDir);

  console.log("Rolled back src/ from snapshot:", snapshotDir);
}

const BLOCKED_PATH_PATTERNS = [
  /node_modules\//,
  /\.env/,
  /\.git\//,
  /config\.json$/,
  /data\/config\.json$/,
];

/**
 * Apply patch files to the project.
 */
function applyPatch(files: PatchFile[]): void {
  const projectRoot = getProjectRoot();
  for (const file of files) {
    const fullPath = path.resolve(projectRoot, file.path);
    // Path traversal check
    if (!fullPath.startsWith(projectRoot + path.sep)) {
      throw new Error(`Path traversal blocked: ${file.path}`);
    }
    // Blocked path patterns
    const relativePath = path.relative(projectRoot, fullPath);
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(relativePath)) {
        throw new Error(`Blocked path: ${file.path} (matches ${pattern})`);
      }
    }
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, file.content, "utf-8");
  }
}

const ALLOWED_COMMANDS = /^(npx tsc|npm test|npm run \w[\w-]*|node [\w/.+-]+\.ts)$/;

/**
 * Run a test command and return success/failure.
 */
function runTest(command: string): { success: boolean; output: string } {
  if (!ALLOWED_COMMANDS.test(command.trim())) {
    return { success: false, output: `Blocked command: "${command}". Only npx tsc, npm test, npm run <script>, and node <file>.ts are allowed.` };
  }
  try {
    const output = execSync(command, {
      cwd: getProjectRoot(),
      encoding: "utf-8",
      timeout: 60_000,
    });
    return { success: true, output };
  } catch (err: unknown) {
    const output =
      err instanceof Error && "stdout" in err
        ? String((err as { stdout: string }).stdout)
        : String(err);
    return { success: false, output };
  }
}

/**
 * Restore pending patches from a previous session.
 * Scans pending/ for approved patches and either rolls back (if expired)
 * or restarts the dead man's switch timer (if still within 10 min window).
 */
export function restorePendingPatches(
  config: AppConfig,
  sendMessage: (text: string) => Promise<void>,
): void {
  const pendingDir = getPendingDir(config);
  if (!fs.existsSync(pendingDir)) return;

  const files = fs.readdirSync(pendingDir).filter(f => f.startsWith("patch-") && f.endsWith(".json"));
  for (const file of files) {
    try {
      const pendingPath = path.join(pendingDir, file);
      const proposal: PatchProposal = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));

      if (proposal.status !== "approved") continue;

      const elapsed = Date.now() - proposal.timestamp;
      const DEAD_MAN_TIMEOUT_MS = 10 * 60 * 1000;

      if (elapsed >= DEAD_MAN_TIMEOUT_MS) {
        // Expired — rollback immediately
        if (proposal.snapshotPath) {
          rollback(config, proposal.snapshotPath);
        }
        fs.unlinkSync(pendingPath);

        logEvent(config, {
          tier: 4,
          action: "patch_timeout_rollback",
          detail: { patchId: proposal.id },
          timestamp: Date.now(),
        });

        sendMessage(`⚠️ Patch "${proposal.id}" expired during restart — rolled back.`).catch(() => {});
        console.log(`[patcher] Rolled back expired patch: ${proposal.id}`);
      } else {
        // Still within window — restart timer with remaining time
        const remaining = DEAD_MAN_TIMEOUT_MS - elapsed;
        const patchId = proposal.id;

        const timer = setTimeout(async () => {
          activeTimers.delete(patchId);

          if (proposal.snapshotPath) {
            rollback(config, proposal.snapshotPath);
          }
          if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);

          logEvent(config, {
            tier: 4,
            action: "patch_timeout_rollback",
            detail: { patchId },
            timestamp: Date.now(),
          });

          await sendMessage(
            "⚠️ No confirmation received within 10 minutes. Rolled back patch and restarting.",
          );
          process.kill(process.pid, "SIGUSR1");
        }, remaining);

        activeTimers.set(patchId, timer);
        console.log(`[patcher] Restored timer for patch ${patchId}: ${Math.round(remaining / 1000)}s remaining`);
      }
    } catch (err) {
      console.error(`[patcher] Failed to restore pending patch ${file}:`, (err as Error).message);
    }
  }
}

/**
 * Set up inline keyboard callback handlers for patch approval/denial.
 */
export function setupPatchApprovalHandlers(
  bot: Telegraf,
  config: AppConfig,
  sendMessage: (text: string) => Promise<void>,
): void {
  // Approve patch
  bot.action(/^patch_approve:(.+)$/, async (ctx) => {
    const patchId = ctx.match[1];
    const pendingPath = path.join(getPendingDir(config), `patch-${patchId}.json`);

    if (!fs.existsSync(pendingPath)) {
      await ctx.answerCbQuery("Patch not found or already processed.");
      return;
    }

    const proposal: PatchProposal = JSON.parse(
      fs.readFileSync(pendingPath, "utf-8"),
    );

    await ctx.answerCbQuery("Applying patch...");

    // Apply the patch files
    applyPatch(proposal.files);

    // Run test command if provided
    if (proposal.testCommand) {
      await ctx.editMessageText(`⚙️ Running tests: \`${proposal.testCommand}\`...`);
      const result = runTest(proposal.testCommand);

      if (!result.success) {
        // Auto-rollback
        if (proposal.snapshotPath) {
          rollback(config, proposal.snapshotPath);
        }
        fs.unlinkSync(pendingPath);

        logEvent(config, {
          tier: 4,
          action: "patch_test_failed",
          detail: { patchId, testOutput: result.output.slice(0, 500) },
          timestamp: Date.now(),
        });

        await ctx.editMessageText(
          `❌ Patch test failed. Rolled back.\n\n\`\`\`\n${result.output.slice(0, 500)}\n\`\`\``,
        );
        return;
      }
    }

    // Start dead man's switch (10 minutes)
    const DEAD_MAN_TIMEOUT_MS = 10 * 60 * 1000;

    const timer = setTimeout(async () => {
      activeTimers.delete(patchId);

      // Rollback
      if (proposal.snapshotPath) {
        rollback(config, proposal.snapshotPath);
      }
      fs.unlinkSync(pendingPath);

      logEvent(config, {
        tier: 4,
        action: "patch_timeout_rollback",
        detail: { patchId },
        timestamp: Date.now(),
      });

      await sendMessage(
        "⚠️ No confirmation received within 10 minutes. Rolled back patch and restarting.",
      );

      // Signal restart
      process.kill(process.pid, "SIGUSR1");
    }, DEAD_MAN_TIMEOUT_MS);

    activeTimers.set(patchId, timer);

    // Update proposal status
    proposal.status = "approved";
    fs.writeFileSync(pendingPath, JSON.stringify(proposal, null, 2) + "\n", "utf-8");

    logEvent(config, {
      tier: 4,
      action: "patch_applied",
      detail: { patchId, filesChanged: proposal.files.map((f) => f.path) },
      timestamp: Date.now(),
    });

    await ctx.editMessageText(
      `✅ Patch applied. Reply "confirm patch ${patchId}" within 10 minutes or it will be rolled back.`,
    );
  });

  // Deny patch
  bot.action(/^patch_deny:(.+)$/, async (ctx) => {
    const patchId = ctx.match[1];
    const pendingPath = path.join(getPendingDir(config), `patch-${patchId}.json`);

    if (!fs.existsSync(pendingPath)) {
      await ctx.answerCbQuery("Patch not found or already processed.");
      return;
    }

    const proposal: PatchProposal = JSON.parse(
      fs.readFileSync(pendingPath, "utf-8"),
    );

    // Clean up snapshot
    if (proposal.snapshotPath && fs.existsSync(proposal.snapshotPath)) {
      fs.rmSync(proposal.snapshotPath, { recursive: true, force: true });
    }

    fs.unlinkSync(pendingPath);

    logEvent(config, {
      tier: 4,
      action: "patch_denied",
      detail: { patchId },
      timestamp: Date.now(),
    });

    await ctx.answerCbQuery("Patch denied.");
    await ctx.editMessageText(`❌ Patch "${patchId}" denied.`);
  });

  // Handle "confirm patch <id>" text messages
  bot.hears(/^confirm patch (.+)$/i, async (ctx) => {
    const patchId = ctx.match[1].trim();
    const timer = activeTimers.get(patchId);

    if (!timer) {
      await ctx.reply(`No pending patch confirmation for "${patchId}".`);
      return;
    }

    // Clear the dead man's switch
    clearTimeout(timer);
    activeTimers.delete(patchId);

    // Clean up
    const pendingPath = path.join(getPendingDir(config), `patch-${patchId}.json`);
    if (fs.existsSync(pendingPath)) {
      const proposal: PatchProposal = JSON.parse(
        fs.readFileSync(pendingPath, "utf-8"),
      );

      // Delete snapshot since patch is confirmed
      if (proposal.snapshotPath && fs.existsSync(proposal.snapshotPath)) {
        fs.rmSync(proposal.snapshotPath, { recursive: true, force: true });
      }

      fs.unlinkSync(pendingPath);
    }

    logEvent(config, {
      tier: 4,
      action: "patch_confirmed",
      detail: { patchId },
      timestamp: Date.now(),
    });

    await ctx.reply("✅ Patch confirmed and committed.");
  });
}

/**
 * Get the code_patch tool definition.
 */
export function getPatcherTools(
  config: AppConfig,
  sendPatchProposal: (patchId: string, reason: string, filesChanged: string[]) => Promise<void>,
): ToolDefinition[] {
  const codePatch: ToolDefinition = {
    name: "code_patch",
    description:
      "Propose a code patch to modify your own source files. This is a Tier 4 evolution action " +
      "that requires user approval via Telegram inline keyboard, plus a dead man's switch confirmation " +
      "within 10 minutes. A snapshot of src/ is taken before applying. If a test_command is provided, " +
      "it will be run after applying; failure triggers auto-rollback.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Array of file modifications",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative path from project root (e.g., 'src/agent/loop.ts')",
              },
              content: {
                type: "string",
                description: "New file content",
              },
            },
            required: ["path", "content"],
          },
        },
        reason: {
          type: "string",
          description: "Why this patch is needed",
        },
        test_command: {
          type: "string",
          description:
            "Optional command to run after applying (e.g., 'npx tsc --noEmit'). Failure triggers rollback.",
        },
      },
      required: ["files", "reason"],
    },
    execute: async (input) => {
      const files = input.files as PatchFile[];
      const reason = input.reason as string;
      const testCommand = input.test_command as string | undefined;

      const patchId = String(Date.now());

      // Create snapshot
      const snapshotPath = createSnapshot(config, patchId);

      // Save proposal
      const proposal: PatchProposal = {
        id: patchId,
        files,
        reason,
        testCommand,
        status: "pending",
        timestamp: Date.now(),
        snapshotPath,
      };

      const pendingPath = path.join(getPendingDir(config), `patch-${patchId}.json`);
      fs.writeFileSync(
        pendingPath,
        JSON.stringify(proposal, null, 2) + "\n",
        "utf-8",
      );

      // Send Telegram approval message
      const filesChanged = files.map((f) => f.path);
      await sendPatchProposal(patchId, reason, filesChanged);

      logEvent(config, {
        tier: 4,
        action: "patch_proposed",
        detail: { patchId, reason, filesChanged },
        timestamp: Date.now(),
      });

      return (
        `Code patch "${patchId}" proposed and sent for approval. ` +
        `${files.length} file(s) will be modified. ` +
        `A snapshot of src/ has been saved for rollback.`
      );
    },
  };

  return [codePatch];
}
