/**
 * LLM Provider interface — abstraction for language model backends.
 *
 * Removes the hard dependency on any specific LLM. Contributors can add
 * Ollama, OpenAI, Groq, local llama.cpp, etc. by creating
 * src/llm/<provider>/index.ts that exports a default LLMProvider.
 */

import type { AppConfig } from "../types.js";

/** Which role this provider can fill. */
export type LLMRole = "conversation" | "background" | "vision" | "embedding";

/** Options for text completion. */
export interface CompleteOptions {
  /** System instructions. */
  system: string;
  /** User prompt / question. */
  prompt: string;
  /** Provider-specific model name override. */
  model?: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Timeout in ms. */
  timeoutMs?: number;
}

/** Core interface for all LLM providers. */
export interface LLMProvider {
  /** Unique provider ID, e.g. "claude-cli", "anthropic-api", "ollama". */
  readonly id: string;
  /** Display name, e.g. "Claude CLI (Max subscription)". */
  readonly name: string;
  /** Which roles this provider supports. */
  readonly roles: LLMRole[];

  /** Called once at startup with the app config. */
  init?(config: AppConfig): void | Promise<void>;
  /** Whether this provider is currently available (API keys present, etc.). */
  isAvailable(): boolean;

  /** Text completion — returns the full response text. */
  complete(opts: CompleteOptions): Promise<string>;

  /** Streaming completion — for real-time conversation. */
  stream?(opts: CompleteOptions): AsyncIterable<string>;

  /** Vision — describe an image. */
  describeImage?(image: Buffer | string, prompt: string): Promise<string>;

  /** Generate embeddings for text. */
  embed?(text: string): Promise<number[]>;

  /** Config key — reads from config.json. */
  configKey?: string;
}
