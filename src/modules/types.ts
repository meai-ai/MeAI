/**
 * SimModule — extensible life simulation modules.
 *
 * Contributors can add new life dimensions (pets, finance, fitness, cooking,
 * plants, commute, dating) by creating src/modules/<name>/index.ts that
 * exports a default SimModule instance. No core file edits needed.
 */

import type { AppConfig, ToolDefinition } from "../types.js";

/** A block of context to inject into the system prompt. */
export interface ContextBlock {
  /** Section header (e.g., "What my cat did today") */
  header: string;
  /** Body text (markdown-compatible) */
  body: string;
  /** Priority: higher = appears earlier in context. Default: 0 */
  priority?: number;
}

/** A heartbeat action that this module can execute. */
export interface HeartbeatActionDef {
  /** Unique action ID, e.g. "feed_pet" */
  id: string;
  /** Human-readable description shown to the heartbeat LLM */
  description: string;
  /** Minimum minutes between executions */
  cooldownMinutes: number;
  /** Schedule categories where this action is allowed */
  allowedDuringCategories?: string[];
}

/** Core interface for all simulation modules. */
export interface SimModule {
  /** Unique module ID, e.g. "pets", "finance" */
  readonly id: string;
  /** Display name, e.g. "Pet Simulation" */
  readonly name: string;
  /** Module IDs that must init before this one */
  readonly dependencies?: string[];

  /** Called once at startup with the app config. */
  init(config: AppConfig): void | Promise<void>;
  /** Called on shutdown for cleanup. */
  teardown?(): void | Promise<void>;

  /** Inject context blocks into the system prompt each turn. */
  getContextBlocks?(): ContextBlock[];
  /** Declare autonomous heartbeat actions this module can perform. */
  getHeartbeatActions?(): HeartbeatActionDef[];
  /** Execute a heartbeat action by ID. Returns true if executed. */
  executeHeartbeatAction?(actionId: string): Promise<boolean>;
  /** Provide agent tools for this module. */
  getTools?(config: AppConfig): ToolDefinition[];

  /**
   * Character config key — if set, this module reads its config from
   * character.yaml under modules.<characterConfigKey>.
   */
  characterConfigKey?: string;
}
