/**
 * Shared TypeScript types for MeAI.
 */

// ── Config ──────────────────────────────────────────────────────────

export interface AppConfig {
  telegramBotToken: string;
  allowedChatId: number;
  anthropicApiKey: string;
  openaiApiKey?: string;       // optional — enables GPT routing
  model: string;               // default model string
  openaiModel?: string;        // OpenAI model for GPT path (default: gpt-4o)
  claudeModel?: string;        // Claude model for complex/coding path (default: claude-sonnet)
  /**
   * Which provider handles real-time conversation: "anthropic" or "openai".
   * Background tasks (emotion, memory, curiosity) always use Claude Haiku.
   * Default: determined by model field — openai if model starts with "gpt-"
   */
  conversationProvider?: "anthropic" | "openai";
  maxContextTokens: number;
  compactionThreshold: number;
  statePath: string; // resolved absolute path to data dir (default: <project>/data)
  /** X (Twitter) API credentials — optional, enables social posting + timeline reading */
  xApiKey?: string;
  xApiKeySecret?: string;
  xAccessToken?: string;
  xAccessTokenSecret?: string;
  /** fal.ai API key — optional, enables selfie/sticker generation */
  falApiKey?: string;
  /** Fish Audio TTS — optional, enables voice messages */
  fishAudioApiKey?: string;
  fishAudioVoiceId?: string;
  /** Tavily Search API — optional, enables high-quality web search (falls back to DuckDuckGo) */
  tavilyApiKey?: string;
  /** Suno API — optional, enables music composition */
  sunoApiKey?: string;
  /** Telegram channel ID for moments timeline — optional */
  momentsChannelId?: string;
  /** Channel type — "telegram" (default), "discord", etc. */
  channel?: string;
  /** LLM provider configuration — maps roles to provider IDs */
  llm?: {
    conversation?: string;
    background?: string;
    embedding?: string;
    vision?: string;
  };
  /** MAIP Protocol — optional, enables federated AI agent networking */
  maip?: {
    enabled: boolean;
    port: number;
    publicUrl: string;
    guardianDid?: string;
    guardianEndpoint?: string;
    autonomyLevel?: number;
    registryUrls?: string[];
    interests?: string[];
    dailyInteractionCap?: number;
    quietPeriod?: [number, number];
  };
}

// ── Memory (Tier 1) ────────────────────────────────────────────────

export interface Memory {
  key: string;
  value: string;
  timestamp: number;
  confidence: number;
}

export interface MemoryStore {
  memories: Memory[];
}

// ── Skills (Tier 2) ────────────────────────────────────────────────

export interface Skill {
  name: string;
  content: string; // SKILL.md body
  hasTools: boolean; // whether skills/<name>/tools.ts exists
}

// ── Skill Routing (Progressive Loading) ─────────────────────────────

/**
 * Compact metadata for the always-present skill directory.
 * The model sees this for ALL skills so it knows what's available,
 * even when a skill's full SKILL.md isn't injected.
 */
export interface SkillDirectoryEntry {
  name: string;
  oneLiner: string; // ≤80 chars, extracted from SKILL.md
  hasTools: boolean;
}

// ── Session / Transcript ───────────────────────────────────────────

export type Role = "user" | "assistant";

export interface TranscriptEntry {
  role: Role;
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
}

// ── Session Index ─────────────────────────────────────────────────

export interface SessionMeta {
  id: string;            // unique ID: YYYYMMDD-HHMMSS-slug
  slug: string;          // LLM-generated: "debugging-react-hooks"
  title: string;         // LLM-generated: "Debugging React Hooks Performance Issues"
  topics: string[];      // LLM-generated: ["react", "hooks", "performance"]
  summary: string;       // LLM-generated summary of the conversation
  createdAt: number;     // timestamp of first message
  updatedAt: number;     // timestamp of last message
  messageCount: number;  // number of transcript entries
  tokenEstimate: number; // approximate token count
}

export interface SessionIndex {
  sessions: SessionMeta[];
  activeSessionId: string; // ID of the current active session file
}

// ── Tool System ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ── Evolution Events ───────────────────────────────────────────────

export type EvolutionTier = 1 | 2 | 3 | 4;

export interface EvolutionEvent {
  tier: EvolutionTier;
  action: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

// ── Tier 3: Tool Proposal ──────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "denied";

export interface ToolProposal {
  name: string;
  description: string;
  code: string;
  status: ProposalStatus;
  timestamp: number;
}

// ── Tier 4: Code Patch Proposal ────────────────────────────────────

export interface PatchFile {
  path: string;
  content: string;
}

export interface PatchProposal {
  id: string;
  files: PatchFile[];
  reason: string;
  testCommand?: string;
  status: ProposalStatus;
  timestamp: number;
  snapshotPath?: string;
}
