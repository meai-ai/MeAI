/**
 * Module registry — auto-discovers and manages SimModule instances.
 *
 * Scans src/modules/[name]/index.ts for modules, topological-sorts by dependencies,
 * and provides aggregation methods for context blocks, heartbeat actions, and tools.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseRegistry } from "../registry/base.js";
import type { SimModule, ContextBlock, HeartbeatActionDef } from "./types.js";
import type { AppConfig, ToolDefinition } from "../types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("modules");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ModuleRegistry extends BaseRegistry<SimModule> {
  constructor() {
    super("modules", __dirname);
  }

  /** Get all context blocks from all modules, sorted by priority (desc). */
  getAllContextBlocks(): ContextBlock[] {
    const blocks: ContextBlock[] = [];
    for (const mod of this.getAll()) {
      try {
        const modBlocks = mod.getContextBlocks?.() ?? [];
        blocks.push(...modBlocks);
      } catch (err) {
        log.warn(`Context blocks failed for module ${mod.id}:`, err);
      }
    }
    return blocks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** Get all heartbeat actions from all modules. */
  getAllHeartbeatActions(): HeartbeatActionDef[] {
    const actions: HeartbeatActionDef[] = [];
    for (const mod of this.getAll()) {
      try {
        const modActions = mod.getHeartbeatActions?.() ?? [];
        actions.push(...modActions);
      } catch (err) {
        log.warn(`Heartbeat actions failed for module ${mod.id}:`, err);
      }
    }
    return actions;
  }

  /** Execute a heartbeat action by ID across all modules. Returns true if handled. */
  async executeHeartbeatAction(actionId: string): Promise<boolean> {
    for (const mod of this.getAll()) {
      if (!mod.executeHeartbeatAction) continue;
      try {
        const handled = await mod.executeHeartbeatAction(actionId);
        if (handled) return true;
      } catch (err) {
        log.warn(`Heartbeat action ${actionId} failed in module ${mod.id}:`, err);
      }
    }
    return false;
  }

  /** Get all tools from all modules. */
  getAllTools(config: AppConfig): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const mod of this.getAll()) {
      try {
        const modTools = mod.getTools?.(config) ?? [];
        tools.push(...modTools);
      } catch (err) {
        log.warn(`Tools failed for module ${mod.id}:`, err);
      }
    }
    return tools;
  }
}

/** Singleton module registry instance. */
export const moduleRegistry = new ModuleRegistry();
