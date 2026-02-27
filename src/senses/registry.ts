/**
 * Sense Provider registry — auto-discovers information source providers.
 *
 * Key method: getSense(type) returns the first available provider for a sense type.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseRegistry } from "../registry/base.js";
import type { SenseProvider, SenseType } from "./types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("senses");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class SenseRegistry extends BaseRegistry<SenseProvider> {
  constructor() {
    super("senses", __dirname);
  }

  /** Get the first available provider for a sense type. */
  getSense(type: SenseType): SenseProvider | undefined {
    for (const provider of this.getAll()) {
      if (provider.type === type && provider.isAvailable()) {
        return provider;
      }
    }
    return undefined;
  }

  /** Get all available providers for a sense type (for fallback chains). */
  getAllSenses(type: SenseType): SenseProvider[] {
    return this.getAll().filter(p => p.type === type && p.isAvailable());
  }
}

/** Singleton sense registry instance. */
export const senseRegistry = new SenseRegistry();
