/**
 * Anthropic API LLM Provider — uses the Anthropic SDK for completions.
 *
 * Handles conversation (streaming) and vision roles.
 * Requires anthropicApiKey in config.
 */

import type { AppConfig } from "../../types.js";
import type { LLMProvider, LLMRole, CompleteOptions } from "../types.js";

let apiKey: string | undefined;

const provider: LLMProvider = {
  id: "anthropic-api",
  name: "Anthropic API (Claude)",
  roles: ["conversation", "background", "vision"] as LLMRole[],

  init(config: AppConfig): void {
    apiKey = config.anthropicApiKey;
    if (apiKey) {
      console.log("[llm:anthropic-api] Anthropic API key configured");
    }
  },

  isAvailable(): boolean {
    return !!apiKey;
  },

  async complete(opts: CompleteOptions): Promise<string> {
    if (!apiKey) throw new Error("Anthropic API key not configured");

    // Dynamic import to avoid requiring the SDK at module load time
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: opts.model ?? "claude-sonnet-4-5-20250929",
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });

    const textBlock = response.content.find(b => b.type === "text");
    return textBlock?.text ?? "";
  },

  async describeImage(image: Buffer | string, prompt: string): Promise<string> {
    if (!apiKey) throw new Error("Anthropic API key not configured");

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const imageData = typeof image === "string"
      ? image // assume base64
      : image.toString("base64");

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
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
