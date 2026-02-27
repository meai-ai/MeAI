/**
 * Ollama LLM Provider — stub for local LLM via Ollama.
 *
 * Contributor-friendly: free, local, no API key needed.
 * Install Ollama (https://ollama.ai), pull a model, and configure:
 *   { "llm": { "background": "ollama" } }
 *
 * TODO: Implement complete() using Ollama's REST API.
 */

import type { AppConfig } from "../../types.js";
import type { LLMProvider, LLMRole, CompleteOptions } from "../types.js";

let available = false;

const provider: LLMProvider = {
  id: "ollama",
  name: "Ollama (Local LLM)",
  roles: ["conversation", "background", "vision", "embedding"] as LLMRole[],

  async init(_config: AppConfig): Promise<void> {
    // Check if Ollama is running
    try {
      const res = await fetch("http://localhost:11434/api/tags");
      if (res.ok) {
        available = true;
        const data = await res.json() as { models?: unknown[] };
        console.log(`[llm:ollama] Ollama available with ${(data.models ?? []).length} model(s)`);
      }
    } catch {
      console.log("[llm:ollama] Ollama not running at localhost:11434 — provider unavailable");
    }
  },

  isAvailable(): boolean {
    return available;
  },

  async complete(opts: CompleteOptions): Promise<string> {
    if (!available) throw new Error("Ollama not available");

    const model = opts.model ?? "llama3.2";

    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system: opts.system,
        prompt: opts.prompt,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: opts.maxTokens ?? 4096,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { response?: string };
    return data.response ?? "";
  },

  async embed(text: string): Promise<number[]> {
    if (!available) throw new Error("Ollama not available");

    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embedding error: ${res.status}`);
    }

    const data = await res.json() as { embedding?: number[] };
    return data.embedding ?? [];
  },
};

export default provider;
