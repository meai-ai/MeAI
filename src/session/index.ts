/**
 * Session index — manages metadata for archived conversation sessions.
 *
 * Each session gets an LLM-generated slug, title, topics, and summary.
 * The index is stored as a JSON file and supports searching past conversations.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionMeta, SessionIndex, TranscriptEntry, AppConfig } from "../types.js";
import { claudeText } from "../claude-runner.js";
import { getUserTZ } from "../lib/pst-date.js";

const INDEX_FILE = "index.json";

/**
 * Generate a date-based prefix for session IDs.
 */
function datePrefix(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class SessionIndexManager {
  private indexPath: string;
  private archiveDir: string;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.indexPath = path.join(config.statePath, "sessions", INDEX_FILE);
    this.archiveDir = path.join(config.statePath, "sessions", "archive");
  }

  /**
   * Load the session index from disk.
   */
  load(): SessionIndex {
    if (!fs.existsSync(this.indexPath)) {
      return { sessions: [], activeSessionId: "main" };
    }
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
    } catch {
      return { sessions: [], activeSessionId: "main" };
    }
  }

  /**
   * Save the session index to disk.
   */
  save(index: SessionIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  }

  /**
   * Generate an LLM slug, title, topics, and summary for a set of transcript entries.
   */
  async generateSessionMeta(entries: TranscriptEntry[]): Promise<{
    slug: string;
    title: string;
    topics: string[];
    summary: string;
  }> {
    // Build a condensed version of the conversation for the LLM
    const condensed = entries
      .map((e) => {
        const text = e.content.length > 300 ? e.content.slice(0, 300) + "…" : e.content;
        return `[${e.role}]: ${text}`;
      })
      .join("\n");

    // Limit total input to avoid excessive token usage
    const input = condensed.length > 8000 ? condensed.slice(0, 8000) + "\n…(truncated)" : condensed;

    try {
      const raw = await claudeText({
        system:
          "You generate metadata for conversation archives. " +
          "Respond with ONLY valid JSON, no markdown fences, no explanation.",
        prompt:
          "Analyze this conversation and generate metadata.\n\n" +
          "Return JSON with these fields:\n" +
          '- "slug": a short URL-friendly identifier (2-5 words, lowercase, hyphens, e.g. "debugging-react-hooks")\n' +
          '- "title": a descriptive title (5-10 words)\n' +
          '- "topics": array of 2-5 topic tags (lowercase single words)\n' +
          '- "summary": a 1-3 sentence summary preserving key facts, decisions, and outcomes\n\n' +
          `Conversation:\n${input}`,
        model: "smart",
        timeoutMs: 90_000,
      });
      // Strip markdown code fences if the model wrapped the JSON
      const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      const parsed = JSON.parse(text);

      return {
        slug: String(parsed.slug || "unnamed-session").replace(/[^a-z0-9-]/g, "").slice(0, 60),
        title: String(parsed.title || "Untitled Session"),
        topics: Array.isArray(parsed.topics)
          ? parsed.topics.map((t: unknown) => String(t).toLowerCase()).slice(0, 5)
          : [],
        summary: String(parsed.summary || ""),
      };
    } catch (err) {
      console.error("Slug generation failed:", err);
      return {
        slug: "session-" + Date.now(),
        title: "Untitled Session",
        topics: [],
        summary: "",
      };
    }
  }

  /**
   * Archive a set of transcript entries as a named session.
   * Returns the created SessionMeta.
   */
  async archive(entries: TranscriptEntry[]): Promise<SessionMeta> {
    if (entries.length === 0) {
      throw new Error("Cannot archive empty session");
    }

    const meta = await this.generateSessionMeta(entries);

    const createdAt = entries[0].timestamp;
    const updatedAt = entries[entries.length - 1].timestamp;
    const id = `${datePrefix(createdAt)}-${meta.slug}`;

    // Write full transcript to archive
    const archivePath = path.join(this.archiveDir, `${id}.jsonl`);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(archivePath, content, "utf-8");

    // Estimate tokens
    const tokenEstimate = Math.ceil(content.length / 4);

    const sessionMeta: SessionMeta = {
      id,
      slug: meta.slug,
      title: meta.title,
      topics: meta.topics,
      summary: meta.summary,
      createdAt,
      updatedAt,
      messageCount: entries.length,
      tokenEstimate,
    };

    // Update index
    const index = this.load();
    index.sessions.push(sessionMeta);
    this.save(index);

    console.log(`Archived session: ${id} ("${meta.title}", ${entries.length} entries)`);
    return sessionMeta;
  }

  /**
   * Load a specific archived session's transcript by ID.
   */
  loadArchive(sessionId: string): TranscriptEntry[] {
    const archivePath = path.join(this.archiveDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(archivePath)) return [];

    return fs
      .readFileSync(archivePath, "utf-8")
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
   * Search sessions by query (matches against slug, title, topics, summary).
   */
  search(query: string): SessionMeta[] {
    const index = this.load();
    const q = query.toLowerCase();

    return index.sessions.filter((s) => {
      return (
        s.slug.includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.topics.some((t) => t.includes(q)) ||
        s.summary.toLowerCase().includes(q)
      );
    });
  }

  /**
   * List all sessions, most recent first.
   */
  listAll(): SessionMeta[] {
    const index = this.load();
    return [...index.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get a formatted summary of the session index for system prompt context.
   */
  getIndexSummary(limit = 10): string {
    const sessions = this.listAll().slice(0, limit);
    if (sessions.length === 0) return "";

    return sessions
      .map((s) => {
        const date = new Date(s.updatedAt).toLocaleDateString("en-US", { timeZone: getUserTZ() });
        return `- [${s.slug}] ${s.title} (${date}, ${s.messageCount} msgs) — ${s.summary.slice(0, 100)}`;
      })
      .join("\n");
  }
}
