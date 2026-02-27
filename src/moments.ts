/**
 * Character's timeline — Telegram Channel as social feed.
 *
 * Posts life moments to a Telegram channel, creating a persistent,
 * scrollable feed of the character's inner life:
 *   - Emotion micro-events (vivid mood shifts)
 *   - Selfies (photos with captions)
 *   - Activity results (vibe coding, deep reading, learning)
 *   - Discoveries (curiosity explorations)
 *   - Thoughts (reflective moments during quiet times)
 *   - X cross-posts (when she posts on Twitter)
 *
 * Dedup/throttle: max ~6 posts/day, min 1h between posts.
 * Style: casual first-person posts, like real social media updates.
 */

import fs from "node:fs";
import path from "node:path";
import type { Telegraf } from "telegraf";
import type { AppConfig } from "./types.js";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { claudeText } from "./claude-runner.js";
import { createLogger } from "./lib/logger.js";
import { formatTimelineContext } from "./timeline.js";
import { getEmotionalState } from "./emotion.js";
import { getUserTZ } from "./lib/pst-date.js";
import { getCharacter } from "./character.js";

const log = createLogger("moments");

// ── Types ────────────────────────────────────────────────────────────

export type MomentType =
  | "emotion"     // vivid mood shift / micro-event
  | "selfie"      // photo with caption
  | "activity"    // vibe coding / reading / learning result
  | "discovery"   // curiosity exploration find
  | "thought"     // reflective text during quiet moments
  | "xpost";      // cross-post from X/Twitter

interface MomentRecord {
  id: string;
  type: MomentType;
  text: string;
  mediaPath?: string;      // local image path (for selfies)
  timestamp: number;
  channelMessageId?: number;
  sourceEvent?: string;    // original microEvent — for dedup across cached emotion refreshes
}

interface MomentsState {
  /** All posted moments (rolling window) */
  moments: MomentRecord[];
  /** Tracks daily post count */
  dailyDate: string;
  dailyCount: number;
  /** Timestamp of last posted moment */
  lastPostedAt: number;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_STORED_MOMENTS = 50;

// ── Module state ─────────────────────────────────────────────────────

let config: AppConfig | null = null;
let bot: Telegraf | null = null;
let stateFilePath = "";

// ── Init ─────────────────────────────────────────────────────────────

export function initMoments(cfg: AppConfig, telegrafBot: Telegraf): void {
  if (!cfg.momentsChannelId) {
    log.info("Moments disabled (no momentsChannelId configured)");
    return;
  }

  config = cfg;
  bot = telegrafBot;
  stateFilePath = path.join(cfg.statePath, "moments-state.json");

  log.info(`Moments enabled → channel: ${cfg.momentsChannelId}`);
}

export function isMomentsEnabled(): boolean {
  return !!(config?.momentsChannelId && bot);
}

/**
 * Get recent Moments posts for inclusion in conversation context.
 * Returns the last N moments so the character knows what was posted.
 */
export function getRecentMoments(limit = 8): Array<{ text: string; type: MomentType; timestamp: number }> {
  const state = loadState();
  return state.moments.slice(-limit).map((m) => ({
    text: m.text,
    type: m.type,
    timestamp: m.timestamp,
  }));
}

// ── State helpers ────────────────────────────────────────────────────

function loadState(): MomentsState {
  if (!stateFilePath) return { moments: [], dailyDate: "", dailyCount: 0, lastPostedAt: 0 };
  return readJsonSafe<MomentsState>(stateFilePath, {
    moments: [],
    dailyDate: "",
    dailyCount: 0,
    lastPostedAt: 0,
  });
}

function saveState(state: MomentsState): void {
  if (!stateFilePath) return;
  // Prune old moments
  state.moments = state.moments.slice(-MAX_STORED_MOMENTS);
  writeJsonAtomic(stateFilePath, state);
}

// ── Throttle check ───────────────────────────────────────────────────

function canPost(): boolean {
  return isMomentsEnabled();
}

// ── Core: Post a moment ──────────────────────────────────────────────

/**
 * Post a moment to the Telegram channel.
 * Handles text-only and photo+caption formats.
 */
export async function postMoment(
  type: MomentType,
  text: string,
  mediaPath?: string,
  sourceEvent?: string,
): Promise<boolean> {
  // Emotions and selfies are always worth sharing — skip interval/daily throttle
  const alwaysPost = type === "emotion" || type === "selfie";
  if (!alwaysPost && !canPost()) return false;
  if (!bot || !config?.momentsChannelId) return false;

  const channelId = config.momentsChannelId;

  try {
    let messageId: number | undefined;

    if (mediaPath && fs.existsSync(mediaPath)) {
      // Photo + caption
      const msg = await bot.telegram.sendPhoto(
        channelId,
        { source: mediaPath },
        { caption: text },
      );
      messageId = msg.message_id;
    } else {
      // Text only
      const msg = await bot.telegram.sendMessage(channelId, text);
      messageId = msg.message_id;
    }

    // Record
    const state = loadState();
    const record: MomentRecord = {
      id: `${Date.now()}-${type}`,
      type,
      text,
      mediaPath,
      timestamp: Date.now(),
      channelMessageId: messageId,
      ...(sourceEvent ? { sourceEvent } : {}),
    };
    state.moments.push(record);
    state.lastPostedAt = Date.now();
    state.dailyCount++;
    saveState(state);

    log.info(`Posted ${type} moment: "${text.slice(0, 50)}..."`);
    return true;
  } catch (err) {
    log.error(`Failed to post ${type} moment`, err);
    return false;
  }
}

// ── Moment generators ────────────────────────────────────────────────

/**
 * Generate and post an emotion moment from a micro-event.
 * Called when the emotion engine produces a vivid micro-event.
 */
export async function postEmotionMoment(
  mood: string,
  microEvent: string,
  cause: string,
): Promise<boolean> {
  // Skip canPost() — emotions bypass daily/interval throttle via postMoment's alwaysPost.
  // But enforce a dedicated emotion cooldown to prevent the same cached micro-event
  // from being posted repeatedly (emotion state is cached ~2h, heartbeat fires every 5min).
  if (!isMomentsEnabled()) return false;
  if (!microEvent && !cause) return false;

  // Dedup: skip if this exact microEvent was already posted as a moment today.
  // (Emotion cache returns the same microEvent for ~2h; heartbeat fires every 5min.)
  const state = loadState();
  const recentEmotionMoments = state.moments.filter(
    (m) => m.type === "emotion" && Date.now() - m.timestamp < 24 * 60 * 60 * 1000,
  );
  if (recentEmotionMoments.some((m) => m.sourceEvent === microEvent)) {
    log.info("Emotion moment already posted for this microEvent, skipping");
    return false;
  }

  try {
    const emotionPrompt = getCharacter().persona.moments_emotion;
    if (!emotionPrompt) return false; // skip if no prompt configured
    const caption = await claudeText({
      system: emotionPrompt,
      prompt: `Mood: ${mood}\nWhat happened: ${microEvent || cause}`,
      model: "fast",
      timeoutMs: 30_000,
    });

    if (!caption || caption.length < 3) return false;
    return await postMoment("emotion", caption.trim(), undefined, microEvent);
  } catch (err) {
    log.error("Failed to generate emotion moment", err);
    return false;
  }
}

/**
 * Post a selfie moment (photo + caption).
 * Called when selfie.ts generates a new selfie.
 */
export async function postSelfieMoment(
  imagePath: string,
  trigger: string,
): Promise<boolean> {
  // Skip canPost() — selfies bypass throttle via postMoment's alwaysPost
  if (!isMomentsEnabled()) return false;

  try {
    // Gather real context so the caption reflects what she's actually doing
    const timelineCtx = formatTimelineContext();
    const emotion = await getEmotionalState(undefined, undefined);
    const moodLine = emotion
      ? `Mood: ${emotion.mood} (valence ${emotion.valence}/10, energy ${emotion.energy}/10)`
      : "";

    const selfiePrompt = getCharacter().persona.moments_selfie;
    if (!selfiePrompt) return false; // skip if no prompt configured
    const caption = await claudeText({
      system: selfiePrompt,
      prompt: `Photo scene: ${trigger}\n${moodLine}\n${timelineCtx}`,
      model: "fast",
      timeoutMs: 30_000,
    });

    const text = caption?.trim() || "📸";
    return await postMoment("selfie", text, imagePath);
  } catch (err) {
    log.error("Failed to post selfie moment", err);
    return false;
  }
}

/**
 * Post an activity result moment.
 * Called after activities.ts completes an activity (vibe coding, reading, learning).
 */
export async function postActivityMoment(
  activityType: string,
  title: string,
  summary: string,
  reaction: string,
): Promise<boolean> {
  if (!canPost()) return false;

  try {
    const activityPrompt = getCharacter().persona.moments_activity;
    if (!activityPrompt) return false; // skip if no prompt configured
    const caption = await claudeText({
      system: activityPrompt,
      prompt: `Activity type: ${activityType}\nWhat I did: ${title}\nSummary: ${summary}\nReaction: ${reaction}`,
      model: "fast",
      timeoutMs: 30_000,
    });

    if (!caption || caption.length < 5) return false;
    return await postMoment("activity", caption.trim());
  } catch (err) {
    log.error("Failed to post activity moment", err);
    return false;
  }
}

/**
 * Post a discovery moment.
 * Called when curiosity.ts finds something share-worthy.
 */
export async function postDiscoveryMoment(
  query: string,
  summary: string,
  reaction: string,
  sources: string[],
): Promise<boolean> {
  if (!canPost()) return false;

  try {
    const discoveryPrompt = getCharacter().persona.moments_discovery;
    if (!discoveryPrompt) return false; // skip if no prompt configured
    const caption = await claudeText({
      system: discoveryPrompt,
      prompt: `Searched for: ${query}\nDiscovery: ${summary}\nReaction: ${reaction}\nSources: ${sources.slice(0, 2).join(", ")}`,
      model: "fast",
      timeoutMs: 30_000,
    });

    if (!caption || caption.length < 5) return false;

    // Append first source link if the LLM didn't include one
    let text = caption.trim();
    if (sources.length > 0 && !text.includes("http")) {
      text += `\n${sources[0]}`;
    }

    return await postMoment("discovery", text);
  } catch (err) {
    log.error("Failed to post discovery moment", err);
    return false;
  }
}

/**
 * Post a thought/reflection moment.
 * Called during quiet/rest periods when she has something on her mind.
 */
export async function postThoughtMoment(
  mood: string,
  cause: string,
  threads: string,
): Promise<boolean> {
  if (!canPost()) return false;

  try {
    const thoughtPrompt = getCharacter().persona.moments_thought;
    if (!thoughtPrompt) return false; // skip if no prompt configured
    const caption = await claudeText({
      system: thoughtPrompt,
      prompt: `Mood: ${mood}\nCause: ${cause}\nOn my mind: ${threads || "(nothing in particular)"}`,
      model: "fast",
      timeoutMs: 30_000,
    });

    if (!caption || caption.length < 5) return false;
    return await postMoment("thought", caption.trim());
  } catch (err) {
    log.error("Failed to post thought moment", err);
    return false;
  }
}

/**
 * Cross-post an X/Twitter post as a moment.
 */
export async function postXCrossMoment(tweetText: string): Promise<boolean> {
  if (!canPost()) return false;
  if (!tweetText) return false;

  // Post the tweet text directly — it's already in the character's voice
  return await postMoment("xpost", tweetText);
}

// ── Heartbeat integration ────────────────────────────────────────────

/**
 * Called by heartbeat after each action completes.
 * Evaluates whether the result is moment-worthy and posts if so.
 *
 * This is the main integration point — lightweight check + conditional post.
 */
export async function maybeMoment(
  action: string,
  result: {
    // For explore
    discovery?: { query: string; summary: string; reaction: string; shareWorthy: boolean; sources: string[] };
    // For activity
    activity?: { type: string; title: string; summary: string; reaction: string; shareWorthy: boolean };
    // For post (X cross-post)
    xPostText?: string;
    // For emotion (rest/any action)
    emotion?: { mood: string; microEvent: string; cause: string; valence: number };
    // For selfie
    selfie?: { imagePath: string; trigger: string };
  },
): Promise<void> {
  if (!isMomentsEnabled()) return;

  try {
    switch (action) {
      case "explore":
        if (result.discovery?.shareWorthy) {
          await postDiscoveryMoment(
            result.discovery.query,
            result.discovery.summary,
            result.discovery.reaction,
            result.discovery.sources,
          );
        }
        break;

      case "activity":
        if (result.activity?.shareWorthy) {
          await postActivityMoment(
            result.activity.type,
            result.activity.title,
            result.activity.summary,
            result.activity.reaction,
          );
        }
        break;

      case "post":
        if (result.xPostText) {
          await postXCrossMoment(result.xPostText);
        }
        break;

      case "rest":
        // During rest, occasionally post a thought if the emotion is vivid
        if (result.emotion && result.emotion.microEvent && result.emotion.valence <= 4) {
          // Only post thoughts when mood is notably low (more interesting than "calm")
          await postEmotionMoment(
            result.emotion.mood,
            result.emotion.microEvent,
            result.emotion.cause,
          );
        } else if (result.emotion?.microEvent && Math.random() < 0.15) {
          // 15% chance to post any vivid micro-event during rest
          await postEmotionMoment(
            result.emotion.mood,
            result.emotion.microEvent,
            result.emotion.cause,
          );
        }
        break;
    }
  } catch (err) {
    // Moments are non-critical — never block heartbeat
    log.error("maybeMoment error", err);
  }
}

// ── Selfie hook ──────────────────────────────────────────────────────

/**
 * Hook called when selfie.ts generates a new selfie.
 * Posts it as a moment if enabled and within throttle limits.
 */
export async function onSelfieGenerated(
  imagePath: string,
  trigger: string,
): Promise<void> {
  if (!isMomentsEnabled()) return;
  try {
    await postSelfieMoment(imagePath, trigger);
  } catch (err) {
    log.error("onSelfieGenerated error", err);
  }
}
