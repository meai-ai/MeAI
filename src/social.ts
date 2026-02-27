/**
 * Social media engine — the character autonomously posts on X (Twitter).
 *
 * She decides what to post based on:
 * - Curiosity discoveries (things she learned today)
 * - Emotional state (mood-driven sharing)
 * - Work insights (market observations, analysis angles)
 * - Life moments (micro events, hobbies, cat photos descriptions)
 * - Reactions to trending topics or X timeline
 *
 * Posts are fully autonomous — no approval gate needed.
 * She decides when and whether to post based on context.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "./claude-runner.js";
import type { AppConfig, Memory } from "./types.js";
import { XClient, type Tweet, type PostTweetResult } from "./x-client.js";
import type { CuriosityEngine, Discovery } from "./curiosity.js";
import { s, renderTemplate, getCharacter } from "./character.js";
import { formatEmotionContext, getEmotionalState, type EmotionalState } from "./emotion.js";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { getStoreManager } from "./memory/store-manager.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("social");

// ── Constants ────────────────────────────────────────────────────────

const randMs = (minMin: number, maxMin: number) =>
  (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────

interface SocialState {
  lastPostedAt: number;
  dailyDate: string;
  dailyCount: number;
  /** Recent posts for continuity (don't repeat topics) */
  recentPosts: Array<{ text: string; tweetId: string; timestamp: number }>;
}

// ── Social Engine ────────────────────────────────────────────────────

export class SocialEngine {
  private config: AppConfig;
  private x: XClient;
  private curiosity: CuriosityEngine | null;
  private stopped = false;
  private xUserId: string | null = null;

  constructor(config: AppConfig, xClient: XClient, curiosity?: CuriosityEngine) {
    this.config = config;
    this.x = xClient;
    this.curiosity = curiosity ?? null;
  }

  /** Initialize X user identity (called once at startup). */
  async init(): Promise<void> {
    const me = await this.x.getMe();
    if (me) {
      this.xUserId = me.id;
      console.log(`[social] Logged in as @${me.username} (${me.name})`);
    } else {
      console.warn("[social] Could not look up X user — timeline features disabled");
    }
  }

  /** Legacy: start self-scheduling loop (not used when heartbeat is active). */
  async start(): Promise<void> {
    await this.init();

    console.log("[social] Started");
    setTimeout(() => this.loop(), randMs(10, 25));
  }

  stop(): void { this.stopped = true; }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const posted = await this.maybePost();
      // After posting: longer rest (2-6 hr); after skip: retry sooner (45-120 min)
      setTimeout(() => this.loop(), posted ? randMs(120, 360) : randMs(45, 120));
    } catch (e) {
      console.error("[social] Error:", e);
      setTimeout(() => this.loop(), randMs(20, 45));
    }
  }

  /**
   * Public entry point for the heartbeat.
   * Runs one posting cycle without self-scheduling.
   */
  async tick(): Promise<void> {
    try {
      await this.maybePost();
    } catch (e) {
      console.error("[social] tick error:", e);
    }
  }

  /** Get X client for external use (e.g., curiosity engine reading X). */
  getXClient(): XClient {
    return this.x;
  }

  getXUserId(): string | null {
    return this.xUserId;
  }

  // ── Core posting loop ──────────────────────────────────────────────

  private async maybePost(): Promise<boolean> {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const todayStr = pstDateStr();

    const state = this.loadState();

    // Reset daily counter on new day
    if (state.dailyDate !== todayStr) {
      state.dailyCount = 0;
      state.dailyDate = todayStr;
      this.saveState(state);
    }

    // Gather context for post generation
    const [emotionalState, timelineContent, trendingTopics] = await Promise.all([
      getEmotionalState(),
      this.fetchTimelineContext(),
      this.fetchTrending(),
    ]);

    const discoveries = this.curiosity?.getRecentDiscoveries(3) ?? [];
    const memories = this.loadMemories();

    const timeSinceLastPostHr = state.lastPostedAt
      ? Math.round((Date.now() - state.lastPostedAt) / 3600000 * 10) / 10
      : 999;

    // Ask LLM: should she post? If yes, what?
    const postContent = await this.generatePost({
      emotionalState,
      discoveries,
      timelineContent,
      trendingTopics,
      memories,
      recentPosts: state.recentPosts,
      userTime,
      timeSinceLastPostHr,
      todayCount: state.dailyCount,
    });

    if (!postContent) {
      return false;
    }

    // Post it — via API if available, otherwise queue for browser posting
    const result = await this.x.postTweet(postContent);
    if (result.success) {
      console.log(`[social] Posted: ${postContent.slice(0, 60)}...`);
      state.lastPostedAt = Date.now();
      state.dailyCount++;
      state.recentPosts.push({ text: postContent, tweetId: result.tweetId ?? "", timestamp: Date.now() });
      state.recentPosts = state.recentPosts.slice(-10);
      this.saveState(state);
      return true;
    } else if (result.error?.includes("API") || result.error?.includes("credentials") || result.error?.includes("401") || result.error?.includes("403") || result.error?.includes("oauth")) {
      this.queueForBrowser(postContent);
      state.lastPostedAt = Date.now();
      state.dailyCount++;
      state.recentPosts.push({ text: postContent, tweetId: "queued", timestamp: Date.now() });
      state.recentPosts = state.recentPosts.slice(-10);
      this.saveState(state);
      return true;
    } else {
      console.error(`[social] Post failed: ${result.error}`);
      return false;
    }
  }

  // ── Context gathering ──────────────────────────────────────────────

  private async fetchTimelineContext(): Promise<string> {
    if (!this.xUserId) return "";
    try {
      const tweets = await this.x.getTimeline(this.xUserId, 10);
      if (tweets.length === 0) return "";
      return tweets
        .slice(0, 8)
        .map((t) => `@${t.authorUsername ?? "?"}: ${t.text.slice(0, 120)}`)
        .join("\n");
    } catch (err) {
      log.warn("failed to fetch timeline", err);
      return "";
    }
  }

  private async fetchTrending(): Promise<string> {
    try {
      const topics = await this.x.getTrending();
      return topics.slice(0, 8).join(", ");
    } catch (err) {
      log.warn("failed to fetch trending topics", err);
      return "";
    }
  }

  // ── Post generation ────────────────────────────────────────────────

  private async generatePost(ctx: {
    emotionalState: EmotionalState;
    discoveries: Discovery[];
    timelineContent: string;
    trendingTopics: string;
    memories: Memory[];
    recentPosts: Array<{ text: string; timestamp: number }>;
    userTime: Date;
    timeSinceLastPostHr: number;
    todayCount: number;
  }): Promise<string | null> {
    const hour = ctx.userTime.getHours();
    const minute = ctx.userTime.getMinutes();
    const dayOfWeek = s().time.day_names[ctx.userTime.getDay()];

    const recentPostsText = ctx.recentPosts
      .slice(-5)
      .map((p) => p.text)
      .join("\n---\n");

    const discoveriesText = ctx.discoveries
      .map((d) => `searched "${d.query}": ${d.summary} (${d.reaction})`)
      .join("\n");

    const emotionText = formatEmotionContext(ctx.emotionalState);

    const char = getCharacter();
    const customSocialPost = char.persona.social_post;

    let system: string;
    if (customSocialPost) {
      system = renderTemplate(customSocialPost, char, {
        discoveriesText: discoveriesText || "(no discoveries today)",
        emotionText,
        timelineContent: ctx.timelineContent,
        trendingTopics: ctx.trendingTopics,
        recentPostsText: recentPostsText || "(none yet)",
        dayOfWeek,
        hour: String(hour),
        minute: String(minute).padStart(2, "0"),
        todayCount: String(ctx.todayCount),
        timeSinceLastPostHr: String(ctx.timeSinceLastPostHr),
      });
    } else {
      const socialPersona = char.persona.social ?? `You are ${char.name}, with your own X (Twitter) account.\nYou post because you genuinely have something to say, not just for the sake of posting.`;

      system = `${socialPersona}

Your discoveries and things you learned today (material, not required to use):
${discoveriesText || "(no discoveries today)"}

Your current mood:
${emotionText}

${ctx.timelineContent ? `Timeline you just scrolled:\n${ctx.timelineContent}\n` : ""}
${ctx.trendingTopics ? `${char.location.city} trending: ${ctx.trendingTopics}\n` : ""}

Your recent posts (avoid repeating topics):
${recentPostsText || "(none yet)"}

It's ${dayOfWeek} ${hour}:${String(minute).padStart(2, "0")}. Posted ${ctx.todayCount} times today, last post was ${ctx.timeSinceLastPostHr} hours ago.

Rules:
- If you have something to post, write the tweet content directly
- If you have nothing to say, reply with one word: SKIP
- Don't use hashtags (unless it feels very natural)
- Don't @ anyone
- Keep it under 280 characters
- Output the tweet directly, no prefix, explanation, or quotes`;
    }

    try {
      const text = (await claudeText({
        system,
        prompt: "Think about whether you have something you want to post.",
        model: "smart",
        timeoutMs: 90_000,
      })).trim();

      if (!text || text === "SKIP" || text.startsWith("SKIP")) return null;

      // Enforce character limit (280 chars, where CJK = 2)
      if (this.tweetLength(text) > 280) {
        return text.slice(0, 140); // rough trim
      }

      return text;
    } catch (err) {
      console.error("[social] Post generation error:", err);
      return null;
    }
  }

  /** Calculate tweet length (CJK characters count as 2). */
  private tweetLength(text: string): number {
    let len = 0;
    for (const char of text) {
      // CJK ranges
      const code = char.charCodeAt(0);
      if (code >= 0x4E00 && code <= 0x9FFF) len += 2;
      else if (code >= 0x3000 && code <= 0x303F) len += 2;
      else if (code >= 0xFF00 && code <= 0xFFEF) len += 2;
      else len += 1;
    }
    return len;
  }

  // ── State management ──────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.config.statePath, "social.json");
  }

  /** Write tweet to queue file for Claude in Chrome to post via browser */
  private queueForBrowser(text: string): void {
    const queuePath = path.join(this.config.statePath, "tweet-queue.json");
    const queue = readJsonSafe<Array<{ text: string; createdAt: number; status: string }>>(queuePath, []);
    queue.push({ text, createdAt: Date.now(), status: "pending" });
    writeJsonAtomic(queuePath, queue);
    console.log(`[social] Queued for browser: ${text.slice(0, 60)}...`);
  }

  private loadState(): SocialState {
    const p = this.getStatePath();
    return readJsonSafe<SocialState>(p, { lastPostedAt: 0, dailyDate: "", dailyCount: 0, recentPosts: [] });
  }

  private saveState(state: SocialState): void {
    writeJsonAtomic(this.getStatePath(), state);
  }

  private loadMemories(): Memory[] {
    try {
      return getStoreManager().loadCategories("core", "emotional");
    } catch {
      return [];
    }
  }
}

// ── Public helpers ───────────────────────────────────────────────────

/**
 * Fetch real-time X content as a signal source for the curiosity engine.
 * Returns formatted tweets on topics she cares about.
 */
export async function fetchXContent(
  xClient: XClient,
  topics: string[],
  maxPerTopic = 5,
): Promise<string> {
  const results: string[] = [];

  for (const topic of topics.slice(0, 3)) {
    try {
      const search = await xClient.searchRecent(topic, maxPerTopic);
      for (const tweet of search.tweets) {
        results.push(`[@${tweet.authorUsername ?? "?"}] ${tweet.text.slice(0, 150)}`);
      }
    } catch (err) {
      log.warn(`failed to search X for topic: ${topic}`, err);
    }
  }

  return results.join("\n");
}
