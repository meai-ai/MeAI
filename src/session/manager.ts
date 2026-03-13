/**
 * Session manager — JSONL transcript read/write with indexed archiving.
 *
 * Stores conversation turns as newline-delimited JSON in main.jsonl.
 * Supports loading recent turns within a token budget (rough estimate).
 *
 * Before compaction destroys detail, the full transcript is archived as a
 * named session with an LLM-generated slug, title, topics, and summary.
 * This preserves full conversation history while keeping the active
 * context window manageable.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "../claude-runner.js";
import type { TranscriptEntry, AppConfig } from "../types.js";
import { SessionIndexManager } from "./index.js";

const JSONL_FILE = "main.jsonl";
const ROLLING_SUMMARY_FILE = "rolling-summary.json";

/** Persisted rolling summary that bridges older conversation into the sliding window. */
interface RollingSummary {
  /** The summary text covering older messages */
  text: string;
  /** Timestamp of the last message covered by this summary */
  coveredUpTo: number;
  /** Number of messages summarized so far */
  messagesCovered: number;
  /** Turn counter — triggers refresh every N turns */
  turnsSinceRefresh: number;
}

// Rough token estimate: 1 token ≈ 4 characters
const CHARS_PER_TOKEN = 4;

// Keep this many recent entries uncompacted
const KEEP_RECENT = 10;

/** Callback to report token usage from compaction API calls. */
export type UsageCallback = (model: string, source: string, usage: {
  input_tokens: number;
  output_tokens: number;
}) => void;

// Minimum entries before archiving makes sense (avoid tiny sessions)
const MIN_ARCHIVE_ENTRIES = 6;

export class SessionManager {
  private filePath: string;
  private config: AppConfig;
  onUsage: UsageCallback | null = null;
  private sessionIndex: SessionIndexManager;

  constructor(config: AppConfig) {
    this.config = config;
    this.filePath = path.join(config.statePath, "sessions", JSONL_FILE);
    this.sessionIndex = new SessionIndexManager(config);
  }

  /**
   * Get the session index manager (for slash commands and context assembly).
   */
  getIndex(): SessionIndexManager {
    return this.sessionIndex;
  }

  /**
   * Append a transcript entry to the JSONL file.
   */
  append(entry: TranscriptEntry): void {
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.filePath, line, "utf-8");
  }

  /**
   * Load recent transcript entries, staying within a token budget.
   * Returns entries in chronological order (oldest first).
   */
  loadRecent(maxTokens: number): TranscriptEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const entries: TranscriptEntry[] = [];
    let totalChars = 0;
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    // Walk backwards from most recent
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const charCount = line.length;

      if (totalChars + charCount > maxChars && entries.length > 0) {
        break;
      }

      try {
        const entry: TranscriptEntry = JSON.parse(line);
        entries.unshift(entry); // prepend to keep chronological order
        totalChars += charCount;
      } catch {
        console.warn(`Skipping malformed JSONL line ${i}`);
      }
    }

    return entries;
  }

  /**
   * Get all entries (for compaction).
   */
  loadAll(): TranscriptEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is TranscriptEntry => e !== null);
  }

  /**
   * Rewrite the entire session file (used after compaction).
   */
  rewrite(entries: TranscriptEntry[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(this.filePath, content, "utf-8");
  }

  /**
   * Estimate total token usage of the transcript.
   */
  estimateTokens(): number {
    if (!fs.existsSync(this.filePath)) return 0;
    const size = fs.statSync(this.filePath).size;
    return Math.ceil(size / CHARS_PER_TOKEN);
  }

  /**
   * Check if compaction is needed (context > threshold).
   */
  needsCompaction(): boolean {
    const estimated = this.estimateTokens();
    return estimated > this.config.maxContextTokens * this.config.compactionThreshold;
  }

  /**
   * Compact the transcript by summarizing old turns and keeping recent ones.
   *
   * IMPROVEMENT: Before compaction destroys detail, the old entries are
   * archived as a named session with LLM-generated slug and metadata.
   * The full transcript is preserved in the archive while the active
   * context is compacted down.
   */
  async compact(): Promise<void> {
    const entries = this.loadAll();
    if (entries.length <= KEEP_RECENT) return;

    const oldEntries = entries.slice(0, entries.length - KEEP_RECENT);
    const recentEntries = entries.slice(entries.length - KEEP_RECENT);

    // ── Archive before compacting ────────────────────────────────
    // Only archive if there are enough entries to form a meaningful session.
    // Skip entries that are themselves summaries from prior compaction rounds.
    const archivableEntries = oldEntries.filter(
      (e) => !e.content.startsWith("[Previous conversation summary]:"),
    );

    if (archivableEntries.length >= MIN_ARCHIVE_ENTRIES) {
      try {
        const meta = await this.sessionIndex.archive(archivableEntries);
        console.log(`Archived session before compaction: ${meta.id}`);
      } catch (err) {
        console.error("Session archiving failed (compaction continues):", err);
      }
    }

    // ── Summarize and compact ────────────────────────────────────
    const oldText = oldEntries
      .map((e) => `[${e.role}]: ${e.content}`)
      .join("\n\n");

    try {
      const summary = await claudeText({
        label: "session.compact",
        system:
          "You are a conversation summarizer. Summarize the following conversation transcript " +
          "into a concise summary, preserving key facts, decisions, and context that would be " +
          "important for continuing the conversation. Be factual and brief.",
        prompt: `Summarize this conversation:\n\n${oldText}`,
        model: "smart",
        timeoutMs: 90_000,
      });

      // Create summary entry
      const summaryEntry: TranscriptEntry = {
        role: "assistant",
        content: `[Previous conversation summary]: ${summary}`,
        timestamp: Date.now(),
      };

      // Rewrite with summary + recent entries
      this.rewrite([summaryEntry, ...recentEntries]);
      console.log(
        `Compacted transcript: ${entries.length} entries → ${recentEntries.length + 1} entries`,
      );
    } catch (err) {
      console.error("Compaction failed:", err);
      // Don't rewrite if summarization fails
    }
  }

  /**
   * Start a new session — archive the current transcript and clear it.
   * Returns the archived session metadata, or null if nothing to archive.
   */
  async startNewSession(): Promise<{ slug: string; title: string } | null> {
    const entries = this.loadAll();

    // Filter out prior summaries
    const realEntries = entries.filter(
      (e) => !e.content.startsWith("[Previous conversation summary]:"),
    );

    if (realEntries.length < MIN_ARCHIVE_ENTRIES) {
      // Not enough content to archive; just clear the file
      if (fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "", "utf-8");
      }
      return null;
    }

    try {
      const meta = await this.sessionIndex.archive(realEntries);
      // Clear the active session
      fs.writeFileSync(this.filePath, "", "utf-8");
      return { slug: meta.slug, title: meta.title };
    } catch (err) {
      console.error("Failed to archive session:", err);
      // Clear anyway so the user gets a fresh start
      fs.writeFileSync(this.filePath, "", "utf-8");
      return null;
    }
  }

  // ── Rolling summary support ───────────────────────────────────────

  private get rollingSummaryPath(): string {
    return path.join(this.config.statePath, "sessions", ROLLING_SUMMARY_FILE);
  }

  /** Load the persisted rolling summary, or null if none exists. */
  private loadRollingSummary(): RollingSummary | null {
    if (!fs.existsSync(this.rollingSummaryPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.rollingSummaryPath, "utf-8")) as RollingSummary;
    } catch {
      return null;
    }
  }

  /** Save the rolling summary to disk. */
  private saveRollingSummary(summary: RollingSummary): void {
    fs.writeFileSync(this.rollingSummaryPath, JSON.stringify(summary, null, 2), "utf-8");
  }

  /**
   * Load a sliding window of recent messages, capped by both token budget
   * and message count. Prepends the rolling summary as a system-like entry
   * if one exists.
   */
  loadWindowed(
    maxRecentTokens: number,
    maxMessages: number,
  ): { messages: TranscriptEntry[] } {
    if (!fs.existsSync(this.filePath)) {
      return { messages: [] };
    }

    const raw = fs.readFileSync(this.filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const entries: TranscriptEntry[] = [];
    let totalChars = 0;
    const maxChars = maxRecentTokens * CHARS_PER_TOKEN;

    // Walk backwards, collecting up to maxMessages within token budget
    for (let i = lines.length - 1; i >= 0 && entries.length < maxMessages; i--) {
      const line = lines[i];
      if (totalChars + line.length > maxChars && entries.length > 0) break;
      try {
        const entry: TranscriptEntry = JSON.parse(line);
        entries.unshift(entry);
        totalChars += line.length;
      } catch {
        console.warn(`Skipping malformed JSONL line ${i}`);
      }
    }

    // Prepend rolling summary if available
    const summary = this.loadRollingSummary();
    if (summary?.text) {
      const summaryEntry: TranscriptEntry = {
        role: "assistant",
        content: `[conversation summary]: ${summary.text}`,
        timestamp: summary.coveredUpTo,
      };
      entries.unshift(summaryEntry);
    }

    return { messages: entries };
  }

  /**
   * Summarize messages between the rolling summary coverage and the current
   * sliding window, updating the rolling summary.
   */
  async refreshSummary(): Promise<void> {
    const all = this.loadAll();
    if (all.length === 0) return;

    const summary = this.loadRollingSummary();
    const coveredUpTo = summary?.coveredUpTo ?? 0;

    // Find gap messages: those after the summary but before the recent window
    // We summarize everything except the last KEEP_RECENT messages
    const gapEnd = Math.max(0, all.length - KEEP_RECENT);
    const gapMessages = all.slice(0, gapEnd).filter(e => e.timestamp > coveredUpTo);

    if (gapMessages.length === 0) return;

    const gapText = gapMessages
      .map(e => `[${e.role}]: ${e.content}`)
      .join("\n\n");

    try {
      const existingSummary = summary?.text ?? "";
      const prompt = existingSummary
        ? `Previous summary:\n${existingSummary}\n\nNew conversation to incorporate:\n${gapText}`
        : `Summarize this conversation segment:\n\n${gapText}`;

      const newSummary = await claudeText({
        label: "session.rolling-summary",
        system:
          "Summarize this conversation segment concisely, preserving key facts, " +
          "decisions, and context. If a previous summary is provided, merge the new " +
          "information into a unified summary. Be factual and brief.",
        prompt,
        model: "smart",
        timeoutMs: 90_000,
      });

      if (!newSummary || newSummary.trim() === "") {
        console.warn("[session] Rolling summary returned empty, skipping update");
        return;
      }

      const lastGapMsg = gapMessages[gapMessages.length - 1];
      this.saveRollingSummary({
        text: newSummary,
        coveredUpTo: lastGapMsg.timestamp,
        messagesCovered: (summary?.messagesCovered ?? 0) + gapMessages.length,
        turnsSinceRefresh: 0,
      });

      console.log(`[session] Rolling summary updated, covering ${(summary?.messagesCovered ?? 0) + gapMessages.length} messages`);
    } catch (err) {
      console.error("[session] Rolling summary refresh failed:", err);
      // Append a note that some conversation could not be summarized
      if (summary) {
        this.saveRollingSummary({
          ...summary,
          text: summary.text + "\n(partial conversation could not be summarized)",
          turnsSinceRefresh: 0,
        });
      }
    }
  }

  /**
   * Increment the turn counter and trigger a rolling summary refresh
   * every 30 turns.
   */
  async incrementTurnCounter(): Promise<void> {
    const summary = this.loadRollingSummary() ?? {
      text: "",
      coveredUpTo: 0,
      messagesCovered: 0,
      turnsSinceRefresh: 0,
    };

    summary.turnsSinceRefresh += 1;

    if (summary.turnsSinceRefresh >= 30) {
      await this.refreshSummary();
    } else {
      this.saveRollingSummary(summary);
    }
  }

  /**
   * Get the JSONL file path.
   */
  getPath(): string {
    return this.filePath;
  }
}
