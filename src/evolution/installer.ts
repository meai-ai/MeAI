/**
 * Tier 3 Evolution — Tool installer with Telegram approval gate.
 *
 * Provides tool_propose: the agent writes a tool proposal, which is sent
 * to the user via Telegram inline keyboard for approval/denial.
 * On approval, the tool code is written to skills/<name>/tools.ts and
 * hot-loaded into the registry immediately.
 */

import fs from "node:fs";
import path from "node:path";
import type { Telegraf } from "telegraf";
import type { AppConfig, ToolDefinition, ToolProposal, EvolutionEvent } from "../types.js";

function getPendingDir(config: AppConfig): string {
  return path.join(config.statePath, "evolution", "pending");
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

const BLOCKED_CODE_PATTERNS = [
  { pattern: /child_process/, label: "child_process" },
  { pattern: /\bexec\s*\(/, label: "exec()" },
  { pattern: /\bexecSync\s*\(/, label: "execSync()" },
  { pattern: /\bspawn\s*\(/, label: "spawn()" },
  { pattern: /\beval\s*\(/, label: "eval()" },
  { pattern: /process\.exit/, label: "process.exit" },
  { pattern: /process\.kill/, label: "process.kill" },
  { pattern: /\brequire\s*\(/, label: "require()" },
];

function validateToolCode(code: string): { safe: boolean; reason?: string } {
  for (const { pattern, label } of BLOCKED_CODE_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, reason: `Blocked pattern: ${label}` };
    }
  }
  return { safe: true };
}

/**
 * Set up the inline keyboard callback handlers on the Telegraf bot
 * for approving/denying tool proposals.
 */
export function setupToolApprovalHandlers(
  bot: Telegraf,
  config: AppConfig,
): void {
  // Approve tool
  bot.action(/^tool_approve:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const pendingPath = path.join(getPendingDir(config), `${name}.json`);

    if (!fs.existsSync(pendingPath)) {
      await ctx.answerCbQuery("Proposal not found or already processed.");
      return;
    }

    const proposal: ToolProposal = JSON.parse(
      fs.readFileSync(pendingPath, "utf-8"),
    );

    // Validate tool code safety
    const validation = validateToolCode(proposal.code);
    if (!validation.safe) {
      fs.unlinkSync(pendingPath);
      await ctx.answerCbQuery("Tool blocked for safety!");
      await ctx.editMessageText(`🚫 Tool "${name}" blocked: ${validation.reason}`);
      logEvent(config, {
        tier: 3,
        action: "tool_blocked",
        detail: { name, reason: validation.reason },
        timestamp: Date.now(),
      });
      return;
    }

    // Write to skills/<name>/tools.ts
    const skillDir = path.join(config.statePath, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "tools.ts"), proposal.code, "utf-8");

    // Create a SKILL.md if one doesn't exist
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      fs.writeFileSync(
        skillMdPath,
        `# ${name}\n\n${proposal.description}\n`,
        "utf-8",
      );
    }

    // Update proposal status and clean up
    proposal.status = "approved";
    fs.unlinkSync(pendingPath);

    const now = Date.now();
    logEvent(config, {
      tier: 3,
      action: "tool_approved",
      detail: { name, description: proposal.description },
      timestamp: now,
    });

    await ctx.answerCbQuery("Tool approved!");
    await ctx.editMessageText(
      `✅ Tool "${name}" approved and installed. It will be available on the next turn.`,
    );
  });

  // Deny tool
  bot.action(/^tool_deny:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const pendingPath = path.join(getPendingDir(config), `${name}.json`);

    if (!fs.existsSync(pendingPath)) {
      await ctx.answerCbQuery("Proposal not found or already processed.");
      return;
    }

    fs.unlinkSync(pendingPath);

    const now = Date.now();
    logEvent(config, {
      tier: 3,
      action: "tool_denied",
      detail: { name },
      timestamp: now,
    });

    await ctx.answerCbQuery("Tool denied.");
    await ctx.editMessageText(`❌ Tool "${name}" denied.`);
  });

  // Show full code
  bot.action(/^tool_code:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const pendingPath = path.join(getPendingDir(config), `${name}.json`);

    if (!fs.existsSync(pendingPath)) {
      await ctx.answerCbQuery("Proposal not found.");
      return;
    }

    const proposal: ToolProposal = JSON.parse(
      fs.readFileSync(pendingPath, "utf-8"),
    );

    // Telegram message limit is 4096 chars; truncate if needed
    let codeText = proposal.code;
    if (codeText.length > 3800) {
      codeText = codeText.slice(0, 3800) + "\n... (truncated)";
    }

    await ctx.answerCbQuery();
    await ctx.reply(`\`\`\`typescript\n${codeText}\n\`\`\``, {
      parse_mode: "Markdown",
    });
  });
}

/**
 * Get the tool_propose tool definition.
 */
export function getInstallerTools(
  config: AppConfig,
  sendProposal: (name: string, description: string, code: string) => Promise<void>,
): ToolDefinition[] {
  const toolPropose: ToolDefinition = {
    name: "tool_propose",
    description:
      "Propose a new tool for installation. The proposal will be sent to the user for approval " +
      "via Telegram inline keyboard. The tool code must be a valid TypeScript file that exports " +
      "a getTools(config) function returning ToolDefinition[]. On approval, it will be installed " +
      "as a hot-loadable skill tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name (alphanumeric + hyphens, e.g., 'web-search', 'calculator')",
        },
        description: {
          type: "string",
          description: "Human-readable description of what this tool does",
        },
        code: {
          type: "string",
          description:
            "TypeScript source code for tools.ts. Must export: function getTools(config: AppConfig): ToolDefinition[]",
        },
      },
      required: ["name", "description", "code"],
    },
    execute: async (input) => {
      const name = input.name as string;
      const description = input.description as string;
      const code = input.code as string;

      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
        return "Error: Tool name must be alphanumeric with hyphens.";
      }

      const validation = validateToolCode(code);
      if (!validation.safe) {
        return `Error: Tool code blocked for safety — ${validation.reason}. Remove the dangerous pattern and try again.`;
      }

      // Save proposal to pending
      const proposal: ToolProposal = {
        name,
        description,
        code,
        status: "pending",
        timestamp: Date.now(),
      };

      const pendingPath = path.join(getPendingDir(config), `${name}.json`);
      fs.writeFileSync(
        pendingPath,
        JSON.stringify(proposal, null, 2) + "\n",
        "utf-8",
      );

      // Send Telegram approval message
      await sendProposal(name, description, code);

      logEvent(config, {
        tier: 3,
        action: "tool_proposed",
        detail: { name, description },
        timestamp: Date.now(),
      });

      return `Tool "${name}" proposed and sent for approval. The user will see an inline keyboard to approve or deny.`;
    },
  };

  return [toolPropose];
}
