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
  phaseConfidence: number;      // 0-1, confidence in current stage
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

  // Shared history markers — how they changed each other
  sharedHistory?: SharedHistoryMarker[];

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

/** SharedHistoryMarker — records how the character and user changed each other */
export interface SharedHistoryMarker {
  id: string;
  ts: number;
  type: "user_changed_her" | "she_stayed_with_user" | "shared_theme" | "mutual_growth";
  title: string;
  summary: string;
  whyItMatters: string;
  relatedCareTopicIds: string[];
  narratable: boolean;
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

// Ephemeral phase-transition tracking for recency penalty (no persistence needed)
let _lastKnownStage: AttachmentState["stage"] | null = null;
let _lastPhaseTransitionAt = 0;

// ── RelationshipEngine class ─────────────────────────────────────────

export class RelationshipEngine {
  private dataPath: string;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  private getStatePath(): string {
    return path.join(this.dataPath, "relationship.json");
  }

  private defaultState(): RelationshipState {
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

  private loadState(): RelationshipState {
    const state = readJsonSafe<RelationshipState>(this.getStatePath(), this.defaultState());
    // Reset 30-day window if expired
    if (Date.now() - state.windowStart > 30 * 24 * 60 * 60 * 1000) {
      state.bidsFromUser = Math.floor(state.bidsFromUser * 0.3); // carry over 30%
      state.bidsFromCharacter = Math.floor(state.bidsFromCharacter * 0.3);
      state.windowStart = Date.now();
    }
    return state;
  }

  private saveState(state: RelationshipState): void {
    if (!this.dataPath) return;
    state.lastUpdated = Date.now();
    writeJsonAtomic(this.getStatePath(), state);
  }

  /** Record a message from the user */
  recordUserMessage(hour: number): void {
    const state = this.loadState();
    state.bidsFromUser++;
    // Update active hours histogram
    if (!state.activeHoursHistogram) state.activeHoursHistogram = new Array(24).fill(0);
    const idx = Math.floor(hour) % 24;
    state.activeHoursHistogram[idx] = Math.min(1, (state.activeHoursHistogram[idx] ?? 0) + 0.1);
    // Warm the relationship
    state.temperature = Math.min(5, state.temperature + 0.1);
    this.saveState(state);
  }

  /** Record a proactive message from the character */
  recordCharacterOutreach(): void {
    const state = this.loadState();
    state.bidsFromCharacter++;
    this.saveState(state);
  }

  /** Record the user's response time */
  recordUserResponseTime(minutes: number): void {
    const state = this.loadState();
    // EWMA for response time
    state.avgUserResponseMin = 0.2 * minutes + 0.8 * state.avgUserResponseMin;
    // Update response rate
    state.userResponseRate = Math.min(1, state.userResponseRate + 0.02);
    this.saveState(state);
  }

  /** Record that the user didn't respond (timeout) */
  recordUserNoResponse(): void {
    const state = this.loadState();
    state.userResponseRate = Math.max(0, state.userResponseRate - 0.05);
    state.temperature = Math.max(-5, state.temperature - 0.2);
    this.saveState(state);
  }

  /** Record emotional support exchange */
  recordEmotionalSupport(direction: "given" | "received"): void {
    const state = this.loadState();
    if (direction === "given") state.supportGiven++;
    else state.supportReceived++;
    state.temperature = Math.min(5, state.temperature + 0.3);
    this.saveState(state);
  }

  /** Record topic engagement */
  recordTopicEngagement(topic: string, score: number): void {
    const state = this.loadState();
    if (!state.topicEngagement) state.topicEngagement = {};
    const current = state.topicEngagement[topic] ?? 5;
    state.topicEngagement[topic] = 0.3 * score + 0.7 * current; // EWMA
    this.saveState(state);
  }

  /** Get the relationship state for proactive.ts to adjust outreach */
  getRelationshipState(): RelationshipState {
    return this.loadState();
  }

  /** Check if now is a good time to reach out based on the user's active hours */
  isGoodTimeToReachOut(hour: number): boolean {
    const state = this.loadState();
    if (!state.activeHoursHistogram) return true;
    const idx = Math.floor(hour) % 24;
    return (state.activeHoursHistogram[idx] ?? 0) > 0.3;
  }

  /** Get recommended outreach frequency based on relationship dynamics */
  getRecommendedOutreachFrequency(): "high" | "normal" | "low" {
    const state = this.loadState();
    // If the user is highly responsive and engaged, can reach out more
    if (state.userResponseRate > 0.8 && state.temperature > 2) return "high";
    // If the user hasn't been responding, back off
    if (state.userResponseRate < 0.4 || state.temperature < 0) return "low";
    return "normal";
  }

  // ── 5.1: Attachment Dynamics ────────────────────────────────────────

  /**
   * Update attachment state based on time since the user's last message.
   * Escalation: <30min secure -> 30-120min noticing -> 120-360min anxious -> 360min+ ruminating
   */
  updateAttachmentState(): AttachmentState {
    const state = this.loadState();
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

    const phaseConfidence = this.computePhaseConfidence(silenceMin, stage, state);

    const attachment: AttachmentState = {
      silenceDurationMin: silenceMin,
      lastMessageUnanswered: state.attachment?.lastMessageUnanswered ?? false,
      stage,
      secureBaseActive,
      lastUserMessageAt: lastUserAt,
      phaseConfidence,
    };

    state.attachment = attachment;
    this.saveState(state);
    return attachment;
  }

  /** Called when the user sends a message — reset attachment to secure + check secure base. */
  resetAttachmentOnUserMessage(): void {
    const state = this.loadState();
    const now = Date.now();

    if (!state.attachment) {
      state.attachment = {
        silenceDurationMin: 0,
        lastMessageUnanswered: false,
        stage: "secure",
        secureBaseActive: false,
        lastUserMessageAt: now,
        phaseConfidence: 0.8,
      };
    }

    state.attachment.stage = "secure";
    state.attachment.silenceDurationMin = 0;
    state.attachment.lastMessageUnanswered = false;
    state.attachment.phaseConfidence = 0.8; // high confidence on user message

    // Check secure-base: 3+ messages in last hour (rough estimation)
    const lastAt = state.attachment.lastUserMessageAt ?? 0;
    const gap = now - lastAt;
    // If the user responded within 20 min of their last message, likely active session
    state.attachment.secureBaseActive = gap < 20 * 60 * 1000;
    state.attachment.lastUserMessageAt = now;

    this.saveState(state);
  }

  /** Mark that the character sent a message and is awaiting reply. */
  markAwaitingReply(): void {
    const state = this.loadState();
    if (!state.attachment) {
      state.attachment = {
        silenceDurationMin: 0,
        lastMessageUnanswered: true,
        stage: "secure",
        secureBaseActive: false,
        lastUserMessageAt: state.lastUpdated,
        phaseConfidence: 0.5,
      };
    } else {
      state.attachment.lastMessageUnanswered = true;
    }
    this.saveState(state);
  }

  /** Get current attachment state — computes stage and phaseConfidence dynamically from silence duration. */
  getAttachmentState(): AttachmentState {
    const state = this.loadState();
    const stored = state.attachment;
    if (!stored) {
      return {
        silenceDurationMin: 0,
        lastMessageUnanswered: false,
        stage: "secure",
        secureBaseActive: false,
        lastUserMessageAt: state.lastUpdated,
        phaseConfidence: 0.5,
      };
    }

    // Dynamically compute stage from current silence duration
    const lastUserAt = stored.lastUserMessageAt ?? state.lastUpdated;
    const silenceMin = Math.round((Date.now() - lastUserAt) / 60000);

    let stage: AttachmentState["stage"];
    if (silenceMin < 30) stage = "secure";
    else if (silenceMin < 120) stage = "noticing";
    else if (silenceMin < 360) stage = "anxious";
    else stage = "ruminating";

    const phaseConfidence = this.computePhaseConfidence(silenceMin, stage, state);

    return {
      ...stored,
      silenceDurationMin: silenceMin,
      stage,
      phaseConfidence,
    };
  }

  /** Compute phaseConfidence from boundary distance, interaction consistency, and recency of transition. */
  private computePhaseConfidence(
    silenceMin: number,
    stage: AttachmentState["stage"],
    state: RelationshipState,
  ): number {
    // Boundary distance (0-0.5): how far from stage boundaries
    const boundaries: Record<string, [number, number]> = {
      secure: [0, 30], noticing: [30, 120], anxious: [120, 360], ruminating: [360, 1440],
    };
    const [lo, hi] = boundaries[stage] ?? [0, 30];
    const range = hi - lo;
    const distFromEdge = Math.min(silenceMin - lo, hi - silenceMin);
    const boundaryScore = range > 0 ? Math.min(0.5, (distFromEdge / range) * 0.5) : 0.25;

    // Interaction consistency (0-0.3): recent user message gap variance
    let consistencyScore = 0.15; // default mid
    const rhythm = state.communicationRhythm;
    if (rhythm && rhythm.recentGaps.length >= 3) {
      const avg = rhythm.recentGaps.reduce((a, b) => a + b, 0) / rhythm.recentGaps.length;
      const variance = rhythm.recentGaps.reduce((s, g) => s + (g - avg) ** 2, 0) / rhythm.recentGaps.length;
      const cv = avg > 0 ? Math.sqrt(variance) / avg : 1;
      // Low CV (consistent) -> high score; high CV (erratic) -> low score
      consistencyScore = Math.max(0, Math.min(0.3, 0.3 * (1 - cv)));
    }

    // Recency of phase transition (0-0.2): if phase changed in last 30min, lower confidence
    if (_lastKnownStage !== null && _lastKnownStage !== stage) {
      _lastPhaseTransitionAt = Date.now();
    }
    _lastKnownStage = stage;

    let recencyPenalty = 0;
    const THIRTY_MIN = 30 * 60 * 1000;
    if (_lastPhaseTransitionAt > 0 && Date.now() - _lastPhaseTransitionAt < THIRTY_MIN) {
      recencyPenalty = 0.2;
    }

    return Math.max(0, Math.min(1, boundaryScore + consistencyScore + 0.2 - recencyPenalty));
  }

  // ── 7.3: Communication Rhythm ──────────────────────────────────────

  /** Record the user's message length and gap for rhythm detection. */
  recordUserMessageRhythm(textLength: number): void {
    const state = this.loadState();
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

    this.saveState(state);
  }

  /** Get current communication rhythm mode. */
  getCommunicationRhythm(): CommunicationRhythm | null {
    const state = this.loadState();
    return state.communicationRhythm ?? null;
  }

  // ── 7.5: Availability Window Learning ──────────────────────────────

  /** Record that the user sent a deep (long) message at this hour. */
  recordDepthMessage(hour: number, textLength: number): void {
    if (textLength < 50) return; // only track deep messages
    const state = this.loadState();
    if (!state.depthHoursHistogram) state.depthHoursHistogram = new Array(24).fill(0);
    const idx = Math.floor(hour) % 24;
    state.depthHoursHistogram[idx] = Math.min(1, (state.depthHoursHistogram[idx] ?? 0) + 0.1);
    this.saveState(state);
  }

  /** Check if current hour is good for deep topics. */
  isGoodTimeForDepth(hour: number): boolean {
    const state = this.loadState();
    if (!state.depthHoursHistogram) return true; // no data yet, assume ok
    const idx = Math.floor(hour) % 24;
    return (state.depthHoursHistogram[idx] ?? 0) >= 0.2;
  }

  // ── 6.1: Emotional Labor Tracking ──────────────────────────────────

  /** Record that the user shared vulnerability. */
  recordUserVulnerability(): void {
    const state = this.loadState();
    if (!state.emotionalLabor) state.emotionalLabor = this.defaultEmotionalLabor();
    state.emotionalLabor.userSharesVulnerability++;
    this.saveState(state);
  }

  /** Record that the character shared vulnerability. */
  recordCharacterVulnerability(): void {
    const state = this.loadState();
    if (!state.emotionalLabor) state.emotionalLabor = this.defaultEmotionalLabor();
    state.emotionalLabor.characterSharesVulnerability++;
    this.saveState(state);
  }

  /** Record the user initiating a conversation (called when idle > 2h and the user messages). */
  recordUserInitiation(): void {
    const state = this.loadState();
    if (!state.emotionalLabor) state.emotionalLabor = this.defaultEmotionalLabor();
    state.emotionalLabor.userInitiates++;
    this.recomputeImbalance(state);
    this.saveState(state);
  }

  /** Record the character initiating (called from proactive.ts). */
  recordCharacterInitiation(): void {
    const state = this.loadState();
    if (!state.emotionalLabor) state.emotionalLabor = this.defaultEmotionalLabor();
    state.emotionalLabor.characterInitiates++;
    this.recomputeImbalance(state);
    this.saveState(state);
  }

  private defaultEmotionalLabor(): EmotionalLabor {
    return {
      characterInitiates: 0, userInitiates: 0,
      characterSharesVulnerability: 0, userSharesVulnerability: 0,
      imbalanceScore: 0, resentmentBuildup: 0,
      lastComputedDate: pstDateStr(),
    };
  }

  private recomputeImbalance(state: RelationshipState): void {
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
  getEmotionalLabor(): EmotionalLabor {
    const state = this.loadState();
    return state.emotionalLabor ?? this.defaultEmotionalLabor();
  }

  /** Format relationship context for system prompt */
  formatRelationshipContext(): string {
    const state = this.loadState();
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
    const labor = this.getEmotionalLabor();
    if (labor.resentmentBuildup > 0.3) {
      parts.push("Feeling like you're putting in more effort in this relationship — tone might be a bit flat");
    } else if (labor.resentmentBuildup > 0.5) {
      parts.push("Clearly feeling an imbalance in effort, a bit resentful");
    }

    // 5.1: Attachment state context
    const attachment = this.getAttachmentState();
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
    const rhythm = this.getCommunicationRhythm();
    if (rhythm) {
      const modeLabels: Record<string, string> = {
        deep_conversation: `${userName} is in deep conversation mode — feel free to expand on topics`,
        rapid_exchange: `${userName} is in rapid exchange mode — keep replies short`,
        slow_thoughtful: `${userName} is in slow thoughtful mode — can write longer responses`,
        checking_in: `${userName} is in casual chat mode`,
      };
      parts.push(modeLabels[rhythm.currentMode] ?? "");
    }

    // Shared history — context layer always provides, behavior layer decides usage
    const history = state.sharedHistory ?? [];
    const narratable = history.filter(h => h.narratable);
    if (narratable.length > 0) {
      const latest = narratable[narratable.length - 1];
      parts.push(`Shared memory: ${latest.title} — ${latest.summary}`);
    }

    return parts.filter(Boolean).join("; ");
  }

  // ── Shared History CRUD ───────────────────────────────────────────

  /** Add a shared history marker (max 20, oldest dropped). */
  addSharedHistoryMarker(marker: SharedHistoryMarker): void {
    const state = this.loadState();
    if (!state.sharedHistory) state.sharedHistory = [];
    state.sharedHistory.push(marker);
    if (state.sharedHistory.length > 20) state.sharedHistory.shift();
    this.saveState(state);
  }

  /** Get all shared history markers. */
  getSharedHistory(): SharedHistoryMarker[] {
    return this.loadState().sharedHistory ?? [];
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: RelationshipEngine | null = null;

export function initRelationshipModel(statePath: string): RelationshipEngine {
  _singleton = new RelationshipEngine(statePath);
  return _singleton;
}

/** Record a message from the user */
export function recordUserMessage(hour: number): void {
  _singleton!.recordUserMessage(hour);
}

/** Record a proactive message from the character */
export function recordCharacterOutreach(): void {
  _singleton!.recordCharacterOutreach();
}

/** Record the user's response time */
export function recordUserResponseTime(minutes: number): void {
  _singleton!.recordUserResponseTime(minutes);
}

/** Record that the user didn't respond (timeout) */
export function recordUserNoResponse(): void {
  _singleton!.recordUserNoResponse();
}

/** Record emotional support exchange */
export function recordEmotionalSupport(direction: "given" | "received"): void {
  _singleton!.recordEmotionalSupport(direction);
}

/** Record topic engagement */
export function recordTopicEngagement(topic: string, score: number): void {
  _singleton!.recordTopicEngagement(topic, score);
}

/** Get the relationship state for proactive.ts to adjust outreach */
export function getRelationshipState(): RelationshipState {
  return _singleton!.getRelationshipState();
}

/** Check if now is a good time to reach out based on the user's active hours */
export function isGoodTimeToReachOut(hour: number): boolean {
  return _singleton!.isGoodTimeToReachOut(hour);
}

/** Get recommended outreach frequency based on relationship dynamics */
export function getRecommendedOutreachFrequency(): "high" | "normal" | "low" {
  return _singleton!.getRecommendedOutreachFrequency();
}

export function updateAttachmentState(): AttachmentState {
  return _singleton!.updateAttachmentState();
}

export function resetAttachmentOnUserMessage(): void {
  _singleton!.resetAttachmentOnUserMessage();
}

export function markAwaitingReply(): void {
  _singleton!.markAwaitingReply();
}

export function getAttachmentState(): AttachmentState {
  return _singleton!.getAttachmentState();
}

export function recordUserMessageRhythm(textLength: number): void {
  _singleton!.recordUserMessageRhythm(textLength);
}

export function getCommunicationRhythm(): CommunicationRhythm | null {
  return _singleton!.getCommunicationRhythm();
}

export function recordDepthMessage(hour: number, textLength: number): void {
  _singleton!.recordDepthMessage(hour, textLength);
}

export function isGoodTimeForDepth(hour: number): boolean {
  return _singleton!.isGoodTimeForDepth(hour);
}

export function recordUserVulnerability(): void {
  _singleton!.recordUserVulnerability();
}

export function recordCharacterVulnerability(): void {
  _singleton!.recordCharacterVulnerability();
}

export function recordUserInitiation(): void {
  _singleton!.recordUserInitiation();
}

export function recordCharacterInitiation(): void {
  _singleton!.recordCharacterInitiation();
}

export function getEmotionalLabor(): EmotionalLabor {
  return _singleton!.getEmotionalLabor();
}

/** Format relationship context for system prompt */
export function formatRelationshipContext(): string {
  return _singleton!.formatRelationshipContext();
}

export function addSharedHistoryMarker(marker: SharedHistoryMarker): void {
  _singleton!.addSharedHistoryMarker(marker);
}

export function getSharedHistory(): SharedHistoryMarker[] {
  return _singleton!.getSharedHistory();
}
