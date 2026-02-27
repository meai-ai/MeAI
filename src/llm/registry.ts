/**
 * LLM Provider registry — auto-discovers and manages LLM backends.
 *
 * Key method: getProvider(role) returns the configured provider for a role.
 * Fallback chain if primary is unavailable.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseRegistry } from "../registry/base.js";
import type { LLMProvider, LLMRole } from "./types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("llm");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** LLM role → provider ID mapping (from config). */
let roleMapping: Partial<Record<LLMRole, string>> = {};

class LLMRegistry extends BaseRegistry<LLMProvider> {
  constructor() {
    super("llm", __dirname);
  }

  /** Set the role → provider mapping (called from config loading). */
  setRoleMapping(mapping: Partial<Record<LLMRole, string>>): void {
    roleMapping = mapping;
  }

  /**
   * Get the provider configured for a specific role.
   * Falls back to any available provider with that role if configured one is unavailable.
   */
  getProvider(role: LLMRole): LLMProvider | undefined {
    // Try configured provider first
    const configuredId = roleMapping[role];
    if (configuredId) {
      const provider = this.get(configuredId);
      if (provider?.isAvailable()) return provider;
      log.warn(`Configured ${role} provider "${configuredId}" not available, trying fallbacks`);
    }

    // Fallback: first available provider that supports this role
    for (const provider of this.getAll()) {
      if (provider.roles.includes(role) && provider.isAvailable()) {
        return provider;
      }
    }

    return undefined;
  }
}

/** Singleton LLM registry instance. */
export const llmRegistry = new LLMRegistry();
