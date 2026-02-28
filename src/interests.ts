/**
 * Interest-based content discovery — gives the character real things to talk about.
 *
 * The character follows tech and finance news for grounding in reality.
 * The user's interests are loaded from character config.
 * This module fetches real headlines from RSS feeds and provides them
 * as natural conversation material for proactive outreach.
 *
 * The proactive LLM decides IF any of these are worth sharing —
 * this module just provides the raw material.
 */

import fs from "node:fs";
import path from "node:path";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import type { Memory } from "./types.js";
import { transcribeFromUrl } from "./media.js";
import { getStoreManager } from "./memory/store-manager.js";
import { s } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

interface ContentItem {
  title: string;
  source: string;
  url: string;
  description: string;
}

interface FeedConfig {
  name: string;
  url: string;
  category: string;
}

interface YouTubeVideo {
  title: string;
  channel: string;
  url: string;
  description: string;
  published: string;
}

interface PodcastEpisode {
  title: string;
  show: string;
  url: string;
  description: string;
  duration: string;
  published: string;
}

// ── RSS Feeds ────────────────────────────────────────────────────────
// Default feeds the character would naturally follow

const FEEDS: FeedConfig[] = [
  // Tech — general technology news
  { name: "Hacker News", url: "https://news.ycombinator.com/rss", category: "tech" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "tech" },
  // Finance — market and finance news
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "finance" },
];

// ── Cache TTLs ──────────────────────────────────────────────────────

const CONTENT_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const YOUTUBE_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const PODCAST_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ── HTTP helper ──────────────────────────────────────────────────────

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    const req = client.get(url, {
      headers: {
        "User-Agent": "MeAI/1.0 RSS Reader",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve relative redirects (e.g. "/path/...") against the original URL
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchUrl(redirectUrl).then(resolve, reject);
        return;
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── RSS parsing ──────────────────────────────────────────────────────

function parseRSS(xml: string, source: string): ContentItem[] {
  const items: ContentItem[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link") || extractGuidTag(block);
    const description = cleanHtml(extractTag(block, "description") || "");

    if (title && link) {
      items.push({
        title: cleanHtml(title),
        source,
        url: link,
        description: description.slice(0, 150),
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractGuidTag(xml: string): string | null {
  const match = xml.match(/<guid[^>]*>([^<]+)<\/guid>/i);
  return match ? match[1].trim() : null;
}

function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// ── Interest extraction from memory ──────────────────────────────────

/**
 * Extract interest keywords from memory store.
 * Looks at interests.*, user.hobbies, and other relevant keys.
 */
function extractInterestKeywords(statePath: string): string[] {
  try {
    const memories = getStoreManager().loadCategories("core", "emotional");
    const keywords: string[] = [];

    for (const m of memories) {
      // Direct interest tags
      if (m.key.startsWith("interests.") || m.key.startsWith("user.hobbies")) {
        keywords.push(...m.value.split(/[,，、\s]+/).filter(Boolean));
      }
      // Work-related interests
      if (m.key.startsWith("work.") || m.key.startsWith("user.work")) {
        keywords.push(...m.value.split(/[,，、\s]+/).filter(Boolean));
      }
      // Any key containing "interest", "hobby", "like"
      if (/interest|hobby|like/.test(m.key)) {
        keywords.push(...m.value.split(/[,，、\s]+/).filter(Boolean));
      }
    }

    return [...new Set(keywords)].filter(k => k.length > 1);
  } catch {
    return [];
  }
}

/**
 * Score content items by relevance to user interests.
 * Simple keyword matching — good enough for filtering headlines.
 */
function scoreByRelevance(items: ContentItem[], interests: string[]): ContentItem[] {
  if (interests.length === 0) return items.slice(0, 10);

  const lowerInterests = interests.map(k => k.toLowerCase());

  const scored = items.map(item => {
    const text = `${item.title} ${item.description}`.toLowerCase();
    let score = 0;
    for (const interest of lowerInterests) {
      if (text.includes(interest)) score++;
    }
    return { item, score };
  });

  // Sort by relevance, then mix in some random ones for variety
  scored.sort((a, b) => b.score - a.score);

  const relevant = scored.filter(s => s.score > 0).map(s => s.item).slice(0, 6);
  const random = scored.filter(s => s.score === 0).map(s => s.item);

  // Pick 2-3 random items for serendipity
  const shuffled = random.sort(() => Math.random() - 0.5).slice(0, 3);

  return [...relevant, ...shuffled];
}

// ── Local Events (SF) ────────────────────────────────────────────────

const LOCAL_FEEDS: FeedConfig[] = [
  // SF local events and happenings
  { name: "SFGate", url: "https://www.sfgate.com/bayarea/feed/Bay-Area-News-702.php", category: "local" },
  { name: "Eater SF", url: "https://sf.eater.com/rss/index.xml", category: "food" },
];

const LOCAL_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ── Subscriptions (persistent, self-evolving) ───────────────────────
// The character can discover and subscribe to new YouTube channels + podcasts
// through the curiosity engine. The hardcoded list below is just the
// initial seed — actual subscriptions live in subscriptions.json.

interface YouTubeSub {
  name: string;
  channelId: string;
  category: string;
  source: "seed" | "discovered";
  subscribedAt: number;
  /** Why she subscribed (for discovered ones) */
  reason?: string;
}

interface PodcastSub {
  name: string;
  url: string;
  category: string;
  source: "seed" | "discovered";
  subscribedAt: number;
  reason?: string;
}

interface Subscriptions {
  youtube: YouTubeSub[];
  podcasts: PodcastSub[];
}

/** Seed subscriptions — initial defaults before she starts discovering her own */
const SEED_YOUTUBE: YouTubeSub[] = [
  { name: "Fireship", channelId: "UCsBjURrPoezykLs9EqgamOA", category: "tech", source: "seed", subscribedAt: 0 },
  { name: "3Blue1Brown", channelId: "UCYO_jab_esuFRV4b17AJtAw", category: "tech", source: "seed", subscribedAt: 0 },
  { name: "Two Minute Papers", channelId: "UCbfYPyITQ-7l4upoX8nvctg", category: "tech", source: "seed", subscribedAt: 0 },
  { name: "Patrick Boyle", channelId: "UCASM0cgfkJxQ1ICmRilfHLw", category: "finance", source: "seed", subscribedAt: 0 },
  { name: "Bloomberg TV", channelId: "UCIALMKvObZNtJ6AmdCLP7Lg", category: "finance", source: "seed", subscribedAt: 0 },
  { name: "ThePrimeagen", channelId: "UCUyeluBRhGPCW4rPe_UvBZQ", category: "tech", source: "seed", subscribedAt: 0 },
];

const SEED_PODCASTS: PodcastSub[] = [
  { name: "Lex Fridman", url: "https://lexfridman.com/feed/podcast/", category: "tech", source: "seed", subscribedAt: 0 },
  { name: "All-In Podcast", url: "https://feeds.megaphone.fm/all-in-with-chamath-jason-sacks-and-friedberg", category: "tech", source: "seed", subscribedAt: 0 },
  { name: "Odd Lots", url: "https://feeds.bloomberg.com/podcasts/etf_odd_lots.xml", category: "finance", source: "seed", subscribedAt: 0 },
  { name: "Acquired", url: "https://feeds.simplecast.com/JbGcrmMG", category: "tech", source: "seed", subscribedAt: 0 },
];

// ── Class ────────────────────────────────────────────────────────────

export class InterestsEngine {
  private _statePath: string;
  private contentCache: { items: ContentItem[]; fetchedAt: number } | null = null;
  private localCache: { items: ContentItem[]; fetchedAt: number } | null = null;
  private youtubeCache: { videos: YouTubeVideo[]; fetchedAt: number } | null = null;
  private podcastCache: { episodes: PodcastEpisode[]; fetchedAt: number } | null = null;

  constructor(statePath: string) {
    this._statePath = statePath;
  }

  private getSubsPath(): string {
    return path.join(this._statePath, "subscriptions.json");
  }

  /**
   * Load subscriptions from disk, seeding defaults on first run.
   */
  loadSubscriptions(): Subscriptions {
    const p = this.getSubsPath();
    if (this._statePath && fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Subscriptions;
        return { youtube: data.youtube ?? [], podcasts: data.podcasts ?? [] };
      } catch { /* fall through to seed */ }
    }
    // First run — seed defaults
    const subs: Subscriptions = {
      youtube: [...SEED_YOUTUBE],
      podcasts: [...SEED_PODCASTS],
    };
    this.saveSubscriptions(subs);
    return subs;
  }

  private saveSubscriptions(subs: Subscriptions): void {
    if (!this._statePath) return;
    fs.writeFileSync(this.getSubsPath(), JSON.stringify(subs, null, 2) + "\n");
  }

  /**
   * Subscribe to a new YouTube channel.
   * Returns false if already subscribed.
   */
  subscribeYouTube(
    name: string,
    channelId: string,
    category: string,
    reason: string,
  ): boolean {
    const subs = this.loadSubscriptions();
    if (subs.youtube.some(s => s.channelId === channelId)) return false;

    subs.youtube.push({
      name,
      channelId,
      category,
      source: "discovered",
      subscribedAt: Date.now(),
      reason,
    });
    this.saveSubscriptions(subs);
    console.log(`[interests] 🎬 Subscribed to YouTube: ${name} (${reason})`);
    return true;
  }

  /**
   * Subscribe to a new podcast.
   * Returns false if already subscribed.
   */
  subscribePodcast(
    name: string,
    feedUrl: string,
    category: string,
    reason: string,
  ): boolean {
    const subs = this.loadSubscriptions();
    if (subs.podcasts.some(s => s.url === feedUrl)) return false;

    subs.podcasts.push({
      name,
      url: feedUrl,
      category,
      source: "discovered",
      subscribedAt: Date.now(),
      reason,
    });
    this.saveSubscriptions(subs);
    console.log(`[interests] 🎙️ Subscribed to podcast: ${name} (${reason})`);
    return true;
  }

  /**
   * Unsubscribe from a YouTube channel by channelId.
   */
  unsubscribeYouTube(channelId: string): boolean {
    const subs = this.loadSubscriptions();
    const before = subs.youtube.length;
    subs.youtube = subs.youtube.filter(s => s.channelId !== channelId);
    if (subs.youtube.length < before) {
      this.saveSubscriptions(subs);
      console.log(`[interests] Unsubscribed from YouTube channel: ${channelId}`);
      return true;
    }
    return false;
  }

  /**
   * Unsubscribe from a podcast by feed URL.
   */
  unsubscribePodcast(feedUrl: string): boolean {
    const subs = this.loadSubscriptions();
    const before = subs.podcasts.length;
    subs.podcasts = subs.podcasts.filter(s => s.url !== feedUrl);
    if (subs.podcasts.length < before) {
      this.saveSubscriptions(subs);
      console.log(`[interests] Unsubscribed from podcast: ${feedUrl}`);
      return true;
    }
    return false;
  }

  /**
   * Get a human-readable summary of current subscriptions.
   */
  getSubscriptionSummary(): string {
    const subs = this.loadSubscriptions();
    const discoveredTag = s().notifications.discovered_tag;
    const ytLines = subs.youtube.map(sub => {
      const tag = sub.source === "discovered" ? ` ${discoveredTag}` : "";
      return `  YouTube: ${sub.name}${tag}`;
    });
    const podLines = subs.podcasts.map(sub => {
      const tag = sub.source === "discovered" ? ` ${discoveredTag}` : "";
      return `  Podcast: ${sub.name}${tag}`;
    });
    return [...ytLines, ...podLines].join("\n");
  }

  /**
   * Fetch SF local events and happenings.
   * Used for grounding the character's weekend/after-work activities in reality.
   */
  async fetchLocalEvents(): Promise<string> {
    if (this.localCache && Date.now() - this.localCache.fetchedAt < LOCAL_CACHE_TTL) {
      return formatLocalEvents(this.localCache.items);
    }

    const allItems: ContentItem[] = [];

    const promises = LOCAL_FEEDS.map(async (feed) => {
      try {
        const xml = await fetchUrl(feed.url);
        return parseRSS(xml, feed.name).slice(0, 5);
      } catch {
        return [];
      }
    });

    const results = await Promise.all(promises);
    for (const items of results) {
      allItems.push(...items);
    }

    this.localCache = { items: allItems, fetchedAt: Date.now() };
    console.log(`[interests] Fetched ${allItems.length} local SF items`);

    return formatLocalEvents(allItems);
  }

  /**
   * Fetch fresh content from RSS feeds.
   * Returns a mix of tech and finance headlines the character would naturally encounter.
   */
  private async fetchContent(): Promise<ContentItem[]> {
    if (this.contentCache && Date.now() - this.contentCache.fetchedAt < CONTENT_CACHE_TTL) {
      return this.contentCache.items;
    }

    const allItems: ContentItem[] = [];

    const promises = FEEDS.map(async (feed) => {
      try {
        const xml = await fetchUrl(feed.url);
        return parseRSS(xml, feed.name).slice(0, 8);
      } catch {
        return [];
      }
    });

    const results = await Promise.all(promises);
    for (const items of results) {
      allItems.push(...items);
    }

    this.contentCache = { items: allItems, fetchedAt: Date.now() };
    console.log(`[interests] Fetched ${allItems.length} headlines from ${FEEDS.length} feeds`);

    return allItems;
  }

  /**
   * Fetch recent YouTube videos from subscribed channels.
   * Reads from subscriptions.json — she can discover + add new channels over time.
   */
  async fetchYouTubeVideos(): Promise<YouTubeVideo[]> {
    if (this.youtubeCache && Date.now() - this.youtubeCache.fetchedAt < YOUTUBE_CACHE_TTL) {
      return this.youtubeCache.videos;
    }

    const subs = this.loadSubscriptions();
    const channels = subs.youtube;
    const allVideos: YouTubeVideo[] = [];

    const promises = channels.map(async (ch) => {
      try {
        const xml = await fetchUrl(
          `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`,
        );
        return parseAtomFeed(xml, ch.name).slice(0, 3); // latest 3 per channel
      } catch {
        return [];
      }
    });

    const results = await Promise.all(promises);
    for (const videos of results) {
      allVideos.push(...videos);
    }

    // Sort by published date (most recent first)
    allVideos.sort((a, b) => {
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      return tb - ta;
    });

    this.youtubeCache = { videos: allVideos, fetchedAt: Date.now() };
    console.log(`[interests] Fetched ${allVideos.length} YouTube videos from ${channels.length} subscribed channels`);

    return allVideos;
  }

  /**
   * Format YouTube videos for context injection.
   * Returns the most recent videos with relevance scoring.
   */
  async discoverYouTube(statePath: string): Promise<string> {
    try {
      const interests = extractInterestKeywords(statePath);
      const videos = await this.fetchYouTubeVideos();
      if (videos.length === 0) return "";

      // Score by interest relevance
      const lowerInterests = interests.map(k => k.toLowerCase());
      const scored = videos.map(v => {
        const text = `${v.title} ${v.description} ${v.channel}`.toLowerCase();
        let score = 0;
        for (const interest of lowerInterests) {
          if (text.includes(interest)) score++;
        }
        return { video: v, score };
      });

      scored.sort((a, b) => b.score - a.score);

      // Top 5 relevant + 2 random for serendipity
      const relevant = scored.filter(s => s.score > 0).slice(0, 5).map(s => s.video);
      const random = scored
        .filter(s => s.score === 0)
        .sort(() => Math.random() - 0.5)
        .slice(0, 2)
        .map(s => s.video);

      const selected = [...relevant, ...random].slice(0, 6);
      if (selected.length === 0) return "";

      return selected
        .map(v => `[YouTube/${v.channel}] ${v.title}${v.description ? ` — ${v.description.slice(0, 80)}` : ""}`)
        .join("\n");
    } catch (err) {
      console.error("[interests] YouTube discovery error:", err);
      return "";
    }
  }

  /**
   * Fetch recent podcast episodes from subscribed shows.
   * Reads from subscriptions.json — she can discover + add new podcasts over time.
   */
  async fetchPodcastEpisodes(): Promise<PodcastEpisode[]> {
    if (this.podcastCache && Date.now() - this.podcastCache.fetchedAt < PODCAST_CACHE_TTL) {
      return this.podcastCache.episodes;
    }

    const subs = this.loadSubscriptions();
    const feeds = subs.podcasts;
    const allEpisodes: PodcastEpisode[] = [];

    const promises = feeds.map(async (feed) => {
      try {
        const xml = await fetchUrl(feed.url);
        return parsePodcastFeed(xml, feed.name).slice(0, 3); // latest 3 per show
      } catch {
        return [];
      }
    });

    const results = await Promise.all(promises);
    for (const episodes of results) {
      allEpisodes.push(...episodes);
    }

    // Sort by published date (most recent first)
    allEpisodes.sort((a, b) => {
      const ta = a.published ? new Date(a.published).getTime() : 0;
      const tb = b.published ? new Date(b.published).getTime() : 0;
      return tb - ta;
    });

    this.podcastCache = { episodes: allEpisodes, fetchedAt: Date.now() };
    console.log(`[interests] Fetched ${allEpisodes.length} podcast episodes from ${feeds.length} subscribed shows`);

    return allEpisodes;
  }

  /**
   * Format podcast episodes for context injection.
   * Returns recent episodes scored by relevance to user interests.
   */
  async discoverPodcasts(statePath: string): Promise<string> {
    try {
      const interests = extractInterestKeywords(statePath);
      const episodes = await this.fetchPodcastEpisodes();
      if (episodes.length === 0) return "";

      // Score by interest relevance
      const lowerInterests = interests.map(k => k.toLowerCase());
      const scored = episodes.map(ep => {
        const text = `${ep.title} ${ep.description} ${ep.show}`.toLowerCase();
        let score = 0;
        for (const interest of lowerInterests) {
          if (text.includes(interest)) score++;
        }
        return { episode: ep, score };
      });

      scored.sort((a, b) => b.score - a.score);

      // Top 4 relevant + 1 random
      const relevant = scored.filter(s => s.score > 0).slice(0, 4).map(s => s.episode);
      const random = scored
        .filter(s => s.score === 0)
        .sort(() => Math.random() - 0.5)
        .slice(0, 1)
        .map(s => s.episode);

      const selected = [...relevant, ...random].slice(0, 5);
      if (selected.length === 0) return "";

      return selected
        .map(ep => {
          const dur = ep.duration ? ` (${ep.duration})` : "";
          return `[Podcast/${ep.show}]${dur} ${ep.title}${ep.description ? ` — ${ep.description.slice(0, 80)}` : ""}`;
        })
        .join("\n");
    } catch (err) {
      console.error("[interests] Podcast discovery error:", err);
      return "";
    }
  }

  /**
   * Discover content relevant to user interests.
   * Returns formatted text ready for proactive context injection.
   */
  async discoverContent(statePath: string): Promise<string> {
    try {
      const interests = extractInterestKeywords(statePath);
      const allContent = await this.fetchContent();
      const curated = scoreByRelevance(allContent, interests);

      if (curated.length === 0) return "";

      const lines = curated.map(item =>
        `[${item.source}] ${item.title}${item.description ? ` — ${item.description}` : ""}`
      );

      return lines.join("\n");
    } catch (err) {
      console.error("[interests] Content discovery error:", err);
      return "";
    }
  }

  /**
   * Get a compact summary of user's tracked interests.
   * Useful for the proactive prompt to know what the user cares about.
   */
  getInterestSummary(statePath: string): string {
    const keywords = extractInterestKeywords(statePath);
    if (keywords.length === 0) return "";
    return keywords.slice(0, 15).join("\u3001");
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: InterestsEngine | null = null;

export function initInterests(statePath: string): InterestsEngine {
  _singleton = new InterestsEngine(statePath);
  return _singleton;
}

function _get(): InterestsEngine {
  if (!_singleton) throw new Error("initInterests() not called");
  return _singleton;
}

export function loadSubscriptions(): Subscriptions { return _get().loadSubscriptions(); }
export function subscribeYouTube(name: string, channelId: string, category: string, reason: string): boolean { return _get().subscribeYouTube(name, channelId, category, reason); }
export function subscribePodcast(name: string, feedUrl: string, category: string, reason: string): boolean { return _get().subscribePodcast(name, feedUrl, category, reason); }
export function unsubscribeYouTube(channelId: string): boolean { return _get().unsubscribeYouTube(channelId); }
export function unsubscribePodcast(feedUrl: string): boolean { return _get().unsubscribePodcast(feedUrl); }
export function getSubscriptionSummary(): string { return _get().getSubscriptionSummary(); }
export async function fetchLocalEvents(): Promise<string> { return _get().fetchLocalEvents(); }
export async function fetchYouTubeVideos(): Promise<YouTubeVideo[]> { return _get().fetchYouTubeVideos(); }
export async function discoverYouTube(statePath: string): Promise<string> { return _get().discoverYouTube(statePath); }
export async function fetchPodcastEpisodes(): Promise<PodcastEpisode[]> { return _get().fetchPodcastEpisodes(); }
export async function discoverPodcasts(statePath: string): Promise<string> { return _get().discoverPodcasts(statePath); }
export async function discoverContent(statePath: string): Promise<string> { return _get().discoverContent(statePath); }
export function getInterestSummary(statePath: string): string { return _get().getInterestSummary(statePath); }

// ── Module-level helpers (no state dependency) ──────────────────────

function formatLocalEvents(items: ContentItem[]): string {
  if (items.length === 0) return "";
  return items
    .slice(0, 8)
    .map(item => `[${item.source}] ${item.title}`)
    .join("\n");
}

// ── YouTube fetching (Atom format) ──────────────────────────────────

/**
 * Parse YouTube Atom feed into video entries.
 * YouTube RSS is Atom: <entry> with <title>, <link href="...">, <media:group>
 */
function parseAtomFeed(xml: string, channelName: string): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  for (const entry of entries) {
    const title = extractTag(entry, "title");
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
    const url = linkMatch ? linkMatch[1] : "";
    const description = extractTag(entry, "media:description") ?? "";
    const published = extractTag(entry, "published") ?? "";

    if (title && url) {
      videos.push({
        title: cleanHtml(title),
        channel: channelName,
        url,
        description: cleanHtml(description).slice(0, 200),
        published,
      });
    }
  }

  return videos;
}

// ── Podcast fetching (RSS + iTunes) ─────────────────────────────────

/**
 * Parse podcast RSS feed into episode entries.
 * Extracts itunes:duration, itunes:summary for richer metadata.
 */
function parsePodcastFeed(xml: string, showName: string): PodcastEpisode[] {
  const episodes: PodcastEpisode[] = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link") || extractGuidTag(block);
    const description = cleanHtml(
      extractTag(block, "itunes:summary")
        ?? extractTag(block, "description")
        ?? "",
    );
    const duration = extractTag(block, "itunes:duration") ?? "";
    const published = extractTag(block, "pubDate") ?? "";

    // Enclosure URL as fallback link (direct audio)
    const enclosureMatch = block.match(/<enclosure[^>]*url="([^"]+)"/);
    const url = link || (enclosureMatch ? enclosureMatch[1] : "");

    if (title && url) {
      episodes.push({
        title: cleanHtml(title),
        show: showName,
        url,
        description: description.slice(0, 200),
        duration: formatDuration(duration),
        published,
      });
    }
  }

  return episodes;
}

/**
 * Normalize podcast duration — could be "3600" (seconds), "1:00:00", or "60 min".
 */
function formatDuration(raw: string): string {
  if (!raw) return "";
  // Already formatted like "1:23:45"
  if (raw.includes(":")) return raw;
  // Seconds as number
  const secs = parseInt(raw, 10);
  if (isNaN(secs)) return raw;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${m}min` : `${m}min`;
}

// ── YouTube Transcript Fetching ──────────────────────────────────────
// YouTube auto-generated captions are accessible via the video page's
// embedded player response — no API key required.

/**
 * Extract video ID from a YouTube URL.
 */
function extractVideoId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * Fetch YouTube video transcript (auto-generated captions).
 *
 * Strategy: Fetch the video page HTML, extract the captions track URL
 * from the embedded player config, then fetch the timed text XML.
 * Falls back gracefully if no captions are available.
 */
export async function fetchYouTubeTranscript(videoUrl: string): Promise<string> {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) return "";

  try {
    // Step 1: Fetch the video watch page
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}`);

    // Step 2: Extract captions track URL from player response
    // YouTube embeds "captionTracks" in the initial player response JSON
    const captionMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
    if (!captionMatch) return "";

    // Parse carefully — it's embedded in a larger JSON
    let captionTracks: Array<{ baseUrl: string; languageCode: string }>;
    try {
      // The JSON may contain escaped characters
      const cleaned = captionMatch[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"');
      captionTracks = JSON.parse(cleaned);
    } catch {
      // Try regex fallback for baseUrl
      const baseUrlMatch = captionMatch[1].match(/"baseUrl":\s*"([^"]+)"/);
      if (!baseUrlMatch) return "";
      const baseUrl = baseUrlMatch[1].replace(/\\u0026/g, "&");
      captionTracks = [{ baseUrl, languageCode: "en" }];
    }

    if (captionTracks.length === 0) return "";

    // Step 3: Prefer English, then any available language
    const enTrack = captionTracks.find(t => t.languageCode === "en")
      || captionTracks.find(t => t.languageCode?.startsWith("en"))
      || captionTracks[0];

    if (!enTrack?.baseUrl) return "";

    // Step 4: Fetch the timed text XML
    const captionUrl = enTrack.baseUrl.replace(/\\u0026/g, "&");
    const xml = await fetchUrl(captionUrl);

    // Step 5: Parse timed text XML → plain text
    const lines: string[] = [];
    const textBlocks = xml.match(/<text[^>]*>([\s\S]*?)<\/text>/g) || [];
    for (const block of textBlocks) {
      const textMatch = block.match(/<text[^>]*>([\s\S]*?)<\/text>/);
      if (textMatch) {
        lines.push(cleanHtml(textMatch[1]));
      }
    }

    const transcript = lines.join(" ").replace(/\s+/g, " ").trim();
    if (transcript.length > 0) {
      console.log(`[interests] Fetched YouTube transcript for ${videoId}: ${transcript.length} chars (captions)`);
      return transcript;
    }

    // Fallback: cobalt + whisper pipeline for videos without captions
    console.log(`[interests] No captions for ${videoId}, trying cobalt+whisper...`);
    const whisperText = await transcribeFromUrl(videoUrl);
    if (whisperText.length > 0) {
      console.log(`[interests] Fetched YouTube transcript for ${videoId}: ${whisperText.length} chars (whisper)`);
      return whisperText;
    }

    return "";
  } catch (err) {
    console.error(`[interests] YouTube transcript fetch failed for ${videoUrl}:`, err);

    // Last resort: try cobalt+whisper even if captions parsing errored
    try {
      const whisperText = await transcribeFromUrl(videoUrl);
      if (whisperText.length > 0) return whisperText;
    } catch { /* give up */ }

    return "";
  }
}

// ── Podcast Transcript Fetching ─────────────────────────────────────
// Many podcasts include full show notes or transcripts in their RSS feed
// (in <content:encoded> or detailed <description>). We also check for
// dedicated transcript links in the episode page.

/**
 * Fetch podcast episode transcript or detailed show notes.
 *
 * Strategy (in order):
 * 1. Check RSS <content:encoded> for long-form content (already parsed)
 * 2. Fetch the episode web page and extract main text content
 *
 * This won't get word-for-word audio transcripts for all podcasts, but
 * gets the detailed show notes / summaries that many podcasts provide.
 */
export async function fetchPodcastTranscript(episodeUrl: string): Promise<string> {
  if (!episodeUrl || !episodeUrl.startsWith("http")) return "";

  try {
    // Fetch the episode page and extract text
    const html = await fetchUrl(episodeUrl);

    // Try to find transcript or show notes sections
    // Common patterns: <div class="transcript">, <div class="show-notes">, <article>
    const articleMatch = html.match(/<article[\s\S]*?<\/article>/i)
      || html.match(/<div[^>]*class="[^"]*(?:transcript|show-notes|episode-content|entry-content)[^"]*"[\s\S]*?<\/div>/i);

    let text: string;
    if (articleMatch) {
      text = cleanHtml(articleMatch[0]);
    } else {
      // Fallback: extract body text, skip headers/nav/footer
      const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
      text = bodyMatch ? cleanHtml(bodyMatch[0]) : cleanHtml(html);
    }

    // Clean up and truncate
    text = text
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 10000); // cap at 10K chars

    if (text.length >= 100) {
      console.log(`[interests] Fetched podcast transcript for ${episodeUrl}: ${text.length} chars (web)`);
      return text;
    }

    // Fallback: cobalt + whisper for podcasts without text show notes
    console.log(`[interests] No text content for podcast, trying cobalt+whisper...`);
    const whisperText = await transcribeFromUrl(episodeUrl);
    if (whisperText.length > 0) {
      console.log(`[interests] Fetched podcast transcript for ${episodeUrl}: ${whisperText.length} chars (whisper)`);
      return whisperText;
    }

    return "";
  } catch (err) {
    console.error(`[interests] Podcast transcript fetch failed for ${episodeUrl}:`, err);

    // Last resort: try cobalt+whisper
    try {
      const whisperText = await transcribeFromUrl(episodeUrl);
      if (whisperText.length > 0) return whisperText;
    } catch { /* give up */ }

    return "";
  }
}

