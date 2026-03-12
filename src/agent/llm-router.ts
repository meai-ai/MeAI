/**
 * LLM Provider Routing — Anthropic, OpenAI, and Claude CLI paths.
 *
 * Extracted from AgentLoop to separate orchestration (loop.ts) from
 * provider-specific streaming, tool-call loops, and media delivery.
 *
 * In the open-source version, the LLM registry (src/llm/registry.ts)
 * provides provider discovery. This module handles the concrete calling
 * conventions (streaming, tool loops, message format conversion) that
 * sit on top of the registry.
 */

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { claudeRun } from "../claude-runner.js";
import type { ToolCallRecord } from "../types.js";
import type { ToolRegistry } from "./tools.js";
import type { ImageData } from "../channel/types.js";
import { getCharacter } from "../character.js";
import { isVideoEnabled, generateVideoFromImage } from "../video.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("llm-router");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenAIClient = any;

// ── Callback types for channel media delivery ───────────────────────

export type SendPhotoFn = (photo: Buffer, caption?: string) => Promise<void>;
export type SendVoiceFn = (audio: Buffer, caption?: string) => Promise<void>;
export type SendVideoFn = (video: Buffer, caption?: string) => Promise<void>;
export type SendAudioFn = (audio: Buffer, title?: string, performer?: string) => Promise<void>;
export type DeleteMessageFn = (messageId: number | string) => Promise<void>;

export interface MediaCallbacks {
  sendPhoto: SendPhotoFn | null;
  sendVoice: SendVoiceFn | null;
  sendVideo: SendVideoFn | null;
  sendAudio: SendAudioFn | null;
}

/** Result returned by all three provider paths. */
export interface LLMCallResult {
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** Callback invoked on each Anthropic API response for usage tracking. */
export type OnUsageFn = (model: string, source: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}) => void;

// ── Typing simulation ───────────────────────────────────────────────

// Body-state typing speed modifiers (set per-turn from body state)
let _typingSpeedMultiplier = 1.0;

/** Set typing speed multiplier based on body state. Called before streaming. */
export function setTypingSpeedMultiplier(fatigue: number, caffeine: number): void {
  let mult = 1.0;
  if (fatigue >= 7) mult *= 1.5;   // tired → slower
  if (caffeine >= 6) mult *= 0.6;  // caffeinated → faster
  _typingSpeedMultiplier = mult;
}

function simulateTypingDelay(text: string, llmElapsedMs = 0): number {
  const len = text.length;
  const thinkMs = 500 + Math.random() * 1000;
  const msPerChar = 50 + Math.random() * 30;
  const typeMs = len * msPerChar;
  const rawDelay = Math.min(thinkMs + typeMs, 15_000);
  const adjustedDelay = rawDelay * _typingSpeedMultiplier;
  const finalDelay = Math.max(adjustedDelay - llmElapsedMs, 0);
  return finalDelay;
}

// ── Message splitting ───────────────────────────────────────────────

/**
 * Split a long response into multiple chat-style messages.
 * Real people send 2-5 short messages instead of one essay.
 */
function splitIntoMessages(text: string): string[] {
  if (text.length <= 80) return [text];

  const chunks = text.split(/\n\n+/).filter((c) => c.trim());

  const refined: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= 150) {
      refined.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[。！？!?\n])\s*/);
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 150 && current) {
          refined.push(current.trim());
          current = s;
        } else {
          current += (current ? "" : "") + s;
        }
      }
      if (current.trim()) refined.push(current.trim());
    }
  }

  const merged: string[] = [];
  for (let i = 0; i < refined.length; i++) {
    if (refined[i].length < 15 && i + 1 < refined.length) {
      refined[i + 1] = refined[i] + "\n" + refined[i + 1];
    } else {
      merged.push(refined[i]);
    }
  }

  if (merged.length > 3) {
    const capped = merged.slice(0, 2);
    capped.push(merged.slice(2).join("\n"));
    return capped;
  }

  return merged.length > 0 ? merged : [text];
}

// ── AI tone sanitization ────────────────────────────────────────────

/**
 * Detect and sanitize AI-sounding patterns in generated text.
 * Returns cleaned text, or null if unsalvageable (signal to regenerate).
 */
function sanitizeAITone(text: string): string | null {
  let cleaned = text;

  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, "$1");
  cleaned = cleaned.replace(/^#+\s+/gm, "");
  cleaned = cleaned.replace(/^[-•]\s+/gm, "");
  cleaned = cleaned.replace(/^\d+\.\s+/gm, "");
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

  // Remove trailing service-oriented phrases
  cleaned = cleaned.replace(/[.!]?\s*(let me know if you need|feel free to reach out|I'm here to help|don't hesitate to ask|happy to help)[^.!\?\n]*[.!]?\s*$/gi, "");

  const aiPatterns = [
    // AI-tone patterns
    /as an? AI/i,
    /I('m| am) (not )?(a |an )?(system|tool|assistant|chatbot|language model|AI)/i,
    /my (capabilities|abilities|training|knowledge base|model)/i,
    /in summary|to summarize|firstly.*secondly.*finally/i,
    /that's a (great|good|excellent) question/i,
  ];

  const aiPatternCount = aiPatterns.filter((p) => p.test(cleaned)).length;

  if (aiPatternCount >= 2) {
    console.warn(`[sanitize] AI tone too strong (${aiPatternCount} patterns), signaling regeneration`);
    return null;
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || null;
}

// ── Tool result media handlers ──────────────────────────────────────

/**
 * Handle send_selfie tool result: parse JSON, read image, send via channel.
 * ~20% chance the selfie becomes a short video (animated via Minimax).
 */
export async function handleSelfieResult(toolName: string, toolResult: string, media: MediaCallbacks): Promise<void> {
  if (toolName !== "send_selfie" || !media.sendPhoto) return;
  try {
    const parsed = JSON.parse(toolResult);
    if (parsed.success && parsed.type === "selfie" && parsed.imagePath) {
      const imageBuffer = fs.readFileSync(parsed.imagePath);

      if (media.sendVideo && isVideoEnabled() && Math.random() < 0.20) {
        const videoResult = await generateVideoFromImage(
          imageBuffer,
          parsed.caption || "",
          "selfie",
        );
        if (videoResult) {
          await media.sendVideo(videoResult.video, parsed.caption || undefined);
          log.info(`Video selfie sent: ${videoResult.videoPath}`);
          return;
        }
        log.info("Video generation failed, falling back to photo");
      }

      await media.sendPhoto(imageBuffer, parsed.caption || undefined);
      log.info(`Selfie sent: ${parsed.imagePath}`);
    }
  } catch (err) {
    log.warn("Failed to handle selfie result", err);
  }
}

/** Handle send_voice tool result: parse JSON, read audio, send via channel. */
export async function handleTTSResult(toolName: string, toolResult: string, media: MediaCallbacks): Promise<void> {
  if (toolName !== "send_voice" || !media.sendVoice) return;
  try {
    const parsed = JSON.parse(toolResult);
    if (parsed.success && parsed.type === "voice" && parsed.audioPath) {
      const audioBuffer = fs.readFileSync(parsed.audioPath);
      await media.sendVoice(audioBuffer);
      log.info(`Voice sent: ${parsed.audioPath}`);
    }
  } catch (err) {
    log.warn("Failed to handle TTS result", err);
  }
}

/** Handle compose_music tool result: parse JSON, read MP3, send via channel as audio. */
export async function handleMusicResult(toolName: string, toolResult: string, media: MediaCallbacks): Promise<void> {
  if (toolName !== "compose_music" || !media.sendAudio) return;
  try {
    const parsed = JSON.parse(toolResult);
    if (parsed.success && parsed.type === "music" && parsed.audioPath) {
      const audioBuffer = fs.readFileSync(parsed.audioPath);
      const character = getCharacter();
      await media.sendAudio(audioBuffer, parsed.title, character.name);
      log.info(`Music sent: ${parsed.audioPath}`);
    }
  } catch (err) {
    log.warn("Failed to handle music result", err);
  }
}

/** Execute tool and dispatch media results. */
async function executeToolWithMedia(
  tools: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
  media: MediaCallbacks,
): Promise<string> {
  const result = await tools.execute(name, input);
  await handleSelfieResult(name, result, media);
  await handleTTSResult(name, result, media);
  await handleMusicResult(name, result, media);
  return result;
}

// ── Claude CLI path (claude --print) ────────────────────────────────

export async function callClaudeCode(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  msgId: number | string,
  editReply: (messageId: number | string, text: string) => Promise<void>,
  sendReply: (text: string) => Promise<{ messageId: number | string }>,
  sendTyping: () => Promise<void>,
  tools: ToolRegistry,
  media: MediaCallbacks,
  imageData?: ImageData,
): Promise<LLMCallResult> {
  const character = getCharacter();
  const userName = character.user.name;
  const toolDefs = tools.getToolDefinitions();
  const allToolCalls: ToolCallRecord[] = [];

  let toolInstructions = "";
  if (toolDefs.length > 0) {
    const toolDescriptions = toolDefs
      .map((t) => `- ${t.name}: ${t.description}\n  Input schema: ${JSON.stringify(t.input_schema)}`)
      .join("\n");
    toolInstructions =
      `\n\n## Available Tools\n${toolDescriptions}\n\n` +
      `## Tool Calling Protocol\n` +
      `When you need to use a tool, output ONLY a tool call block (no other text):\n` +
      `<tool_call>\n{"name": "tool_name", "input": {"param": "value"}}\n</tool_call>\n\n` +
      `After the tool executes, you'll see the result and can continue your response.\n` +
      `If you don't need any tools, just respond normally with text.`;
  }

  const fullSystem = systemPrompt + toolInstructions;

  let tmpImagePath: string | null = null;
  if (imageData) {
    const ext = imageData.mimeType.split("/")[1] || "jpg";
    tmpImagePath = `/tmp/meai-photo-${Date.now()}.${ext}`;
    fs.writeFileSync(tmpImagePath, Buffer.from(imageData.base64, "base64"));
  }

  const serializeMessages = (msgs: Anthropic.MessageParam[]): string => {
    return msgs
      .map((m) => {
        const role = m.role;
        if (typeof m.content === "string") return `[${role}]: ${m.content}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blocks = m.content as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts = blocks
          .map((b: any) => {
            if (b.type === "text") return b.text;
            if (b.type === "tool_result")
              return `[Tool result]: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`;
            if (b.type === "tool_use")
              return `[Tool call: ${b.name}(${JSON.stringify(b.input)})]`;
            return "";
          })
          .filter(Boolean);
        return `[${role}]: ${parts.join("\n")}`;
      })
      .join("\n\n");
  };

  const modelChoice: "fast" | "smart" = "fast";

  let extraContext = "";
  if (tmpImagePath) {
    extraContext += `\n\n[system]: ${userName} sent a photo, saved at ${tmpImagePath}. Use the Read tool to view the image first, then respond naturally like a friend would (don't describe the image in detail, just react like a real person seeing a friend's photo).`;
  }
  let maxRounds = 5;
  const startTime = Date.now();

  try {
  while (maxRounds-- > 0) {
    const prompt = serializeMessages(messages) + extraContext;

    const result = await claudeRun({
      system: fullSystem,
      prompt,
      model: modelChoice,
      timeoutMs: 90_000,
      maxOutputChars: 2_000,
    });

    if (!result.ok) {
      const errorText = result.error || "Something went wrong";
      if (msgId) {
        await editReply(msgId, errorText).catch(() => {});
      } else {
        await sendReply(errorText).catch(() => {});
      }
      return { text: errorText, toolCalls: allToolCalls };
    }

    const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    const matches = [...result.text.matchAll(toolCallRegex)];
    const responseText = result.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();

    if (matches.length === 0) {
      let finalText = responseText || result.text;

      const sanitized = sanitizeAITone(finalText);
      if (sanitized === null && maxRounds > 0) {
        extraContext += `\n\n[system]: Your last reply sounded too much like an AI (used lists, called yourself a system, too long). Reply again like a casual chat message: 1-2 sentences, colloquial, no lists, don't explain your technical architecture. You are a person, not a system.`;
        continue;
      }
      finalText = sanitized ?? finalText;

      const elapsed = Date.now() - startTime;
      const chunks = splitIntoMessages(finalText);

      const firstDelay = simulateTypingDelay(chunks[0], elapsed);
      if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));
      if (msgId) {
        await editReply(msgId, chunks[0]);
      } else {
        await sendReply(chunks[0]);
      }

      for (let i = 1; i < chunks.length; i++) {
        const delay = simulateTypingDelay(chunks[i]);
        await sendTyping().catch(() => {});
        await new Promise((r) => setTimeout(r, delay));
        await sendReply(chunks[i]);
      }

      return { text: finalText, toolCalls: allToolCalls };
    }

    extraContext += `\n\n[assistant]: ${result.text}`;

    for (const match of matches) {
      try {
        const parsed = JSON.parse(match[1]);
        const toolName = parsed.name;
        const toolInput = parsed.input || {};
        const toolResult = await executeToolWithMedia(tools, toolName, toolInput, media);
        const id = `tc_${Date.now()}`;
        allToolCalls.push({ id, name: toolName, input: toolInput, output: toolResult });
        extraContext += `\n\n[tool_result for ${toolName}]: ${toolResult}`;
      } catch (err) {
        extraContext += `\n\n[tool_error]: ${err}`;
      }
    }

    if (responseText) {
      await editReply(msgId, responseText).catch(() => {});
    }
  }

  return { text: "Processing timeout", toolCalls: allToolCalls };
  } finally {
    if (tmpImagePath) {
      try { fs.unlinkSync(tmpImagePath); } catch (err) { log.warn("failed to clean up temp image file", err); }
    }
  }
}

// ── Anthropic API path ──────────────────────────────────────────────

export async function callAnthropic(
  client: Anthropic,
  stablePrompt: string,
  dynamicPrompt: string,
  messages: Anthropic.MessageParam[],
  msgId: number | string,
  editReply: (messageId: number | string, text: string) => Promise<void>,
  sendReply: (text: string) => Promise<{ messageId: number | string }>,
  sendTyping: () => Promise<void>,
  tools: ToolRegistry,
  media: MediaCallbacks,
  onUsage?: OnUsageFn,
  imageData?: ImageData,
  maxOutputTokens: number = 1024,
): Promise<LLMCallResult> {
  const character = getCharacter();
  const userName = character.user.name;
  const model = "claude-sonnet-4-6";
  const toolDefs = tools.getToolDefinitions();

  // Inject image into last user message if present
  let apiMessages = messages;
  if (imageData && apiMessages.length > 0) {
    apiMessages = [...apiMessages];
    const lastIdx = apiMessages.length - 1;
    const last = apiMessages[lastIdx];
    if (last.role === "user") {
      const textContent = typeof last.content === "string" ? last.content : "";
      const imageHint = textContent.trim()
        ? textContent
        : `(${userName} sent a photo)`;
      apiMessages[lastIdx] = {
        role: "user",
        content: [
          { type: "text", text: imageHint },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: imageData.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: imageData.base64,
            },
          },
        ],
      };
    }
  }

  let accumulated = "";
  const allToolCalls: ToolCallRecord[] = [];
  let continueLoop = true;
  const startTime = Date.now();
  let lastStopReason: string | undefined;
  let lastUsage: LLMCallResult["usage"];

  while (continueLoop) {
    const MAX_RETRIES = 10;
    const RETRY_INTERVAL_MS = 6000;
    let response: Anthropic.Message | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: maxOutputTokens,
          system: [
            {
              type: "text" as const,
              text: stablePrompt,
              cache_control: { type: "ephemeral" as const },
            },
            {
              type: "text" as const,
              text: dynamicPrompt,
            },
          ],
          messages: apiMessages,
          ...(toolDefs.length > 0 ? { tools: toolDefs as Anthropic.Tool[] } : {}),
        });
        response = await stream.finalMessage();
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable = msg.includes("overloaded") || msg.includes("529") ||
          msg.includes("ECONNRESET") || msg.includes("socket hang up");
        if (isRetryable && attempt < MAX_RETRIES) {
          console.warn(`[agent] Anthropic API error (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_INTERVAL_MS / 1000}s: ${msg.slice(0, 100)}`);
          await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
          continue;
        }
        throw err;
      }
    }
    if (!response) throw new Error("Anthropic API failed after retries");

    // Track usage
    if (response.usage) {
      if (onUsage) {
        onUsage(model, "main", {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
        });
      }
      lastUsage = {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? undefined,
        cacheWrite: response.usage.cache_creation_input_tokens ?? undefined,
      };
    }
    lastStopReason = response.stop_reason ?? undefined;

    let chunkText = "";
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === "text") {
        chunkText += block.text;
        accumulated += block.text;
      } else if (block.type === "tool_use") {
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    if (response.stop_reason === "tool_use" && toolUseBlocks.length > 0) {
      apiMessages = [
        ...apiMessages,
        { role: "assistant" as const, content: response.content },
      ];

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const result = await executeToolWithMedia(tools, tu.name, tu.input, media);
        allToolCalls.push({ id: tu.id, name: tu.name, input: tu.input, output: result });

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      apiMessages = [
        ...apiMessages,
        { role: "user" as const, content: toolResults },
      ];
      continueLoop = true;
    } else {
      if (accumulated) {
        const sanitized = sanitizeAITone(accumulated);
        if (sanitized !== null) {
          accumulated = sanitized;
        }
      }

      if (accumulated) {
        const elapsed = Date.now() - startTime;
        const chunks = splitIntoMessages(accumulated);

        const firstDelay = simulateTypingDelay(chunks[0], elapsed);
        if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));
        await editReply(msgId, chunks[0]);

        for (let i = 1; i < chunks.length; i++) {
          const delay = simulateTypingDelay(chunks[i]);
          await sendTyping().catch(() => {});
          await new Promise((r) => setTimeout(r, delay));
          await sendReply(chunks[i]);
        }
      }
      continueLoop = false;
    }
  }

  if (!accumulated) await editReply(msgId, "·").catch(() => {});

  return { text: accumulated, toolCalls: allToolCalls, stopReason: lastStopReason, usage: lastUsage };
}

// ── OpenAI path ─────────────────────────────────────────────────────

export async function callOpenAI(
  client: OpenAIClient,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  msgId: number | string,
  editReply: (messageId: number | string, text: string) => Promise<void>,
  sendReply: (text: string) => Promise<{ messageId: number | string }>,
  sendTyping: () => Promise<void>,
  tools: ToolRegistry,
  media: MediaCallbacks,
  imageData?: ImageData,
  openaiModel?: string,
  configModel?: string,
): Promise<LLMCallResult> {
  const character = getCharacter();
  const userName = character.user.name;
  const model = openaiModel ?? configModel ?? "gpt-4o";

  // Convert Anthropic tool definitions → OpenAI function format
  const toolDefs = tools.getToolDefinitions();
  const oaiTools = toolDefs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  // Convert Anthropic message format → OpenAI format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OAIContent = string | Array<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OAIMessage = { role: string; content: OAIContent; tool_call_id?: string; tool_calls?: any[] };
  const toOAI = (msgs: Anthropic.MessageParam[]): OAIMessage[] =>
    msgs.flatMap((m) => {
      if (typeof m.content === "string") {
        return [{ role: m.role, content: m.content }];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blocks = m.content as Array<any>;
      const textParts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolUseParts = blocks.filter((b) => b.type === "tool_use");
      const toolResultParts = blocks.filter((b) => b.type === "tool_result");

      const out: OAIMessage[] = [];
      if (toolResultParts.length > 0) {
        for (const tr of toolResultParts) {
          out.push({ role: "tool", content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content), tool_call_id: tr.tool_use_id });
        }
      } else if (toolUseParts.length > 0) {
        out.push({
          role: "assistant",
          content: textParts,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tool_calls: toolUseParts.map((tu: any) => ({
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          })),
        });
      } else {
        out.push({ role: m.role, content: textParts });
      }
      return out;
    });

  const oaiMsgList = toOAI(messages);

  // Inject image as vision content block
  if (imageData && oaiMsgList.length > 0) {
    const last = oaiMsgList[oaiMsgList.length - 1];
    if (last.role === "user") {
      const textContent = typeof last.content === "string" ? last.content : "";
      const imageHint = textContent.trim()
        ? textContent
        : `(${userName} sent a photo)`;
      last.content = [
        { type: "text", text: imageHint },
        { type: "image_url", image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
      ];
    }
  }

  let oaiMessages: OAIMessage[] = [
    { role: "system", content: systemPrompt },
    ...oaiMsgList,
  ];

  let accumulated = "";
  const allToolCalls: ToolCallRecord[] = [];
  let continueLoop = true;

  while (continueLoop) {
    const stream = await client.chat.completions.create({
      model,
      messages: oaiMessages,
      max_completion_tokens: 1024,
      stream: true,
      ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
    });

    let chunkText = "";
    const chunkToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        chunkText += delta.content;
        accumulated += delta.content;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!chunkToolCalls.has(idx)) {
            chunkToolCalls.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
          }
          const pending = chunkToolCalls.get(idx)!;
          if (tc.id) pending.id = tc.id;
          if (tc.function?.name) pending.name = tc.function.name;
          if (tc.function?.arguments) pending.args += tc.function.arguments;
        }
      }
    }

    if (accumulated) {
      const sanitized = sanitizeAITone(accumulated);
      if (sanitized !== null) {
        accumulated = sanitized;
      }
    }

    const pendingCalls = [...chunkToolCalls.values()];

    if (pendingCalls.length === 0) {
      if (accumulated) {
        const chunks = splitIntoMessages(accumulated);
        const firstDelay = simulateTypingDelay(chunks[0]);
        if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));
        await editReply(msgId, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          const delay = simulateTypingDelay(chunks[i]);
          await sendTyping().catch(() => {});
          await new Promise((r) => setTimeout(r, delay));
          await sendReply(chunks[i]);
        }
      }
      continueLoop = false;
    } else {
      oaiMessages = [
        ...oaiMessages,
        {
          role: "assistant",
          content: chunkText || "",
          tool_calls: pendingCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          })),
        },
      ];

      for (const tc of pendingCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.args); } catch (err) { log.warn("failed to parse OpenAI tool call args", err); }

        const result = await executeToolWithMedia(tools, tc.name, input, media);
        allToolCalls.push({ id: tc.id, name: tc.name, input, output: result });

        oaiMessages = [
          ...oaiMessages,
          { role: "tool", tool_call_id: tc.id, content: typeof result === "string" ? result : JSON.stringify(result) },
        ];
      }
      continueLoop = true;
    }
  }

  if (!accumulated) await editReply(msgId, "·").catch(() => {});

  return { text: accumulated, toolCalls: allToolCalls };
}
