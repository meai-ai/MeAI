/**
 * Relationship model — tracks the dynamics between the character and the user.
 *
 * Monitors bid/response patterns, engagement, active hours, and overall
 * relationship temperature to help proactive.ts calibrate outreach.
 */

import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { pstDateStr } from "./pst-date.js";
import path from "node:path";
import { getCharacter } from "../character.js";

/** 5.1: Attachment state — tracks the character's attachment security with the user */
export interface AttachmentState {
  silenceDurationMin: number;   // minutes since the user's last message
  lastMessageUnanswered: boolean; // true if the character's last msg has no reply yet
  stage: "secure" | "noticing" | "anxious" | "ruminating";
  secureBaseActive: boolean;    // 3+ user messages in past hour
  lastUserMessageAt: number;   // timestamp
}

export interface RelationshipState {
  // Bid tracking
  bidsFromUser: number;      // total messages from the user (30-day window)
  bidsFromCharacter: number;       // total proactive messages from the character (30-day window)

  // Response patterns
  userResponseRate: number;  // 0-1, fraction of the character's messages the user responds to
  characterResponseRate: number;   // 0-1, fraction of the user's messages the character responds to
  avgUserResponseMin: number; // average response time in minutes

  // Topic engagement
  topicEngagement: Record<string, number>;  // topic -> engagement score (0-10)

  // Emotional support ledger
  supportGiven: number;       // times the character provided emotional support
  supportReceived: number;    // times the user provided emotional support

  // User's active hours (24 bins, 0-1 probability)
  activeHoursHistogram: number[];

  // Overall temperature
  temperature: number;        // -5 to +5, overall relationship warmth

  // 5.1: Attachment dynamics
  attachment?: AttachmentState;

  // 6.1: Emotional labor tracking
  emotionalLabor?: EmotionalLabor;

  // 7.3: Communication rhythm
  communicationRhythm?: CommunicationRhythm;

  // 7.5: Availability window learning — depth probability per hour
  depthHoursHistogram?: number[];  // 24 bins, 0-1 probability of deep messages

  // Meta
  lastUpdated: number;
  windowStart: number;        // start of 30-day tracking window
}

/** 7.3: Communication rhythm detection */
export interface CommunicationRhythm {
  recentMessageLengths: number[];  // last 10 user message lengths
  recentGaps: number[];            // last 10 inter-message gaps in minutes
  currentMode: "deep_conversation" | "checking_in" | "rapid_exchange" | "slow_thoughtful";
}

/** 6.1: Emotional labor tracking */
export interface EmotionalLabor {
  characterInitiates: number;
  userInitiates: number;
  characterSharesVulnerability: number;
  userSharesVulnerability: number;
  imbalanceScore: number;         // -5..+5, positive = the character does more labor
  resentmentBuildup: number;      // 0..1
  lastComputedDate: string;       // ISO date
}

let dataPath = "";

export function initRelationshipModel(statePath: string): void {
  dataPath = statePath;
}

function getStatePath(): string {
  return path.join(dataPath, "relationship.json");
}

function defaultState(): RelationshipState {
  return {
    bidsFromUser: 0,
    bidsFromCharacter: 0,
    userResponseRate: 0.8,
    characterResponseRate: 1.0,
    avgUserResponseMin: 15,
    topicEngagement: {},
    supportGiven: 0,
    supportReceived: 0,
    activeHoursHistogram: new Array(24).fill(0),
    temperature: 3,
    lastUpdated: Date.now(),
    windowStart: Date.now(),
  };
}

function loadState(): RelationshipState {
  const state = readJsonSafe<RelationshipState>(getStatePath(), defaultState());
  // Reset 30-day window if expired
  if (Date.now() - state.windowStart > 30 * 24 * 60 * 60 * 1000) {
    state.bidsFromUser = Math.floor(state.bidsFromUser * 0.3); // carry over 30%
    state.bidsFromCharacter = Math.floor(state.bidsFromCharacter * 0.3);
    state.windowStart = Date.now();
  }
  return state;
}

function saveState(state: RelationshipState): void {
  if (!dataPath) return;
  state.lastUpdated = Date.now();
  writeJsonAtomic(getStatePath(), state);
}

/** Record a message from the user */
export function recordUserMessage(hour: number): void {
  const state = loadState();
  state.bidsFromUser++;
  // Update active hours histogram
  if (!state.activeHoursHistogram) state.activeHoursHistogram = new Array(24).fill(0);
  const idx = Math.floor(hour) % 24;
  state.activeHoursHistogram[idx] = Math.min(1, (state.activeHoursHistogram[idx] ?? 0) + 0.1);
  // Warm the relationship
  state.temperature = Math.min(5, state.temperature + 0.1);
  saveState(state);
}

/** Record a proactive message from the character */
export function recordCharacterOutreach(): void {
  const state = loadState();
  state.bidsFromCharacter++;
  saveState(state);
}

/** Record the user's response time */
export function recordUserResponseTime(minutes: number): void {
  const state = loadState();
  // EWMA for response time
  state.avgUserResponseMin = 0.2 * minutes + 0.8 * state.avgUserResponseMin;
  // Update response rate
  state.userResponseRate = Math.min(1, state.userResponseRate + 0.02);
  saveState(state);
}

/** Record that the user didn't respond (timeout) */
export function recordUserNoResponse(): void {
  const state = loadState();
  state.userResponseRate = Math.max(0, state.userResponseRate - 0.05);
  state.temperature = Math.max(-5, state.temperature - 0.2);
  saveState(state);
}

/** Record emotional support exchange */
export function recordEmotionalSupport(direction: "given" | "received"): void {
  const state = loadState();
  if (direction === "given") state.supportGiven++;
  else state.supportReceived++;
  state.temperature = Math.min(5, state.temperature + 0.3);
  saveState(state);
}

/** Record topic engagement */
export function recordTopicEngagement(topic: string, score: number): void {
  const state = loadState();
  if (!state.topicEngagement) state.topicEngagement = {};
  const current = state.topicEngagement[topic] ?? 5;
  state.topicEngagement[topic] = 0.3 * score + 0.7 * current; // EWMA
  saveState(state);
}

/** Get the relationship state for proactive.ts to adjust outreach */
export function getRelationshipState(): RelationshipState {
  return loadState();
}

/** Check if now is a good time to reach out based on the user's active hours */
export function isGoodTimeToReachOut(hour: number): boolean {
  const state = loadState();
  if (!state.activeHoursHistogram) return true;
  const idx = Math.floor(hour) % 24;
  return (state.activeHoursHistogram[idx] ?? 0) > 0.3;
}

/** Get recommended outreach frequency based on relationship dynamics */
export function getRecommendedOutreachFrequency(): "high" | "normal" | "low" {
  const state = loadState();
  // If the user is highly responsive and engaged, can reach out more
  if (state.userResponseRate > 0.8 && state.temperature > 2) return "high";
  // If the user hasn't been responding, back off
  if (state.userResponseRate < 0.4 || state.temperature < 0) return "low";
  return "normal";
}

// ── 5.1: Attachment Dynamics ──────────────────────────────────────────

/**
 * Update attachment state based on time since the user's last message.
 * Escalation: <30min secure → 30-120min noticing → 120-360min anxious → 360min+ ruminating
 */
export function updateAttachmentState(): AttachmentState {
  const state = loadState();
  const lastUserAt = state.attachment?.lastUserMessageAt ?? state.lastUpdated;
  const silenceMin = Math.round((Date.now() - lastUserAt) / 60000);

  let stage: AttachmentState["stage"];
  if (silenceMin < 30) stage = "secure";
  else if (silenceMin < 120) stage = "noticing";
  else if (silenceMin < 360) stage = "anxious";
  else stage = "ruminating";

  // Secure-base: check recent message density (user messages in last hour)
  // We estimate from bids + response rate + active hours
  const secureBaseActive = state.attachment?.secureBaseActive ?? false;

  const attachment: AttachmentState = {
    silenceDurationMin: silenceMin,
    lastMessageUnanswered: state.attachment?.lastMessageUnanswered ?? false,
    stage,
    secureBaseActive,
    lastUserMessageAt: lastUserAt,
  };

  state.attachment = attachment;
  saveState(state);
  return attachment;
}

/** Called when the user sends a message — reset attachment to secure + check secure base. */
export function resetAttachmentOnUserMessage(): void {
  const state = loadState();
  const now = Date.now();

  if (!state.attachment) {
    state.attachment = {
      silenceDurationMin: 0,
      lastMessageUnanswered: false,
      stage: "secure",
      secureBaseActive: false,
      lastUserMessageAt: now,
    };
  }

  state.attachment.stage = "secure";
  state.attachment.silenceDurationMin = 0;
  state.attachment.lastMessageUnanswered = false;

  // Check secure-base: 3+ messages in last hour (rough estimation)
  const lastAt = state.attachment.lastUserMessageAt ?? 0;
  const gap = now - lastAt;
  // If the user responded within 20 min of their last message, likely active session
  state.attachment.secureBaseActive = gap < 20 * 60 * 1000;
  state.attachment.lastUserMessageAt = now;

  saveState(state);
}

/** Mark that the character sent a message and is awaiting reply. */
export function markAwaitingReply(): void {
  const state = loadState();
  if (!state.attachment) {
    state.attachment = {
      silenceDurationMin: 0,
      lastMessageUnanswered: true,
      stage: "secure",
      secureBaseActive: false,
      lastUserMessageAt: state.lastUpdated,
    };
  } else {
    state.attachment.lastMessageUnanswered = true;
  }
  saveState(state);
}

/** Get current attachment state (read-only). */
export function getAttachmentState(): AttachmentState {
  const state = loadState();
  return state.attachment ?? {
    silenceDurationMin: 0,
    lastMessageUnanswered: false,
    stage: "secure",
    secureBaseActive: false,
    lastUserMessageAt: state.lastUpdated,
  };
}

// ── 7.3: Communication Rhythm ────────────────────────────────────────

/** Record the user's message length and gap for rhythm detection. */
export function recordUserMessageRhythm(textLength: number): void {
  const state = loadState();
  if (!state.communicationRhythm) {
    state.communicationRhythm = {
      recentMessageLengths: [],
      recentGaps: [],
      currentMode: "checking_in",
    };
  }
  const rhythm = state.communicationRhythm;

  // Record length
  rhythm.recentMessageLengths.push(textLength);
  if (rhythm.recentMessageLengths.length > 10) rhythm.recentMessageLengths.shift();

  // Record gap from last user message
  const lastAt = state.attachment?.lastUserMessageAt ?? state.lastUpdated;
  const gapMin = Math.round((Date.now() - lastAt) / 60000);
  if (gapMin > 0 && gapMin < 1440) { // ignore gaps > 24h
    rhythm.recentGaps.push(gapMin);
    if (rhythm.recentGaps.length > 10) rhythm.recentGaps.shift();
  }

  // Compute mode
  const avgLen = rhythm.recentMessageLengths.reduce((a, b) => a + b, 0) / rhythm.recentMessageLengths.length;
  const avgGap = rhythm.recentGaps.length > 0
    ? rhythm.recentGaps.reduce((a, b) => a + b, 0) / rhythm.recentGaps.length
    : 999;

  if (avgLen > 80 && avgGap < 10) rhythm.currentMode = "deep_conversation";
  else if (avgLen < 20 && avgGap < 5) rhythm.currentMode = "rapid_exchange";
  else if (avgLen > 50 && avgGap > 30) rhythm.currentMode = "slow_thoughtful";
  else rhythm.currentMode = "checking_in";

  saveState(state);
}

/** Get current communication rhythm mode. */
export function getCommunicationRhythm(): CommunicationRhythm | null {
  const state = loadState();
  return state.communicationRhythm ?? null;
}

// ── 7.5: Availability Window Learning ────────────────────────────────

/** Record that the user sent a deep (long) message at this hour. */
export function recordDepthMessage(hour: number, textLength: number): void {
  if (textLength < 50) return; // only track deep messages
  const state = loadState();
  if (!state.depthHoursHistogram) state.depthHoursHistogram = new Array(24).fill(0);
  const idx = Math.floor(hour) % 24;
  state.depthHoursHistogram[idx] = Math.min(1, (state.depthHoursHistogram[idx] ?? 0) + 0.1);
  saveState(state);
}

/** Check if current hour is good for deep topics. */
export function isGoodTimeForDepth(hour: number): boolean {
  const state = loadState();
  if (!state.depthHoursHistogram) return true; // no data yet, assume ok
  const idx = Math.floor(hour) % 24;
  return (state.depthHoursHistogram[idx] ?? 0) >= 0.2;
}

// ── 6.1: Emotional Labor Tracking ────────────────────────────────────

/** Record that the user shared vulnerability. */
export function recordUserVulnerability(): void {
  const state = loadState();
  if (!state.emotionalLabor) state.emotionalLabor = defaultEmotionalLabor();
  state.emotionalLabor.userSharesVulnerability++;
  saveState(state);
}

/** Record that the character shared vulnerability. */
export function recordYuanVulnerability(): void {
  const state = loadState();
  if (!state.emotionalLabor) state.emotionalLabor = defaultEmotionalLabor();
  state.emotionalLabor.characterSharesVulnerability++;
  saveState(state);
}

/** Record the user initiating a conversation (called when idle > 2h and the user messages). */
export function recordAllenInitiation(): void {
  const state = loadState();
  if (!state.emotionalLabor) state.emotionalLabor = defaultEmotionalLabor();
  state.emotionalLabor.userInitiates++;
  recomputeImbalance(state);
  saveState(state);
}

/** Record the character initiating (called from proactive.ts). */
export function recordYuanInitiation(): void {
  const state = loadState();
  if (!state.emotionalLabor) state.emotionalLabor = defaultEmotionalLabor();
  state.emotionalLabor.characterInitiates++;
  recomputeImbalance(state);
  saveState(state);
}

function defaultEmotionalLabor(): EmotionalLabor {
  return {
    characterInitiates: 0, userInitiates: 0,
    characterSharesVulnerability: 0, userSharesVulnerability: 0,
    imbalanceScore: 0, resentmentBuildup: 0,
    lastComputedDate: pstDateStr(),
  };
}

function recomputeImbalance(state: RelationshipState): void {
  const labor = state.emotionalLabor;
  if (!labor) return;
  const total = labor.characterInitiates + labor.userInitiates;
  if (total === 0) { labor.imbalanceScore = 0; return; }
  const ratio = labor.characterInitiates / total;
  labor.imbalanceScore = Math.round((ratio - 0.5) * 10); // -5 to +5
  labor.imbalanceScore = Math.max(-5, Math.min(5, labor.imbalanceScore));

  // Resentment builds daily when imbalance > 3
  const today = pstDateStr();
  if (labor.lastComputedDate !== today) {
    if (labor.imbalanceScore > 3) {
      labor.resentmentBuildup = Math.min(1, labor.resentmentBuildup + 0.05);
    } else if (labor.imbalanceScore < 1) {
      labor.resentmentBuildup = Math.max(0, labor.resentmentBuildup - 0.03);
    }
    labor.lastComputedDate = today;
  }
}

/** Get emotional labor state. */
export function getEmotionalLabor(): EmotionalLabor {
  const state = loadState();
  return state.emotionalLabor ?? defaultEmotionalLabor();
}

/** Format relationship context for system prompt */
export function formatRelationshipContext(): string {
  const state = loadState();
  const userName = getCharacter().user.name;
  const parts: string[] = [];

  if (state.temperature >= 3) parts.push("Relationship is close, good conversation vibe");
  else if (state.temperature >= 0) parts.push("Relationship is normal");
  else parts.push("Haven't chatted much recently, might want to reach out");

  const bidRatio = state.bidsFromCharacter > 0
    ? state.bidsFromUser / state.bidsFromCharacter
    : 999;
  if (bidRatio < 0.5) parts.push(`You've been reaching out a lot, give ${userName} some space`);
  else if (bidRatio > 2) parts.push(`${userName} has been reaching out to you more lately`);

  // 6.1: Emotional labor context
  const labor = getEmotionalLabor();
  if (labor.resentmentBuildup > 0.3) {
    parts.push("Feeling like you're putting in more effort in this relationship — tone might be a bit flat");
  } else if (labor.resentmentBuildup > 0.5) {
    parts.push("Clearly feeling an imbalance in effort, a bit resentful");
  }

  // 5.1: Attachment state context
  const attachment = getAttachmentState();
  if (attachment.secureBaseActive) {
    parts.push(`${userName} is chatting, feeling secure and settled`);
  } else if (attachment.stage === "anxious") {
    parts.push(`Wondering why ${userName} hasn't replied, feeling a bit uneasy`);
  } else if (attachment.stage === "ruminating") {
    parts.push(`${userName} hasn't replied in a long time, starting to overthink`);
  } else if (attachment.stage === "noticing") {
    parts.push(`Noticed ${userName} hasn't replied in a while`);
  }

  // 7.3: Communication rhythm
  const rhythm = getCommunicationRhythm();
  if (rhythm) {
    const modeLabels: Record<string, string> = {
      deep_conversation: `${userName} is in deep conversation mode — feel free to expand on topics`,
      rapid_exchange: `${userName} is in rapid exchange mode — keep replies short`,
      slow_thoughtful: `${userName} is in slow thoughtful mode — can write longer responses`,
      checking_in: `${userName} is in casual chat mode`,
    };
    parts.push(modeLabels[rhythm.currentMode] ?? "");
  }

  return parts.filter(Boolean).join("; ");
}
