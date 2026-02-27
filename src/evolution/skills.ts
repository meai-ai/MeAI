/**
 * Tier 2 Evolution — Skills system.
 *
 * Provides skill_upsert and skill_delete tools that the agent can call
 * freely (no approval required). Creates/updates SKILL.md files under
 * data/skills/<name>/. Changes take effect on the next turn when
 * the context assembler rescans skills/.
 */

import fs from "node:fs";
import path from "node:path";
import type { AppConfig, ToolDefinition, EvolutionEvent } from "../types.js";

function getSkillsDir(config: AppConfig): string {
  return path.join(config.statePath, "skills");
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

export function getSkillTools(config: AppConfig): ToolDefinition[] {
  const skillUpsert: ToolDefinition = {
    name: "skill_upsert",
    description:
      "Create or update a skill. A skill is a SKILL.md file that gets injected into your system prompt. " +
      "Use this to define domain knowledge, behavioral guidelines, or specialized capabilities. " +
      "The skill will be available on the next turn.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Skill name (alphanumeric + hyphens, e.g., 'coding-style', 'meeting-notes')",
        },
        content: {
          type: "string",
          description: "Markdown content for the SKILL.md file",
        },
      },
      required: ["name", "content"],
    },
    execute: async (input) => {
      const name = input.name as string;
      const content = input.content as string;

      // Validate name
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) {
        return "Error: Skill name must be alphanumeric with hyphens, starting with a letter or number.";
      }

      const skillDir = path.join(getSkillsDir(config), name);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillMdPath = path.join(skillDir, "SKILL.md");
      const isUpdate = fs.existsSync(skillMdPath);

      fs.writeFileSync(skillMdPath, content + "\n", "utf-8");

      const now = Date.now();
      logEvent(config, {
        tier: 2,
        action: isUpdate ? "skill_update" : "skill_create",
        detail: { name, contentLength: content.length },
        timestamp: now,
      });

      return `Skill ${isUpdate ? "updated" : "created"}: ${name} (${content.length} chars). It will appear in your context on the next turn.`;
    },
  };

  const skillDelete: ToolDefinition = {
    name: "skill_delete",
    description:
      "Delete a skill. Removes the SKILL.md file (and its directory if no tools.ts exists). " +
      "The skill will disappear from your context on the next turn.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the skill to delete",
        },
      },
      required: ["name"],
    },
    execute: async (input) => {
      const name = input.name as string;
      const skillDir = path.join(getSkillsDir(config), name);
      const skillMdPath = path.join(skillDir, "SKILL.md");

      if (!fs.existsSync(skillMdPath)) {
        return `Error: Skill not found: ${name}`;
      }

      fs.unlinkSync(skillMdPath);

      // Remove the directory if it's now empty (no tools.ts)
      const toolsPath = path.join(skillDir, "tools.ts");
      if (!fs.existsSync(toolsPath)) {
        try {
          fs.rmdirSync(skillDir);
        } catch {
          // Directory not empty — that's fine, leave it
        }
      }

      const now = Date.now();
      logEvent(config, {
        tier: 2,
        action: "skill_delete",
        detail: { name },
        timestamp: now,
      });

      return `Skill deleted: ${name}. It will disappear from your context on the next turn.`;
    },
  };

  return [skillUpsert, skillDelete];
}
