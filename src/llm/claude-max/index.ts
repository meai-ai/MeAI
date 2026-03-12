/**
 * Claude Max LLM Provider — uses Max OAuth for completions.
 *
 * Routes requests through the Anthropic API with OAuth tokens from a
 * Claude Max subscription, eliminating API billing costs.
 *
 * Requires maxOAuthEnabled: true in config and a valid .oauth-tokens.json file.
 * Generate tokens with: npx anthropic-max-router
 *
 * Can serve as both conversation and background provider. Configure via:
 *   "llm": { "conversation": "claude-max", "background": "claude-max" }
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../../types.js";
import type { LLMProvider, LLMRole, CompleteOptions } from "../types.js";
import {
  initMaxOAuth,
  isMaxOAuthAvailable,
  createAnthropicClient,
} from "../../max-oauth.js";

let client: Anthropic | null = null;
let available = false;

const provider: LLMProvider = {
  id: "claude-max",
  name: "Claude Max (OAuth subscription)",
  roles: ["conversation", "background", "vision"] as LLMRole[],

  init(config: AppConfig): void {
    if (!config.maxOAuthEnabled) {
      console.log("[llm:claude-max] Disabled (maxOAuthEnabled is false)");
      return;
    }

    // initMaxOAuth may already have been called from index.ts, but it's idempotent
    initMaxOAuth(config.statePath, config.maxOAuthTokenPath);

    if (isMaxOAuthAvailable()) {
      client = createAnthropicClient(config.anthropicApiKey);
      available = true;
      console.log("[llm:claude-max] Max OAuth provider ready");
    } else {
      console.log("[llm:claude-max] Token file not found — provider unavailable");
      console.log("[llm:claude-max] Generate tokens with: npx anthropic-max-router");
    }
  },

  isAvailable(): boolean {
    return available;
  },

  async complete(opts: CompleteOptions): Promise<string> {
    if (!client) throw new Error("Claude Max OAuth client not initialized");

    const response = await client.messages.create({
      model: opts.model ?? "claude-sonnet-4-6",
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return text;
  },

  async describeImage(image: Buffer | string, prompt: string): Promise<string> {
    if (!client) throw new Error("Claude Max OAuth client not initialized");

    const imageData = typeof image === "string"
      ? image
      : image.toString("base64");

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageData,
            },
          },
          { type: "text", text: prompt },
        ],
      }],
    });

    const textBlock = response.content.find(b => b.type === "text");
    return textBlock?.text ?? "";
  },
};

export default provider;
