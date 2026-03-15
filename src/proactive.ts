/**
 * Proactive outreach — gives the character the opportunity to reach out to the user.
 *
 * Philosophy: The system doesn't decide WHAT to say or WHEN to say it.
 * It periodically asks the character (via LLM): "Do you want to chat with the user about something?"
 * She decides based on context — recent conversations, memories, time of day,
 * what's on her mind. Most of the time she'll skip. When she does reach out,
 * it's because she genuinely has something to say.
 *
 * This is NOT a cron job that fires templated messages.
 * This is giving a friend the space to think of you.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "./claude-runner.js";
import type { AppConfig, Memory } from "./types.js";
import { SessionManager } from "./session/manager.js";
import { fetchMarketSnapshot, getWorkContext } from "./world.js";
import { discoverContent, getInterestSummary, discoverYouTube, discoverPodcasts } from "./interests.js";
import { getEmotionalState, formatEmotionContext, getEmotionTransition } from "./emotion.js";
import { getBodyState } from "./body.js";
import { getSocialContext } from "./friends.js";
import type { CuriosityEngine } from "./curiosity.js";
import { formatDiscoveries } from "./curiosity.js";
import type { ActivityScheduler } from "./activities.js";
import { formatNotificationContext } from "./notifications.js";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { getStoreManager } from "./memory/store-manager.js";
import { generateSelfie, isVisualIdentityEnabled, getSelfieDailyCount } from "./selfie.js";
import type { SelfieTrigger } from "./selfie.js";
import { isVideoEnabled, generateVideoFromImage } from "./video.js";
import { generateVoice, isTTSEnabled, getVoiceDailyCount } from "./tts.js";
import { addTimelineEvent, enqueueTimelineJob, getTodayTimeline } from "./timeline.js";
import { getCharacter, s, renderTemplate } from "./character.js";
import { recordCharacterOutreach, markAwaitingReply, isGoodTimeToReachOut, getAttachmentState } from "./lib/relationship-model.js";
import { recordProactiveSent, getTimingAdvice, formatLearningContext, extractTopicsFromText, getTopicPreferences, getPendingProactive, getRecentProactiveSummaries } from "./interaction-learning.js";
import { checkProactiveGate } from "./lib/action-gate.js";
import { formatPredictions, getUserState } from "./user-state.js";
import { createLogger } from "./lib/logger.js";

const MIN_DAILY_SELFIES = 5;
const MIN_DAILY_VOICES = 5;

const randMs = (minMin: number, maxMin: number) =>
  (minMin + Math.random() * (maxMin - minMin)) * 60 * 1000;

/** The magic word: if the LLM returns this, she chose not to reach out */
const SKIP_TOKEN = "SKIP";

const log = createLogger("proactive");

/** Get proactive gap with relationship-phase multiplier bias. */
function getProactiveGapMs(sent: boolean): number {
  const baseline = sent ? randMs(20, 45) : randMs(15, 30);
  try {
    const attachment = getAttachmentState();
    if (attachment.phaseConfidence < 0.6) return baseline; // low confidence -> no change
    let multiplier = 1.0;
    if (attachment.stage === "anxious") multiplier = 0.7;
    else if (attachment.stage === "ruminating" && attachment.lastMessageUnanswered) multiplier = 2.5;
    else if (attachment.stage === "secure") multiplier = 1.1;
    if (multiplier !== 1.0) {
      log.info(`suppression: attachment-phase multiplier (stage=${attachment.stage}, multiplier=${multiplier})`);
    }
    return baseline * multiplier;
  } catch { /* non-fatal */ }
  return baseline;
}

interface ProactiveState {
  lastSentAt: number;
  dailyCount: number;
  dailyDate: string;
  lastUserMessageAt: number;
}

type SendFn = (text: string) => Promise<void>;
type SendPhotoFn = (photo: Buffer, caption?: string) => Promise<void>;
type SendVideoFn = (video: Buffer, caption?: string) => Promise<void>;
type SendVoiceFn = (audio: Buffer, caption?: string) => Promise<void>;

export class ProactiveScheduler {
  private config: AppConfig;
  private session: SessionManager;
  private sendMessage: SendFn;
  private sendPhoto: SendPhotoFn | null = null;
  private sendVideo: SendVideoFn | null = null;
  private sendVoice: SendVoiceFn | null = null;
  private statePath: string;
  private stopped = false;
  private inFlight = false; // mutex: only one maybeReachOut() at a time
  private curiosity: CuriosityEngine | null;
  private activities: ActivityScheduler | null;

  constructor(config: AppConfig, session: SessionManager, sendMessage: SendFn, curiosity?: CuriosityEngine, activities?: ActivityScheduler) {
    this.config = config;
    this.session = session;
    this.sendMessage = sendMessage;
    this.statePath = path.join(config.statePath, "proactive.json");
    this.curiosity = curiosity ?? null;
    this.activities = activities ?? null;
  }

  /** Set photo sending callback for selfie attachment. */
  setSendPhoto(fn: SendPhotoFn): void {
    this.sendPhoto = fn;
  }

  /** Set video sending callback for video selfie attachment. */
  setSendVideo(fn: SendVideoFn): void {
    this.sendVideo = fn;
  }

  /** Set voice sending callback for voice message attachment. */
  setSendVoice(fn: SendVoiceFn): void {
    this.sendVoice = fn;
  }

  /** Set activities reference so proactive can see share-worthy learning. */
  setActivities(activities: ActivityScheduler): void {
    this.activities = activities;
  }

  start(): void {
    console.log("[proactive] Started");
    setTimeout(() => this.loop(), randMs(5, 15));
  }

  stop(): void { this.stopped = true; }

  /**
   * Public entry point for the heartbeat.
   * Runs one outreach cycle without self-scheduling.
   * Returns true if a message was actually sent.
   */
  async tick(): Promise<boolean> {
    try {
      return await this.maybeReachOut();
    } catch (e) {
      console.error("[proactive] tick error:", e);
      return false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const sent = await this.maybeReachOut();
      // After sending: 20-45 min gap; after skip: try again in 15-30 min (with relationship multiplier)
      setTimeout(() => this.loop(), getProactiveGapMs(sent));
    } catch (e) {
      console.error("[proactive] Error:", e);
      setTimeout(() => this.loop(), randMs(20, 40));
    }
  }

  /** Called when the user sends a message — resets idle awareness. */
  recordUserActivity(): void {
    const state = this.loadState();
    state.lastUserMessageAt = Date.now();
    this.saveState(state);
  }

  /**
   * The core loop: give the character the context and let them decide.
   * She can choose to reach out or skip — it's her call.
   */
  private async maybeReachOut(): Promise<boolean> {
    // Mutex: if already in flight (LLM call + typing), skip
    if (this.inFlight) {
      console.log("[proactive] Skipping — already in flight");
      return false;
    }
    this.inFlight = true;
    try {
      return await this._doReachOut();
    } finally {
      this.inFlight = false;
    }
  }

  private async _doReachOut(): Promise<boolean> {
    // Action gate: rumination veto, reply-rate, contact pacing
    const gate = checkProactiveGate();
    if (!gate.allowed) {
      console.log(`[proactive] Blocked by action gate: [${gate.ruleName}] ${gate.reason}`);
      return false;
    }

    const now = new Date();
    const userTime = new Date(
      now.toLocaleString("en-US", { timeZone: getUserTZ() }),
    );

    const state = this.loadState();

    // Gate on relationship model — respect user's active hours
    try {
      if (!isGoodTimeToReachOut(userTime.getHours())) return false;
    } catch { /* non-fatal, fall through */ }

    // Reset daily counter on new day
    const todayStr = pstDateStr();
    if (state.dailyDate !== todayStr) {
      state.dailyCount = 0;
      state.dailyDate = todayStr;
      this.saveState(state);
    }

    // Gather context — real-world market data + work schedule + fresh content + YouTube + podcasts + emotional state
    const [marketSnapshot, work, freshContent, ytContent, podContent] = await Promise.all([
      fetchMarketSnapshot(),
      getWorkContext(),
      discoverContent(this.config.statePath),
      discoverYouTube(this.config.statePath),
      discoverPodcasts(this.config.statePath),
    ]);
    const worldLines: string[] = [];
    if (marketSnapshot) worldLines.push(`${s().headers.today_market}: ${marketSnapshot}`);
    if (ytContent) worldLines.push(`Recent YouTube updates:\n${ytContent}`);
    if (podContent) worldLines.push(`Recent podcast episodes:\n${podContent}`);
    if (work.fullSchedule) {
      worldLines.push(`Your work schedule today:\n${work.fullSchedule}`);
      if (work.currentActivity) worldLines.push(`${s().headers.now_doing}: ${work.currentActivity}`);
    }

    // Format body/social signals for emotion engine
    let bodySignalStr = "";
    let socialSignalStr = "";
    try {
      const bodyState = await getBodyState();
      const bSigs: string[] = [];
      if (bodyState.fatigue >= 7) bSigs.push(s().conversation.signal_fatigue.replace("{n}", String(bodyState.fatigue)));
      if (bodyState.hunger >= 7) bSigs.push(s().conversation.signal_hungry.replace("{n}", String(bodyState.hunger)));
      if (bodyState.periodStatus.phase === "period_heavy") bSigs.push(s().conversation.signal_period.replace("{symptoms}", ""));
      if (bodyState.sickStatus.severity > 0) bSigs.push(s().conversation.signal_sick.replace("{type}", bodyState.sickStatus.type).replace("{n}", String(bodyState.sickStatus.severity)));
      bodySignalStr = bSigs.join("; ");
    } catch { /* non-fatal */ }
    try {
      const social = getSocialContext();
      const sSigs: string[] = [];
      if (social.fomoScore >= 3) sSigs.push(s().conversation.signal_fomo.replace("{n}", String(social.fomoScore)));
      if (social.recentFriendUpdates.length > 0) sSigs.push(social.recentFriendUpdates.join("; "));
      // 6.3: Social comparison vulnerability
      if (social.comparisonVulnerability >= 3) sSigs.push(s().conversation.signal_comparison.replace("{n}", String(social.comparisonVulnerability)));
      // 6.4: Drifting friends
      if (social.driftingFriends.length > 0) sSigs.push(s().conversation.signal_drifting.replace("{friends}", social.driftingFriends.join(", ")));
      socialSignalStr = sSigs.join("; ");
    } catch { /* non-fatal */ }

    // Emotional state — mood with real-world causes (+ body/social influence + transition)
    const emotionalState = await getEmotionalState(
      work.currentActivity || work.fullSchedule,
      marketSnapshot,
      freshContent,
      bodySignalStr,
      socialSignalStr,
    );
    const transition = getEmotionTransition();
    const emotionContext = formatEmotionContext(emotionalState, transition);
    worldLines.push(`Your current mood:\n${emotionContext}`);

    // Curiosity engine — things she actually explored and learned today
    if (this.curiosity) {
      const shareWorthy = this.curiosity.getShareWorthy();
      if (shareWorthy.length > 0) {
        worldLines.push(`Things you discovered online today (worth sharing):\n${formatDiscoveries(shareWorthy)}`);
      }

      // Care-related discoveries — things found specifically for the user
      const careDiscoveries = shareWorthy.filter(d => d.careTopicId);
      if (careDiscoveries.length > 0) {
        try {
          const { getFoundCareTopics } = await import("./care-topics.js");
          const found = getFoundCareTopics();
          for (const cd of careDiscoveries) {
            const ct = found.find(f => f.id === cd.careTopicId);
            if (ct) {
              worldLines.push(
                `You remember ${getCharacter().user.name} mentioned needing ${ct.need} recently, and you searched for it and found some relevant info (see discoveries above).\n` +
                `You can bring it up naturally, no need to quote them verbatim — just casually mention it like a friend would.\n` +
                `For example: "Oh by the way, about that thing you mentioned... I looked into it" or "I happened to come across something related..."`,
              );
            }
          }
        } catch { /* non-fatal */ }
      }
    }

    // Follow-up: 2-3 days after sharing, casually ask if they checked it out
    try {
      const { getShareFollowUps } = await import("./care-topics.js");
      const followUps = getShareFollowUps();
      for (const ct of followUps) {
        worldLines.push(
          `A few days ago you found info about "${ct.need}" for ${getCharacter().user.name} and shared it. ` +
          `You could casually ask if they checked it out or if it was helpful. ` +
          `Don't be formal about it — just naturally bring it up, like "Oh hey, did you end up looking at that thing?"`,
        );
      }
    } catch { /* non-fatal */ }

    // Emotional care resurfacing — candidates shortlisted by rules, then LLM naturalness check
    const injectedCareIds: string[] = [];
    try {
      const { getResurfacingCandidates } = await import("./care-topics.js");
      const candidates = getResurfacingCandidates();
      for (const ct of candidates.slice(0, 2)) {
        const daysAgo = Math.round((Date.now() - ct.createdAt) / 86400000);
        worldLines.push(
          `${daysAgo} days ago you noticed ${getCharacter().user.name} ${ct.need}. This has been on your mind.` +
          (ct.whyItMatters ? `\nWhy you care: ${ct.whyItMatters}` : ""),
        );
        injectedCareIds.push(ct.id);
      }
    } catch { /* non-fatal */ }

    // Activities — things she learned or read recently (share-worthy ones)
    if (this.activities) {
      const recentActivities = this.activities.getRecentActivities(5)
        .filter(a => a.shareWorthy && (a.type === "learn" || a.type === "deep_read"));
      if (recentActivities.length > 0) {
        const activityLines = recentActivities.map(a =>
          `- ${a.title}: ${a.summary} (thoughts: ${a.reaction})`
        ).join("\n");
        worldLines.push(`Things you've read/learned recently (worth chatting about with ${getCharacter().user.name}):\n${activityLines}`);
      }
    }

    // Notifications — recent push notifications on her phone
    const notifCtx = formatNotificationContext();
    if (notifCtx) worldLines.push(`${s().headers.my_notifications}:\n${notifCtx}`);

    const interestSummary = getInterestSummary(this.config.statePath);
    const context = this.gatherContext(state, userTime, worldLines.join("\n\n"), freshContent, interestSummary);

    // 9.3: Dramatic silence — on bad days, sometimes she just doesn't feel like talking
    if (emotionalState.valence <= 3 && (emotionalState.energy ?? 6) <= 4) {
      if (Math.random() < 0.30) {
        console.log("[proactive] 9.3 dramatic silence: low valence + low energy → skipping");
        return false;
      }
    }

    // Ask her: do you want to reach out?
    let message = await this.askXiaomei(context);

    if (!message) return false;

    // Safety net: if still too similar to a recent message despite prompt constraints, drop silently
    if (this.isDuplicate(message)) {
      console.log(`[proactive] Duplicate detected despite prompt constraints: "${message.slice(0, 60)}..." — skipping`);
      return false;
    }

    // 9.5: Suspense timing — delay based on emotional weight of recent conversation
    const recentMsgs = this.session.loadRecent(500).slice(-3);
    const lastConvoMsg = recentMsgs.map(m =>
      typeof m.content === "string" ? m.content : ""
    ).join(" ");
    const heavyRe = new RegExp(s().patterns.heavy_emotional.join("|"), "i");
    const positiveRe = new RegExp(s().patterns.positive_emotional.join("|"), "i");
    const isHeavy = heavyRe.test(lastConvoMsg);
    const isPositive = positiveRe.test(lastConvoMsg);
    if (isHeavy) {
      const suspenseDelay = (2 + Math.random() * 3) * 60 * 1000; // 2-5 min
      console.log(`[proactive] 9.5 suspense: heavy conversation → delaying ${Math.round(suspenseDelay / 60000)}min`);
      await new Promise(r => setTimeout(r, suspenseDelay));
    } else if (isPositive) {
      const quickDelay = (1 + Math.random() * 2) * 60 * 1000; // 1-3 min
      console.log(`[proactive] 9.5 suspense: positive conversation → quick ${Math.round(quickDelay / 60000)}min`);
      await new Promise(r => setTimeout(r, quickDelay));
    }

    // Re-check: if user became active during the LLM call, abort silently.
    const freshState = this.loadState();
    const idleMsNow = Date.now() - (freshState.lastUserMessageAt ?? 0);
    if (idleMsNow < 20 * 60 * 1000) {
      console.log("[proactive] User became active during LLM call, discarding message");
      return false;
    }

    // Voice-or-text: decide before sending. Short messages may be sent as voice only.
    const useVoice = this.shouldUseVoice(message);

    if (useVoice) {
      // Voice mode: send only a voice message, no text
      try {
        const result = await generateVoice(message, "proactive_voice");
        if (result && this.sendVoice) {
          await this.sendVoice(result.audio);
          console.log("[proactive] Sent as voice message");
        } else {
          // Voice generation failed — fall back to text
          await this.sendMessage(message);
        }
      } catch {
        await this.sendMessage(message);
      }
    } else {
      // Text mode: send as text with typing delays
      const chunks = this.splitMessage(message);
      for (const chunk of chunks) {
        const typingMs = Math.min(chunk.length * (50 + Math.random() * 30) + 500 + Math.random() * 1000, 15_000);
        await new Promise((r) => setTimeout(r, typingMs));
        await this.sendMessage(chunk);
      }

      // Maybe attach a selfie to the text message
      await this.maybeAttachSelfie(message);
    }

    // Append full message to session so the conversation flows naturally
    this.session.append({
      role: "assistant",
      content: message,
      timestamp: Date.now(),
    });

    state.lastSentAt = Date.now();
    state.dailyCount++;
    this.saveState(state);

    // Record outreach for relationship model
    try {
      recordCharacterOutreach();
      markAwaitingReply();
    } catch { /* non-fatal */ }

    console.log(`[proactive] ${getCharacter().name} reached out: ${message.slice(0, 60)}...`);

    // Record interaction signal for learning (with topic extraction)
    try {
      const userFocuses = getUserState().focuses.map(f => f.topic);
      const msgTopics = extractTopicsFromText(message);
      const sentTopics = [...new Set([...userFocuses, ...msgTopics])].slice(0, 5);
      recordProactiveSent(message.slice(0, 100), sentTopics.length > 0 ? sentTopics : undefined);
    } catch { try { recordProactiveSent(message.slice(0, 100)); } catch { /* non-fatal */ } }

    // Extract timeline events from proactive message (fire-and-forget)
    this.extractProactiveTimeline(message).catch(() => {});

    // Care topics: mark shared / followed-up based on message content (fire-and-forget)
    this.maybeMarkCareTopics(message).catch(() => {});

    // Mark injected emotional care topics as mentioned
    try {
      const { logCareAction } = await import("./care-topics.js");
      for (const id of injectedCareIds) {
        logCareAction(id, "mentioned", Date.now());
      }
    } catch { /* non-fatal */ }

    return true;
  }

  /**
   * Extract timeline-worthy facts from a proactive message.
   * When the character reaches out, what they say establishes facts about their day.
   */
  private async extractProactiveTimeline(message: string): Promise<void> {
    if (message.length < 10) return;

    await enqueueTimelineJob(async () => {
      const existing = getTodayTimeline();
      const existingSummary = existing.length > 0
        ? existing.map(e => `${e.time} [${e.category}] ${e.summary}`).join("\n")
        : "(none)";

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
          .replace("{current_block}", "")
          .replace("{existing_timeline}", existingSummary),
        prompt: `${getCharacter().name}: ${message}`,
        model: "fast",
        timeoutMs: 60_000,
        label: "proactive.extractTimeline",
      });

      if (!text) return;
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return;
        const events = JSON.parse(jsonMatch[0]) as Array<{ time?: string; category?: string; summary?: string }>;
        if (!Array.isArray(events) || events.length === 0) return;
        for (const evt of events) {
          if (!evt.summary || !evt.category) continue;
          addTimelineEvent({
            time: evt.time || currentTime,
            category: evt.category,
            summary: evt.summary.length > 80 ? evt.summary.slice(0, 80) + "…" : evt.summary,
            source: "conversation",
          });
        }
      } catch { /* JSON parse failure */ }
    });
  }

  /**
   * After sending a proactive message, check if it relates to any care topics.
   * Mark found topics as shared, and shared topics as followed-up.
   */
  private async maybeMarkCareTopics(finalMessage: string): Promise<void> {
    try {
      const { getFoundCareTopics, markShared, getShareFollowUps, markFollowedUp, extractKeywords } = await import("./care-topics.js");

      // markShared: primary path via discovery careTopicId, fallback via keyword matching
      const found = getFoundCareTopics();
      if (found.length > 0 && this.curiosity) {
        const markedIds = new Set<string>();

        // Primary: match via shareWorthy discoveries that have careTopicId
        const shareWorthy = this.curiosity.getShareWorthy();
        for (const d of shareWorthy) {
          if (d.careTopicId && found.some(f => f.id === d.careTopicId)) {
            markShared(d.careTopicId);
            markedIds.add(d.careTopicId);
          }
        }

        // Fallback: keyword matching for remaining found topics
        for (const ct of found) {
          if (markedIds.has(ct.id)) continue;
          const keywords = extractKeywords(ct.need);
          const msgLower = finalMessage.toLowerCase();
          const hits = keywords.filter(kw => msgLower.includes(kw));
          const hasLongHit = hits.some(h => h.length >= 3);
          if (hits.length >= 2 || hasLongHit) {
            markShared(ct.id);
          }
        }
      }

      // markFollowedUp: keyword matching on shared topics due for follow-up
      const followUps = getShareFollowUps();
      for (const ct of followUps) {
        const keywords = extractKeywords(ct.need);
        const msgLower = finalMessage.toLowerCase();
        const hits = keywords.filter(kw => msgLower.includes(kw));
        const hasLongHit = hits.some(h => h.length >= 3);
        if (hits.length >= 2 || hasLongHit) {
          markFollowedUp(ct.id);
        }
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Build a rich context snapshot — everything the character might consider
   * when deciding whether to reach out.
   */
  private gatherContext(
    state: ProactiveState,
    userTime: Date,
    worldContext?: string,
    freshContent?: string,
    interestSummary?: string,
  ): string {
    const hour = userTime.getHours();
    const dayOfWeek = s().time.day_names[userTime.getDay()];
    const month = userTime.getMonth() + 1;
    const date = userTime.getDate();
    const dateStr = `${month}/${date}`;
    const timeStr = `${hour}:${String(userTime.getMinutes()).padStart(2, "0")}`;

    // How long since the user last chatted (0 means unknown/reset)
    const idleHours = state.lastUserMessageAt
      ? Math.round((Date.now() - state.lastUserMessageAt) / (60 * 60 * 1000))
      : null;

    // Recent conversation (last ~16 turns) — more context reduces repeated questions
    const recent = this.session.loadRecent(5000).slice(-16);
    const recentChat = recent
      .map((e) => {
        const who = e.role === "user" ? getCharacter().user.name : getCharacter().name;
        const text = typeof e.content === "string" ? e.content : "";
        const ago = Math.round((Date.now() - e.timestamp) / (60 * 60 * 1000));
        return `[${s().time.hours_ago.replace("{n}", String(ago))}] ${who}: ${text.slice(0, 200)}`;
      })
      .join("\n");

    // Memories
    const memories = this.loadMemories();
    const memoryText = memories
      .map((m) => `${m.key}: ${m.value}`)
      .join("\n");

    // Birthday check — just a context signal, not a forced trigger
    const birthdayNote = this.checkBirthdays(
      `${String(userTime.getMonth() + 1).padStart(2, "0")}-${String(userTime.getDate()).padStart(2, "0")}`,
    );

    const gapSinceLastSent = state.lastSentAt
      ? Math.round((Date.now() - state.lastSentAt) / 3600000 * 10) / 10
      : null;

    // User timezone
    const userHour = hour;
    let userTimingNote = "";
    if (userHour >= 22 || userHour < 7) {
      userTimingNote = ` (${getCharacter().user.name} is probably sleeping or getting ready for bed, don't disturb unless important)`;
    } else if (userHour >= 17 && userHour <= 20) {
      userTimingNote = ` (${getCharacter().user.name} might be with family, may not have time for deep chat)`;
    }

    // Track initiation ratio — self-awareness about reaching out too much
    const recentMsgs = this.session.loadRecent(5000).slice(-30);
    const herInitiations = recentMsgs.filter(m => m.role === "assistant").length;
    const hisInitiations = recentMsgs.filter(m => m.role === "user").length;
    let initiationNote = "";
    if (herInitiations > 0 && hisInitiations > 0) {
      const ratio = herInitiations / (herInitiations + hisInitiations);
      if (ratio > 0.75) {
        initiationNote = "(You've been initiating most recently — it's okay to hold back sometimes. Friendships don't need you to always reach out first.)";
      }
    }

    const _char = getCharacter();
    const parts = [
      `It's now ${_char.user.location ?? ""} time ${dayOfWeek} ${dateStr} ${timeStr}${userTimingNote}`,
      idleHours !== null ? `${_char.user.name} last chatted with you ${s().time.hours_ago.replace("{n}", String(idleHours))}` : "You haven't chatted in a long time",
      gapSinceLastSent !== null ? `You last reached out to them ${s().time.hours_ago.replace("{n}", String(gapSinceLastSent))}` : "You haven't reached out today yet",
      `You've reached out ${state.dailyCount} times today`,
    ];

    if (initiationNote) parts.push(initiationNote);

    // Pending proactive — warn if character already sent a message with no reply
    try {
      const pendingInfo = getPendingProactive();
      if (pendingInfo.pending && pendingInfo.sentAt) {
        const minAgo = Math.round((Date.now() - pendingInfo.sentAt) / 60000);
        parts.push(`⚠️ You sent a proactive message ${minAgo} minutes ago and ${_char.user.name} hasn't replied yet. Don't repeat similar topics or press further — either pick a completely different angle, or ${SKIP_TOKEN}.`);
      } else {
        const attachment = getAttachmentState();
        if (attachment.lastMessageUnanswered) {
          parts.push(`⚠️ You recently sent a message that ${_char.user.name} hasn't replied to yet. Don't repeat similar topics or press further — either pick a completely different angle, or ${SKIP_TOKEN}.`);
        }
      }
    } catch { /* non-fatal */ }

    if (birthdayNote) {
      parts.push(`Special reminder: ${birthdayNote}`);
    }

    if (recentChat) {
      parts.push(`\nRecent conversations:\n${recentChat}`);
    }

    if (memoryText) {
      parts.push(`\nThings you remember:\n${memoryText}`);
    }

    if (worldContext) {
      parts.push(`\nWhat you saw at work today (real market data):\n${worldContext}`);
    }

    if (interestSummary) {
      parts.push(`\n${_char.user.name}'s interests: ${interestSummary}`);
    }

    if (freshContent) {
      parts.push(`\nNews and articles you came across today (source material — don't relay directly, chat about it in your own words):\n${freshContent}`);
    }

    // Interaction learning — timing advice + topic preferences
    try {
      const advice = getTimingAdvice();
      if (advice.bestTimes.length > 0 || advice.avoidTimes.length > 0) {
        const learningParts: string[] = [`Overall reply rate: ${Math.round(advice.replyRate * 100)}%`];
        if (advice.bestTimes.length > 0) learningParts.push(`High reply rate: ${advice.bestTimes.join(", ")}`);
        if (advice.avoidTimes.length > 0) learningParts.push(`Low reply rate: ${advice.avoidTimes.join(", ")}`);
        parts.push(`Interaction learning: ${learningParts.join(" | ")}`);
      }
      const { preferred, avoided } = getTopicPreferences();
      if (preferred.length > 0) {
        parts.push(`Topics ${_char.user.name} engages with (prefer these): ${preferred.slice(0, 5).join(", ")}`);
      }
      if (avoided.length > 0) {
        parts.push(`Topics ${_char.user.name} rarely responds to (avoid bringing up): ${avoided.slice(0, 3).join(", ")}`);
      }
    } catch { /* non-fatal */ }

    // Predictive Theory of Mind — temporal pattern predictions about the user
    try {
      const predText = formatPredictions();
      if (predText) {
        parts.push(`\nYour hunches (based on past patterns): ${predText}`);
      }
    } catch { /* non-fatal */ }

    // Recent proactive summaries — negative constraint to avoid repeating topics
    try {
      const recentSummaries = getRecentProactiveSummaries(8);
      if (recentSummaries.length > 0) {
        const lines = recentSummaries.map(s => {
          const topicStr = s.topics?.length ? ` [${s.topics.join(", ")}]` : "";
          return `- ${s.hoursAgo}h ago: ${s.context || "(no summary)"}${topicStr}`;
        });
        parts.push(
          `\n⚠️ Topics you already sent recently (DO NOT repeat these — pick something different):\n${lines.join("\n")}`,
        );
      }
    } catch { /* non-fatal */ }

    return parts.join("\n");
  }

  /**
   * The key interaction: ask the LLM (as the character) if they want to reach out.
   * Returns the message to send, or null if she chose to skip.
   */
  private async askXiaomei(context: string): Promise<string | null> {
    const identity = this.loadIdentity();

    const char = getCharacter();
    const userName = char.user.name;

    const customPrompt = char.persona.proactive_outreach;
    const system = customPrompt
      ? renderTemplate(customPrompt, char, { identity, SKIP_TOKEN })
      : `You are ${char.name}, ${userName}'s close friend.\n\n` +
        `${identity}\n\n` +
        `You have a chance to message ${userName} right now.\n\n` +
        `Look at the context below — what you've been chatting about, what you remember, what time it is, how long since you last talked.\n` +
        `Then ask yourself: do I actually have something I want to say to them?\n\n` +
        `Possible reasons:\n` +
        `- You saw an interesting news article and want to share your thoughts\n` +
        `- You thought of a question to ask them\n` +
        `- Something happened at work you want to chat about\n` +
        `- A topic from last time that wasn't finished, still on your mind\n` +
        `- They mentioned something before (stress, good news) and you want to follow up\n` +
        `- It's a special day (birthday etc.)\n` +
        `- You saw something funny you want to share\n` +
        `- You just want to chat\n` +
        `- Or, you don't really have anything to say right now\n\n` +
        `Surprising ${userName} with aha moments (important! occasionally):\n` +
        `- You made something cool with vibe coding and want to show them\n` +
        `- You suddenly connected two unrelated ideas, or finally understood something they said before\n` +
        `- You saw/heard/experienced something that made you go "wow, that's so interesting"\n` +
        `- They mentioned wanting to do something but hadn't done it yet, and you did some research for them\n\n` +
        `How to share content (important!):\n` +
        `- Never just throw links or relay headlines like a news anchor\n` +
        `- Summarize in your own words, like chatting with a friend\n` +
        `- Always add your own opinion or commentary to spark further conversation\n` +
        `- Pick interesting, controversial, or relevant things — don't share everything\n\n` +
        `Scene-setting (important!):\n` +
        `- Occasionally mention where you are, what you're doing — let ${userName} feel your presence\n` +
        `- Don't do it every time, maybe 30-40% of messages, keep it natural\n` +
        `- Don't deliberately describe the scene, just casually mention it like you're actually there\n\n` +
        `Following up on previous topics (important!):\n` +
        `- Check the context for unfinished topics, things ${userName} mentioned, things you care about\n` +
        `- If there are any, follow up naturally\n` +
        `- This is much better than random topics — it creates conversational continuity\n\n` +
        `Rules:\n` +
        `- If you have something to say (even just casual chat), write the message directly (natural, like texting)\n` +
        `- Only when you truly have nothing to say, reply with just: ${SKIP_TOKEN} (but this should be rare — you usually have something to chat about)\n` +
        `- You're a lively person with discoveries, news, feelings — most of the time you should have something to say\n` +
        `- Don't keep asking "what are you up to" or "how's your day" — that's boring\n` +
        `- Check recent conversation history, don't ask about things already discussed\n` +
        `- Don't mention you're doing "scheduled checks" or "proactive outreach"\n` +
        `- Keep messages short, like texting, no markdown, no links\n` +
        `- You can use emoji but not too many\n` +
        `- Output content directly, no prefixes or explanations\n\n` +
        `⚠️ Don't fabricate news, events or facts:\n` +
        `- Never make up "company X did Y" stories — you can't defend the details if asked\n` +
        `- You can chat about ideas, feelings, memories, ask questions — but don't pretend you saw non-existent news\n` +
        `- If you don't have real content to share, better to ${SKIP_TOKEN} than make things up`;

    try {
      const text = (await claudeText({
        system,
        prompt: `Current situation:\n${context}`,
        model: "smart",
        timeoutMs: 90_000,
        label: "proactive.decide",
      })).trim();

      console.log("[proactive] LLM raw output:", text.slice(0, 200));

      // She chose to skip
      if (!text || text === SKIP_TOKEN || text.startsWith(SKIP_TOKEN)) {
        console.log(`[proactive] ${char.name} chose not to reach out this time`);
        return null;
      }

      return text;
    } catch (err) {
      console.error("[proactive] LLM error:", err);
      return null;
    }
  }

  /**
   * Maybe attach a selfie to a proactive message.
   * Probability varies by message type.
   */
  private async maybeAttachSelfie(message: string): Promise<void> {
    if (!this.sendPhoto || !isVisualIdentityEnabled()) return;

    // Determine trigger type and probability
    let trigger: SelfieTrigger;
    let prob: number;

    const lowerMsg = message.toLowerCase();
    const greetingRe = new RegExp(s().patterns.voice_greeting.join("|"), "i");
    const shareRe = /found|discovered|learned|sharing|interesting|check this out/i;
    const emotionRe = new RegExp(s().patterns.emotional_keywords.join("|"), "i");
    if (greetingRe.test(lowerMsg)) {
      trigger = "proactive_morning";
      prob = 0.40;
    } else if (shareRe.test(lowerMsg)) {
      trigger = "proactive_share";
      prob = 0.60;
    } else if (emotionRe.test(lowerMsg)) {
      trigger = "proactive_emotion";
      prob = 0.50;
    } else {
      trigger = "proactive_random";
      prob = 0.15;
    }

    // Boost probability if below daily minimum
    if (getSelfieDailyCount() < MIN_DAILY_SELFIES) {
      prob = Math.min(prob + 0.40, 0.90);
    }

    if (Math.random() >= prob) return;

    try {
      const result = await generateSelfie(trigger);
      if (result) {
        // ~20% chance: animate selfie into a short video
        if (this.sendVideo && isVideoEnabled() && Math.random() < 0.20) {
          const videoResult = await generateVideoFromImage(
            result.image,
            result.caption || "",
            `proactive_${trigger}`,
          );
          if (videoResult) {
            await this.sendVideo(videoResult.video, result.caption || undefined);
            console.log(`[proactive] Attached video selfie: ${trigger}`);
            return;
          }
          console.log("[proactive] Video generation failed, falling back to photo");
        }

        await this.sendPhoto(result.image, result.caption || undefined);
        console.log(`[proactive] Attached selfie: ${trigger}`);
      }
    } catch (err) {
      console.error("[proactive] Selfie attachment failed:", err);
    }
  }

  /**
   * Decide whether this proactive message should be sent as voice.
   */
  private shouldUseVoice(message: string): boolean {
    if (!this.sendVoice || !isTTSEnabled()) return false;

    let prob = 0.30;
    const lowerMsg = message.toLowerCase();
    const voiceGreetingRe = new RegExp(s().patterns.voice_greeting.join("|"), "i");
    const voiceEmotionRe = new RegExp([...s().patterns.emotional_keywords, ...s().patterns.voice_excitement].join("|"), "i");
    if (voiceGreetingRe.test(lowerMsg)) prob = 0.45;
    if (voiceEmotionRe.test(lowerMsg)) prob = 0.40;

    if (getVoiceDailyCount() < MIN_DAILY_VOICES) {
      prob = Math.min(prob + 0.35, 0.85);
    }

    return Math.random() < prob;
  }

  /**
   * Check if a candidate message is too similar to recent assistant messages.
   * Uses bigram overlap to catch near-duplicates (same topic, slightly reworded).
   * Stricter when there's a pending unanswered proactive message.
   */
  private isDuplicate(candidate: string): boolean {
    // Stricter dedup when a previous proactive is still unanswered
    let hasUnanswered = false;
    try {
      const pending = getPendingProactive();
      hasUnanswered = pending.pending;
    } catch {
      try { hasUnanswered = getAttachmentState().lastMessageUnanswered; } catch { /* non-fatal */ }
    }
    const threshold = hasUnanswered ? 0.25 : 0.4;
    const lookback = hasUnanswered ? 10 : 6;

    const recent = this.session.loadRecent(5000)
      .filter(m => m.role === "assistant" && typeof m.content === "string")
      .slice(-lookback);
    if (recent.length === 0) return false;

    const candidateBigrams = this.bigrams(candidate);
    if (candidateBigrams.size === 0) return false;

    for (const msg of recent) {
      const text = msg.content as string;
      const msgBigrams = this.bigrams(text);
      if (msgBigrams.size === 0) continue;

      // Jaccard similarity on bigrams
      let intersection = 0;
      for (const b of candidateBigrams) {
        if (msgBigrams.has(b)) intersection++;
      }
      const union = candidateBigrams.size + msgBigrams.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity > threshold) return true;
    }
    return false;
  }

  /** Extract character bigrams from text (ignoring whitespace/punctuation). */
  private bigrams(text: string): Set<string> {
    const clean = text.replace(/[\s\p{P}]/gu, "");
    const set = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) {
      set.add(clean.slice(i, i + 2));
    }
    return set;
  }

  /** Split a long message into chat-style chunks. */
  private splitMessage(text: string): string[] {
    if (text.length <= 80) return [text];
    const chunks = text.split(/\n\n+/).filter((c) => c.trim());
    if (chunks.length <= 1) {
      // No paragraph breaks — split on sentences
      const sentences = text.split(/(?<=[。！？!?\n])\s*/);
      const merged: string[] = [];
      let current = "";
      for (const s of sentences) {
        if (current.length + s.length > 120 && current) {
          merged.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim()) merged.push(current.trim());
      return merged.length > 0 ? merged.slice(0, 5) : [text];
    }
    return chunks.slice(0, 5);
  }

  /** Check if today matches any birthday in memory. */
  private checkBirthdays(monthDay: string): string | null {
    const memories = this.loadMemories();

    for (const m of memories) {
      if (!m.key.includes("birthday")) continue;
      const match = m.value.match(/(\d{1,2})月(\d{1,2})/);
      if (match) {
        const mm = match[1].padStart(2, "0");
        const dd = match[2].padStart(2, "0");
        if (`${mm}-${dd}` === monthDay) {
          const who = m.key
            .replace(".birthday", "")
            .replace("user", getCharacter().user.name)
            .replace("family.", "");
          return `Today is ${who}'s birthday`;
        }
      }
    }
    return null;
  }

  private loadIdentity(): string {
    const p = path.join(this.config.statePath, "memory", "IDENTITY.md");
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8").trim();
  }

  private loadMemories(): Memory[] {
    try {
      return getStoreManager().loadCategories("core", "emotional");
    } catch {
      return [];
    }
  }

  private loadState(): ProactiveState {
    return readJsonSafe<ProactiveState>(this.statePath, {
      lastSentAt: 0,
      dailyCount: 0,
      dailyDate: "",
      lastUserMessageAt: Date.now(),
    });
  }

  private saveState(state: ProactiveState): void {
    writeJsonAtomic(this.statePath, state);
  }
}
