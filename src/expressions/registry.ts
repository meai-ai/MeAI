/**
 * Expression Provider registry — auto-discovers creative output providers.
 *
 * Key method: getExpression(type) returns the first available provider for a type.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseRegistry } from "../registry/base.js";
import type { ExpressionProvider, ExpressionType } from "./types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("expressions");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ExpressionRegistry extends BaseRegistry<ExpressionProvider> {
  constructor() {
    super("expressions", __dirname);
  }

  /** Get the first available provider for an expression type. */
  getExpression(type: ExpressionType): ExpressionProvider | undefined {
    for (const provider of this.getAll()) {
      if (provider.type === type && provider.isAvailable()) {
        return provider;
      }
    }
    return undefined;
  }

  /** Get all available providers for an expression type (for fallback chains). */
  getAllExpressions(type: ExpressionType): ExpressionProvider[] {
    return this.getAll().filter(p => p.type === type && p.isAvailable());
  }
}

/** Singleton expression registry instance. */
export const expressionRegistry = new ExpressionRegistry();
