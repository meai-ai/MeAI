/**
 * Tier 1 Evolution — Memory system.
 *
 * Provides memory_set, memory_get, memory_list, and memory_search tools
 * that the agent can call freely (no approval required).
 *
 * Upgrades over v1:
 *   - memory_search: BM25 full-text search with temporal decay
 *   - memory_set: deduplication detection (warns on similar existing memories)
 *   - All operations update the search index automatically
 */

import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Memory, ToolDefinition, EvolutionEvent } from "../types.js";
import { MemorySearchEngine } from "../memory/search.js";
import { getMem0 } from "../memory/mem0-engine.js";
import { getStoreManager } from "../memory/store-manager.js";
import { getUserTZ } from "../lib/pst-date.js";

// Module-level search engine instance — rebuilt when store changes
let searchEngine: MemorySearchEngine | null = null;
let lastStoreHash = "";

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

/**
 * Get or rebuild the search engine index.
 * Rebuilds only when category files have changed (tracked by combined hash).
 */
export function getSearchEngine(config: AppConfig): MemorySearchEngine {
  const manager = getStoreManager();
  const currentHash = manager.getCombinedHash();

  if (!searchEngine || currentHash !== lastStoreHash) {
    searchEngine = new MemorySearchEngine();
    const memories = manager.loadAll();
    searchEngine.buildIndex(memories);
    lastStoreHash = currentHash;
  }

  return searchEngine;
}

export function getMemoryTools(config: AppConfig): ToolDefinition[] {
  const memorySet: ToolDefinition = {
    name: "memory_set",
    description:
      "Store or update a memory. Keys are namespaced (e.g., user.name, preferences.theme, context.project). " +
      "Use this to remember important facts about the user, your context, or learned patterns. " +
      "Confidence ranges from 0.0 to 1.0 (default 0.8). " +
      "Warns if a similar memory already exists (deduplication).",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Namespaced key (e.g., user.name, preferences.editor, context.current_project)",
        },
        value: {
          type: "string",
          description: "The value to store",
        },
        confidence: {
          type: "number",
          description: "Confidence level 0.0-1.0 (default 0.8)",
        },
      },
      required: ["key", "value"],
    },
    execute: async (input) => {
      const key = input.key as string;
      const value = input.value as string;
      const confidence = typeof input.confidence === "number" ? input.confidence : 0.8;

      const manager = getStoreManager();
      const existing = manager.get(key);
      const now = Date.now();

      // Dedup check: look for similar memories with different keys
      let dedupWarning = "";
      if (!existing) {
        const engine = getSearchEngine(config);
        const similar = engine.findSimilar(`${key} ${value}`, 0.6);
        const otherSimilar = similar.filter(s => s.memory.key !== key);
        if (otherSimilar.length > 0) {
          const top = otherSimilar[0];
          dedupWarning = ` (Note: similar memory exists — ${top.memory.key}: ${top.memory.value}, similarity: ${(top.similarity * 100).toFixed(0)}%)`;
        }
      }

      await manager.set(key, value, confidence);

      logEvent(config, {
        tier: 1,
        action: "memory_set",
        detail: { key, value, confidence },
        timestamp: now,
      });

      // Sync to mem0 semantic index (fire-and-forget)
      const mem0 = getMem0();
      if (mem0) {
        mem0.addMemory(key, value, confidence).catch((err) =>
          console.error("[mem0] sync error:", err),
        );
      }

      return `Memory stored: ${key} = ${value} (confidence: ${confidence})${dedupWarning}`;
    },
  };

  const memoryGet: ToolDefinition = {
    name: "memory_get",
    description: "Retrieve a specific memory by its key.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The memory key to look up",
        },
      },
      required: ["key"],
    },
    execute: async (input) => {
      const key = input.key as string;
      const found = getStoreManager().get(key);

      if (!found) {
        return `No memory found for key: ${key}`;
      }

      return `${found.key} = ${found.value} (confidence: ${found.confidence}, stored: ${new Date(found.timestamp).toLocaleString("en-US", { timeZone: getUserTZ() })})`;
    },
  };

  const memoryList: ToolDefinition = {
    name: "memory_list",
    description:
      "List stored memories, optionally filtered by a key prefix (e.g., 'user.' to list all user memories).",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description:
            "Optional prefix to filter keys (e.g., 'user.', 'preferences.'). Omit to list all.",
        },
      },
      required: [],
    },
    execute: async (input) => {
      const prefix = (input.prefix as string) ?? "";
      const filtered = getStoreManager().list(prefix || undefined);

      if (filtered.length === 0) {
        return prefix
          ? `No memories found with prefix: ${prefix}`
          : "No memories stored yet.";
      }

      const lines = filtered.map(
        (m) =>
          `- ${m.key}: ${m.value} (confidence: ${m.confidence})`,
      );
      return `${filtered.length} memories:\n${lines.join("\n")}`;
    },
  };

  const memorySearch: ToolDefinition = {
    name: "memory_search",
    description:
      "Search memories by natural language query. Uses semantic vector search (mem0) with BM25 fallback. " +
      "Much more powerful than memory_get (exact key match) or memory_list (prefix match). " +
      "Understands meaning, not just keywords — 'where does he work?' finds user.company. " +
      "Example: memory_search('daughter birthday') finds family.daughter.birthday.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'birthday', 'work project', 'food preferences')",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 10.",
        },
        key_prefix: {
          type: "string",
          description: "Optional: restrict search to keys starting with this prefix (e.g., 'user.').",
        },
      },
      required: ["query"],
    },
    execute: async (input) => {
      const query = input.query as string;
      const limit = (input.limit as number) || 10;
      const keyPrefix = input.key_prefix as string | undefined;

      // Try mem0 semantic search first
      const mem0 = getMem0();
      if (mem0?.isReady) {
        try {
          const semanticResults = await mem0.search(query, limit + 5);

          if (semanticResults.length > 0) {
            // Cross-reference with store to get structured key-value data
            const memories = getStoreManager().loadAll();
            const memoryMap = new Map(memories.map((m) => [m.key, m]));

            // Merge: match mem0 results back to store.json entries by metadata key
            const merged: Array<{ key: string; value: string; score: number; age: string }> = [];
            const seen = new Set<string>();

            for (const sr of semanticResults) {
              const metaKey = sr.metadata?.key as string | undefined;
              if (metaKey && memoryMap.has(metaKey)) {
                if (keyPrefix && !metaKey.startsWith(keyPrefix)) continue;
                if (seen.has(metaKey)) continue;
                seen.add(metaKey);
                const m = memoryMap.get(metaKey)!;
                const age = Math.floor((Date.now() - m.timestamp) / (24 * 60 * 60 * 1000));
                merged.push({
                  key: m.key,
                  value: m.value,
                  score: sr.score ?? 0,
                  age: age === 0 ? "today" : `${age}d ago`,
                });
              }
            }

            // Also run BM25 to catch exact key matches that semantic search might miss
            const engine = getSearchEngine(config);
            const bm25Results = engine.search(query, { limit: 5, keyPrefix });
            for (const r of bm25Results) {
              if (!seen.has(r.memory.key)) {
                seen.add(r.memory.key);
                const age = Math.floor((Date.now() - r.memory.timestamp) / (24 * 60 * 60 * 1000));
                merged.push({
                  key: r.memory.key,
                  value: r.memory.value,
                  score: r.score * 0.5, // Weight BM25 lower when semantic results exist
                  age: age === 0 ? "today" : `${age}d ago`,
                });
              }
            }

            // Sort by score descending and limit
            merged.sort((a, b) => b.score - a.score);
            const limited = merged.slice(0, limit);

            if (limited.length === 0) {
              return `No memories found for: "${query}"`;
            }

            const lines = limited.map((r, i) =>
              `${i + 1}. ${r.key}: ${r.value} (score: ${r.score.toFixed(2)}, ${r.age})`,
            );
            return `Found ${limited.length} memories for "${query}" (semantic+BM25):\n${lines.join("\n")}`;
          }
        } catch (err) {
          console.error("[mem0] Semantic search failed, falling back to BM25:", err);
        }
      }

      // Fallback: BM25 full-text search
      const engine = getSearchEngine(config);
      const results = engine.search(query, { limit, keyPrefix });

      if (results.length === 0) {
        return `No memories found for: "${query}"`;
      }

      const lines = results.map((r, i) => {
        const age = Math.floor((Date.now() - r.memory.timestamp) / (24 * 60 * 60 * 1000));
        const ageStr = age === 0 ? "today" : `${age}d ago`;
        return `${i + 1}. ${r.memory.key}: ${r.memory.value} (score: ${r.score.toFixed(2)}, ${ageStr})`;
      });

      return `Found ${results.length} memories for "${query}":\n${lines.join("\n")}`;
    },
  };

  return [memorySet, memoryGet, memoryList, memorySearch];
}
