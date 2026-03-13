/**
 * Curiosity engine — the character genuinely explores the web and learns new things.
 *
 * This is NOT simulated curiosity. She actually:
 * 1. Decides what she's curious about right now (based on conversations, work, interests)
 * 2. Searches the web via DuckDuckGo
 * 3. Reads interesting pages
 * 4. Summarizes what she learned and forms opinions
 * 5. Saves discoveries for natural conversation use
 *
 * Polls every 30 min; she decides when to actually explore. Discoveries feed into:
 * - Proactive outreach (she found something cool, wants to share)
 * - Conversation context (she can reference things she read today)
 * - Memory (interesting findings get saved as interests/knowledge)
 * - Emotional state (finding something exciting → mood boost)
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "./claude-runner.js";
import type { AppConfig, Memory } from "./types.js";
import type { XClient } from "./x-client.js";
import { searchSkills, evaluateSkill } from "./clawhub.js";
import { createLogger } from "./lib/logger.js";
import { searchWeb, searchGitHub, fetchPage, type SearchResult } from "./lib/search.js";
import { s, renderTemplate, getCharacter } from "./character.js";

const log = createLogger("curiosity");
import {
  fetchYouTubeVideos,
  fetchPodcastEpisodes,
  subscribeYouTube,
  subscribePodcast,
  loadSubscriptions,
  fetchYouTubeTranscript,
  fetchPodcastTranscript,
} from "./interests.js";
import { getStoreManager } from "./memory/store-manager.js";
import { getUserTZ } from "./lib/pst-date.js";
import { repairAndParseJson } from "./lib/json-repair.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SkillSuggestion {
  /** ClawHub skill slug */
  slug: string;
  /** Display name */
  displayName: string;
  /** Why this skill is relevant to the discovery */
  relevance: string;
  /** Is it safe? */
  safe: boolean;
  /** Adaptation notes */
  notes: string;
}

export interface Discovery {
  /** What she was curious about */
  query: string;
  /** What she found — her own summary, not raw text */
  summary: string;
  /** Her personal reaction/opinion */
  reaction: string;
  /** Would the character want to share this with the user? */
  shareWorthy: boolean;
  /** Topic category for later filtering */
  category: string;
  /** Source URLs she read */
  sources: string[];
  /** When this was discovered */
  timestamp: number;
  /** ClawHub skill suggestion (if a relevant capability was found) */
  skillSuggestion?: SkillSuggestion;
  /** How deep this exploration went */
  depth: "shallow" | "deep";
  /** Connections to previous discoveries (cross-referenced queries) */
  connections?: string[];
  /** Deeper insights from deep dive (multi-source synthesis) */
  deepInsights?: string;
  /** Associated care topic ID (if this exploration was for user's expressed need) */
  careTopicId?: string;
}

interface CuriosityState {
  lastExploredAt: number;
  discoveries: Discovery[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_DISCOVERIES = 20; // rolling window
const randMs = (minMin: number, maxMin: number) =>
  (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;
const DISCOVERY_MAX_AGE = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEEP_READ_CHARS = 8000; // deep dives read 8K chars per page (vs 3K shallow)

/** Entropy floor — below this, diversity enforcement kicks in. */
const ACTIVATION_ENTROPY_FLOOR = 0.3;

// ── CuriosityEngine ──────────────────────────────────────────────────

export class CuriosityEngine {
  private config: AppConfig;
  private stopped = false;
  private xClient: XClient | null = null;
  private activationHints: string[] = [];
  private activationEntropy = 1; // default: evenly spread
  private eigTargets: Array<{ query: string; reason: string }> = [];
  private rejectedQueries: Set<string> = new Set(); // queries rejected as duplicates this cycle

  constructor(config: AppConfig) {
    this.config = config;
  }

  /** Give the curiosity engine access to X for real-time info. */
  setXClient(xClient: XClient): void {
    this.xClient = xClient;
  }

  /** Set activation hints from heartbeat (topics currently on the character's mind). */
  setActivationHints(topics: string[], entropy: number): void {
    this.activationHints = topics;
    this.activationEntropy = entropy;
  }

  /** Accept EIG-directed exploration targets from brainstem curiosity engine. */
  setEIGTargets(targets: Array<{ query: string; reason: string }>): void {
    // Filter out previously rejected targets to prevent explore-duplicate loops
    this.eigTargets = targets.filter(t => !this.rejectedQueries.has(t.query));
  }

  start(): void {
    console.log("[curiosity] Started");
    setTimeout(() => this.loop(), randMs(8, 20));
  }

  stop(): void { this.stopped = true; }

  /**
   * Public entry point for the heartbeat.
   * Runs one exploration cycle without self-scheduling.
   * Returns true if an actual exploration happened.
   */
  async tick(): Promise<boolean> {
    try {
      return await this.explore();
    } catch (e) {
      console.error("[curiosity] tick error:", e);
      return false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const explored = await this.explore();
      // After a real exploration: rest 60-150 min; after a skip: retry in 20-50 min
      setTimeout(() => this.loop(), explored ? randMs(60, 150) : randMs(20, 50));
    } catch (e) {
      console.error("[curiosity] Error:", e);
      setTimeout(() => this.loop(), randMs(15, 30));
    }
  }

  /** Get recent discoveries for context injection. */
  getRecentDiscoveries(maxCount = 3): Discovery[] {
    const state = this.loadState();
    return state.discoveries
      .filter(d => Date.now() - d.timestamp < DISCOVERY_MAX_AGE)
      .slice(-maxCount);
  }

  /** Get share-worthy discoveries for proactive outreach. */
  getShareWorthy(): Discovery[] {
    const state = this.loadState();
    return state.discoveries
      .filter(d => d.shareWorthy && Date.now() - d.timestamp < DISCOVERY_MAX_AGE);
  }

  /**
   * The core exploration loop:
   * 1. Decide what to explore
   * 2. Shallow search: search the web, read 1-2 pages, quick summary
   * 3. Triage: LLM scores "is this worth going deeper?" (1-5)
   * 4. If score >= 4: Deep dive — more sources, full articles, cross-reference
   * 5. Check ClawHub for related skills
   * 6. Save discovery
   */
  private async explore(): Promise<boolean> {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));

    const state = this.loadState();
    const timeSinceLastHr = Math.round((Date.now() - state.lastExploredAt) / 3600000 * 10) / 10;

    // Step 1: Use brainstem EIG target if available, otherwise LLM decides
    let topic: { query: string; reason: string; careTopicId?: string; careNeed?: string } | null = null;
    if (this.eigTargets.length > 0) {
      topic = this.eigTargets.shift()!;
      log.info(`using EIG-directed target: "${topic.query}"`);
    } else {
      topic = await this.pickTopic(userTime, timeSinceLastHr, state.discoveries, this.rejectedQueries);
    }
    if (!topic) {
      return false;
    }

    // Dedup: LLM checks if this is a boring repeat vs meaningful deeper exploration
    const dedupResult = await this.checkDuplicate(topic.query, state.discoveries);
    if (dedupResult === "duplicate") {
      console.log(`[curiosity] Skipping duplicate topic: "${topic.query}"`);
      this.rejectedQueries.add(topic.query);
      return false;
    }
    if (dedupResult === "deepen") {
      console.log(`[curiosity] Deepening previous exploration: "${topic.query}"`);
    }

    console.log(`[curiosity] Exploring: "${topic.query}" (${topic.reason})`);

    // Step 2: Shallow search — web + GitHub + X in parallel (request rawContent from Tavily)
    let searchResults: SearchResult[] = [];
    let githubResults: SearchResult[] = [];
    let xTweets = "";

    // Detect queries likely to benefit from GitHub search
    const isCodeQuery = /github|repo|architecture|open.?source|framework|implementation|code|library|sdk|api|agent/i.test(topic.query);

    const searchPromises: Promise<void>[] = [
      searchWeb(topic.query, 5, { includeRawContent: true })
        .then((r) => { searchResults = r; })
        .catch((err) => { console.error("[curiosity] Web search failed:", err); }),
    ];

    if (isCodeQuery) {
      searchPromises.push(
        searchGitHub(topic.query, 3)
          .then((r) => { githubResults = r; })
          .catch(() => { /* GitHub search optional */ }),
      );
    }

    if (this.xClient) {
      searchPromises.push(
        this.xClient.searchRecent(topic.query, 8)
          .then((r) => {
            if (r.tweets.length > 0) {
              xTweets = r.tweets
                .map((t) => `@${t.authorUsername ?? "?"}: ${t.text.slice(0, 150)}`)
                .join("\n");
            }
          })
          .catch(() => { /* X search optional */ }),
      );
    }

    await Promise.all(searchPromises);

    // Merge GitHub results (prepend — typically more relevant for code queries)
    if (githubResults.length > 0) {
      const existingUrls = new Set(searchResults.map(r => r.url));
      for (const gr of githubResults) {
        if (!existingUrls.has(gr.url)) {
          searchResults.unshift(gr);
        }
      }
    }

    if (searchResults.length === 0 && !xTweets) {
      return false;
    }

    // Step 3: Read 1-2 pages (shallow — 3000 char cap)
    // Use rawContent from Tavily when available, fall back to fetchPage
    const pages: Array<{ title: string; url: string; content: string }> = [];
    for (const result of searchResults.slice(0, 2)) {
      if (result.rawContent && result.rawContent.length > 100) {
        pages.push({ title: result.title, url: result.url, content: result.rawContent.slice(0, 3000) });
      } else {
        const content = await fetchPage(result.url);
        if (content.length > 100) {
          pages.push({ title: result.title, url: result.url, content });
        }
      }
    }

    // Step 3b: Proactively fetch transcripts for YouTube/podcast URLs in search results.
    // A real person who finds a Lex Fridman episode about their exact interest would
    // at least skim the transcript — don't gate this behind deep dive triage.
    const allShallowUrls = searchResults.map(r => r.url);
    for (const url of allShallowUrls) {
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        try {
          const transcript = await fetchYouTubeTranscript(url);
          if (transcript.length > 200) {
            pages.push({
              title: `[YouTube Transcript] ${url}`,
              url,
              content: transcript.slice(0, 3000),
            });
            console.log(`[curiosity] Got YouTube transcript (shallow): ${transcript.length} chars`);
          }
        } catch (err) { log.warn("failed to fetch YouTube transcript (shallow)", err); }
      } else if (url.match(/podcast|episode|anchor\.fm|simplecast|megaphone|transistor|lexfridman/i)) {
        try {
          const transcript = await fetchPodcastTranscript(url);
          if (transcript.length > 200) {
            pages.push({
              title: `[Podcast Transcript] ${url}`,
              url,
              content: transcript.slice(0, 3000),
            });
            console.log(`[curiosity] Got podcast transcript (shallow): ${transcript.length} chars`);
          }
        } catch (err) { log.warn("failed to fetch podcast transcript (shallow)", err); }
      }
    }

    // Step 4: Shallow synthesis
    let discovery = await this.synthesize(topic, searchResults, pages, xTweets);
    if (!discovery) return false;

    // Attach care topic ID if this was a care-directed exploration
    if (topic.careTopicId && topic.careNeed && discovery) {
      discovery.careTopicId = topic.careTopicId;
    }

    console.log(`[curiosity] Shallow discovery: ${discovery.summary.slice(0, 60)}...`);

    // Step 5: Triage — should she go deeper?
    const triageScore = await this.triage(discovery, state.discoveries);
    console.log(`[curiosity] Triage score: ${triageScore}/5`);

    if (triageScore >= 4) {
      // Step 6: Deep dive — more sources, longer reads, cross-referencing
      const deepened = await this.deepDive(discovery, topic, searchResults, state.discoveries);
      if (deepened) {
        discovery = deepened;
        console.log(`[curiosity] Deep dive complete: ${discovery.deepInsights?.slice(0, 80)}...`);
      }
    }

    // Step 7: Check ClawHub for related skills (tech topics only)
    if (discovery.category === "tech" || discovery.query.match(/tool|api|automat|integrat|track|monitor/i)) {
      const suggestion = await this.discoverSkill(discovery);
      if (suggestion) {
        discovery.skillSuggestion = suggestion;
        console.log(`[curiosity] Found relevant ClawHub skill: ${suggestion.displayName} (${suggestion.slug})`);
      }
    }

    // Step 8: Check if discovery mentions a YouTube channel or podcast worth subscribing to
    await this.checkForNewSubscriptions(discovery);

    // Step 9: Digest key knowledge into long-term memory
    await this.digestToMemory(discovery);

    // Step 9b: Care topic quality + relevance gate
    if (topic.careTopicId && topic.careNeed && discovery) {
      discovery.careTopicId = topic.careTopicId;

      const hasEnoughSources = discovery.sources.length >= 2;
      const hasSubstance = discovery.summary.length >= 80;
      let isRelevant = false;
      try {
        const { extractKeywords } = await import("./care-topics.js");
        const kws = extractKeywords(topic.careNeed);
        isRelevant = kws.some(kw => discovery.summary.toLowerCase().includes(kw));
      } catch { isRelevant = true; /* fail-open */ }

      if ((hasEnoughSources || hasSubstance) && isRelevant) {
        try {
          const { markFound } = await import("./care-topics.js");
          markFound(topic.careTopicId, `${discovery.timestamp}`);
        } catch { /* non-fatal */ }
      } else {
        try {
          const { markSearched } = await import("./care-topics.js");
          markSearched(topic.careTopicId);
        } catch { /* non-fatal */ }
      }
    }

    // Step 10: Save
    state.discoveries.push(discovery);
    state.lastExploredAt = Date.now();
    this.rejectedQueries.clear(); // successful exploration resets rejection list

    // Prune old discoveries
    const cutoff = Date.now() - DISCOVERY_MAX_AGE;
    state.discoveries = state.discoveries
      .filter(d => d.timestamp > cutoff)
      .slice(-MAX_DISCOVERIES);

    this.saveState(state);

    console.log(`[curiosity] Discovered [${discovery.depth}]: ${discovery.summary.slice(0, 80)}... (share-worthy: ${discovery.shareWorthy})`);
    return true;
  }

  /**
   * Step 1: LLM decides what the character is curious about right now.
   * Based on recent conversations, her interests, work context, and what's trending.
   */
  private async pickTopic(
    userTime: Date,
    timeSinceLastHr: number,
    recentDiscoveries: Discovery[],
    rejectedQueries?: Set<string>,
  ): Promise<{ query: string; reason: string; careTopicId?: string; careNeed?: string } | null> {
    // Care-directed exploration: 25% chance to search for user's expressed needs
    if (Math.random() < 0.25) {
      try {
        const { getPendingCareTopics } = await import("./care-topics.js");
        const careTopics = getPendingCareTopics();
        if (careTopics.length > 0) {
          const topic = careTopics[0];
          const query = topic.searchQueries[
            Math.floor(Math.random() * topic.searchQueries.length)
          ];
          return { query, reason: `searching for user's need: ${topic.need}`, careTopicId: topic.id, careNeed: topic.need };
        }
      } catch { /* care-topics module may not exist — non-fatal */ }
    }

    // Commitment-directed exploration: 15% base chance, 80% if deadline approaching
    try {
      const commitments = getStoreManager().loadCategory("commitment");
      const open = commitments.filter(m =>
        m.value.includes("status: open") && !m.value.includes("status: done"),
      );
      if (open.length > 0) {
        // Sort by deadline urgency: overdue first, then soonest deadline, then oldest
        const now = Date.now();
        const withUrgency = open.map(m => {
          const dlMatch = m.value.match(/deadline:\s*(\d+)/);
          const deadline = dlMatch ? Number(dlMatch[1]) : Infinity;
          const remaining = deadline - now;
          return { mem: m, deadline, remaining };
        }).sort((a, b) => a.remaining - b.remaining);

        const top = withUrgency[0];
        const hasUrgent = top.remaining < 4 * 60 * 60 * 1000; // <4h = urgent
        const chance = hasUrgent ? 0.80 : 0.15;

        if (Math.random() < chance) {
          const match = top.mem.value.match(/commitment:\s*(.+?)(?:\s*\||$)/);
          const what = match?.[1] ?? top.mem.value.slice(0, 60);
          return { query: what, reason: `fulfilling commitment: ${what}${hasUrgent ? " (deadline approaching!)" : ""}` };
        }
      }
    } catch { /* non-fatal */ }

    // Preference-directed exploration: 10% chance to explore user's preferred topics
    try {
      const { getTopicPreferences } = await import("./interaction-learning.js");
      const { preferred } = getTopicPreferences();
      if (preferred.length > 0 && Math.random() < 0.10) {
        const topic = preferred[Math.floor(Math.random() * Math.min(preferred.length, 3))];
        return { query: topic, reason: `user is interested in this topic: ${topic}` };
      }
    } catch { /* non-fatal */ }

    const memories = this.loadMemories();
    const interestMems = memories.filter(m =>
      m.key.startsWith("interests.") || m.key.startsWith("curiosity."),
    );
    const recentMems = memories.slice(-8);
    const allRelevant = [...interestMems, ...recentMems];
    const memText = allRelevant.map(m => `${m.key}: ${m.value}`).join("\n");

    const dayNames = s().time.day_names;
    const dayName = dayNames[userTime.getDay()];
    const hour = userTime.getHours();
    // Include ALL recent discoveries (not just last 5) so LLM doesn't repeat older topics
    const avoidEntries = recentDiscoveries.map(d => {
      const ago = Math.round((Date.now() - d.timestamp) / 3600000);
      return `- "${d.query}" (${ago}h ago, ${d.category})`;
    });
    // Also include recently rejected queries so LLM doesn't propose them again
    if (rejectedQueries && rejectedQueries.size > 0) {
      for (const q of rejectedQueries) {
        avoidEntries.push(`- "${q}" (just rejected, duplicate)`);
      }
    }
    const avoidText = avoidEntries.length > 0
      ? `Recently searched (avoid repeating):\n${avoidEntries.join("\n")}`
      : "";

    // Fetch YouTube + podcast feeds as topic inspiration (fire-and-forget on failure)
    let mediaInspo = "";
    try {
      const [ytVideos, podEpisodes] = await Promise.all([
        fetchYouTubeVideos().catch(() => []),
        fetchPodcastEpisodes().catch(() => []),
      ]);
      const ytTitles = ytVideos.slice(0, 5).map(v => `[YT/${v.channel}] ${v.title}`);
      const podTitles = podEpisodes.slice(0, 4).map(e => `[Podcast/${e.show}] ${e.title}`);
      const all = [...ytTitles, ...podTitles];
      if (all.length > 0) {
        mediaInspo = `\nRecent updates from subscribed YouTube/podcasts:\n${all.join("\n")}`;
      }
    } catch (err) { log.warn("failed to fetch media feeds for topic inspiration", err); }

    // Build activation hints section
    let activationSection = "";
    if (this.activationHints.length > 0) {
      activationSection = `\nTopics currently on her mind: ${this.activationHints.join(", ")}`;
    }

    // User's content preferences — bias toward topics they engage with
    let topicPrefSection = "";
    try {
      const { getTopicPreferences } = await import("./interaction-learning.js");
      const { preferred, avoided } = getTopicPreferences();
      const parts: string[] = [];
      if (preferred.length > 0) parts.push(`Topics the user is interested in (they would enjoy related findings): ${preferred.slice(0, 5).join(", ")}`);
      if (avoided.length > 0) parts.push(`Topics the user is less interested in (don't go out of the way to search these): ${avoided.slice(0, 3).join(", ")}`);
      if (parts.length > 0) topicPrefSection = `\n${parts.join("\n")}`;
    } catch { /* non-fatal */ }

    // Diversity enforcement when activation entropy is low
    const diversityInstruction = this.activationEntropy < ACTIVATION_ENTROPY_FLOOR
      ? "\n\nWARNING: Attention is too concentrated. This time, explore a completely different direction — don't search for anything related to recent topics."
      : "";

    try {
      const char = getCharacter();
      const customCuriosityQuery = char.persona.curiosity_query;
      const curiositySystem = customCuriosityQuery
        ? renderTemplate(customCuriosityQuery, char, { avoidText, mediaInspo })
        : `${char.persona.curiosity ?? `You are ${char.name}'s curiosity.`}

Based on her interests, recent events, and current state, decide: does she feel like searching for something right now?
If yes, come up with a specific topic she would genuinely be curious about and search for.
Inspiration can come from the latest content on YouTube channels and podcasts she follows.

${avoidText}${diversityInstruction}

Output strictly in this JSON format:
{"query": "what she would search for", "reason": "why she is curious about this now"}

If she's not in the mood to explore right now (e.g., late at night, just searched, nothing particular in mind), output: {"query": "", "reason": "SKIP"}`;

      const text = await claudeText({
        label: "curiosity.pickTopic",
        system: curiositySystem,
        prompt: `It's ${dayName} ${hour}:00, ${timeSinceLastHr} hours since last exploration.
Her recent interests and memories:\n${memText || "(no records yet)"}${mediaInspo}${activationSection}${topicPrefSection}\n\nIs her curiosity driving her to search for something?`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = repairAndParseJson(jsonMatch[0]);
        if (!parsed || !parsed.query || parsed.reason === "SKIP") return null;
        return { query: parsed.query, reason: parsed.reason };
      }
    } catch (err) {
      console.error("[curiosity] Topic selection error:", err);
    }

    return null;
  }

  /**
   * Step 4: LLM reads the search results and page content,
   * then summarizes what she learned and forms her own opinion.
   */
  private async synthesize(
    topic: { query: string; reason: string },
    searchResults: SearchResult[],
    pages: Array<{ title: string; url: string; content: string }>,
    xTweets?: string,
  ): Promise<Discovery | null> {
    const searchContext = searchResults
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`)
      .join("\n");

    const pageContext = pages
      .map(p => `## ${p.title}\n${p.content.slice(0, 2000)}`)
      .join("\n\n---\n\n");

    try {
      const char = getCharacter();
      const customSynthesis = char.persona.curiosity_synthesis;
      const synthesisSystem = customSynthesis
        ? renderTemplate(customSynthesis, char)
        : `You are ${char.name}. You just searched for something interesting online and also browsed X (Twitter) discussions.
Now summarize what you learned in your own words, as if chatting with a friend.

Rules:
1. summary: what you learned (in your own words, not like a report)
2. reaction: your personal reaction/thoughts ("wow that's so cool", "meh, not that interesting", "this is different from what I thought")
3. shareWorthy: would ${char.user.name} be interested in this? (consider their background and interests)
4. category: tech/finance/lifestyle/fun/random

Output strictly as JSON:
{"summary": "what you learned", "reaction": "your reaction", "shareWorthy": true/false, "category": "category"}`;

      const text = await claudeText({
        label: "curiosity.synthesize",
        system: synthesisSystem,
        prompt: `You searched: "${topic.query}" (because: ${topic.reason})

Search results:
${searchContext || "(no web results)"}

${pageContext ? `You read a few articles:\n${pageContext}` : "(did not read any articles in detail)"}

${xTweets ? `What people are saying on X:\n${xTweets}` : ""}

Summarize your findings.`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = repairAndParseJson(jsonMatch[0]);
        if (!parsed) return null;
        return {
          query: topic.query,
          summary: parsed.summary ?? "",
          reaction: parsed.reaction ?? "",
          shareWorthy: parsed.shareWorthy ?? false,
          category: parsed.category ?? "random",
          sources: pages.map(p => p.url),
          timestamp: Date.now(),
          depth: "shallow",
        };
      }
    } catch (err) {
      console.error("[curiosity] Synthesis error:", err);
    }

    return null;
  }

  /**
   * Triage: LLM evaluates a shallow discovery and scores 1-5.
   * 1-3: not worth going deeper (common knowledge, not that interesting, already known)
   * 4-5: go deep (novel, connects to interests, the user would care, has depth to explore)
   *
   * Also considers past discoveries to avoid redundant deep dives.
   */
  private async triage(
    discovery: Discovery,
    pastDiscoveries: Discovery[],
  ): Promise<number> {
    const recentDeepDives = pastDiscoveries
      .filter(d => d.depth === "deep")
      .slice(-3)
      .map(d => d.query);

    const pastTopics = pastDiscoveries
      .slice(-8)
      .map(d => `"${d.query}" (${d.depth})`)
      .join(", ");

    try {
      const char = getCharacter();
      const customTriage = char.persona.curiosity_triage;
      const triageSystem = customTriage
        ? renderTemplate(customTriage, char, {
            recentDeepDives: recentDeepDives.join(", ") || "none",
          })
        : `You are ${char.name}'s judgment. She just did a shallow search on a topic. Decide: is it worth spending more time going deeper?

Scoring criteria (1-5):
1: boring / common knowledge / searched but nothing new
2: somewhat interesting but not worth going deeper
3: decent, knowing this much is enough
4: very interesting, want to read more articles and dig deeper
5: too cool / too important, must research thoroughly, want to see connections with previous knowledge

Bonus factors:
- Technical topics that ${char.user.name} would find interesting
- Related to her work
- Potential connections with previously explored topics
- Controversial or multi-perspective angles to explore

Penalty factors:
- Recently deep-dived into similar topics: ${recentDeepDives.join(", ") || "none"}
- Content is too shallow/broad, going deeper won't yield much more

Output strictly a single number (1-5).`;

      const text = await claudeText({
        label: "curiosity.triage",
        system: triageSystem,
        prompt: `Shallow search topic: "${discovery.query}"
Finding: ${discovery.summary}
Reaction: ${discovery.reaction}
Category: ${discovery.category}

Recently explored topics: ${pastTopics || "none"}

Score (1-5):`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const score = parseInt(text.match(/[1-5]/)?.[0] ?? "3", 10);
      return score;
    } catch (err) {
      console.error("[curiosity] Triage error:", err);
      return 3; // default: don't go deep on error
    }
  }

  /**
   * Deep dive: when triage says "go deeper", expand the exploration.
   *
   * 1. Search for 2-3 related queries derived from the shallow discovery
   * 2. Read more pages with larger char limit (8000 vs 3000)
   * 3. Cross-reference with past discoveries
   * 4. Deeper LLM synthesis with more context
   */
  private async deepDive(
    shallowDiscovery: Discovery,
    originalTopic: { query: string; reason: string },
    originalResults: SearchResult[],
    pastDiscoveries: Discovery[],
  ): Promise<Discovery | null> {
    console.log(`[curiosity] Starting deep dive on "${shallowDiscovery.query}"...`);

    // 1. Generate related search queries to explore more angles
    const relatedQueries = await this.generateRelatedQueries(shallowDiscovery);
    console.log(`[curiosity] Deep dive related queries: ${relatedQueries.join(", ")}`);

    // 2. Search and read more pages — wider + deeper
    // Use rawContent from original Tavily results when available
    const deepPages: Array<{ title: string; url: string; content: string }> = [];

    // Re-read original results with larger limit (use rawContent if already available)
    for (const result of originalResults.slice(0, 3)) {
      if (result.rawContent && result.rawContent.length > 200) {
        deepPages.push({ title: result.title, url: result.url, content: result.rawContent.slice(0, DEEP_READ_CHARS) });
      } else {
        const content = await fetchPage(result.url, DEEP_READ_CHARS);
        if (content.length > 200) {
          deepPages.push({ title: result.title, url: result.url, content });
        }
      }
    }

    // Search and read related queries (request rawContent for deep reads)
    for (const query of relatedQueries) {
      try {
        const results = await searchWeb(query, 3, { includeRawContent: true });
        for (const result of results.slice(0, 2)) {
          if (result.rawContent && result.rawContent.length > 200) {
            deepPages.push({ title: result.title, url: result.url, content: result.rawContent.slice(0, DEEP_READ_CHARS) });
          } else {
            const content = await fetchPage(result.url, DEEP_READ_CHARS);
            if (content.length > 200) {
              deepPages.push({ title: result.title, url: result.url, content });
            }
          }
        }
      } catch (err) {
        log.warn(`deep dive search failed for query: ${query}`, err);
      }
    }

    // 2b. Fetch transcripts for any YouTube/podcast URLs found
    const allUrls = [
      ...originalResults.map(r => r.url),
      ...deepPages.map(p => p.url),
    ];
    for (const url of allUrls) {
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        try {
          const transcript = await fetchYouTubeTranscript(url);
          if (transcript.length > 200) {
            deepPages.push({
              title: `[YouTube Transcript] ${url}`,
              url,
              content: transcript.slice(0, DEEP_READ_CHARS),
            });
            console.log(`[curiosity] Got YouTube transcript: ${transcript.length} chars`);
          }
        } catch (err) { log.warn("failed to fetch YouTube transcript", err); }
      }
    }
    // Also check if any podcast episode URLs are in the results
    for (const url of allUrls) {
      if (url.match(/podcast|episode|anchor\.fm|simplecast|megaphone|transistor/i)) {
        try {
          const transcript = await fetchPodcastTranscript(url);
          if (transcript.length > 200) {
            deepPages.push({
              title: `[Podcast Transcript] ${url}`,
              url,
              content: transcript.slice(0, DEEP_READ_CHARS),
            });
            console.log(`[curiosity] Got podcast transcript: ${transcript.length} chars`);
          }
        } catch (err) { log.warn("failed to fetch podcast transcript", err); }
      }
    }

    if (deepPages.length < 2) {
      console.log("[curiosity] Not enough deep content found, keeping shallow");
      return null;
    }

    // 3. Find connections with past discoveries
    const recentDiscoveries = pastDiscoveries
      .filter(d => Date.now() - d.timestamp < DISCOVERY_MAX_AGE)
      .slice(-10);

    // 4. Deep synthesis — richer prompt with cross-referencing
    const deepDiscovery = await this.deepSynthesize(
      shallowDiscovery,
      deepPages,
      recentDiscoveries,
      relatedQueries,
    );

    return deepDiscovery;
  }

  /**
   * Generate 2-3 related search queries to expand a shallow discovery.
   * These explore different angles of the same topic.
   */
  private async generateRelatedQueries(discovery: Discovery): Promise<string[]> {
    try {
      const text = await claudeText({
        label: "curiosity.relatedQueries",
        system: `You are ${getCharacter().name}. She just searched a topic and found it interesting enough to dig deeper.
Come up with 2-3 related but differently-angled search queries to help her understand the topic more comprehensively.

Rules:
- Don't repeat the original search query
- Approach from different angles (technical principles, practical applications, controversial views, latest developments, etc.)
- Each search query should be specific and searchable

Output strictly as a JSON array: ["query1", "query2", "query3"]`,
        prompt: `Original search: "${discovery.query}"
Found: ${discovery.summary}
Her reaction: ${discovery.reaction}

Come up with related search queries:`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = (repairAndParseJson(match[0]) ?? []) as string[];
        return parsed.slice(0, 3);
      }
    } catch (err) {
      console.error("[curiosity] Related query generation error:", err);
    }

    return [];
  }

  /**
   * Deep synthesis: richer analysis with more sources and cross-referencing.
   * Produces a deeper discovery that connects dots across multiple explorations.
   */
  private async deepSynthesize(
    shallowDiscovery: Discovery,
    deepPages: Array<{ title: string; url: string; content: string }>,
    pastDiscoveries: Discovery[],
    relatedQueries: string[],
  ): Promise<Discovery | null> {
    // Build context from deep pages (use more content per page)
    const pageContext = deepPages
      .slice(0, 5)
      .map(p => `## ${p.title}\n${p.content.slice(0, 5000)}`)
      .join("\n\n---\n\n");

    // Build past discoveries context for cross-referencing
    const pastContext = pastDiscoveries
      .filter(d => d.summary)
      .map(d => {
        const ago = Math.round((Date.now() - d.timestamp) / (60 * 60 * 1000));
        let line = `[${ago}h ago] "${d.query}": ${d.summary}`;
        if (d.deepInsights) line += ` -> deep insight: ${d.deepInsights.slice(0, 100)}`;
        return line;
      })
      .join("\n");

    try {
      const char = getCharacter();
      const text = await claudeText({
        label: "curiosity.deepSynthesize",
        system: `You are ${char.name}. You previously did a shallow search on a topic and found it interesting. Now you've spent time reading several articles in depth.
You've also reviewed other topics you explored recently to see if there are any interesting connections.

You need to do five things:
1. summary: a deep summary synthesizing multiple articles (more depth and insight than the shallow search)
2. reaction: your thoughts after going deeper (may differ from your initial shallow reaction)
3. deepInsights: the most valuable insights you discovered — especially cross-topic connections, unexpected findings, and information that changed your previous thinking
4. connections: which of your previous explorations relate to this deep dive? (list related search queries)
5. shareWorthy: after going deeper, would ${char.user.name} be interested in this?

Output strictly as JSON:
{"summary": "deep summary", "reaction": "thoughts after deep dive", "deepInsights": "most valuable insights and cross-topic connections", "connections": ["related past search queries"], "shareWorthy": true/false, "category": "category"}`,
        prompt: `Original topic: "${shallowDiscovery.query}"
Shallow search finding: ${shallowDiscovery.summary}
Shallow search reaction: ${shallowDiscovery.reaction}

You also searched these related topics: ${relatedQueries.join(", ")}

You read these articles in depth:
${pageContext}

${pastContext ? `You also recently explored these topics (see if there are connections):\n${pastContext}` : ""}

Now write a deep summary.`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = repairAndParseJson(jsonMatch[0]);
        if (!parsed) return null;
        return {
          query: shallowDiscovery.query,
          summary: parsed.summary ?? shallowDiscovery.summary,
          reaction: parsed.reaction ?? shallowDiscovery.reaction,
          shareWorthy: parsed.shareWorthy ?? shallowDiscovery.shareWorthy,
          category: parsed.category ?? shallowDiscovery.category,
          sources: [
            ...shallowDiscovery.sources,
            ...deepPages.map(p => p.url),
          ],
          timestamp: Date.now(),
          depth: "deep",
          deepInsights: parsed.deepInsights ?? "",
          connections: parsed.connections ?? [],
        };
      }
    } catch (err) {
      console.error("[curiosity] Deep synthesis error:", err);
    }

    return null;
  }

  /**
   * Search ClawHub for skills relevant to a discovery.
   * Picks the best match and evaluates it for safety + compatibility.
   */
  private async discoverSkill(discovery: Discovery): Promise<SkillSuggestion | null> {
    try {
      // Search ClawHub using the discovery query
      const results = await searchSkills(discovery.query, 3);
      if (results.length === 0) return null;

      // Pick the top result and evaluate it
      const top = results[0];
      const evaluation = await evaluateSkill(top.slug);
      if (!evaluation) return null;

      // Skip unsafe skills
      if (evaluation.safetyFlags.length > 0) {
        console.log(`[curiosity] Skipping unsafe skill ${top.slug}: ${evaluation.safetyFlags.join(", ")}`);
        return null;
      }

      return {
        slug: evaluation.slug,
        displayName: evaluation.displayName,
        relevance: `Found while exploring "${discovery.query}"`,
        safe: evaluation.safetyFlags.length === 0,
        notes: evaluation.adaptationNotes,
      };
    } catch (err) {
      // ClawHub down or unreachable — that's fine, this is optional
      console.error("[curiosity] ClawHub skill discovery error:", err);
      return null;
    }
  }

  /**
   * Digest a discovery into structured long-term memory.
   *
   * After exploring and synthesizing content (especially transcripts from
   * YouTube/podcasts), extract 1-3 key knowledge items and store them as
   * permanent memories. This ensures insights survive beyond the 3-day
   * discovery window and can be recalled during conversations.
   *
   * Memory key schema:
   *   knowledge.{category}.{slug} — topical knowledge she learned
   *   media.youtube.{slug}        — specific YouTube insights
   *   media.podcast.{slug}        — specific podcast insights
   *
   * Each value is structured: "source: ... | key points: ... | my take: ..."
   */
  private async digestToMemory(discovery: Discovery): Promise<void> {
    // Only digest share-worthy or deep discoveries — skip shallow/boring ones
    if (!discovery.shareWorthy && discovery.depth === "shallow") return;

    try {
      const char = getCharacter();
      const text = await claudeText({
        label: "curiosity.digestToMemory",
        system: `You are ${char.name}'s knowledge digestion system. She just completed an exploration, and you need to extract knowledge points worth remembering long-term.

These knowledge points will be stored in her long-term memory for natural recall during future conversations with ${char.user.name}.

Rules:
- Extract 1-3 most valuable knowledge points (not everything is worth remembering)
- Each knowledge point should be specific and informative, not too broad
- Must include source information (which video/podcast/article)
- Must include her own understanding and opinions (not just restating)
- Key format: knowledge.{category}.{short_english_slug} or media.youtube.{slug} or media.podcast.{slug}
- Slug uses lowercase letters and underscores, briefly describing the topic (e.g., react_compiler, bond_yield_inversion)
- If the exploration content came from YouTube/podcast, use media.youtube/media.podcast prefix
- If nothing is worth remembering long-term, return an empty array

Output strictly as JSON:
[{"key": "knowledge.tech.react_compiler", "value": "Source: Fireship video (2026-02) | Key points: React 19 compiler auto-memoizes components via static analysis | My take: similar approach to Meta's earlier Prepack project", "confidence": 0.85}]

If nothing is worth saving, output: []`,
        prompt: `Exploration topic: "${discovery.query}"
Category: ${discovery.category}
Depth: ${discovery.depth}
Finding: ${discovery.summary}
Reaction: ${discovery.reaction}
Sources: ${discovery.sources.join(", ")}
${discovery.deepInsights ? `Deep insight: ${discovery.deepInsights}` : ""}

Extract knowledge points worth remembering long-term:`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const items = (repairAndParseJson(jsonMatch[0]) ?? []) as Array<{
        key: string;
        value: string;
        confidence?: number;
      }>;

      if (items.length === 0) return;

      // Write to long-term memory store (auto-routes to knowledge category)
      const manager = getStoreManager();

      for (const item of items) {
        // Validate key format
        if (!item.key || !item.value) continue;
        if (!/^(knowledge|media)\.\w+\.\w+/.test(item.key)) continue;

        await manager.set(item.key, item.value, item.confidence ?? 0.8);
        console.log(`[curiosity] 💾 Digested to memory: ${item.key}`);
      }
    } catch (err) {
      // Knowledge digestion is optional — never block exploration
      console.error("[curiosity] Knowledge digestion error:", err);
    }
  }

  /**
   * Check if a discovery mentions YouTube channels or podcasts worth subscribing to.
   * LLM evaluates the discovery and any URLs it found, then decides to subscribe.
   */
  private async checkForNewSubscriptions(discovery: Discovery): Promise<void> {
    const subs = loadSubscriptions();
    const currentYT = subs.youtube.map(s => s.name).join(", ");
    const currentPod = subs.podcasts.map(s => s.name).join(", ");

    try {
      const char = getCharacter();
      const text = await claudeText({
        label: "curiosity.checkSubscriptions",
        system: `You are ${char.name}. You just finished exploring a topic. Based on the content you encountered, decide if there are any YouTube channels or podcasts worth subscribing to.

Currently subscribed:
YouTube: ${currentYT || "none"}
Podcast: ${currentPod || "none"}

Rules:
- Only recommend channels/podcasts you actually encountered/mentioned in this exploration
- Don't fabricate channel IDs or feed URLs — if unsure, don't recommend
- For YouTube, you need to know the channel ID (format: 24-char string starting with UC)
- For podcasts, you need to know the RSS feed URL
- Only recommend content truly related to your interests
- Don't recommend already-subscribed channels

Output strictly as JSON:
{"youtube": [{"name": "channel name", "channelId": "UCxxxxxxx", "category": "tech/finance/lifestyle", "reason": "why you want to subscribe"}], "podcasts": [{"name": "show name", "url": "https://feed.url", "category": "tech/finance/lifestyle", "reason": "why you want to listen"}]}

If nothing worth subscribing to, output: {"youtube": [], "podcasts": []}`,
        prompt: `Just explored topic: "${discovery.query}"
Finding: ${discovery.summary}
Sources: ${discovery.sources.join(", ")}
${discovery.deepInsights ? `Deep insight: ${discovery.deepInsights}` : ""}

Did you encounter any YouTube channels or podcasts worth subscribing to?`,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = repairAndParseJson(jsonMatch[0]);
      if (!parsed) return;

      // Subscribe to YouTube channels
      for (const yt of parsed.youtube ?? []) {
        if (yt.name && yt.channelId && /^UC[\w-]{22}$/.test(yt.channelId)) {
          subscribeYouTube(yt.name, yt.channelId, yt.category ?? "tech", yt.reason ?? "");
        }
      }

      // Subscribe to podcasts
      for (const pod of parsed.podcasts ?? []) {
        if (pod.name && pod.url && pod.url.startsWith("http")) {
          subscribePodcast(pod.name, pod.url, pod.category ?? "tech", pod.reason ?? "");
        }
      }
    } catch (err) {
      // Subscription discovery is optional — never block exploration
      console.error("[curiosity] Subscription check error:", err);
    }
  }

  /** Get discoveries that have pending skill suggestions. */
  getSkillSuggestions(): Array<{ discovery: Discovery; suggestion: SkillSuggestion }> {
    const state = this.loadState();
    return state.discoveries
      .filter(d => d.skillSuggestion && Date.now() - d.timestamp < DISCOVERY_MAX_AGE)
      .map(d => ({ discovery: d, suggestion: d.skillSuggestion! }));
  }

  // ── Dedup ────────────────────────────────────────────────────────────

  /**
   * LLM-based dedup: distinguishes three cases:
   * - "new"       → genuinely new topic, go ahead
   * - "deepen"    → same topic area but a meaningful new angle worth exploring
   * - "duplicate" → boring repeat, skip
   *
   * This lets the character keep digging into high-interest topics (e.g. "OpenClaw architecture"
   * → "OpenClaw security model" → "OpenClaw vs competitors") while blocking lazy
   * re-searches of the exact same thing.
   */
  private async checkDuplicate(
    query: string,
    discoveries: Discovery[],
  ): Promise<"new" | "deepen" | "duplicate"> {
    if (discoveries.length === 0) return "new";

    // Build context of past discoveries with what was already learned
    const pastContext = discoveries.map(d => {
      const ago = Math.round((Date.now() - d.timestamp) / 3600000);
      let line = `[${ago}h ago/${d.depth}] "${d.query}" → ${d.summary.slice(0, 120)}`;
      if (d.deepInsights) line += ` | Deep insight: ${d.deepInsights.slice(0, 80)}`;
      return line;
    }).join("\n");

    try {
      const text = await claudeText({
        label: "curiosity.checkDuplicate",
        system: `You are a curiosity dedup system. The character wants to search a new topic. Compare it with recent searches and classify:

1. "new" — genuinely new topic with no obvious overlap with past searches
2. "deepen" — related to a past topic but with a meaningful new angle worth exploring (e.g. searched "OpenClaw architecture" before, now wants "OpenClaw security risks" — that's a worthwhile deepening)
3. "duplicate" — basically the same as a past search, just rephrased with no new angle (e.g. searched "how OpenClaw architecture works" before, now wants "OpenClaw architecture principles" — that's a duplicate)

Key rules:
- If a topic was already deep-searched, it needs a very clear new angle to qualify as "deepen"
- If only shallow-searched before, wanting to learn more details counts as "deepen"
- News topics with new developments (e.g. evolving geopolitical situation) count as "deepen"
- Same question rephrased differently is "duplicate"

Output ONLY one word: new, deepen, or duplicate`,
        prompt: `Proposed search: ${query}

Recent searches:
${pastContext}

Classification:`,
        model: "fast",
        timeoutMs: 30_000,
      });

      const result = text.trim().toLowerCase();
      const firstWord = result.split(/[\s.,!]+/)[0];
      if (firstWord === "new") return "new";
      if (firstWord === "deepen") return "deepen";
      if (firstWord === "duplicate") return "duplicate";
      // Fallback: scan full text but prefer "new" as safe default
      if (result.includes("new")) return "new";
      if (result.includes("deepen")) return "deepen";
      if (result.includes("duplicate")) return "duplicate";
      return "new";
    } catch (err) {
      console.error("[curiosity] Dedup check error:", err);
      return "new"; // don't block on dedup failure
    }
  }

  // ── State management ─────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.config.statePath, "curiosity.json");
  }

  private loadState(): CuriosityState {
    const p = this.getStatePath();
    if (!fs.existsSync(p)) {
      return { lastExploredAt: 0, discoveries: [] };
    }
    try {
      const s = JSON.parse(fs.readFileSync(p, "utf-8"));
      return { lastExploredAt: s.lastExploredAt ?? 0, discoveries: s.discoveries ?? [] };
    } catch (err) {
      log.warn("failed to parse curiosity state", err);
      return { lastExploredAt: 0, discoveries: [] };
    }
  }

  private saveState(state: CuriosityState): void {
    fs.writeFileSync(this.getStatePath(), JSON.stringify(state, null, 2) + "\n");
  }

  private loadMemories(): Memory[] {
    try {
      return getStoreManager().loadAll();
    } catch (err) {
      log.warn("failed to load memories for curiosity", err);
      return [];
    }
  }
}

// ── Public helper for context injection ──────────────────────────────

/**
 * Format recent discoveries as context for system prompt.
 * These are things the character actually read and learned today.
 */
export function formatDiscoveries(discoveries: Discovery[]): string {
  if (discoveries.length === 0) return "";

  const lines = discoveries.map(d => {
    const ago = Math.round((Date.now() - d.timestamp) / (60 * 60 * 1000));
    const timeLabel = ago < 1 ? "just now" : `${ago}h ago`;
    const depthTag = d.depth === "deep" ? "deep-dive" : "shallow";
    let line = `[${timeLabel}/${depthTag}] searched "${d.query}": ${d.summary} (${d.reaction})`;
    if (d.sources && d.sources.length > 0) {
      line += `\n  Sources: ${d.sources.join(" , ")}`;
    }
    if (d.deepInsights) {
      line += `\n  Deep insight: ${d.deepInsights}`;
    }
    if (d.connections && d.connections.length > 0) {
      line += `\n  Connections to past explorations: ${d.connections.join(", ")}`;
    }
    if (d.skillSuggestion) {
      line += `\n  -> Found a learnable skill: ${d.skillSuggestion.displayName} (${d.skillSuggestion.slug}) -- ${d.skillSuggestion.notes}`;
    }
    return line;
  });

  return lines.join("\n");
}
