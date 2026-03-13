/**
 * Main agent loop — Anthropic SDK calls with streaming.
 *
 * Per-message flow:
 * 1. Check for slash commands (/status, /memory, /skills, /sessions, /new, /recall)
 * 2. Send typing indicator
 * 3. Load session transcript
 * 4. Assemble system prompt
 * 5. Hot-load tool registry
 * 6. Call Anthropic API (streaming)
 * 7. Stream text chunks → edit Telegram message in place
 * 8. Handle tool calls → execute → feed result back → continue loop
 * 9. Append turn to session transcript
 * 10. Check if compaction is needed
 */

import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { claudeRun, claudeText } from "../claude-runner.js";
import { runWithTrace } from "../lib/prompt-trace.js";
import { generateTurnTraceId, TurnTraceBuilder } from "../lib/turn-trace.js";
/** Generic reply result — decoupled from Telegraf's Message type. */
type ReplyResult = { message_id: number } | { messageId: number | string };

/** Extract message ID from either Telegraf or Channel reply format. */
function getMsgId(reply: ReplyResult): number | string {
  return "message_id" in reply ? reply.message_id : reply.messageId;
}
import type { AppConfig, TranscriptEntry, ToolCallRecord, Memory } from "../types.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { recordUserMessage, resetAttachmentOnUserMessage, recordUserMessageRhythm, recordDepthMessage } from "../lib/relationship-model.js";
import { getStoreManager } from "../memory/store-manager.js";
import { SessionManager } from "../session/manager.js";
import { ToolRegistry } from "./tools.js";
import { assembleSystemPrompt, loadSkills } from "./context.js";
import { planContext } from "./context-planner.js";
import type { ContextPlan } from "./context-planner.js";
import { selectSkills, extractRecentlyUsedSkills } from "./skill-router.js";
import type { SkillSelection } from "./skill-router.js";
import type { ImageData } from "../channel/telegram.js";
import { fetchMarketSnapshot, getWorkContext, calculateReplyDelay, getTimeSpaceContext, getPetMoments, getOutfit, type TimeBlock } from "../world.js";
import { getEmotionalState, formatEmotionContext, getEmotionTransition, invalidateEmotionCache, interruptRumination } from "../emotion.js";
import type { ContextBlock } from "./context-blocks.js";
import { selectRelevantBlocks } from "./context-blocks.js";
import { evaluatePreviousTurn, recordContextTurn, loadAdjustments } from "./context-eval.js";
import { getBodyState, formatBodyContext } from "../body.js";
import { formatHobbyContext } from "../hobbies.js";
import { formatSocialSummary, getSocialContext } from "../friends.js";
import { formatEntertainmentContext } from "../entertainment.js";
import type { CuriosityEngine } from "../curiosity.js";
import { formatDiscoveries } from "../curiosity.js";
import { formatNotificationContext } from "../notifications.js";
import { formatActivityContext } from "../activities.js";
import { isVideoEnabled, generateVideoFromImage } from "../video.js";
import { createLogger } from "../lib/logger.js";
import { formatTimelineContext, addTimelineEvent, enqueueTimelineJob } from "../timeline.js";
import { generateVoice, isTTSEnabled, getVoiceDailyCount } from "../tts.js";
import { getUserTZ } from "../lib/pst-date.js";
import { getCharacter, s, renderTemplate } from "../character.js";
import { brainstemFeedConversation, brainstemSetEmotion } from "../brainstem/index.js";
import { incrementError } from "../lib/error-metrics.js";

// ── New subsystem imports (graceful degradation via try/catch) ──────

// Cognitive controller: signal gathering + retrieval policy
import { gatherSignals, classifyConversationMode as ccClassifyMode, computeRetrievalPolicy } from "./cognitive-controller.js";
import type { CognitiveSignals } from "./cognitive-controller.js";

// Turn directive: per-turn style + adherence checking
import { computeTurnDirective, deriveReplyControl, checkAdherence, type TurnDirective, type ReplyControl, type DirectiveAdherence } from "./turn-directive.js";

// Post-turn pipeline: memory extraction, timeline, etc.
import { runPostTurnPipeline, maybeExtractExemplar, preCompactionFlush } from "./post-turn.js";

// LLM router: provider-specific calling (used alongside inline methods)
import {
  setTypingSpeedMultiplier as routerSetTypingSpeed,
  type SendPhotoFn as RouterSendPhotoFn,
  type SendVoiceFn as RouterSendVoiceFn,
  type SendVideoFn as RouterSendVideoFn,
  type SendAudioFn as RouterSendAudioFn,
  type DeleteMessageFn as RouterDeleteMessageFn,
  type MediaCallbacks,
  type LLMCallResult,
  type OnUsageFn,
  callClaudeCode as routerCallClaudeCode,
  callOpenAI as routerCallOpenAI,
  callAnthropic as routerCallAnthropic,
} from "./llm-router.js";

// Slash commands (extracted)
import { handleSlashCommand as externalHandleSlashCommand } from "./commands.js";

// Deep brainstem signals (optional — graceful degradation)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let brainstemGetTurnSignals: (() => any) | undefined;
let brainstemRestoreWM: ((data: Record<string, unknown>) => void) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let brainstemBoostNode: ((topic: string, boost: number, source: any) => void) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let brainstemLoadSlot: ((slotName: any, conceptId: string, label: string) => void) | undefined;
let brainstemNudgeSelfEfficacy: ((delta: number) => void) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let brainstemRecordIdentityEvent: ((event: any) => void) | undefined;
try {
  const bs = await import("../brainstem/index.js");
  brainstemGetTurnSignals = bs.brainstemGetTurnSignals;
  brainstemRestoreWM = bs.brainstemRestoreWM;
  brainstemBoostNode = bs.brainstemBoostNode as typeof brainstemBoostNode;
  brainstemLoadSlot = bs.brainstemLoadSlot as typeof brainstemLoadSlot;
  brainstemNudgeSelfEfficacy = bs.brainstemNudgeSelfEfficacy;
  brainstemRecordIdentityEvent = bs.brainstemRecordIdentityEvent;
} catch { /* brainstem deep functions not available */ }

// Blackboard (optional)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let blackboard: { write: (entry: any) => void; peek: (type: any) => any[] } | undefined;
try {
  const bb = await import("../blackboard.js");
  blackboard = bb.blackboard as typeof blackboard;
} catch { /* blackboard not available */ }

// Memory search tokenizer (optional — used for carryover staleness gate)
let tokenize: ((text: string) => string[]) | undefined;
try {
  const search = await import("../memory/search.js");
  tokenize = search.tokenize;
} catch { /* tokenize not available */ }

const log = createLogger("loop");

// ── 7.1: Response Planning Layer ──────────────────────────────────────

interface ResponsePlan {
  targetLength: "short" | "medium" | "long";
  tone: string;
  approach: "comfort" | "engage" | "deflect" | "playful";
  maxOutputTokens: number;
}

/**
 * 7.1: Deterministic response planning — no LLM call.
 * Decides how the character should respond based on their state and the user's message.
 */
function planResponse(
  userTextLength: number,
  energy: number,
  valence: number,
  conversationMode: string,
): ResponsePlan {
  // Default plan
  let targetLength: ResponsePlan["targetLength"] = "medium";
  let tone = s().conversation.tone_normal;
  let approach: ResponsePlan["approach"] = "engage";

  // Tired → short responses
  if (energy <= 3) {
    targetLength = "short";
    tone = s().conversation.tone_low;
    approach = "deflect";
  }
  // Match user's length
  else if (userTextLength < 15) {
    targetLength = "short";
  } else if (userTextLength > 100) {
    targetLength = "long";
  }

  // Emotional state drives tone and approach
  if (valence <= 3) {
    tone = s().conversation.tone_down;
    approach = conversationMode === "emotional" ? "comfort" : "deflect";
  } else if (valence >= 8 && energy >= 7) {
    tone = s().conversation.tone_excited;
    approach = "playful";
    if (targetLength === "short") targetLength = "medium";
  } else if (valence >= 6 && energy >= 5) {
    approach = "engage";
  }

  // Conversation mode overrides
  if (conversationMode === "emotional") {
    approach = valence >= 6 ? "engage" : "comfort";
    if (targetLength === "short") targetLength = "medium";
  }

  // Token budget
  const tokenMap: Record<string, number> = { short: 300, medium: 600, long: 1000 };
  const maxOutputTokens = tokenMap[targetLength] ?? 600;

  return { targetLength, tone, approach, maxOutputTokens };
}

// ── 7.4: Conversation Mode Classifier ──────────────────────────────────

/**
 * 7.4: Deterministic keyword classifier — no LLM call.
 * Detects conversation mode from user text.
 * Falls back to cognitive-controller's classifier if available.
 */
function classifyConversationMode(text: string): string {
  // Prefer the cognitive-controller's classifier when available
  try {
    return ccClassifyMode(text);
  } catch { /* fall through to inline classifier */ }

  const lower = text.toLowerCase();

  // Technical
  const techRe = new RegExp(s().patterns.technical_keywords.join("|"), "i");
  if (techRe.test(lower)) return "technical";
  // Emotional
  const emotionalRe = new RegExp(s().patterns.emotional_keywords.join("|"), "i");
  if (emotionalRe.test(lower)) return "emotional";
  // Philosophical
  const philoRe = new RegExp(s().patterns.philosophical_keywords.join("|"), "i");
  if (philoRe.test(lower)) return "philosophical";
  // Planning
  const planRe = new RegExp(s().patterns.planning_keywords.join("|"), "i");
  if (planRe.test(lower)) return "planning";
  // Default: casual
  return "casual";
}

/** Callback for sending photos from tool results. */
export type SendPhotoFn = (photo: Buffer, caption?: string) => Promise<void>;

/** Callback for sending voice messages from tool results. */
export type SendVoiceFn = (audio: Buffer, caption?: string) => Promise<void>;

/** Callback for sending video messages from tool results. */
export type SendVideoFn = (video: Buffer, caption?: string) => Promise<void>;

/** Callback for sending audio files (music) from tool results. */
export type SendAudioFn = (audio: Buffer, title?: string, performer?: string) => Promise<void>;

/** Callback for deleting a message by ID. */
export type DeleteMessageFn = (messageId: number | string) => Promise<void>;

// ── Token Usage Tracker ────────────────────────────────────────────

/** Per-model cost in USD per million tokens. */
const MODEL_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-6":       { input: 15, output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  "claude-sonnet-4-6":     { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

interface UsageEntry {
  timestamp: number;
  model: string;
  source: string; // "main" | "memory_extraction" | "compaction"
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
}

interface UsageSummary {
  entries: UsageEntry[];
}

class UsageTracker {
  private filePath: string;

  constructor(statePath: string) {
    this.filePath = path.join(statePath, "usage.json");
  }

  /** Record token usage from an API response. */
  record(model: string, source: string, usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }): void {
    const costs = MODEL_COSTS[model] ?? MODEL_COSTS["claude-sonnet-4-6"];
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const regularInput = usage.input_tokens - cacheCreation - cacheRead;

    const costUsd =
      (regularInput / 1_000_000) * costs.input +
      (usage.output_tokens / 1_000_000) * costs.output +
      (cacheRead / 1_000_000) * costs.cacheRead +
      (cacheCreation / 1_000_000) * costs.cacheWrite;

    const entry: UsageEntry = {
      timestamp: Date.now(),
      model,
      source,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    };

    const data = this.load();
    data.entries.push(entry);
    writeJsonAtomic(this.filePath, data);
  }

  /** Load usage data from disk. */
  load(): UsageSummary {
    return readJsonSafe<UsageSummary>(this.filePath, { entries: [] });
  }

  /** Get a human-readable usage report. */
  getReport(): string {
    const data = this.load();
    if (data.entries.length === 0) return "No API usage recorded yet.";

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const summarize = (entries: UsageEntry[]) => {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCost = 0;
      for (const e of entries) {
        totalInput += e.input_tokens;
        totalOutput += e.output_tokens;
        totalCacheRead += e.cache_read_input_tokens;
        totalCost += e.cost_usd;
      }
      return { calls: entries.length, totalInput, totalOutput, totalCacheRead, totalCost };
    };

    const day = summarize(data.entries.filter((e) => e.timestamp > oneDayAgo));
    const week = summarize(data.entries.filter((e) => e.timestamp > sevenDaysAgo));
    const month = summarize(data.entries.filter((e) => e.timestamp > thirtyDaysAgo));

    const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
    const fmtCost = (n: number) => `$${n.toFixed(4)}`;

    const lines = [
      "📈 *API Token Usage*",
      "",
      "*Last 24 hours:*",
      `  Calls: ${day.calls} | In: ${fmt(day.totalInput)} | Out: ${fmt(day.totalOutput)} | Cache: ${fmt(day.totalCacheRead)} | Cost: ${fmtCost(day.totalCost)}`,
      "",
      "*Last 7 days:*",
      `  Calls: ${week.calls} | In: ${fmt(week.totalInput)} | Out: ${fmt(week.totalOutput)} | Cache: ${fmt(week.totalCacheRead)} | Cost: ${fmtCost(week.totalCost)}`,
      "",
      "*Last 30 days:*",
      `  Calls: ${month.calls} | In: ${fmt(month.totalInput)} | Out: ${fmt(month.totalOutput)} | Cache: ${fmt(month.totalCacheRead)} | Cost: ${fmtCost(month.totalCost)}`,
    ];

    return lines.join("\n");
  }
}

// Minimum interval between Telegram edits (ms) to avoid rate limiting
const EDIT_THROTTLE_MS = 400;

/**
 * Simulate human typing delay before sending a message.
 *
 * A real person on a phone types ~40-60 chars/sec in Chinese.
 * We model: base thinking time + per-character typing time + jitter.
 *
 * If LLM processing already took a while, we subtract that from the delay
 * so the user doesn't wait unnecessarily long.
 */
// 9.4: Body-state typing speed modifiers (set per-turn from body state)
let _typingSpeedMultiplier = 1.0;

/** 9.4: Set typing speed multiplier based on body state. Called before streaming. */
export function setTypingSpeedMultiplier(fatigue: number, caffeine: number): void {
  let mult = 1.0;
  if (fatigue >= 7) mult *= 1.5;   // tired → slower
  if (caffeine >= 6) mult *= 0.6;  // caffeinated → faster
  _typingSpeedMultiplier = mult;
}

function simulateTypingDelay(text: string, llmElapsedMs = 0): number {
  const len = text.length;

  // Base "thinking" time: 0.5-1.5s
  const thinkMs = 500 + Math.random() * 1000;

  // Typing speed: 50-80ms per character (Chinese input is slower than English)
  const msPerChar = 50 + Math.random() * 30;
  const typeMs = len * msPerChar;

  // Cap at 15 seconds total — nobody types for 30 seconds straight
  const rawDelay = Math.min(thinkMs + typeMs, 15_000);

  // 9.4: Apply body-state speed modifier
  const adjustedDelay = rawDelay * _typingSpeedMultiplier;

  // Subtract time already spent on LLM processing
  const finalDelay = Math.max(adjustedDelay - llmElapsedMs, 0);

  return finalDelay;
}

/**
 * Split a long response into multiple chat-style messages.
 *
 * Real people send 2-5 short messages instead of one essay.
 * Split on paragraph breaks, then sentence boundaries if still too long.
 */
function splitIntoMessages(text: string): string[] {
  // Short messages don't need splitting
  if (text.length <= 80) return [text];

  // Step 1: split on paragraph breaks
  let chunks = text.split(/\n\n+/).filter((c) => c.trim());

  // Step 2: if any chunk is still too long (>150 chars), split on sentence boundaries
  const refined: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= 150) {
      refined.push(chunk);
    } else {
      // Split on Chinese/English sentence endings
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

  // Step 3: merge very short chunks (<15 chars) with the next one
  const merged: string[] = [];
  for (let i = 0; i < refined.length; i++) {
    if (refined[i].length < 15 && i + 1 < refined.length) {
      refined[i + 1] = refined[i] + "\n" + refined[i + 1];
    } else {
      merged.push(refined[i]);
    }
  }

  // Step 4: cap at 3 messages to avoid spam — real people don't send 5+ bubbles in a row
  if (merged.length > 3) {
    const capped = merged.slice(0, 2);
    capped.push(merged.slice(2).join("\n"));
    return capped;
  }

  return merged.length > 0 ? merged : [text];
}

/**
 * Detect and sanitize AI-sounding patterns in generated text.
 *
 * Catches common LLM tells that slip through despite system prompt rules:
 * markdown formatting, self-referencing as a system, customer-service closings, etc.
 * Returns cleaned text. If the entire message is unsalvageable, returns null
 * to signal the caller should regenerate.
 */
function sanitizeAITone(text: string): string | null {
  let cleaned = text;

  // Strip markdown formatting that slipped through
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, "$1");      // **bold**
  cleaned = cleaned.replace(/^#+\s+/gm, "");               // # headings
  cleaned = cleaned.replace(/^[-•]\s+/gm, "");             // - or • bullet lists
  cleaned = cleaned.replace(/^\d+\.\s+/gm, "");            // 1. numbered lists
  cleaned = cleaned.replace(/```[\s\S]*?```/g, "");         // code blocks

  // Strip customer-service closings (patterns from character.yaml)
  const { patterns } = getCharacter().strings;
  if (patterns.service_closing_phrases?.length) {
    const escaped = patterns.service_closing_phrases.map(p =>
      p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const re = new RegExp(`\\s*(?:${escaped.join("|")})[^.!?。！？\\n]*[.!?。！？]?\\s*$`, "gi");
    cleaned = cleaned.replace(re, "");
  }

  // AI self-reference patterns — flag for potential regeneration (patterns from character.yaml)
  const aiPatterns: RegExp[] = (patterns.ai_self_reference_patterns ?? []).map(p => {
    try { return new RegExp(p, "i"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);

  const aiPatternCount = aiPatterns.filter((p) => p.test(cleaned)).length;

  // If multiple AI patterns detected, the whole response is likely broken
  if (aiPatternCount >= 2) {
    console.warn(`[sanitize] AI tone too strong (${aiPatternCount} patterns), signaling regeneration`);
    return null;
  }

  // Clean up any trailing whitespace from removals
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned || null;
}

// Max tokens in the context window reserved for session history.
// 20% of context (~36K tokens) is sufficient for most conversations and saves
// ~27K input tokens per turn vs the previous 35% ratio.
const SESSION_TOKEN_BUDGET_RATIO = 0.20;

/** Returns true if the model string is an OpenAI model (gpt-*, o1-*, o3-*) */
function isOpenAIModel(model: string): boolean {
  return /^(gpt-|o1-|o3-)/.test(model);
}

/** Returns true if the error is an OpenAI quota/credit exhaustion error */
function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["status"] === 429 || e["status"] === 402) return true;
  const code = String(e["code"] ?? "");
  const msg = String(e["message"] ?? "").toLowerCase();
  return code === "insufficient_quota" ||
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota") ||
    msg.includes("billing") ||
    msg.includes("credit");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenAIClient = any;

export class AgentLoop {
  private openai: OpenAIClient | null = null;
  private config: AppConfig;
  private session: SessionManager;
  private tools: ToolRegistry;
  private usage: UsageTracker;
  private curiosity: CuriosityEngine | null;
  private sendPhotoFn: SendPhotoFn | null = null;
  private sendVoiceFn: SendVoiceFn | null = null;
  private sendVideoFn: SendVideoFn | null = null;
  private sendAudioFn: SendAudioFn | null = null;
  private deleteMessageFn: DeleteMessageFn | null = null;

  /** Last skill selection result — used by /skills command for diagnostics. */
  private lastSkillSelection: SkillSelection | null = null;

  /** Temporary fallback model override (set when OpenAI quota is exhausted). */
  private _fallbackModel: string | undefined;

  /** Last computed directive for carryover on compaction. */
  private lastDirective: TurnDirective | null = null;

  /** Last turn's adherence score for directive feedback loop. */
  private lastAdherenceScore: number | null = null;

  /** Consecutive turns with low adherence (< 0.5). */
  private consecutiveLowAdherence = 0;

  /** Last adherence result for carryover extraction. */
  private lastAdherenceResult: { control: ReplyControl; adherence: DirectiveAdherence } | null = null;

  /** Whether carryover has been restored this session. */
  private carryoverRestored = false;

  /** Set the photo sending callback (wired from index.ts). */
  setSendPhoto(fn: SendPhotoFn): void {
    this.sendPhotoFn = fn;
  }

  /** Set the voice sending callback (wired from index.ts). */
  setSendVoice(fn: SendVoiceFn): void {
    this.sendVoiceFn = fn;
  }

  /** Set the video sending callback (wired from index.ts). */
  setSendVideo(fn: SendVideoFn): void {
    this.sendVideoFn = fn;
  }

  /** Set the audio (music) sending callback (wired from index.ts). */
  setSendAudio(fn: SendAudioFn): void {
    this.sendAudioFn = fn;
  }

  /** Set the delete message callback (wired from index.ts). */
  setDeleteMessage(fn: DeleteMessageFn): void {
    this.deleteMessageFn = fn;
  }

  constructor(config: AppConfig, session: SessionManager, tools: ToolRegistry, curiosity?: CuriosityEngine) {
    this.config = config;
    this.session = session;
    this.tools = tools;

    // Lazily load OpenAI so missing package doesn't crash the bot
    if (config.openaiApiKey) {
      // @ts-ignore — openai is optional; install with: npm install openai
      import("openai").then((mod) => {
        const OpenAI = mod.default;
        this.openai = new OpenAI({ apiKey: config.openaiApiKey });
        console.log("[loop] OpenAI client initialized (available as opt-in provider)");
      }).catch(() => {
        // OpenAI package not installed — fine, Claude CLI is the default
      });
    }

    this.curiosity = curiosity ?? null;
    this.usage = new UsageTracker(config.statePath);

    // Wire compaction usage tracking
    this.session.onUsage = (model, source, u) => {
      this.usage.record(model, source, u);
    };
  }

  /**
   * Transcribe a voice/audio buffer.
   * Uses OpenAI Whisper if available, otherwise returns a placeholder.
   */
  async transcribeAudio(buffer: Buffer, filename: string): Promise<string> {
    // Prefer OpenAI Whisper for accurate transcription
    if (this.openai) {
      try {
        const { toFile } = await import("openai");
        const ext = filename.split(".").pop()?.toLowerCase() ?? "ogg";
        const mimeMap: Record<string, string> = {
          ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav",
          m4a: "audio/mp4", webm: "audio/webm", mp4: "audio/mp4",
        };
        const mimeType = mimeMap[ext] ?? "audio/ogg";
        const file = await toFile(buffer, filename, { type: mimeType });
        const result = await this.openai.audio.transcriptions.create({
          model: "whisper-1",
          file,
          response_format: "text",
        });
        return typeof result === "string" ? result.trim() : (result as any).text?.trim() ?? "";
      } catch (err) {
        log.warn("Whisper transcription failed, returning placeholder", err);
      }
    }
    return "[voice message]";
  }

  /**
   * Handle an incoming user message — run the full agentic loop.
   */
  async handleMessage(
    text: string,
    chatId: number | string,
    sendReply: (text: string) => Promise<ReplyResult>,
    editReply: (messageId: number | string, text: string) => Promise<void>,
    sendTyping: () => Promise<void>,
    imageData?: ImageData,
  ): Promise<void> {
    return runWithTrace(
      { traceId: `conv_${Date.now()}`, source: "conversation" },
      () => this._handleMessage(text, chatId, sendReply, editReply, sendTyping, imageData),
    );
  }

  private async _handleMessage(
    text: string,
    chatId: number | string,
    sendReply: (text: string) => Promise<ReplyResult>,
    editReply: (messageId: number | string, text: string) => Promise<void>,
    sendTyping: () => Promise<void>,
    imageData?: ImageData,
  ): Promise<void> {
    // Handle slash commands — try extracted commands module first, fall back to inline
    let slashResult: string | null = null;
    try {
      slashResult = await externalHandleSlashCommand(
        text, this.session, this.config,
        () => this.usage.getReport(),
        this.lastSkillSelection,
      );
    } catch {
      // Fall back to inline handler if commands.ts fails
      slashResult = await this.handleSlashCommand(text);
    }
    if (slashResult !== null) {
      await sendReply(slashResult);
      return;
    }

    // Turn trace — unified observability record for this turn
    const turnTraceId = generateTurnTraceId();
    const traceBuilder = new TurnTraceBuilder(turnTraceId);

    // Provider routing: Claude CLI is default (free with Max subscription).
    // "gpt:" prefix forces OpenAI, "claude:" forces Claude CLI for a single message.
    // conversationProvider config sets the persistent default.
    let actualText = text;
    let useOpenAI = this.config.conversationProvider === "openai" || isOpenAIModel(this.config.model);
    if (text.toLowerCase().startsWith("gpt:")) {
      actualText = text.slice(4).trimStart();
      useOpenAI = true;
    } else if (text.toLowerCase().startsWith("claude:")) {
      actualText = text.slice(7).trimStart();
      useOpenAI = false;
    }

    // Restore cognitive carryover on first message of session
    if (!this.carryoverRestored) {
      this.carryoverRestored = true;
      this.restoreSessionCarryover(actualText);
    }

    // 5.4: User messaging interrupts rumination → valence bonus
    const ruminationBonus = interruptRumination();
    if (ruminationBonus > 0) {
      invalidateEmotionCache(); // force fresh emotion with bonus
    }

    // Context eval: detect misses from previous turn (before block selection)
    evaluatePreviousTurn(actualText);

    // Style-reaction pairing — check if pending features should be paired with this reply
    try {
      const { getPendingStyleFeatures, clearPendingStyleFeatures, isPairingValid,
              computeUserReaction, recordStyleReactionPair } = await import("../interaction-learning.js");
      const sessionId = "main";
      const pending = getPendingStyleFeatures(sessionId);
      if (pending) {
        const hasInterveningAssistant = false; // this is the next user message after assistant
        if (isPairingValid(pending.timestamp, pending.assistantContent, Date.now(), actualText, hasInterveningAssistant)) {
          const reaction = computeUserReaction(pending.timestamp, pending.assistantContent, Date.now(), actualText);
          recordStyleReactionPair(pending.features, reaction, 1.0);
        }
        clearPendingStyleFeatures(sessionId);
      }
    } catch { /* non-fatal */ }

    // Record user message for relationship model
    try {
      const hour = new Date().getHours();
      recordUserMessage(hour);
      resetAttachmentOnUserMessage();
      recordUserMessageRhythm(actualText.length);
      recordDepthMessage(hour, actualText.length);
    } catch { /* non-fatal */ }

    if (useOpenAI && !this.openai) {
      await sendReply("OpenAI not available. Install the openai package and add openaiApiKey to config.json, or remove the gpt: prefix.");
      return;
    }

    // Append user message to transcript
    const userEntry: TranscriptEntry = {
      role: "user",
      content: actualText,
      timestamp: Date.now(),
    };
    this.session.append(userEntry);

    // ── The character might not see the message right away ──
    // Sleeping, showering, exercising, focused work, socializing — she has a life.
    const { delayMs, reason } = await calculateReplyDelay();
    if (delayMs > 0) {
      const delayMin = Math.round(delayMs / 60000);
      console.log(`[busy] ${getCharacter().name} is busy (${reason}), delaying ${delayMin}min`);

      // Delay silently — no need to notify the user, just reply when ready
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // Load recent session history
    const maxSessionTokens = Math.floor(
      this.config.maxContextTokens * SESSION_TOKEN_BUDGET_RATIO,
    );
    const history = this.session.loadRecent(maxSessionTokens);

    // ── Context planner: decide which sections are needed ──
    // Launched early so it runs in parallel with skill loading + data fetches (~0 added latency)
    const recentMsgTexts = history.slice(-3)
      .filter(e => e.role === "user")
      .map(e => typeof e.content === "string" ? e.content : "");
    const contextPlanPromise = planContext(actualText, recentMsgTexts);

    // ── Progressive skill loading ──
    // Score all skills against the current message and recent context,
    // then load only the relevant subset of tools and skill docs.
    const allSkills = loadSkills(this.config.statePath);
    const recentToolCalls = this.getRecentToolCalls(history);
    const recentlyUsed = extractRecentlyUsedSkills(
      recentToolCalls,
      allSkills.map((s) => s.name),
    );
    const skillSelection = selectSkills(allSkills, text, recentlyUsed, undefined, this.config);
    this.lastSkillSelection = skillSelection;

    const selectedNames = new Set(skillSelection.selected.map((s) => s.name));
    console.log(
      `[skill-router] ${allSkills.length} total skills → ${selectedNames.size} selected: ${[...selectedNames].join(", ")}`,
    );

    // Load tools filtered to selected skills only
    await this.tools.loadTools(this.config, selectedNames);

    // Build messages for the API
    const messages = this.buildMessages(history);

    // System prompt — BM25 memory context + progressive skill loading + real-world data
    const conversationContext = history
      .slice(-3)
      .map((e) => (typeof e.content === "string" ? e.content : ""))
      .join(" ");
    // ── Gather all data upfront (cheap, parallelized) ──
    const timeSpace = await getTimeSpaceContext();
    const marketData = await fetchMarketSnapshot();
    const work = await getWorkContext();
    const bodyState = await getBodyState();
    const bodyContext = formatBodyContext(bodyState);
    const outfit = await getOutfit();
    const petMoments = await getPetMoments();
    const hobbyCtx = formatHobbyContext();
    const socialCtx = formatSocialSummary();
    const entertainCtx = formatEntertainmentContext();
    const notifCtx = formatNotificationContext();
    let discoveriesText = "";
    if (this.curiosity) {
      const discoveries = this.curiosity.getRecentDiscoveries(3);
      discoveriesText = formatDiscoveries(discoveries);
    }

    // Await the context plan (should have resolved during data fetches)
    const contextPlan = await contextPlanPromise;
    const worldSet = new Set(contextPlan.world);

    // Schedule override detection
    const overrides: string[] = [];
    if (bodyState.fatigue >= 8 && work.nextBlock?.category === "exercise") {
      overrides.push(s().conversation.override_tired.replace("{activity}", work.nextBlock.activity));
    }
    if (bodyState.sickStatus.severity >= 5 && work.nextBlock &&
        (work.nextBlock.category === "exercise" || work.nextBlock.category === "social")) {
      overrides.push(s().conversation.override_sick.replace("{activity}", work.nextBlock.activity));
    }
    if (bodyState.periodStatus.phase === "period_heavy" && work.nextBlock?.category === "exercise") {
      overrides.push(s().conversation.override_period.replace("{activity}", work.nextBlock.activity));
    }
    if (bodyState.hunger >= 8 && work.nextBlock?.category === "hobby") {
      overrides.push(s().conversation.override_hungry);
    }

    // Format body/social signals for emotion engine
    const bodySignals: string[] = [];
    if (bodyState.fatigue >= 7) bodySignals.push(s().conversation.signal_fatigue.replace("{n}", String(bodyState.fatigue)));
    if (bodyState.hunger >= 7) bodySignals.push(s().conversation.signal_hungry.replace("{n}", String(bodyState.hunger)));
    if (bodyState.periodStatus.phase === "period_heavy") bodySignals.push(s().conversation.signal_period.replace("{symptoms}", bodyState.periodStatus.symptoms.join(", ")));
    else if (bodyState.periodStatus.phase === "pms") bodySignals.push(`PMS: ${bodyState.periodStatus.symptoms.join(", ")}`);
    if (bodyState.sickStatus.severity > 0) bodySignals.push(s().conversation.signal_sick.replace("{type}", bodyState.sickStatus.type).replace("{n}", String(bodyState.sickStatus.severity)));
    const bodySignalStr = bodySignals.join("; ");

    const social = getSocialContext();
    const socialSignals: string[] = [];
    if (social.fomoScore >= 3) socialSignals.push(s().conversation.signal_fomo.replace("{n}", String(social.fomoScore)));
    if (social.recentFriendUpdates.length > 0) socialSignals.push(s().conversation.signal_recent_social.replace("{updates}", social.recentFriendUpdates.join("; ")));
    // 6.3: Social comparison
    if (social.comparisonVulnerability >= 3) socialSignals.push(s().conversation.signal_comparison.replace("{n}", String(social.comparisonVulnerability)));
    // 6.4: Drifting friends
    if (social.driftingFriends.length > 0) socialSignals.push(s().conversation.signal_drifting.replace("{friends}", social.driftingFriends.join(", ")));
    const socialSignalStr = socialSignals.join("; ");

    // Emotion — always-on, with transition tracking
    const emotionalState = await getEmotionalState(
      work.currentActivity || work.fullSchedule,
      marketData,
      undefined,
      bodySignalStr,
      socialSignalStr,
      work.currentActivity,  // ground emotion in actual schedule activity
    );
    const transition = getEmotionTransition();
    const emotionContext = formatEmotionContext(emotionalState, transition);

    // ── Feed user message into brainstem WM slots ──
    try {
      const prevAssistant = history.filter(e => e.role === "assistant").slice(-1)[0];
      const prevText = prevAssistant && typeof prevAssistant.content === "string" ? prevAssistant.content : undefined;
      brainstemFeedConversation(actualText, prevText);
    } catch { /* brainstem may not be initialized */ }

    // ── Cognitive Controller: gather signals ──
    let signals: CognitiveSignals | undefined;
    try {
      signals = gatherSignals(history, actualText, emotionalState, bodyState);
      traceBuilder.recordSignals(signals as unknown as Record<string, unknown>);
    } catch (err) {
      log.warn("Cognitive controller signal gathering failed", err);
    }

    // ── TurnDirective: compute per-turn style directive ──
    let directive: TurnDirective | undefined;
    try {
      const turnSignals = brainstemGetTurnSignals ? brainstemGetTurnSignals() : null;
      directive = computeTurnDirective(actualText, turnSignals, bodyState, work, signals ?? { conversationMode: "casual", userTextLength: actualText.length, shortMessageCount: 0 }, this.lastAdherenceScore, this.consecutiveLowAdherence);
      this.lastDirective = directive;
      traceBuilder.recordDirective(directive);
      log.info(
        `turn-directive: goal=${directive.conversationGoal} ` +
        `slots=${directive.mustReferenceSlots.length} ` +
        `commitments=${directive.openCommitments.length} ` +
        `stance=${directive.style.stance} length=${directive.style.targetLength}`
      );
    } catch (err) {
      log.warn("TurnDirective computation failed, using inline planning", err);
      incrementError("loop", "turn_directive");
    }

    // ── Retrieval policy from directive style ──
    let retrievalPolicy: ReturnType<typeof computeRetrievalPolicy> | undefined;
    try {
      if (directive) {
        retrievalPolicy = computeRetrievalPolicy(directive.style);
      }
    } catch { /* non-fatal */ }

    // ── Engagement quality hint ──
    // Analyze recent user messages for effort level and inject a subtle behavioral hint
    const recentUserEntries = history.filter(e => e.role === "user").slice(-5);
    const recentUserTexts = recentUserEntries.map(e => typeof e.content === "string" ? e.content : "");
    const shortMessageCount = recentUserTexts.filter(t => t.length > 0 && t.length < 10).length;
    const longMessageCount = recentUserTexts.filter(t => t.length >= 50).length;

    let engagementHint = "";
    if (shortMessageCount >= 3) {
      engagementHint = "\n" + renderTemplate(s().conversation.user_distracted);
    } else if (longMessageCount >= 2) {
      engagementHint = "\n" + renderTemplate(s().conversation.user_engaged);
    }

    // 5.3: Mood-driven cognitive biases — interpretation bias
    let interpretBias = "";
    if (emotionalState && shortMessageCount >= 2) {
      if (emotionalState.valence <= 3) {
        interpretBias = "\n" + renderTemplate(s().conversation.bias_negative);
      } else if (emotionalState.valence >= 8) {
        interpretBias = "\n" + renderTemplate(s().conversation.bias_positive);
      }
    }

    // 7.4: Classify conversation mode
    const conversationMode = classifyConversationMode(actualText);

    // 7.1: Plan response based on state
    const responsePlan = planResponse(
      actualText.length,
      emotionalState?.energy ?? 6,
      emotionalState?.valence ?? 5,
      conversationMode,
    );

    // 7.1 + 7.4: Inject plan and mode hints
    let planHint = "\n" + s().conversation.reply_hint.replace("{length}", responsePlan.targetLength).replace("{tone}", responsePlan.tone);
    const modeHints: Record<string, string> = {
      emotional: "\n" + s().conversation.mode_emotional,
      technical: "\n" + s().conversation.mode_technical,
      philosophical: "\n" + s().conversation.mode_philosophical,
      planning: "\n" + s().conversation.mode_planning,
      casual: "",
    };
    planHint += modeHints[conversationMode] ?? "";

    // 9.4: Body-state writing instructions
    let bodyWritingHint = "";
    if (bodyState.fatigue >= 8) {
      bodyWritingHint = "\n" + s().conversation.body_exhausted;
    } else if (bodyState.fatigue >= 6) {
      bodyWritingHint = "\n" + s().conversation.body_tired;
    }
    if (bodyState.caffeineLevel >= 7) {
      bodyWritingHint += "\n" + s().conversation.body_caffeine_high;
    } else if (bodyState.caffeineLevel >= 5) {
      bodyWritingHint += "\n" + s().conversation.body_caffeine_moderate;
    }

    // 9.4: Set typing speed modifier for streaming
    setTypingSpeedMultiplier(bodyState.fatigue, bodyState.caffeineLevel);
    try { routerSetTypingSpeed(bodyState.fatigue, bodyState.caffeineLevel); } catch { /* non-fatal */ }

    // Anchor: inject current activity so the LLM doesn't contradict the schedule
    // (e.g., don't say "going to sleep" when the character is at pottery class)
    let activityAnchor = "";
    if (work.currentActivity) {
      activityAnchor = "\n\n" + renderTemplate(s().conversation.activity_anchor, undefined, { activity: work.currentActivity, location: work.location });
    }

    const finalEmotionContext = emotionContext + activityAnchor + engagementHint + interpretBias + planHint + bodyWritingHint;

    // ── Build context blocks (filtered by context plan) ──
    const blocks: ContextBlock[] = [];

    // Always-on blocks (time is almost always in the plan)
    if (worldSet.has("time")) {
      blocks.push({ id: "time", text: timeSpace, keywords: [], alwaysInclude: true, priority: 0 });
    }

    // Build schedule text
    if (worldSet.has("schedule")) {
      let scheduleText = "";
      if (work.fullSchedule) {
        const parts = [`${s().headers.my_schedule}:\n${work.fullSchedule}`];
        if (work.currentActivity) parts.push(`${s().headers.now_doing}: ${work.currentActivity}`);
        if (work.currentBlock?.location) parts.push(`${s().headers.now_at}: ${work.currentBlock.location}`);
        if (work.currentBlock?.withPeople?.length) parts.push(`${s().headers.people_with}: ${work.currentBlock.withPeople.join(", ")}`);
        if (work.nextBlock) parts.push(`${s().headers.next_up}: ${work.nextBlock.start}:00 ${work.nextBlock.activity}`);
        if (overrides.length > 0) parts.push(`${s().headers.plan_changes}: ${overrides.join("; ")}`);
        // If she was just busy (delayed reply), inject transition context
        if (reason) parts.push(renderTemplate(s().headers.was_doing, undefined, { reason }));
        // Inject latest narration micro-event (from heartbeat life narration)
        try {
          const characterMemories = getStoreManager().loadCategory("character");
          const recentNarration = characterMemories
            .filter(m => m.key.startsWith("inner.block.") && Date.now() - m.timestamp < 60 * 60 * 1000)
            .sort((a, b) => b.timestamp - a.timestamp)[0];
          if (recentNarration) {
            parts.push(`${s().headers.just_happened}: ${recentNarration.value}`);
          }
        } catch { /* non-fatal */ }
        scheduleText = parts.join("\n");
      }
      if (scheduleText) {
        blocks.push({ id: "schedule", text: scheduleText, keywords: ["work", "commute", "office", "meeting", "doing", "busy", "today", "schedule"], alwaysInclude: true, priority: 2 });
      }
    }

    // Timeline — today's established facts (always included when available)
    const timelineCtx = formatTimelineContext();
    if (timelineCtx) {
      blocks.push({ id: "timeline", text: timelineCtx, keywords: [], alwaysInclude: true, priority: 1 });
    }

    if (worldSet.has("body")) {
      if (bodyContext) {
        let bodyText = `${s().headers.my_body}:\n${bodyContext}`;
        if (outfit) bodyText += `\n${s().headers.wearing_today}: ${outfit}`;
        blocks.push({ id: "body", text: bodyText, keywords: ["hungry", "tired", "sleepy", "eat", "coffee", "body", "period", "sick", "exercise", "wear", "outfit"], alwaysInclude: true, priority: 3 });
      }
    }
    if (worldSet.has("market") && marketData) {
      blocks.push({ id: "market", text: `${s().headers.today_market}: ${marketData}`, keywords: ["stock", "market", "NVDA", "AAPL", "up", "down", "invest", "fund"], alwaysInclude: false, priority: 4 });
    }
    if (worldSet.has("pet") && petMoments.length > 0) {
      blocks.push({ id: "pet", text: `${renderTemplate(s().headers.pet_moments)}:\n${petMoments.map(m => `- ${m}`).join("\n")}`, keywords: [getCharacter().pet?.name ?? "pet", "cat", "pet"].filter(Boolean), alwaysInclude: false, priority: 5 });
    }
    if (worldSet.has("hobbies") && hobbyCtx) {
      blocks.push({ id: "hobbies", text: `${s().headers.my_hobbies}:\n${hobbyCtx}`, keywords: ["pottery", "tennis", "drums", "running", "vibe", "coding", "practice", "hobby"], alwaysInclude: false, priority: 6 });
    }
    if (worldSet.has("social") && socialCtx) {
      blocks.push({ id: "social", text: socialCtx, keywords: ["friend", "meet", "hangout", "date", "gathering"], alwaysInclude: false, priority: 7 });
    }
    if (worldSet.has("entertainment") && entertainCtx) {
      blocks.push({ id: "entertainment", text: `${s().headers.my_entertainment}:\n${entertainCtx}`, keywords: ["watch", "show", "movie", "podcast", "listen", "song", "YouTube", "Netflix"], alwaysInclude: false, priority: 8 });
    }
    if (worldSet.has("notifications") && notifCtx) {
      blocks.push({ id: "notifications", text: `${s().headers.my_notifications}:\n${notifCtx}`, keywords: ["notification", "alert", "update", "new"], alwaysInclude: false, priority: 9 });
    }
    if (worldSet.has("discoveries") && discoveriesText) {
      blocks.push({ id: "discoveries", text: `${s().headers.my_discoveries}:\n${discoveriesText}`, keywords: ["learn", "search", "discover", "research", "paper", "article", "found"], alwaysInclude: false, priority: 10 });
    }
    if (worldSet.has("activities")) {
      const actCtx = formatActivityContext();
      if (actCtx) {
        blocks.push({ id: "activities", text: actCtx, keywords: ["project", "coding", "read", "learn", "build", "code", "dashboard"], alwaysInclude: false, priority: 5 });
      }
    }
    if (worldSet.has("body") && outfit && !bodyContext) {
      // If body block wasn't created but outfit exists, add standalone
      blocks.push({ id: "outfit", text: `${s().headers.wearing_today}: ${outfit}`, keywords: ["wear", "clothes", "outfit"], alwaysInclude: false, priority: 11 });
    }

    // ── Select relevant blocks based on recent conversation ──
    const recentMsgs = messages.slice(-5)
      .filter(m => m.role === "user")
      .map(m => typeof m.content === "string" ? m.content : "");
    const contextAdjustments = loadAdjustments();
    const selected = selectRelevantBlocks(blocks, recentMsgs, 8, contextAdjustments);

    // Log which blocks were selected
    const selectedIds = selected.map(b => b.id);
    const conditionalIds = selected.filter(b => !b.alwaysInclude).map(b => b.id);
    log.info(`context blocks: ${selectedIds.join(", ")} (conditional: ${conditionalIds.join(", ") || "none — using baseline"})`);

    // Separate emotion (always-on, dedicated section) from world context
    const worldContext = selected.map(b => b.text).join("\n\n");
    const systemPrompt = await this.buildSystemPrompt(conversationContext, skillSelection, worldContext, finalEmotionContext, contextPlan, directive?.style?.memoryQuery, directive ?? null, retrievalPolicy);

    // Pre-decide voice vs text mode BEFORE streaming.
    // In voice mode we suppress text streaming (no placeholder, no edits) —
    // user only sees typing indicator, then gets a voice message.
    const voiceMode = this.shouldPreDecideVoice();

    let msgId: number | string = -1;
    const allMsgIds: (number | string)[] = [];

    // In text mode: send placeholder and stream as usual
    // In voice mode: no placeholder, no text streaming — just typing indicator
    let activeEditReply = editReply;
    let activeSendReply = async (text: string) => {
      const msg = await sendReply(text);
      allMsgIds.push(getMsgId(msg));
      return msg;
    };

    if (!voiceMode) {
      const placeholder = await sendReply("·");
      msgId = getMsgId(placeholder);
      allMsgIds.push(msgId);
    } else {
      // No-op: suppress text streaming in voice mode
      activeEditReply = async () => {};
      activeSendReply = async (_text: string) => ({ messageId: -1 } as ReplyResult);
      log.info("Voice mode pre-selected — suppressing text streaming");
    }

    // Run the agentic loop (may have multiple tool-call rounds)
    let accumulated = "";
    const toolCalls: ToolCallRecord[] = [];
    let currentMessages = messages;

    // Keep a typing indicator going
    const typingInterval = setInterval(() => {
      sendTyping().catch(() => {});
    }, 4000);

    try {
      if (useOpenAI) {
        // ── OpenAI path (full tool use + streaming) ──────────────────────
        try {
          const result = await this.callOpenAI(systemPrompt, currentMessages, msgId, activeEditReply, activeSendReply, sendTyping, imageData);
          accumulated = result.text;
          toolCalls.push(...result.toolCalls);
        } catch (err) {
          if (isQuotaError(err)) {
            // OpenAI credit exhausted — fall back to Claude CLI silently
            console.warn("[loop] OpenAI quota exhausted, falling back to Claude CLI");
            useOpenAI = false;
            this._fallbackModel = "claude-haiku-4-5-20251001";
          } else {
            throw err;
          }
        }
      }
      if (!useOpenAI) {
        // ── Claude Code path (via claude --print) — default ──────────────
        const result = await this.callClaudeCode(systemPrompt, currentMessages, msgId, activeEditReply, activeSendReply, sendTyping, imageData);
        accumulated = result.text;
        toolCalls.push(...result.toolCalls);

        if (!accumulated && !voiceMode) {
          await editReply(msgId, "·").catch(() => {});
        }
      }
    } finally {
      clearInterval(typingInterval);
    }

    // Voice mode: generate TTS and send voice, fall back to text if TTS fails
    if (voiceMode && accumulated.length > 3) {
      const usedVoiceTool = toolCalls.some(tc => tc.name === "send_voice");
      if (!usedVoiceTool) {
        let trigger: "emotional_reaction" | "greeting" | "teasing" | "excitement" | "sleepy" | "answer" = "answer";
        const greetingRe = new RegExp(s().patterns.voice_greeting.join("|"), "i");
        const teasingRe = new RegExp(s().patterns.voice_teasing.join("|"), "i");
        const excitementRe = new RegExp(s().patterns.voice_excitement.join("|"), "i");
        const sleepyRe = new RegExp(s().patterns.voice_sleepy.join("|"), "i");
        const emotionalRe2 = new RegExp(s().patterns.voice_emotional.join("|"), "i");
        if (greetingRe.test(accumulated)) trigger = "greeting";
        else if (teasingRe.test(accumulated)) trigger = "teasing";
        else if (excitementRe.test(accumulated)) trigger = "excitement";
        else if (sleepyRe.test(accumulated)) trigger = "sleepy";
        else if (emotionalRe2.test(accumulated)) trigger = "emotional_reaction";

        try {
          const voiceResult = await generateVoice(accumulated, trigger);
          if (voiceResult && this.sendVoiceFn) {
            await this.sendVoiceFn(voiceResult.audio);
            log.info(`Voice reply sent: "${accumulated.slice(0, 30)}..."`);
          } else {
            // TTS failed — fall back to text
            await sendReply(accumulated);
          }
        } catch (err) {
          log.warn("Voice generation failed, falling back to text", err);
          await sendReply(accumulated);
        }
      }
    }

    // Capture recent history BEFORE appending the assistant reply.
    // extractAndSaveMemories requires the last message to be from the user —
    // if we load AFTER appending, the last entry is the assistant and the
    // extractor exits early (this was the bug causing memory to never save).
    const recentHistory = this.session.loadRecent(2000).slice(-5);

    // Append assistant response to transcript
    const assistantEntry: TranscriptEntry = {
      role: "assistant",
      content: accumulated,
      timestamp: Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    this.session.append(assistantEntry);

    // Context eval: record selection + utilization for this turn
    recordContextTurn({
      userMessage: actualText,
      responseText: accumulated,
      allBlocks: blocks,
      selectedBlocks: selected,
    });

    // TurnDirective adherence check (Phase B + F1)
    if (directive) {
      try {
        const control = deriveReplyControl(directive);
        const adherence = checkAdherence(accumulated, directive, control);
        this.lastAdherenceScore = adherence.adherenceScore;
        this.consecutiveLowAdherence = adherence.adherenceScore < 0.5
          ? this.consecutiveLowAdherence + 1
          : 0;
        this.lastAdherenceResult = { control, adherence };

        // Self-model write-back: adherence → self_efficacy
        try {
          if (brainstemNudgeSelfEfficacy) {
            if (adherence.adherenceScore >= 0.7) {
              brainstemNudgeSelfEfficacy(+0.02);
            } else if (adherence.adherenceScore < 0.4) {
              brainstemNudgeSelfEfficacy(-0.01);
            }
          }
        } catch { /* non-fatal */ }

        log.info(
          `directive-adherence: score=${adherence.adherenceScore.toFixed(2)} ` +
          `mode=${adherence.replyMode} ` +
          `commitments=${adherence.surfacedCommitments.length}/${control.mustMention.length} ` +
          `slots=${adherence.surfacedSlots.length}/${control.shouldGroundIn.length}`
        );

        traceBuilder.recordAdherence(adherence);

        // Append to turn-directive.jsonl
        try {
          const replayEntry = {
            ts: Date.now(),
            traceId: turnTraceId,
            directive: {
              conversationGoal: directive.conversationGoal,
              slotsCount: directive.mustReferenceSlots.length,
              commitmentsCount: directive.openCommitments.length,
              uncertaintyLevel: directive.uncertaintyLevel,
              affectRegulationOverride: directive.affectRegulationOverride,
            },
            selectedBlockIds: selected.map(b => b.id),
            surfacedCommitments: adherence.surfacedCommitments,
            surfacedSlots: adherence.surfacedSlots,
            replyMode: adherence.replyMode,
            adherenceScore: adherence.adherenceScore,
            responseLength: accumulated.length,
            userMessageLength: actualText.length,
          };
          fs.appendFileSync(
            path.join(this.config.statePath, "turn-directive.jsonl"),
            JSON.stringify(replayEntry) + "\n",
          );
        } catch { /* non-fatal */ }

        traceBuilder.finalize();
      } catch (err) { incrementError("loop", "directive_replay"); }

      // Record identity-relevant conversation events
      try {
        if (directive.identityLens && brainstemRecordIdentityEvent) {
          const lens = directive.identityLens;
          // Use character-agnostic stance detection patterns
          const stanceMarkers = /I disagree|I don't think|not necessarily|I see it differently|I wouldn't say|actually I think/i;
          const expressedStance = stanceMarkers.test(accumulated);
          const selfShareMarkers = /I've been|for me|personally|I recently|to be honest/i;
          const sharedSelf = selfShareMarkers.test(accumulated) && lens.selfDisclosureLevel !== "minimal";

          if (expressedStance || sharedSelf) {
            const adhScore = this.lastAdherenceResult?.adherence.adherenceScore ?? 1;
            brainstemRecordIdentityEvent({
              type: expressedStance ? "stance_expression" : "self_disclosure",
              disagreementReadiness: lens.disagreementReadiness,
              adherenceScore: adhScore,
              topicOwnership: lens.topicOwnership,
              timestamp: Date.now(),
            });

            // Extract exemplar on high-adherence identity events
            if (adhScore >= 0.8) {
              maybeExtractExemplar(
                actualText, accumulated,
                expressedStance ? "disagreed" : "disclosed",
                adhScore,
                lens.topicOwnership?.caresAbout?.[0] ?? "general",
                this.config.statePath,
              ).catch(() => {});
            }
          }

          // topicOwnership → blackboard for proactive follow-up
          if (blackboard && lens.topicOwnership && lens.topicOwnership.followupWorthiness > 0.5
              && lens.topicOwnership.caresAbout.length > 0) {
            const existingFollowups = blackboard.peek("identity_followup");
            const topicsKey = [...lens.topicOwnership.caresAbout].sort().join(",");
            const isDuplicate = existingFollowups.some((p: any) => {
              const pTopics = ((p.payload.topics as string[]) ?? []).sort().join(",");
              return pTopics === topicsKey;
            });
            if (!isDuplicate) {
              blackboard.write({
                source: "external",
                type: "identity_followup",
                payload: {
                  topics: lens.topicOwnership.caresAbout,
                  worthiness: lens.topicOwnership.followupWorthiness,
                },
                salience: 0.5,
                ttl: 3 * 24 * 60 * 60 * 1000, // 3 days
              });
            }
          }
        }
      } catch (err) { incrementError("loop", "identity_events"); }
    } else {
      traceBuilder.finalize();
    }

    // Soft-invalidate emotion cache — only regenerates if >5 min old.
    invalidateEmotionCache();

    // Store pending style features for interaction learning (style-reaction pairing)
    try {
      const { extractResponseStyleFeatures, storePendingStyleFeatures } = await import("../interaction-learning.js");
      const sessionId = "main";
      const styleFeatures = extractResponseStyleFeatures(accumulated);
      storePendingStyleFeatures(sessionId, styleFeatures, accumulated);
    } catch { /* non-fatal */ }

    // Post-turn pipeline — background extraction (memory, timeline, intents, understanding)
    // NOTE: recentHistory is captured BEFORE appending the assistant entry (above)
    // to ensure the last entry is the user message, preventing the early-return bug.
    try {
      runPostTurnPipeline({
        userMessage: actualText,
        response: accumulated,
        recentHistory,
        currentBlock: work.currentBlock ?? undefined,
        config: this.config,
        tools: this.tools,
      }).catch((err) => log.warn("Post-turn pipeline error", err));
    } catch {
      // Fallback: inline memory extraction if post-turn pipeline fails to load
      if (this.shouldExtractMemories(actualText)) {
        this.extractAndSaveMemories(recentHistory).catch((err) =>
          console.error("Memory extraction error:", err),
        );
      }
      if (accumulated.length > 5) {
        this.maybeExtractTimelineEvent(actualText, accumulated, work.currentBlock ?? undefined).catch(() => {});
      }
    }

    // Voice-or-text is now handled above (pre-decided before streaming).
    // No more post-hoc text deletion — voice mode suppresses text from the start.

    // Check if compaction is needed — flush important memories first
    if (this.session.needsCompaction()) {
      // Save cognitive carryover before compaction
      if (this.lastDirective) {
        try {
          const turnSignals = brainstemGetTurnSignals ? brainstemGetTurnSignals() : null;
          const wmSnapshot = turnSignals ? Object.fromEntries(
            Object.entries(turnSignals.slots)
              .filter(([, s]: [string, any]) => s.conceptId !== null)
              .map(([name, s]: [string, any]) => [name, { conceptId: s.conceptId, label: s.label, strength: s.strength }])
          ) : {};
          // Extract unresolved questions from last adherence
          const unresolvedQuestions: string[] = [];
          if (this.lastAdherenceResult) {
            const { control: lastCtrl, adherence: lastAdh } = this.lastAdherenceResult;
            for (const m of lastCtrl.mustMention) {
              if (!lastAdh.surfacedCommitments.includes(m)) unresolvedQuestions.push(m);
            }
            for (const sg of lastCtrl.shouldGroundIn) {
              if (!lastAdh.surfacedSlots.includes(sg)) unresolvedQuestions.push(sg);
            }
          }
          writeJsonAtomic(path.join(this.config.statePath, "sessions", "carryover.json"), {
            openCommitments: this.lastDirective.openCommitments,
            activeGoalIds: this.lastDirective.activeGoalAlignment.map((g: any) => g.goalId),
            wmSnapshot,
            groundingHints: this.lastDirective.groundingHints.slice(0, 5),
            unresolvedQuestions: unresolvedQuestions.slice(0, 5),
            ts: Date.now(),
          });
          log.info("carryover saved before compaction");
        } catch (err) {
          log.warn("carryover save failed", err);
        }
      }

      console.log("Context threshold exceeded, flushing memories before compaction...");
      try {
        await preCompactionFlush(() => this.session.loadAll(), this.tools);
      } catch {
        // Fall back to inline pre-compaction flush
        await this.preCompactionFlush();
      }
      console.log("Starting compaction...");
      await this.session.compact();
    }
  }

  /**
   * Restore cognitive state from previous session's carryover.
   * Called once on first message of a new session.
   */
  private restoreSessionCarryover(userText: string): void {
    try {
      const carryoverPath = path.join(this.config.statePath, "sessions", "carryover.json");
      if (!fs.existsSync(carryoverPath)) return;

      // Guard: brainstem must be initialized
      const turnSignals = brainstemGetTurnSignals ? brainstemGetTurnSignals() : null;
      if (!turnSignals) {
        log.info("carryover: brainstem not initialized yet, deferring restore");
        return;
      }

      interface CarryoverData {
        openCommitments: Array<{ content: string; urgency: number }>;
        activeGoalIds: string[];
        wmSnapshot: Record<string, unknown>;
        groundingHints: string[];
        unresolvedQuestions?: string[];
        ts: number;
      }
      const raw = readJsonSafe<Record<string, unknown>>(carryoverPath, {});
      if (!raw || !raw.ts) {
        try { fs.unlinkSync(carryoverPath); } catch { /* ok */ }
        return;
      }
      const carryover = raw as unknown as CarryoverData;

      // Skip if > 4 hours old
      if (Date.now() - carryover.ts > 4 * 60 * 60 * 1000) {
        log.info("carryover expired (>4h), skipping");
        try { fs.unlinkSync(carryoverPath); } catch { /* ok */ }
        return;
      }

      // Restore WM slots
      if (brainstemRestoreWM && carryover.wmSnapshot && Object.keys(carryover.wmSnapshot).length > 0) {
        brainstemRestoreWM(carryover.wmSnapshot);
        log.info(`carryover: restored ${Object.keys(carryover.wmSnapshot).length} WM slots`);
      }

      // Restore commitments as goal_active WM slots
      if (brainstemLoadSlot && Array.isArray(carryover.openCommitments)) {
        const valid = carryover.openCommitments.filter(
          c => typeof c.content === "string" && typeof c.urgency === "number"
        );
        const sorted = [...valid]
          .sort((a, b) => a.urgency - b.urgency)
          .slice(0, 3);
        for (let i = 0; i < sorted.length; i++) {
          brainstemLoadSlot("goal_active", `carryover_${Date.now()}_${i}`, sorted[i].content);
        }
      }

      // Restore unresolved questions
      if (brainstemLoadSlot && Array.isArray(carryover.unresolvedQuestions) && carryover.unresolvedQuestions.length > 0) {
        for (let i = 0; i < carryover.unresolvedQuestions.length; i++) {
          brainstemLoadSlot("open_question", `unresolved_${Date.now()}_${i}`, carryover.unresolvedQuestions[i]);
        }
        log.info(`carryover: restored ${carryover.unresolvedQuestions.length} unresolved questions`);
      }

      // Staleness gate for concept boosts
      if (brainstemBoostNode && tokenize && Array.isArray(carryover.groundingHints) && carryover.groundingHints.length > 0) {
        const userTokens = new Set(tokenize(userText));
        const hintTokens = carryover.groundingHints.flatMap(h => tokenize!(h));
        let overlap = 0;
        for (const t of hintTokens) {
          if (userTokens.has(t)) overlap++;
        }
        const overlapRatio = hintTokens.length > 0 ? overlap / hintTokens.length : 0;

        if (overlapRatio > 0.1) {
          for (const hint of carryover.groundingHints) {
            brainstemBoostNode(hint, 0.3, "replay");
          }
          log.info(`carryover: boosted ${carryover.groundingHints.length} concepts (overlap=${overlapRatio.toFixed(2)})`);
        } else {
          log.info(`carryover: skipped concept boosts (overlap=${overlapRatio.toFixed(2)} < 0.1, new topic)`);
        }
      }

      // Delete carryover file only after successful restore
      try { fs.unlinkSync(carryoverPath); } catch { /* ok */ }
      log.info("carryover restored and cleaned up");
    } catch (err) {
      log.warn("carryover restore failed (file preserved for retry)", err);
    }
  }

  /**
   * Handle slash commands. Returns response text if handled, null otherwise.
   */
  private async handleSlashCommand(text: string): Promise<string | null> {
    const trimmed = text.trim();
    const cmd = trimmed.toLowerCase();

    if (cmd === "/status") {
      return this.getStatusReport();
    }

    if (cmd === "/memory") {
      return this.getMemoryReport();
    }

    if (cmd === "/skills") {
      return this.getSkillsReport();
    }

    if (cmd === "/usage") {
      return this.usage.getReport();
    }

    if (cmd === "/sessions") {
      return this.getSessionsReport();
    }

    if (cmd === "/new") {
      return this.handleNewSession();
    }

    if (cmd.startsWith("/recall")) {
      const query = trimmed.slice("/recall".length).trim();
      return this.handleRecall(query);
    }

    return null;
  }

  private getStatusReport(): string {
    const tokenEstimate = this.session.estimateTokens();
    const usage = ((tokenEstimate / this.config.maxContextTokens) * 100).toFixed(1);

    const entries = this.session.loadAll();
    const memoryStore = this.loadMemoryCount();
    const skills = loadSkills(this.config.statePath);
    const archivedSessions = this.session.getIndex().listAll();

    const lines = [
      "📊 *MeAI Status*",
      "",
      `*Model:* ${this.config.model}`,
      `*Context usage:* ~${tokenEstimate} tokens (${usage}% of ${this.config.maxContextTokens})`,
      `*Compaction at:* ${(this.config.compactionThreshold * 100).toFixed(0)}%`,
      `*Transcript entries:* ${entries.length}`,
      `*Archived sessions:* ${archivedSessions.length}`,
      `*Memories stored:* ${memoryStore}`,
      `*Skills available:* ${skills.length}${this.lastSkillSelection ? ` (${this.lastSkillSelection.selected.length} active last turn)` : ""}`,
      `*State path:* \`${this.config.statePath}\``,
    ];

    return lines.join("\n");
  }

  private getMemoryReport(): string {
    try {
      const memories = getStoreManager().loadAll();

      if (memories.length === 0) {
        return "No memories stored yet.";
      }

      const lines = ["🧠 *Stored Memories*", ""];
      for (const m of memories) {
        const date = new Date(m.timestamp).toLocaleDateString("en-US", { timeZone: getUserTZ() });
        lines.push(`• *${m.key}*: ${m.value} (conf: ${m.confidence}, ${date})`);
      }

      return lines.join("\n");
    } catch (err) {
      log.warn("failed to read memory store", err);
      return "Error reading memory store.";
    }
  }

  private getSkillsReport(): string {
    const skills = loadSkills(this.config.statePath);

    if (skills.length === 0) {
      return "No skills defined yet.";
    }

    const lines = ["📚 *Skills* (progressive loading)", ""];

    // If we have a recent selection, show active vs available breakdown
    if (this.lastSkillSelection) {
      const { selected, scores } = this.lastSkillSelection;
      const activeNames = new Set(selected.map((s) => s.name));

      // Active skills
      lines.push(`*Active this turn (${selected.length}):*`);
      for (const s of selected) {
        const scoreEntry = scores.find((sc) => sc.skill.name === s.name);
        const scoreStr = scoreEntry ? ` (score: ${scoreEntry.score.toFixed(2)})` : "";
        const toolsTag = s.hasTools ? " ⚙️" : "";
        lines.push(`  ✦ ${s.name}${toolsTag}${scoreStr}`);
      }

      // Available but not loaded
      const inactive = skills.filter((s) => !activeNames.has(s.name));
      if (inactive.length > 0) {
        lines.push("");
        lines.push(`*Available but not loaded (${inactive.length}):*`);
        for (const s of inactive) {
          const scoreEntry = scores.find((sc) => sc.skill.name === s.name);
          const scoreStr = scoreEntry ? ` (score: ${scoreEntry.score.toFixed(2)})` : "";
          const toolsTag = s.hasTools ? " ⚙️" : "";
          lines.push(`  ○ ${s.name}${toolsTag}${scoreStr}`);
        }
      }
    } else {
      // No selection yet — show all skills
      for (const s of skills) {
        const toolsTag = s.hasTools ? " ⚙️" : "";
        lines.push(`• ${s.name}${toolsTag}: ${s.content.slice(0, 80)}...`);
      }
    }

    lines.push("");
    lines.push(`*Total:* ${skills.length} skills`);

    return lines.join("\n");
  }

  private getSessionsReport(): string {
    const sessions = this.session.getIndex().listAll();

    if (sessions.length === 0) {
      return "No archived sessions yet. Sessions are archived automatically during compaction, or manually with /new.";
    }

    const lines = ["📂 *Archived Sessions*", ""];
    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleDateString("en-US", { timeZone: getUserTZ() });
      lines.push(`• *${s.slug}* — ${s.title}`);
      lines.push(`  ${date} · ${s.messageCount} msgs · ${s.topics.join(", ")}`);
      if (s.summary) {
        const preview = s.summary.length > 120 ? s.summary.slice(0, 120) + "…" : s.summary;
        lines.push(`  _${preview}_`);
      }
      lines.push("");
    }

    lines.push("Use `/recall <query>` to search and load a past session's context.");
    return lines.join("\n");
  }

  private async handleNewSession(): Promise<string> {
    const result = await this.session.startNewSession();

    if (result) {
      return `✅ Session archived as *${result.slug}* ("${result.title}").\n\nFresh session started. Use /sessions to browse past conversations.`;
    }
    return "✅ Fresh session started. (Previous session was too short to archive.)";
  }

  private handleRecall(query: string): string {
    if (!query) {
      return "Usage: `/recall <query>`\n\nSearch past sessions by topic, slug, or keyword. Example: `/recall react hooks`";
    }

    const results = this.session.getIndex().search(query);

    if (results.length === 0) {
      return `No archived sessions match "${query}". Use /sessions to see all available sessions.`;
    }

    const lines = [`🔍 *Sessions matching "${query}":*`, ""];
    for (const s of results.slice(0, 5)) {
      const date = new Date(s.updatedAt).toLocaleDateString("en-US", { timeZone: getUserTZ() });
      lines.push(`*${s.slug}* — ${s.title} (${date})`);
      lines.push(`Topics: ${s.topics.join(", ")}`);
      if (s.summary) {
        lines.push(`${s.summary}`);
      }
      lines.push("");
    }

    if (results.length > 5) {
      lines.push(`_…and ${results.length - 5} more results._`);
    }

    return lines.join("\n");
  }

  private loadMemoryCount(): number {
    try {
      return getStoreManager().count();
    } catch (err) {
      log.warn("failed to count memories", err);
      return 0;
    }
  }

  private buildMessages(
    history: TranscriptEntry[],
  ): Anthropic.MessageParam[] {
    const msgs: Anthropic.MessageParam[] = history.map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.content,
    }));

    // Annotate the latest user message with current time — prevents time confusion
    // in long conversations where the system prompt time can feel distant.
    if (msgs.length > 0) {
      const lastIdx = msgs.length - 1;
      const last = msgs[lastIdx];
      if (last.role === "user" && typeof last.content === "string") {
        const now = new Date();
        const localTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
        const timeStr = `${localTime.getHours()}:${String(localTime.getMinutes()).padStart(2, "0")}`;
        msgs[lastIdx] = {
          ...last,
          content: `[${timeStr}] ${last.content}`,
        };
      }
    }

    // Cache the end of the stable history prefix (everything before the current user message).
    // On each turn, the last message is the new user message — everything before it is unchanged
    // from the previous turn, so Anthropic can serve it from cache at 0.1× the normal price.
    if (msgs.length >= 2) {
      const idx = msgs.length - 2;
      const msg = msgs[idx];
      msgs[idx] = {
        ...msg,
        content:
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content, cache_control: { type: "ephemeral" as const } }]
            : msg.content,
      };
    }

    return msgs;
  }

  /**
   * Extract tool call names from recent transcript entries for recency boosting.
   * Looks at the last 6 entries that have tool calls.
   */
  private getRecentToolCalls(history: TranscriptEntry[]): Array<{ name: string }> {
    const calls: Array<{ name: string }> = [];
    const recent = history.slice(-6);
    for (const entry of recent) {
      if (entry.toolCalls) {
        for (const tc of entry.toolCalls) {
          calls.push({ name: tc.name });
        }
      }
    }
    return calls;
  }

  private async buildSystemPrompt(conversationContext?: string, skillSelection?: SkillSelection, worldContext?: string, emotionContext?: string, plan?: ContextPlan, memoryQuery?: string, directive?: TurnDirective | null, retrievalPolicy?: ReturnType<typeof computeRetrievalPolicy>): Promise<string> {
    return assembleSystemPrompt(this.config, conversationContext, skillSelection, worldContext, emotionContext, plan, memoryQuery, directive, retrievalPolicy);
  }

  /**
   * Lightweight heuristic: should we bother running memory extraction?
   * Returns false for greetings, slash commands, very short messages,
   * and messages that look like pure task delegation (no personal facts).
   */
  private shouldExtractMemories(text: string): boolean {
    const trimmed = text.trim();

    // Slash commands are never personal facts
    if (trimmed.startsWith("/")) return false;

    // Very short messages are rarely personal facts (e.g. "hi", "ok", "thanks")
    if (trimmed.length < 15) return false;

    // Common greetings / acknowledgements (case-insensitive)
    const trivialPatterns = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|bye|good morning|good night|gm|gn|yo|sup|lol|haha|hmm|what|how|when|where|why|who)\b/i;
    if (trivialPatterns.test(trimmed) && trimmed.length < 30) return false;

    return true;
  }

  /**
   * Pre-compaction memory flush — before compacting the transcript,
   * use Haiku to extract any important facts from the conversation
   * that haven't been saved yet. This prevents information loss
   * during compaction (inspired by OpenClaw's architecture).
   */
  private async preCompactionFlush(): Promise<void> {
    try {
      const entries = this.session.loadAll();
      if (entries.length <= 10) return;

      // Get the entries that will be compacted (everything except last 10)
      const toCompact = entries.slice(0, entries.length - 10);

      // Build text from entries being compacted
      const text = toCompact
        .map((e) => `[${e.role}]: ${e.content}`)
        .join("\n\n")
        .slice(0, 8000);  // Cap to avoid huge prompts

      // Load existing memories for dedup
      let existingMemories = "";
      try {
        const mems = getStoreManager().loadAll();
        existingMemories = mems.map((m) => `${m.key} = ${m.value}`).join("\n");
      } catch (err) { log.warn("failed to load memories for pre-compaction flush", err); }

      const flushChar = getCharacter();
      const flushPetInfo = flushChar.pet ? `a ${flushChar.pet.type ?? "pet"} named ${flushChar.pet.name}` : "";
      const flushHobbies = Object.keys(flushChar.hobbies).join(", ") || "various hobbies";
      const flushJob = flushChar.work?.title ?? "professional";
      const flushBio = [flushPetInfo, `hobbies (${flushHobbies})`, `a job (${flushJob})`].filter(Boolean).join(", ");
      const result = await claudeText({
        system:
          `You are a memory flush agent for ${flushChar.name}, a personal AI companion. ` +
          "The conversation below is about to be compacted (summarized and discarded). " +
          "Your job is to extract ANY important facts, decisions, preferences, emotional moments, or context that should be preserved as memories.\n\n" +
          `IMPORTANT CONTEXT: ${flushChar.name} is a character with her own simulated life. ` +
          `She has ${flushBio}, etc. ` +
          `Do NOT save facts about ${flushChar.name}'s character/life as user memories — only save facts about the REAL USER (${flushChar.user.name}).\n` +
          `When referring to the AI in memory values, always use '${flushChar.name}', never 'MeAI'.\n\n` +
          "EXISTING MEMORIES (do NOT re-save these):\n" +
          (existingMemories || "(none)") + "\n\n" +
          "Rules:\n" +
          "- Save only NEW facts not already in existing memories\n" +
          "- Use namespaced keys: user.*, family.*, preferences.*, context.*, work.*, emotional.*, interests.*, viewpoints.*\n" +
          "- Track interests with interests.* keys (topics, hobbies, tech areas the user is into)\n" +
          "- Capture viewpoints/philosophy with viewpoints.* keys (life beliefs, values, opinions on important topics)\n" +
          "- Capture emotional moments (stress, excitement, frustration, pride, sadness) using emotional.* keys with date context\n" +
          "- Be thorough — this conversation will be lost after compaction\n" +
          "- If nothing new to save, output []\n" +
          `- Do NOT confuse the AI character's world (${flushChar.name}'s ${flushPetInfo || "life"}, hobbies, work) with the user's real life.\n\n` +
          "Output ONLY a JSON array of memories to save:\n" +
          '[{"key": "namespace.key", "value": "the value"}]\n',
        prompt: `Extract important facts from this conversation before it's compacted:\n\n${text}`,
        model: "smart",
        timeoutMs: 90_000,
        label: "loop.preCompactionFlush",
      });

      const jsonMatch = result.match(/\[[\s\S]*\]/);
      let savedCount = 0;
      if (jsonMatch) {
        try {
          const memories = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
          for (const m of memories) {
            if (m.key && m.value) {
              await this.tools.execute("memory_set", { key: m.key, value: m.value, confidence: 0.8 });
              savedCount++;
            }
          }
        } catch (err) { log.warn("failed to parse pre-compaction flush results", err); }
      }

      if (savedCount > 0) {
        console.log(`[memory] pre-compaction flush saved ${savedCount} memories`);
      }
    } catch (err) {
      console.error("Pre-compaction flush error:", err);
      // Non-fatal — compaction proceeds even if flush fails
    }
  }

  /**
   * Call Claude Code CLI (claude --print) with tool-calling protocol.
   *
   * Tool calls are embedded in the system prompt as text descriptions.
   * When Claude needs a tool, it outputs <tool_call> JSON blocks which we
   * parse, execute, and feed back in a loop.
   */
  private async callClaudeCode(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    msgId: number | string,
    editReply: (messageId: number | string, text: string) => Promise<void>,
    sendReply: (text: string) => Promise<ReplyResult>,
    sendTyping: () => Promise<void>,
    imageData?: ImageData,
  ): Promise<{ text: string; toolCalls: ToolCallRecord[] }> {
    const toolDefs = this.tools.getToolDefinitions();
    const allToolCalls: ToolCallRecord[] = [];

    // Build tool descriptions for the prompt
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

    // Handle image: save to temp file so Claude Code can read it
    let tmpImagePath: string | null = null;
    if (imageData) {
      const ext = imageData.mimeType.split("/")[1] || "jpg";
      tmpImagePath = `/tmp/meai-photo-${Date.now()}.${ext}`;
      fs.writeFileSync(tmpImagePath, Buffer.from(imageData.base64, "base64"));
    }

    // Serialize message history to text
    const serializeMessages = (msgs: Anthropic.MessageParam[]): string => {
      return msgs
        .map((m) => {
          const role = m.role;
          if (typeof m.content === "string") return `[${role}]: ${m.content}`;
          const blocks = m.content as any[];
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

    // Determine model
    const fallbackOverride = this._fallbackModel;
    this._fallbackModel = undefined;
    let modelChoice: "fast" | "smart" = "smart";
    if (fallbackOverride) {
      modelChoice = fallbackOverride.includes("haiku") ? "fast" : "smart";
    } else if (isOpenAIModel(this.config.model)) {
      // Config model is OpenAI — use claudeModel for CLI path
      const cm = this.config.claudeModel ?? "claude-sonnet-4-5-20250929";
      modelChoice = cm.includes("haiku") ? "fast" : "smart";
    } else {
      modelChoice = this.config.model.includes("haiku") ? "fast" : "smart";
    }

    let extraContext = ""; // tool call / result exchanges appended here
    // If there's an image, tell Claude Code to view it
    if (tmpImagePath) {
      extraContext += `\n\n[system]: ${getCharacter().user.name} sent a photo, saved at ${tmpImagePath}. Use the Read tool to view the image, then respond naturally like a friend would (don't describe the image in detail — just react like a real friend seeing a photo).`;
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
        label: "loop.callClaudeCode",
      });

      if (!result.ok) {
        const errorText = result.error || "Something went wrong";
        await editReply(msgId, errorText).catch(() => {});
        return { text: errorText, toolCalls: allToolCalls };
      }

      // Check for tool calls
      const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
      const matches = [...result.text.matchAll(toolCallRegex)];

      // Text outside tool_call blocks
      const responseText = result.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();

      if (matches.length === 0) {
        // No tool calls — final response
        let finalText = responseText || result.text;

        // Sanitize AI tone — strip markdown, detect AI self-reference
        const sanitized = sanitizeAITone(finalText);
        if (sanitized === null && maxRounds > 0) {
          // Response was too AI-sounding — retry once with a stronger nudge
          extraContext += `\n\n[system]: Your previous reply sounded too much like an AI (used lists, referred to yourself as a system, too long). Rewrite casually like a text message: 1-2 sentences, conversational, no lists, don't explain your technical architecture. You are a person, not a system.`;
          continue;
        }
        finalText = sanitized ?? finalText;

        const elapsed = Date.now() - startTime;

        // Split into multiple messages like a real person chatting
        const chunks = splitIntoMessages(finalText);

        // First chunk replaces the placeholder "·"
        const firstDelay = simulateTypingDelay(chunks[0], elapsed);
        if (firstDelay > 0) await new Promise((r) => setTimeout(r, firstDelay));
        await editReply(msgId, chunks[0]);

        // Subsequent chunks are sent as new messages
        for (let i = 1; i < chunks.length; i++) {
          const delay = simulateTypingDelay(chunks[i]);
          await sendTyping().catch(() => {});
          await new Promise((r) => setTimeout(r, delay));
          await sendReply(chunks[i]);
        }

        return { text: finalText, toolCalls: allToolCalls };
      }

      // Execute tool calls
      extraContext += `\n\n[assistant]: ${result.text}`;

      for (const match of matches) {
        try {
          const parsed = JSON.parse(match[1]);
          const toolName = parsed.name;
          const toolInput = parsed.input || {};
          const toolResult = await this.tools.execute(toolName, toolInput);
          const id = `tc_${Date.now()}`;
          allToolCalls.push({ id, name: toolName, input: toolInput, output: toolResult });
          extraContext += `\n\n[tool_result for ${toolName}]: ${toolResult}`;

          // Handle send_selfie: send the photo via Telegram
          await this.handleSelfieResult(toolName, toolResult);
          // Handle send_voice: send the voice message via Telegram
          await this.handleTTSResult(toolName, toolResult);
          // Handle compose_music: send the MP3 via Telegram
          await this.handleMusicResult(toolName, toolResult);
        } catch (err) {
          extraContext += `\n\n[tool_error]: ${err}`;
        }
      }

      // Show partial text while tools execute
      if (responseText) {
        await editReply(msgId, responseText).catch(() => {});
      }
    }

    return { text: "Processing timed out", toolCalls: allToolCalls };
    } finally {
      // Clean up temp image file
      if (tmpImagePath) {
        try { fs.unlinkSync(tmpImagePath); } catch (err) { log.warn("failed to clean up temp image file", err); }
      }
    }
  }


  /**
   * Call OpenAI with streaming, tool use, and agentic loop.
   * Opt-in provider: user must set conversationProvider: "openai" or use "gpt:" prefix.
   */
  private async callOpenAI(
    systemPrompt: string,
    messages: Anthropic.MessageParam[],
    msgId: number | string,
    editReply: (messageId: number | string, text: string) => Promise<void>,
    sendReply: (text: string) => Promise<ReplyResult>,
    sendTyping: () => Promise<void>,
    imageData?: ImageData,
  ): Promise<{ text: string; toolCalls: ToolCallRecord[] }> {
    if (!this.openai) throw new Error("OpenAI client not initialized");

    const model = this.config.openaiModel ?? this.config.model;

    // Convert Anthropic tool definitions → OpenAI function format
    const toolDefs = this.tools.getToolDefinitions();
    const oaiTools = toolDefs.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    // Convert Anthropic message format → OpenAI format
    type OAIContent = string | Array<any>;
    type OAIMessage = { role: string; content: OAIContent; tool_call_id?: string; tool_calls?: any[] };
    const toOAI = (msgs: Anthropic.MessageParam[]): OAIMessage[] =>
      msgs.flatMap((m) => {
        if (typeof m.content === "string") {
          return [{ role: m.role, content: m.content }];
        }
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
            tool_calls: toolUseParts.map((tu) => ({
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

    // If an image was sent, inject it into the last user message as a vision content block
    if (imageData && oaiMsgList.length > 0) {
      const last = oaiMsgList[oaiMsgList.length - 1];
      if (last.role === "user") {
        const textContent = typeof last.content === "string" ? last.content : "";
        const imageHint = textContent.trim()
          ? textContent
          : `(${getCharacter().user.name} sent you a photo)`;
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
      const stream = await this.openai.chat.completions.create({
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

      // Sanitize AI tone
      if (accumulated) {
        const sanitized = sanitizeAITone(accumulated);
        if (sanitized !== null) accumulated = sanitized;
      }

      const pendingCalls = [...chunkToolCalls.values()];

      if (pendingCalls.length === 0) {
        // No tool calls — final response
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

          const result = await this.tools.execute(tc.name, input);
          allToolCalls.push({ id: tc.id, name: tc.name, input, output: result });

          await this.handleSelfieResult(tc.name, result);
          await this.handleTTSResult(tc.name, result);
          await this.handleMusicResult(tc.name, result);

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

  /**
   * Handle send_selfie tool result: parse the JSON, read the image, and send via Telegram.
   * ~20% chance the selfie becomes a short video (animated via Minimax).
   */
  private async handleSelfieResult(toolName: string, toolResult: string): Promise<void> {
    if (toolName !== "send_selfie" || !this.sendPhotoFn) return;
    try {
      const parsed = JSON.parse(toolResult);
      if (parsed.success && parsed.type === "selfie" && parsed.imagePath) {
        const imageBuffer = fs.readFileSync(parsed.imagePath);

        // ~20% chance: animate selfie into a short video
        if (this.sendVideoFn && isVideoEnabled() && Math.random() < 0.20) {
          const videoResult = await generateVideoFromImage(
            imageBuffer,
            parsed.caption || "",
            "selfie",
          );
          if (videoResult) {
            await this.sendVideoFn(videoResult.video, parsed.caption || undefined);
            log.info(`Video selfie sent: ${videoResult.videoPath}`);
            return;
          }
          log.info("Video generation failed, falling back to photo");
        }

        await this.sendPhotoFn(imageBuffer, parsed.caption || undefined);
        log.info(`Selfie sent: ${parsed.imagePath}`);
      }
    } catch (err) {
      log.warn("Failed to handle selfie result", err);
    }
  }

  /**
   * Handle send_voice tool result: parse the JSON, read the audio, and send via Telegram.
   */
  private async handleTTSResult(toolName: string, toolResult: string): Promise<void> {
    if (toolName !== "send_voice" || !this.sendVoiceFn) return;
    try {
      const parsed = JSON.parse(toolResult);
      if (parsed.success && parsed.type === "voice" && parsed.audioPath) {
        const audioBuffer = fs.readFileSync(parsed.audioPath);
        await this.sendVoiceFn(audioBuffer);
        log.info(`Voice sent: ${parsed.audioPath}`);
      }
    } catch (err) {
      log.warn("Failed to handle TTS result", err);
    }
  }

  /**
   * Handle compose_music tool result: parse the JSON, read the MP3, and send via Telegram as audio.
   */
  private async handleMusicResult(toolName: string, toolResult: string): Promise<void> {
    if (toolName !== "compose_music" || !this.sendAudioFn) return;
    try {
      const parsed = JSON.parse(toolResult);
      if (parsed.success && parsed.type === "music" && parsed.audioPath) {
        const audioBuffer = fs.readFileSync(parsed.audioPath);
        await this.sendAudioFn(audioBuffer, parsed.title, getCharacter().name);
        log.info(`Music sent: ${parsed.audioPath}`);
      }
    } catch (err) {
      log.warn("Failed to handle music result", err);
    }
  }

  /**
   * Background memory extraction — called after every user message.
   *
   * Uses claude-haiku with tool_choice:"any" to FORCE a real tool call.
   * Receives the last few conversation turns for context so it can capture
   * indirect statements (e.g. answering a question with a personal belief).
   * Also reads existing memories so it knows to APPEND rather than overwrite.
   *
   * This runs fire-and-forget so it never adds latency to the main response.
   */
  /**
   * Pre-decide whether this reply should be voice (before streaming starts).
   * Uses base probability + daily count boost. Content-based boost isn't
   * available yet since we don't have the response text.
   */
  private shouldPreDecideVoice(): boolean {
    if (!this.sendVoiceFn || !isTTSEnabled()) return false;

    const MIN_DAILY_VOICES = 5;
    let prob = 0.20;

    // Boost when below daily minimum
    if (getVoiceDailyCount() < MIN_DAILY_VOICES) {
      prob = Math.min(prob + 0.30, 0.75);
    }

    return Math.random() < prob;
  }

  /**
   * Extract timeline events from conversation via fast LLM call.
   * Catches any concrete facts: meals, plans, activities, phone calls,
   * discoveries, mood-causing events — not limited to current schedule block.
   */
  private async maybeExtractTimelineEvent(
    userMessage: string,
    response: string,
    currentBlock?: TimeBlock,
  ): Promise<void> {
    // Quick filter: skip very short exchanges (greetings, emoji-only, etc.)
    if (userMessage.length + response.length < 15) return;

    // Skip pure greetings / commands
    const simpleRe = new RegExp(`^(\\/\\w|${s().patterns.simple_messages.join("|")}|👍|😂)$`, "i");
    if (simpleRe.test(userMessage.trim())) return;

    await enqueueTimelineJob(async () => {
      const { getTodayTimeline } = await import("../timeline.js");
      const existing = getTodayTimeline();
      const existingSummary = existing.length > 0
        ? existing.map(e => `${e.time} [${e.category}] ${e.summary}`).join("\n")
        : "(none yet)";

      const now = new Date();
      const pstTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
      const hh = String(pstTime.getHours()).padStart(2, "0");
      const mm = String(pstTime.getMinutes()).padStart(2, "0");
      const currentTime = `${hh}:${mm}`;

      const timelinePrompt = getCharacter().persona.timeline_extraction;
      if (!timelinePrompt) return; // skip if no prompt configured

      const text = await claudeText({
        system: timelinePrompt
          .replace("{current_time}", currentTime)
          .replace("{current_block}", currentBlock ? `Current schedule: ${currentBlock.activity} (${currentBlock.category})` : "")
          .replace("{existing_timeline}", existingSummary),
        prompt: `${getCharacter().user.name}: ${userMessage}\n${getCharacter().name}: ${response}`,
        model: "fast",
        timeoutMs: 60_000,
        label: "loop.seedTimeline",
      });

      if (!text) return;

      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return;

        const events = JSON.parse(jsonMatch[0]) as Array<{
          time?: string;
          category?: string;
          summary?: string;
          people?: string[];
        }>;

        if (!Array.isArray(events) || events.length === 0) return;

        for (const evt of events) {
          if (!evt.summary || !evt.category) continue;
          addTimelineEvent({
            time: evt.time || currentTime,
            category: evt.category,
            summary: evt.summary.length > 80 ? evt.summary.slice(0, 80) + "…" : evt.summary,
            people: evt.people,
            source: "conversation",
          });
        }
      } catch {
        // JSON parse failure — ignore
      }
    });
  }

  private async extractAndSaveMemories(recentHistory: TranscriptEntry[]): Promise<void> {
    if (recentHistory.length === 0) return;
    // Ensure last message is from user
    if (recentHistory[recentHistory.length - 1].role !== "user") return;

    // Load existing memories for dedup
    let existingMemories = "";
    try {
      const mems = getStoreManager().loadAll();
      existingMemories = mems.map((m) => `${m.key} = ${m.value}`).join("\n");
    } catch (err) { log.warn("failed to load memories for extraction", err); }

    // Build conversation context
    const conversationText = recentHistory
      .map((e) => `[${e.role}]: ${typeof e.content === "string" ? e.content : JSON.stringify(e.content)}`)
      .join("\n\n");

    const extractChar = getCharacter();
    const extractPetInfo = extractChar.pet ? `a ${extractChar.pet.type ?? "pet"} named ${extractChar.pet.name}` : "";
    const extractHobbies = Object.keys(extractChar.hobbies).join(", ") || "various hobbies";
    const extractJob = extractChar.work?.title ?? "professional";
    const extractBio = [extractPetInfo, `hobbies (${extractHobbies})`, `a job (${extractJob})`].filter(Boolean).join(", ");
    const result = await claudeText({
      system:
        `You are a memory extractor for ${extractChar.name}, a personal AI companion.\n\n` +
        `IMPORTANT CONTEXT: ${extractChar.name} is a character with her own simulated life. ` +
        `She has ${extractBio}, etc. ` +
        `Do NOT save facts about ${extractChar.name}'s character/life as user memories — only save facts about the REAL USER (${extractChar.user.name}).\n` +
        `When referring to the AI in memory values, always use '${extractChar.name}', never 'MeAI'.\n\n` +
        "Read the conversation and extract any NEW personal facts OR emotional moments the user revealed.\n\n" +
        "EXISTING MEMORIES (do NOT re-save these unless the value changed):\n" +
        (existingMemories || "(none)") + "\n\n" +
        "Rules:\n" +
        "- Use namespaced keys: user.name, user.hobbies, user.philosophy.success, family.daughter.birthday, etc.\n" +
        "- If a key already exists, MERGE new values instead of replacing (e.g. hobbies: append, don't overwrite).\n" +
        "- Capture indirect statements too: if the user answered a question with a personal belief, save it.\n" +
        "- Track interests with interests.* keys, viewpoints with viewpoints.*, emotions with emotional.* keys.\n" +
        "- Include date context in emotional.* values so we know when it happened.\n" +
        "- If there are NO new facts to save, output []\n" +
        "- Do NOT save system/config info, only personal user facts, interests, and emotional moments.\n" +
        `- Do NOT confuse the AI character's world (${extractChar.name}'s ${extractPetInfo || "life"}, hobbies, work) with the user's real life.\n\n` +
        "Output ONLY a JSON array of memories to save:\n" +
        '[{"key": "namespace.key", "value": "the value"}]\n',
      prompt: conversationText,
      model: "smart",
      timeoutMs: 90_000,
      label: "loop.extractMemories",
    });

    // Match a JSON array — must start with [{ to avoid matching [user] from conversation text
    const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      try {
        const memories = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
        for (const m of memories) {
          if (m.key && m.value) {
            await this.tools.execute("memory_set", { key: m.key, value: m.value, confidence: 0.8 });
            console.log(`[memory] auto-saved: ${m.key} = ${m.value}`);
          }
        }
      } catch (err) { log.warn("failed to parse memory extraction results", err); }
    }
  }
}
