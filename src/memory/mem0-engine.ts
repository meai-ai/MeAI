/**
 * Mem0 Semantic Memory Engine for MeAI.
 *
 * Wraps the mem0ai/oss SDK to provide semantic (vector) search over memories.
 * Uses OpenAI embeddings for vectorization and OpenAI gpt-4o-mini for LLM-powered
 * fact extraction from conversations.
 *
 * This is a supplementary layer on top of the existing store.json + BM25 system:
 *   - store.json remains the persistent source of truth
 *   - mem0 provides in-memory vector index for semantic search
 *   - On startup, existing memories are synced from store.json into mem0
 *   - When new memories are added, they're synced to mem0 as well
 *
 * Falls back gracefully when OpenAI API key is not configured.
 */

import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Memory } from "../types.js";

// Re-export mem0 types we use
export interface Mem0SearchResult {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Suppress known non-fatal errors from mem0's internal LLM dedup.
 *
 * When mem0.add() finds similar existing memories, it asks gpt-4o-mini
 * whether to ADD/UPDATE/DELETE. The LLM sometimes returns an UPDATE with
 * an ID not in the temp mapping → "Memory with ID undefined not found".
 * This is caught inside mem0 (non-fatal), but pollutes our logs.
 */
async function withSuppressedMem0Errors<T>(fn: () => Promise<T>): Promise<T> {
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    // Suppress mem0's internal dedup errors — already caught by the library
    if (msg.includes("Error processing memory action") ||
        msg.includes("Memory with ID") ||
        msg.includes("Failed to parse memory actions")) {
      return;
    }
    origError.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.error = origError;
  }
}

/** Path where mem0's "memory" vector store provider persists data. */
function getDbPath(): string {
  return path.join(process.cwd(), "vector_store.db");
}

/** Fixed embedding dimension for text-embedding-3-small. */
const EMBEDDING_DIM = 1536;

export class Mem0Engine {
  private mem0: any = null;
  private ready = false;
  private synced = false;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Static factory: create and initialize a Mem0Engine from config.
   * Returns null if initialization fails (e.g. missing OpenAI key).
   */
  static async createFromConfig(config: AppConfig): Promise<Mem0Engine | null> {
    const engine = new Mem0Engine(config);
    const ok = await engine.initialize();
    return ok ? engine : null;
  }

  /**
   * Initialize the mem0 engine with OpenAI LLM + OpenAI embeddings.
   * Returns false if OpenAI API key is missing (semantic search disabled).
   */
  async initialize(): Promise<boolean> {
    if (!this.config.openaiApiKey) {
      console.log("[mem0] OpenAI API key not configured — semantic search disabled, using BM25 fallback");
      return false;
    }

    try {
      // Reuse existing vector_store.db if present — it persists across restarts
      // and only new/changed memories are synced incrementally.

      await this.createMem0Instance();

      this.ready = true;
      console.log(`[mem0] Semantic memory engine initialized (gpt-4o-mini + text-embedding-3-small, dim=${EMBEDDING_DIM})`);
      return true;
    } catch (err) {
      console.error("[mem0] Failed to initialize:", err);
      return false;
    }
  }

  /**
   * Create the mem0 Memory instance and patch its embedder to force
   * a consistent dimension in every OpenAI API call.
   *
   * mem0's built-in OpenAI embedder does NOT pass `dimensions` to the API,
   * which can cause text-embedding-3-small to return inconsistent sizes
   * (1536 vs 384) across calls. Patching ensures every call explicitly
   * requests EMBEDDING_DIM dimensions.
   */
  private async createMem0Instance(): Promise<void> {
    const { Memory } = await import("mem0ai/oss");
    this.mem0 = new Memory({
      llm: {
        provider: "openai",
        config: {
          apiKey: this.config.openaiApiKey,
          model: "gpt-4o-mini",
        },
      },
      embedder: {
        provider: "openai",
        config: {
          apiKey: this.config.openaiApiKey,
          model: "text-embedding-3-small",
        },
      },
      vectorStore: {
        provider: "memory",
        config: {
          collectionName: "meai-memories",
          dimension: EMBEDDING_DIM,
        },
      },
      disableHistory: true,
      historyDbPath: path.join(this.config.statePath, "memory", "mem0-history.db"),
    });

    // Replace mem0's embedder with raw fetch()-based implementation.
    // Bypasses the OpenAI SDK entirely to guarantee correct dimensions.
    const apiKey = this.config.openaiApiKey;
    const embedModel = "text-embedding-3-small";

    const callEmbedAPI = async (input: string | string[]): Promise<number[][]> => {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: embedModel,
          input,
          dimensions: EMBEDDING_DIM,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`OpenAI embeddings API error ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const json: any = await resp.json();
      return json.data.map((d: any) => d.embedding);
    };

    this.mem0.embedder = {
      model: embedModel,
      embeddingDims: EMBEDDING_DIM,
      embed: async (text: string) => {
        const vecs = await callEmbedAPI(text);
        const vec = vecs[0];
        if (vec.length !== EMBEDDING_DIM) {
          console.error(`[mem0] embed() returned ${vec.length} dims despite requesting ${EMBEDDING_DIM}! (raw fetch)`);
        }
        return vec;
      },
      embedBatch: async (texts: string[]) => {
        return await callEmbedAPI(texts);
      },
    };

    // Verify vector store dimension matches
    const vsDim = this.mem0.vectorStore?.dimension;
    console.log(`[mem0] Replaced embedder with raw fetch (dimensions=${EMBEDDING_DIM}), vectorStore.dimension=${vsDim}`);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /**
   * Sync existing memories from store.json into mem0's vector index.
   * Called once on startup. Incremental — skips memories already indexed.
   */
  async syncFromStore(memories: Memory[]): Promise<void> {
    if (!this.ready || this.synced) return;

    const count = memories.length;
    if (count === 0) {
      this.synced = true;
      return;
    }

    // Check what's already in the vector index to avoid re-embedding
    let existingKeys = new Set<string>();
    try {
      const existing = await this.mem0.getAll({ userId: "user" });
      for (const r of existing.results ?? []) {
        if (r.metadata?.key) existingKeys.add(r.metadata.key);
      }
    } catch { /* if getAll fails, just re-sync everything */ }

    const toSync = memories.filter(m => !existingKeys.has(m.key));
    if (toSync.length === 0) {
      this.synced = true;
      console.log(`[mem0] All ${count} memories already indexed, skipping sync`);
      return;
    }

    console.log(`[mem0] Syncing ${toSync.length} new memories (${existingKeys.size} already indexed)...`);
    let synced = 0;
    let failed = 0;

    for (const m of toSync) {
      try {
        await withSuppressedMem0Errors(() =>
          this.mem0.add(
            `${m.key}: ${m.value}`,
            {
              userId: "user",
              metadata: { key: m.key, confidence: m.confidence, timestamp: m.timestamp },
            },
          ),
        );
        synced++;
      } catch (err) {
        failed++;
        if (failed <= 3) {
          console.error(`[mem0] Failed to sync memory "${m.key}":`, err);
        }
      }
    }

    this.synced = true;
    console.log(`[mem0] Sync complete: ${synced}/${toSync.length} new memories indexed${failed > 0 ? ` (${failed} failed)` : ""}`);
  }

  /**
   * Add a single memory to the mem0 vector index.
   * Called after memory_set writes to store.json.
   */
  async addMemory(key: string, value: string, confidence = 0.8): Promise<void> {
    if (!this.ready) return;

    try {
      await withSuppressedMem0Errors(() =>
        this.mem0.add(
          `${key}: ${value}`,
          {
            userId: "user",
            metadata: { key, confidence },
          },
        ),
      );
    } catch (err) {
      console.error(`[mem0] Failed to add memory "${key}":`, err);
    }
  }

  /**
   * Semantic search over memories using vector similarity.
   * Returns ranked results with relevance scores.
   */
  async search(query: string, limit = 10): Promise<Mem0SearchResult[]> {
    if (!this.ready) return [];

    try {
      const result = await this.mem0.search(query, {
        userId: "user",
        limit,
      });

      return (result.results ?? []).map((r: any) => ({
        id: r.id,
        memory: r.memory,
        score: r.score,
        metadata: r.metadata,
      }));
    } catch (err) {
      console.error("[mem0] Search error:", err);
      return [];
    }
  }

  /**
   * Extract and store memories from a conversation using mem0's LLM-powered extraction.
   * Returns the extracted memory strings.
   */
  async addConversation(messages: Array<{ role: string; content: string }>): Promise<string[]> {
    if (!this.ready) return [];

    try {
      const result: any = await withSuppressedMem0Errors(() =>
        this.mem0.add(
          messages.map((m) => ({ role: m.role, content: m.content })),
          { userId: "user" },
        ),
      );

      return (result.results ?? []).map((r: any) => r.memory).filter(Boolean);
    } catch (err) {
      console.error("[mem0] Conversation extraction error:", err);
      return [];
    }
  }

  /**
   * Get all memories stored in mem0's vector index.
   */
  async getAll(): Promise<Mem0SearchResult[]> {
    if (!this.ready) return [];

    try {
      const result = await this.mem0.getAll({ userId: "user" });
      return (result.results ?? []).map((r: any) => ({
        id: r.id,
        memory: r.memory,
        score: r.score,
        metadata: r.metadata,
      }));
    } catch (err) {
      console.error("[mem0] getAll error:", err);
      return [];
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let engine: Mem0Engine | null = null;

/**
 * Initialize the global Mem0 engine. Call once at startup.
 * Returns null if OpenAI key is not configured (graceful degradation).
 */
export async function initMem0(config: AppConfig): Promise<Mem0Engine | null> {
  engine = new Mem0Engine(config);
  const ok = await engine.initialize();
  if (!ok) {
    engine = null;
    return null;
  }
  return engine;
}

/**
 * Get the global Mem0 engine instance (null if not initialized).
 */
export function getMem0(): Mem0Engine | null {
  return engine;
}
