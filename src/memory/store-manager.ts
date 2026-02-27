/**
 * Hierarchical Memory Store Manager
 *
 * Splits the flat store.json into 6 category files with differentiated
 * context loading. Core facts always present, knowledge only on-demand.
 *
 * Categories:
 *   core      — user.*, family.*, healthcare.*     → always loaded in full
 *   emotional — emotional.*, interests.*, viewpoints.*, wishlist.*  → top 8 by recency+relevance
 *   knowledge — knowledge.*, media.*               → only via search
 *   character  — activity.*, inner.*               → character's own life events
 *   insights  — insights.*                         → latest per topic (compact)
 *   system    — system.*, apple.*, skills.*        → never in conversation
 */

import fs from "node:fs";
import path from "node:path";
import type { Memory } from "../types.js";
import { readJsonSafe, writeJsonAtomic, withFileLock } from "../lib/atomic-file.js";

// ── Types ──────────────────────────────────────────────────────────

export type MemoryCategory = "core" | "emotional" | "knowledge" | "character" | "insights" | "system";

interface CategoryFile {
  memories: Memory[];
}

// ── Prefix routing table ───────────────────────────────────────────

const PREFIX_ROUTES: Array<[string, MemoryCategory]> = [
  // Core
  ["user.", "core"],
  ["family.", "core"],
  ["healthcare.", "core"],
  // Emotional
  ["emotional.", "emotional"],
  ["interests.", "emotional"],
  ["viewpoints.", "emotional"],
  ["wishlist.", "emotional"],
  // Knowledge
  ["knowledge.", "knowledge"],
  ["media.", "knowledge"],
  // character's own life
  ["activity.", "character"],
  ["inner.", "character"],
  // Insights
  ["insights.", "insights"],
  // System
  ["system.", "system"],
  ["apple.", "system"],
  ["skills.", "system"],
];

const DEFAULT_CATEGORY: MemoryCategory = "emotional";

export function routeToCategory(key: string): MemoryCategory {
  for (const [prefix, category] of PREFIX_ROUTES) {
    if (key.startsWith(prefix)) return category;
  }
  return DEFAULT_CATEGORY;
}

// ── Category file names ────────────────────────────────────────────

const CATEGORY_FILES: Record<MemoryCategory, string> = {
  core: "core.json",
  emotional: "emotional.json",
  knowledge: "knowledge.json",
  character: "character.json",
  insights: "insights.json",
  system: "system.json",
};

const ALL_CATEGORIES: MemoryCategory[] = ["core", "emotional", "knowledge", "character", "insights", "system"];

// ── Store Manager ──────────────────────────────────────────────────

export class MemoryStoreManager {
  private memoryDir: string;
  private cache = new Map<MemoryCategory, { mtimeMs: number; memories: Memory[] }>();

  constructor(private statePath: string) {
    this.memoryDir = path.join(statePath, "memory");
  }

  private categoryPath(category: MemoryCategory): string {
    return path.join(this.memoryDir, CATEGORY_FILES[category]);
  }

  /**
   * Load a single category, with mtime-based caching.
   */
  loadCategory(category: MemoryCategory): Memory[] {
    const filePath = this.categoryPath(category);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return [];
    }

    const cached = this.cache.get(category);
    if (cached && cached.mtimeMs === mtimeMs) {
      return [...cached.memories];
    }

    const data = readJsonSafe<CategoryFile>(filePath, { memories: [] });
    const memories = data.memories ?? [];
    this.cache.set(category, { mtimeMs, memories });
    return [...memories];
  }

  /**
   * Load all memories across all categories.
   */
  loadAll(): Memory[] {
    const result: Memory[] = [];
    for (const cat of ALL_CATEGORIES) {
      result.push(...this.loadCategory(cat));
    }
    return result;
  }

  /**
   * Load memories from specific categories.
   */
  loadCategories(...categories: MemoryCategory[]): Memory[] {
    const result: Memory[] = [];
    for (const cat of categories) {
      result.push(...this.loadCategory(cat));
    }
    return result;
  }

  /**
   * Set a memory — auto-routes to the correct category file by key prefix.
   */
  async set(key: string, value: string, confidence: number): Promise<void> {
    const category = routeToCategory(key);
    const filePath = this.categoryPath(category);
    const now = Date.now();

    await withFileLock<CategoryFile>(
      filePath,
      (current) => {
        const memories = current.memories ?? [];
        const idx = memories.findIndex((m) => m.key === key);
        const memory: Memory = { key, value, timestamp: now, confidence };

        if (idx >= 0) {
          memories[idx] = memory;
        } else {
          memories.push(memory);
        }

        return { memories };
      },
      { memories: [] },
    );

    // Invalidate cache for this category
    this.cache.delete(category);
  }

  /**
   * Get a single memory by key. Searches all categories.
   */
  get(key: string): Memory | undefined {
    // Try the expected category first
    const category = routeToCategory(key);
    const catMemories = this.loadCategory(category);
    const found = catMemories.find((m) => m.key === key);
    if (found) return found;

    // Fall back to searching all categories
    for (const cat of ALL_CATEGORIES) {
      if (cat === category) continue;
      const memories = this.loadCategory(cat);
      const m = memories.find((mem) => mem.key === key);
      if (m) return m;
    }
    return undefined;
  }

  /**
   * List memories, optionally filtered by key prefix.
   */
  list(prefix?: string): Memory[] {
    const all = this.loadAll();
    if (!prefix) return all;
    return all.filter((m) => m.key.startsWith(prefix));
  }

  /**
   * Total memory count across all categories.
   */
  count(): number {
    let total = 0;
    for (const cat of ALL_CATEGORIES) {
      total += this.loadCategory(cat).length;
    }
    return total;
  }

  /**
   * Combined hash for search index invalidation — checks all category files.
   */
  getCombinedHash(): string {
    const parts: string[] = [];
    for (const cat of ALL_CATEGORIES) {
      const filePath = this.categoryPath(cat);
      try {
        const stat = fs.statSync(filePath);
        parts.push(`${cat}:${stat.size}-${stat.mtimeMs}`);
      } catch {
        parts.push(`${cat}:empty`);
      }
    }
    return parts.join("|");
  }

  /**
   * One-time migration from flat store.json to category files.
   */
  async migrateIfNeeded(): Promise<boolean> {
    const markerPath = path.join(this.memoryDir, ".migrated");
    if (fs.existsSync(markerPath)) return false;

    const storePath = path.join(this.memoryDir, "store.json");
    if (!fs.existsSync(storePath)) {
      // No store.json to migrate — write marker and empty category files
      for (const cat of ALL_CATEGORIES) {
        const fp = this.categoryPath(cat);
        if (!fs.existsSync(fp)) {
          writeJsonAtomic(fp, { memories: [] });
        }
      }
      fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");
      return false;
    }

    console.log("[store-manager] Migrating store.json → category files...");

    const raw = readJsonSafe<Record<string, unknown>>(storePath, {});
    const memoriesArray: Memory[] = (raw.memories as Memory[] | undefined) ?? [];

    // Bucket memories by category
    const buckets = new Map<MemoryCategory, Memory[]>();
    for (const cat of ALL_CATEGORIES) {
      buckets.set(cat, []);
    }

    for (const m of memoriesArray) {
      const cat = routeToCategory(m.key);
      buckets.get(cat)!.push(m);
    }

    // Recover top-level key entries (activities.ts bug — writes store[key] instead of into memories array)
    for (const [k, v] of Object.entries(raw)) {
      if (k === "memories") continue;
      if (typeof v === "object" && v !== null && "key" in v && "value" in v) {
        const entry = v as Memory;
        const cat = routeToCategory(entry.key);
        const bucket = buckets.get(cat)!;
        const existingIdx = bucket.findIndex((m) => m.key === entry.key);
        if (existingIdx < 0) {
          bucket.push(entry);
          console.log(`[store-manager] Recovered top-level entry: ${entry.key} → ${cat}`);
        } else if (entry.timestamp > bucket[existingIdx].timestamp) {
          // Top-level entry is newer — replace
          bucket[existingIdx] = entry;
          console.log(`[store-manager] Recovered newer top-level entry: ${entry.key} → ${cat}`);
        }
      }
    }

    // Write category files
    for (const cat of ALL_CATEGORIES) {
      const memories = buckets.get(cat)!;
      writeJsonAtomic(this.categoryPath(cat), { memories });
      console.log(`[store-manager]   ${cat}: ${memories.length} memories`);
    }

    // Backup original store.json
    const backupPath = storePath + ".bak";
    fs.renameSync(storePath, backupPath);
    console.log(`[store-manager] Backed up store.json → store.json.bak`);

    // Write migration marker
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf-8");
    console.log("[store-manager] Migration complete.");

    return true;
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let instance: MemoryStoreManager | null = null;

export function initStoreManager(statePath: string): MemoryStoreManager {
  instance = new MemoryStoreManager(statePath);
  return instance;
}

export function getStoreManager(): MemoryStoreManager {
  if (!instance) {
    throw new Error("MemoryStoreManager not initialized — call initStoreManager() first");
  }
  return instance;
}
