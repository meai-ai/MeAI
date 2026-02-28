/**
 * Tool dispatcher and registry.
 *
 * Loads built-in tools (memory, skills, etc.) and hot-loaded skill tools
 * at the start of every agent turn.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition, AppConfig } from "../types.js";
import { getMemoryTools } from "../evolution/memory.js";
import { getSkillTools } from "../evolution/skills.js";
import { getInstallerTools } from "../evolution/installer.js";
import { getPatcherTools } from "../evolution/patcher.js";
import { getSkillDiscoveryTools } from "../evolution/skill-discovery.js";
import { getNotificationTools } from "../notifications.js";
import { moduleRegistry } from "../modules/registry.js";
import { getCharacterUpdateTools } from "../character.js";

/**
 * Callbacks that the tool registry needs to send Telegram messages
 * for Tier 3/4 approval gates.
 */
export interface ToolRegistryCallbacks {
  sendToolProposal: (name: string, description: string, code: string) => Promise<void>;
  sendPatchProposal: (patchId: string, reason: string, filesChanged: string[]) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  sendPhoto?: (photo: Buffer, caption?: string) => Promise<void>;
}

/**
 * Scan each skill directory for a tools.ts file and dynamically import it.
 *
 * Each tools.ts must export a function:
 *   export function getTools(config: AppConfig): ToolDefinition[]
 *
 * A cache-busting query parameter is appended to force re-import on each turn.
 *
 * When selectedSkills is provided, only skills in that set are loaded
 * (progressive skill loading). When omitted, all skills are loaded (legacy).
 */
async function scanSkillTools(
  config: AppConfig,
  selectedSkills?: Set<string>,
): Promise<ToolDefinition[]> {
  const skillsDir = path.join(config.statePath, "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const tools: ToolDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip skills not selected for this turn (progressive loading)
    if (selectedSkills && !selectedSkills.has(entry.name)) continue;

    const toolsPath = path.join(skillsDir, entry.name, "tools.ts");
    if (!fs.existsSync(toolsPath)) continue;

    try {
      // Cache-bust by appending timestamp
      const fileUrl = pathToFileURL(toolsPath).href + `?t=${Date.now()}`;
      const mod = await import(fileUrl);

      // Support both ESM named export and CJS-wrapped default export
      const getToolsFn = typeof mod.getTools === "function"
        ? mod.getTools
        : typeof mod.default?.getTools === "function"
          ? mod.default.getTools
          : null;

      if (getToolsFn) {
        const skillTools: ToolDefinition[] = getToolsFn(config);
        for (const tool of skillTools) {
          tools.push(tool);
        }
        console.log(`Hot-loaded ${skillTools.length} tool(s) from skill: ${entry.name}`);
      } else {
        console.warn(`Skill ${entry.name}/tools.ts has no getTools() export, skipping.`);
      }
    } catch (err) {
      console.error(`Error loading tools from skill ${entry.name}:`, err);
    }
  }

  return tools;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private callbacks: ToolRegistryCallbacks | null = null;

  /**
   * Set callbacks for Telegram interactions (Tier 3/4 approval gates).
   */
  setCallbacks(callbacks: ToolRegistryCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Load available tools (called at the start of every agent turn).
   *
   * When selectedSkills is provided (progressive loading), only hot-loads
   * tools from the selected skill directories. Core tools (memory, skill
   * management, installer, patcher) are always loaded.
   */
  async loadTools(config: AppConfig, selectedSkills?: Set<string>): Promise<void> {
    this.tools.clear();

    // Tier 1: Memory tools (always loaded)
    for (const tool of getMemoryTools(config)) {
      this.register(tool);
    }

    // Tier 2: Skill management tools (always loaded)
    for (const tool of getSkillTools(config)) {
      this.register(tool);
    }

    // Skill discovery: ClawHub search + evaluate (always loaded)
    for (const tool of getSkillDiscoveryTools(config)) {
      this.register(tool);
    }

    // Notification tools: subscribe, unsubscribe, list_subscriptions, check_notifications
    for (const tool of getNotificationTools(config)) {
      this.register(tool);
    }

    // SimModule tools — from extensible modules (src/modules/*/index.ts)
    for (const tool of moduleRegistry.getAllTools(config)) {
      this.register(tool);
    }

    // Character tools: update_character + confirm_character_update (always loaded)
    for (const tool of getCharacterUpdateTools(config)) {
      this.register(tool);
    }

    // Hot-loaded skill tools — filtered to selected skills when progressive loading is active
    const hotTools = await scanSkillTools(config, selectedSkills);
    for (const tool of hotTools) {
      this.register(tool);
    }

    if (selectedSkills) {
      console.log(
        `[skill-router] Loaded tools for ${selectedSkills.size} selected skill(s): ${[...selectedSkills].join(", ")}`,
      );
    }

    // Tier 3: Tool installer
    if (this.callbacks) {
      const installerTools = getInstallerTools(config, this.callbacks.sendToolProposal);
      for (const tool of installerTools) {
        this.register(tool);
      }
    }

    // Tier 4: Codebase patcher
    if (this.callbacks) {
      const patcherTools = getPatcherTools(config, this.callbacks.sendPatchProposal);
      for (const tool of patcherTools) {
        this.register(tool);
      }
    }
  }

  /**
   * Get all tool definitions for the Anthropic API.
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  /**
   * Execute a tool by name.
   */
  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}"`;
    }
    try {
      return await tool.execute(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing tool "${name}": ${msg}`;
    }
  }

  /**
   * Register a tool (used by built-in tools and hot-loaded skill tools).
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Check if any tools are registered.
   */
  hasTools(): boolean {
    return this.tools.size > 0;
  }
}
