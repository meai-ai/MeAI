/**
 * Base registry — shared auto-discovery + lifecycle pattern for all 5 axes.
 *
 * Each axis (modules, channels, senses, expressions, llm) follows the same pattern:
 *   1. Auto-discover providers under src/[axis]/[name]/index.ts
 *   2. Topological sort by dependencies (if any)
 *   3. Init all providers in order
 *   4. Provide aggregation methods (getAll, getByType, etc.)
 *
 * Subclasses just define the axis directory and provider-specific logic.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../lib/logger.js";
import type { AppConfig } from "../types.js";

/** Minimal interface all registerable providers must satisfy. */
export interface Registerable {
  readonly id: string;
  readonly name: string;
  readonly dependencies?: string[];
  init?(config: AppConfig): void | Promise<void>;
  teardown?(): void | Promise<void>;
  isAvailable?(): boolean;
}

const log = createLogger("registry");

export class BaseRegistry<T extends Registerable> {
  protected providers = new Map<string, T>();
  protected axisName: string;
  protected axisDir: string;
  private initialized = false;

  constructor(axisName: string, axisDir: string) {
    this.axisName = axisName;
    this.axisDir = axisDir;
  }

  /**
   * Auto-discover providers by scanning axisDir for subdirectories with index.ts.
   * Each index.ts must have a default export of the provider instance.
   */
  async discover(): Promise<void> {
    if (!fs.existsSync(this.axisDir)) {
      log.info(`[${this.axisName}] No provider directory at ${this.axisDir}, skipping discovery`);
      return;
    }

    const entries = fs.readdirSync(this.axisDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const indexPath = path.join(this.axisDir, entry.name, "index.ts");
      if (!fs.existsSync(indexPath)) continue;

      try {
        const fileUrl = pathToFileURL(indexPath).href;
        const mod = await import(fileUrl);
        const provider: T | undefined = mod.default ?? mod;

        if (provider && typeof provider === "object" && "id" in provider) {
          this.register(provider as T);
          log.info(`[${this.axisName}] Discovered provider: ${(provider as T).id}`);
        } else {
          log.warn(`[${this.axisName}] ${entry.name}/index.ts has no valid default export`);
        }
      } catch (err) {
        log.warn(`[${this.axisName}] Failed to load ${entry.name}:`, err);
      }
    }
  }

  /** Register a provider manually (for built-in providers or testing). */
  register(provider: T): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Initialize all registered providers in dependency order.
   * Uses topological sort when providers declare dependencies.
   */
  async initAll(config: AppConfig): Promise<void> {
    if (this.initialized) return;

    const sorted = this.topoSort();

    for (const provider of sorted) {
      try {
        await provider.init?.(config);
        log.info(`[${this.axisName}] Initialized: ${provider.id}`);
      } catch (err) {
        log.warn(`[${this.axisName}] Init failed for ${provider.id}:`, err);
      }
    }

    this.initialized = true;
  }

  /** Teardown all providers in reverse order. */
  async teardownAll(): Promise<void> {
    const sorted = this.topoSort().reverse();

    for (const provider of sorted) {
      try {
        await provider.teardown?.();
      } catch (err) {
        log.warn(`[${this.axisName}] Teardown failed for ${provider.id}:`, err);
      }
    }

    this.initialized = false;
  }

  /** Get a provider by ID. */
  get(id: string): T | undefined {
    return this.providers.get(id);
  }

  /** Get all registered providers. */
  getAll(): T[] {
    return [...this.providers.values()];
  }

  /** Get all available providers (isAvailable() returns true or not defined). */
  getAvailable(): T[] {
    return this.getAll().filter(p => !p.isAvailable || p.isAvailable());
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Topological sort by dependencies.
   * Providers without dependencies come first.
   */
  private topoSort(): T[] {
    const all = [...this.providers.values()];
    const visited = new Set<string>();
    const sorted: T[] = [];

    const visit = (provider: T, stack: Set<string>) => {
      if (visited.has(provider.id)) return;
      if (stack.has(provider.id)) {
        log.warn(`[${this.axisName}] Circular dependency detected involving ${provider.id}`);
        return;
      }

      stack.add(provider.id);

      for (const depId of provider.dependencies ?? []) {
        const dep = this.providers.get(depId);
        if (dep) visit(dep, stack);
      }

      stack.delete(provider.id);
      visited.add(provider.id);
      sorted.push(provider);
    };

    for (const provider of all) {
      visit(provider, new Set());
    }

    return sorted;
  }
}
