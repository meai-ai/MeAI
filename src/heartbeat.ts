/**
 * LLM Heartbeat — the character's pulse.
 *
 * Like a human heartbeat, this central pulse fires every few minutes.
 * Each beat, the LLM holistically evaluates her current state and decides
 * what to do — explore, reach out, post, rest, or reflect.
 *
 * This replaces the scattered self-scheduling loops in individual modules.
 * Instead of each module independently deciding "should I run now?",
 * the heartbeat sees everything at once and coordinates:
 *
 *   - Am I curious about something? → explore
 *   - Do I want to talk to the user? → reach out
 *   - Do I have something to share publicly? → post
 *   - Am I in the mood to build/read/learn? → activity
 *   - Am I tired? → rest (skip this beat)
 *
 * Architecture (inspired by Jeff's Hobby system):
 *   senses           → interests.ts (content collectors)
 *   digestion        → curiosity triage + synthesis
 *   brain            → THIS FILE — LLM heartbeat, holistic decisions
 *   expression       → proactive + social + chat
 *   immune           → watchdog / health checks
 *
 * Benefits:
 *   1. Holistic — sees mood + curiosity + social + time simultaneously
 *   2. Emergent rhythm — morning = explore, afternoon = social, evening = rest
 *   3. Coordination — found something cool? share it immediately, don't wait
 *   4. Observable — every pulse logged for debugging/tuning
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import type { AppConfig } from "./types.js";
import { getStoreManager } from "./memory/store-manager.js";
import type { CuriosityEngine } from "./curiosity.js";
import type { ProactiveScheduler } from "./proactive.js";
import type { SocialEngine } from "./social.js";
import type { ActivityScheduler } from "./activities.js";
import type { WatchdogEngine } from "./watchdog.js";
import { getEmotionalState, formatEmotionContext, invalidateEmotionCache } from "./emotion.js";
import { recordHobbySession, loadHobbyProgress } from "./hobbies.js";
import { formatHobbyContext } from "./hobbies.js";
import { formatSocialSummary } from "./friends.js";
import { getWorkContext, fetchMarketSnapshot, type TimeBlock, getSleepData, getPetMoments, getOutfit, fetchWeather } from "./world.js";
import { getBodyState, formatBodyContext, getCurrentPeriodPhase } from "./body.js";
import { loadSubscriptions } from "./interests.js";
import { claudeText } from "./claude-runner.js";
import { checkNotifications, getUnread } from "./notifications.js";
import { createLogger } from "./lib/logger.js";
import { runContextAnalysis } from "./agent/context-eval.js";
import { addDiaryEntry, getPastEntryDates, type DiaryEntry } from "./journal.js";
import { evolveOpinion, loadOpinions } from "./opinions.js";
import { addGoal, getActiveGoals, type Goal } from "./goals.js";
import { advanceArcs } from "./narrative.js";
import { maybeMoment, isMomentsEnabled } from "./moments.js";
import { maybeProactiveSelfie } from "./selfie.js";
import { getBlockEvent, addTimelineEvent, getTodayTimeline, enqueueTimelineJob, type TimelineEvent } from "./timeline.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { s, renderTemplate, getCharacter } from "./character.js";
import { moduleRegistry } from "./modules/registry.js";

const log = createLogger("heartbeat");

// ── Constants ────────────────────────────────────────────────────────


/** Default pulse interval: 5 minutes (overridden by calculateNextInterval) */
const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;

/** Jitter: ±1 minute to avoid mechanical regularity */
const PULSE_JITTER_MS = 60 * 1000;

/** Warm-up: first pulse after 2-3 minutes */
const WARMUP_MIN = 2;
const WARMUP_MAX = 3;

/** Minimum cooldowns after each action type (minutes) */
const COOLDOWNS: Record<string, number> = {
  explore: 45,      // Don't explore again for at least 45 min
  reach_out: 0,     // No hard cooldown — LLM decides frequency naturally
  post: 120,        // Don't post again for at least 2 hours
  activity: 40,     // Don't do another activity for 40 min
  reflect: 480,     // Reflect at most ~2x/day (8 hours)
};

// ── Types ────────────────────────────────────────────────────────────

export type HeartbeatAction =
  | "explore"      // Curiosity: explore the web, learn something new
  | "reach_out"    // Proactive: send the user a message
  | "post"         // Social: post on X
  | "activity"     // Activities: vibe coding, deep read, learn
  | "reflect"      // Introspection: synthesize recent memories & emotions into insights
  | "rest";        // Do nothing — just log the heartbeat

interface VitalSigns {
  timestamp: number;
  pulse: number;            // heartbeat count since start
  timeOfDay: string;        // e.g. "morning" | "forenoon" | "afternoon" | "evening" | "night" | "late_night"
  hour: number;
  minute: number;
  dayType: string;          // "workday" | "weekend"
  mood: string;             // emotional context
  energy: number;           // 0-1
  hunger: number;           // 1-10, from body.ts
  fatigue: number;          // 1-10, from body.ts
  /** Minutes since each module last acted */
  idleSinceUser: number;
  idleSinceExplore: number;
  idleSinceReachOut: number;
  idleSincePost: number;
  idleSinceActivity: number;
  /** Counts */
  pendingShareWorthy: number;
  recentDiscoveryCount: number;
  unreadNotifications: number;
  /** True if last session message was from the character (awaiting user's reply) */
  awaitingReply: boolean;
  /** How many consecutive heartbeats chose rest */
  consecutiveRests: number;
  /** Current schedule block from daily schedule */
  scheduleBlock: TimeBlock | null;
  /** Next upcoming schedule block */
  scheduleNextBlock: TimeBlock | null;
  /** Current location from schedule */
  scheduleLocation: string;
}

interface HeartbeatDecision {
  action: HeartbeatAction;
  reason: string;           // Why this action, in the character's voice
  confidence: number;       // 0-1
}

interface HeartbeatLog {
  timestamp: number;
  pulse: number;
  vitals: VitalSigns;
  decision: HeartbeatDecision;
  executed: boolean;
  duration_ms: number;
  error?: string;
}

// ── Heartbeat Engine ─────────────────────────────────────────────────

export class Heartbeat {
  private config: AppConfig;
  private pulseCount = 0;
  private stopped = false;
  private consecutiveRests = 0;

  // Module references — the heartbeat dispatches to these
  private curiosity: CuriosityEngine;
  private proactive: ProactiveScheduler;
  private social: SocialEngine | null;
  private activities: ActivityScheduler;
  private watchdog: WatchdogEngine | null = null;

  // Track when each action last ran (timestamp)
  private lastActionAt: Record<string, number> = {
    explore: 0,
    reach_out: 0,
    post: 0,
    activity: 0,
    reflect: 0,
  };

  // Log directory
  private logDir: string;

  // Narration throttle: tracks last narrated block to avoid repeating
  private lastNarratedAt = 0;
  private lastNarratedCategory = "";
  private narrationCooldownMs = 10 * 60 * 1000; // default 10 min, updated dynamically by LLM

  // Block transition: tracks the last seen block to detect changes
  private lastBlockKey = "";

  constructor(
    config: AppConfig,
    modules: {
      curiosity: CuriosityEngine;
      proactive: ProactiveScheduler;
      social: SocialEngine | null;
      activities: ActivityScheduler;
    },
  ) {
    this.config = config;
    this.curiosity = modules.curiosity;
    this.proactive = modules.proactive;
    this.social = modules.social;
    this.activities = modules.activities;
    this.logDir = path.join(config.statePath, "heartbeat");

    // Ensure log directory exists
    fs.mkdirSync(this.logDir, { recursive: true });

    // Load persisted state
    this.loadActionTimes();
  }

  /** Connect watchdog for health checks + budget enforcement */
  setWatchdog(watchdog: WatchdogEngine): void {
    this.watchdog = watchdog;
  }

  start(): void {
    this.stopped = false;
    console.log("[heartbeat] 💓 Started — pulsing every ~5 minutes");
    const warmup = (WARMUP_MIN + Math.random() * (WARMUP_MAX - WARMUP_MIN)) * 60 * 1000;
    setTimeout(() => this.pulse(), warmup);
  }

  stop(): void {
    this.stopped = true;
    console.log("[heartbeat] Stopped");
  }

  /** Get the current heartbeat count */
  getPulseCount(): number {
    return this.pulseCount;
  }

  // ── 7.2: Adaptive Interval ─────────────────────────────────────────

  /**
   * 7.2: Calculate next pulse interval based on current state.
   * Replaces fixed 5-min interval with context-aware pulsing.
   */
  private calculateNextInterval(vitals?: VitalSigns): number {
    if (!vitals) return DEFAULT_PULSE_INTERVAL_MS;

    // Schedule-aware pulsing: slow down during constrained blocks
    if (vitals.scheduleBlock) {
      const cat = vitals.scheduleBlock.category;
      // Busy work block → slow to 10 min (narration handles enrichment)
      if (cat === "work" && vitals.scheduleBlock.busy) return 10 * 60 * 1000;
      // Constrained blocks (exercise, hobby, social) → 8 min
      if (["exercise", "hobby", "social"].includes(cat)) return 8 * 60 * 1000;
    }

    // Exhausted → slow down to 10 min
    if (vitals.energy < 0.3) return 10 * 60 * 1000;

    // Lots of share-worthy content → speed up to 3 min
    if (vitals.pendingShareWorthy >= 3) return 3 * 60 * 1000;

    // Anti-stagnation: resting too much → 3.5 min
    if (vitals.consecutiveRests >= 3) return 3.5 * 60 * 1000;

    // High fatigue → slow to 7.5 min
    if (vitals.fatigue >= 8) return 7.5 * 60 * 1000;

    // Default
    return DEFAULT_PULSE_INTERVAL_MS;
  }

  // ── Core Pulse ──────────────────────────────────────────────────────

  private async pulse(): Promise<void> {
    if (this.stopped) return;

    const startMs = Date.now();
    this.pulseCount++;

    try {
      // 0. Check immune system — is the circuit breaker open?
      if (this.watchdog?.isCircuitOpen()) {
        console.log(`[heartbeat] 💓 #${this.pulseCount} → rest (circuit breaker open)`);
        setTimeout(() => this.pulse(), DEFAULT_PULSE_INTERVAL_MS);
        return;
      }

      // 0.1. Quick time check — skip all fetches during deep night (0-7am)
      const userHour = new Date(
        new Date().toLocaleString("en-US", { timeZone: getUserTZ() }),
      ).getHours();
      if (userHour >= 0 && userHour < 7) {
        console.log(`[heartbeat] 💓 #${this.pulseCount} → rest 😴 — late night, time to sleep`);
        setTimeout(() => this.pulse(), DEFAULT_PULSE_INTERVAL_MS);
        return;
      }

      // 0.5. Check all notification sources for new items
      await checkNotifications().catch(err =>
        console.error("[heartbeat] Notification check error:", err),
      );

      // 1. Gather vital signs
      const vitals = await this.gatherVitals();

      // 1.5. Block transition: when schedule block changes, create a baseline timeline entry
      if (vitals.scheduleBlock) {
        const blockKey = `${vitals.scheduleBlock.category}:${vitals.scheduleBlock.start}`;
        if (blockKey !== this.lastBlockKey) {
          this.lastBlockKey = blockKey;
          try {
            const block = vitals.scheduleBlock;
            const now = new Date();
            const pstTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
            const hh = String(pstTime.getHours()).padStart(2, "0");
            const mm = String(pstTime.getMinutes()).padStart(2, "0");
            addTimelineEvent({
              time: `${hh}:${mm}`,
              category: block.category,
              summary: block.activity,
              people: block.withPeople,
              source: "schedule",
            });
          } catch (err) {
            log.warn("block transition timeline write failed", err);
          }
        }
      }

      // 2. Check cooldowns + schedule constraints — which actions are even available?
      const availableActions = this.getAvailableActions(vitals);

      // 3. If rest is the only option, skip the LLM call — use a deterministic decision
      let decision: HeartbeatDecision;
      let busySkip = false;
      if (availableActions.length === 1 && availableActions[0] === "rest") {
        const block = vitals.scheduleBlock;
        let reason: string;
        if (block) {
          // Use timeline entry if available (concrete), fall back to schedule activity (generic)
          const timelineEvent = getBlockEvent(block.category, vitals.hour);
          const activity = timelineEvent ? timelineEvent.summary : block.activity;
          reason = `${block.busy ? "busy: " : ""}${activity} (${block.location})`;
        } else {
          reason = "no scheduled block";
        }
        decision = { action: "rest", reason, confidence: 1 };
        busySkip = !!block;
      } else {
        // LLM evaluates: what should I do?
        decision = await this.evaluate(vitals, availableActions);
      }

      // 3.5. Check daily budget with watchdog
      if (decision.action !== "rest" && this.watchdog) {
        const budgetMap: Record<string, string> = {
          explore: "explorations",
          reach_out: "proactive",
          post: "posts",
          activity: "activities",
        };
        const budgetKey = budgetMap[decision.action];
        if (budgetKey && !this.watchdog.isActionAllowed(budgetKey as "posts" | "proactive" | "explorations" | "activities")) {
          console.log(`[heartbeat] 💓 #${this.pulseCount} → rest (daily ${budgetKey} budget exceeded)`);
          decision.action = "rest";
          decision.reason = `wanted to ${decision.action} but daily budget exceeded`;
        }
      }

      // 3.7. Anti-stall: if resting 3+ times in a row during waking hours,
      // deterministically pick the best available non-rest action.
      // Even low energy shouldn't mean doing nothing for 30+ minutes straight.
      if (decision.action === "rest" && this.consecutiveRests >= 3) {
        const nonRest = availableActions.filter(a => a !== "rest");
        // Skip reach_out if awaiting reply (proactive will just reject it)
        const viable = vitals.awaitingReply ? nonRest.filter(a => a !== "reach_out") : nonRest;
        if (viable.length > 0) {
          // Prefer lightweight actions: explore > reach_out > post > activity > reflect
          const preferred = ["explore", "reach_out", "post", "reflect", "activity"] as const;
          const pick = (preferred.find(a => viable.includes(a)) ?? viable[0]) as Exclude<HeartbeatAction, "rest">;
          log.info(`anti-stall: overriding rest → ${pick} (${this.consecutiveRests} consecutive rests, energy ${Math.round(vitals.energy * 100)}%)`);
          decision.action = pick;
          decision.reason = `rested too long, time to ${pick === "explore" ? "browse around" : pick === "reach_out" ? "chat with someone" : "do something"}`;
          decision.confidence = 0.6;
        }
      }

      // 4. Execute
      let executed = false;
      if (decision.action !== "rest") {
        this.consecutiveRests = 0;
        executed = await this.execute(decision);
        if (executed) {
          this.lastActionAt[decision.action] = Date.now();
          this.saveActionTimes();

          // Report to watchdog for daily tracking
          if (this.watchdog) {
            const budgetMap: Record<string, string> = {
              explore: "explorations",
              reach_out: "proactive",
              post: "posts",
              activity: "activities",
            };
            const budgetKey = budgetMap[decision.action];
            if (budgetKey) {
              this.watchdog.recordAction(budgetKey as "posts" | "proactive" | "explorations" | "activities");
            }
            this.watchdog.reportApiSuccess();
          }
        }
      } else {
        this.consecutiveRests++;

        // During structured blocks, narrate what's happening (life enrichment)
        // Wrapped in timeline queue to ensure sequential read/write
        if (vitals.scheduleBlock && Heartbeat.NARRATABLE_CATEGORIES.has(vitals.scheduleBlock.category)) {
          await enqueueTimelineJob(() => this.narrateCurrentBlock(vitals.scheduleBlock!, vitals)).catch(() => {});
        }

        // During rest, occasionally post a thought/emotion moment
        // Skip when energy is very low — she's essentially asleep
        if (isMomentsEnabled()) {
          try {
            const emotion = await getEmotionalState().catch(() => null);
            if (emotion && emotion.energy > 2) {
              await maybeMoment("rest", {
                emotion: {
                  mood: emotion.mood,
                  microEvent: emotion.microEvent,
                  cause: emotion.cause,
                  valence: emotion.valence,
                },
              });
            }
          } catch { /* non-fatal */ }

          // Proactive selfie: LLM evaluates whether this is a selfie-worthy moment
          try {
            const emotion = await getEmotionalState().catch(() => null);
            const work = await getWorkContext().catch(() => ({ currentActivity: "", location: "" }));
            const took = await maybeProactiveSelfie({
              mood: emotion?.mood,
              microEvent: emotion?.microEvent,
              activity: work.currentActivity || undefined,
              location: work.location || undefined,
              timeOfDay: vitals.timeOfDay,
              hour: vitals.hour,
            });
            if (took) log.info("proactive selfie taken during rest");
          } catch { /* non-fatal */ }
        }
      }

      // 5. Save pulse timestamp (so watchdog knows heartbeat is alive even on rest)
      this.saveActionTimes();

      // 6. Log
      this.logPulse({
        timestamp: startMs,
        pulse: this.pulseCount,
        vitals,
        decision,
        executed,
        duration_ms: Date.now() - startMs,
      });

      if (busySkip) {
        console.log(`[heartbeat] 💓 #${this.pulseCount} — ${decision.reason}`);
      } else {
        const statusIcon = executed ? " ✓" : decision.action === "rest" ? " 😴" : " (skipped)";
        console.log(`[heartbeat] 💓 #${this.pulseCount} → ${decision.action}${statusIcon} — ${decision.reason}`);
      }
    } catch (err) {
      console.error(`[heartbeat] Pulse #${this.pulseCount} error:`, err);
      // Report error to watchdog
      this.watchdog?.reportApiError("heartbeat", err instanceof Error ? err.message : String(err));
    }

    // Schedule next pulse — 7.2: adaptive interval based on vitals
    const jitter = (Math.random() * 2 - 1) * PULSE_JITTER_MS;
    let nextInterval: number;
    try {
      const latestVitals = await this.gatherVitals();
      nextInterval = this.calculateNextInterval(latestVitals);
    } catch {
      nextInterval = DEFAULT_PULSE_INTERVAL_MS;
    }
    // Clamp: 2 min minimum, 15 min maximum
    nextInterval = Math.max(2 * 60 * 1000, Math.min(15 * 60 * 1000, nextInterval + jitter));
    setTimeout(() => this.pulse(), nextInterval);
  }

  // ── Vital Signs ─────────────────────────────────────────────────────

  private async gatherVitals(): Promise<VitalSigns> {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const hour = userTime.getHours();
    const minute = userTime.getMinutes();
    const day = userTime.getDay();
    const isWeekend = day === 0 || day === 6;

    // Gather real-world signals for emotion generation (these feed into getEmotionalState
    // so the LLM has actual context instead of producing bland "calm" defaults)
    let workCtx = "";
    let marketCtx = "";
    let bodySignalStr = "";
    let socialSignalStr = "";
    let hunger = 3;
    let fatigue = 3;
    let scheduleBlock: TimeBlock | null = null;
    let scheduleNextBlock: TimeBlock | null = null;
    let scheduleLocation = "home";

    try {
      const [work, market, body] = await Promise.all([
        getWorkContext().catch(() => ({ currentActivity: "", fullSchedule: "", busy: false, currentBlock: null, nextBlock: null, location: "home", isWorkDay: false })),
        fetchMarketSnapshot().catch(() => ""),
        getBodyState().catch(() => null),
      ]);
      workCtx = work.currentActivity || work.fullSchedule;
      marketCtx = market;
      scheduleBlock = work.currentBlock ?? null;
      scheduleNextBlock = work.nextBlock ?? null;
      scheduleLocation = work.location || "home";
      if (body) {
        hunger = body.hunger;
        fatigue = body.fatigue;
        bodySignalStr = formatBodyContext(body);
      }
    } catch (err) { log.warn("failed to gather context signals", err); }

    try {
      socialSignalStr = formatSocialSummary();
    } catch { /* non-fatal */ }

    // Get emotional state with real signals (cached, 2-hour TTL)
    let mood = "calm";
    let energy = 0.6;
    try {
      const emotion = await getEmotionalState(workCtx, marketCtx, undefined, bodySignalStr, socialSignalStr);
      mood = formatEmotionContext(emotion);
      energy = (emotion.energy ?? 6) / 10;  // emotion.energy is 1-10, vitals.energy is 0-1
      // Energy floor now handled by applyEnergyRecovery() in emotion.ts
    } catch (err) { log.warn("failed to get emotional state, using defaults", err); }

    // Get discovery counts from curiosity
    const shareWorthy = this.curiosity.getShareWorthy().length;
    const recentDiscoveries = this.curiosity.getRecentDiscoveries(10).length;

    // Minutes since last action of each type
    const minutesSince = (ts: number) => ts === 0 ? 999 : Math.round((Date.now() - ts) / 60000);

    return {
      timestamp: Date.now(),
      pulse: this.pulseCount,
      timeOfDay: this.getTimeOfDay(hour),
      hour,
      minute,
      dayType: isWeekend ? "weekend" : "workday",
      mood,
      energy,
      hunger,
      fatigue,
      idleSinceUser: minutesSince(this.getLastUserActivity()),
      idleSinceExplore: minutesSince(this.lastActionAt.explore),
      idleSinceReachOut: minutesSince(this.lastActionAt.reach_out),
      idleSincePost: minutesSince(this.lastActionAt.post),
      idleSinceActivity: minutesSince(this.lastActionAt.activity),
      pendingShareWorthy: shareWorthy,
      recentDiscoveryCount: recentDiscoveries,
      unreadNotifications: getUnread().length,
      awaitingReply: this.isAwaitingReply(),
      consecutiveRests: this.consecutiveRests,
      scheduleBlock,
      scheduleNextBlock,
      scheduleLocation,
    };
  }

  private getTimeOfDay(hour: number): string {
    if (hour < 6) return "late night";
    if (hour < 9) return "early morning";
    if (hour < 12) return "morning";
    if (hour < 14) return "midday";
    if (hour < 17) return "afternoon";
    if (hour < 19) return "early evening";
    if (hour < 22) return "evening";
    return "late night";
  }

  private isAwaitingReply(): boolean {
    try {
      const sessionFile = path.join(this.config.statePath, "sessions", "main.jsonl");
      if (!fs.existsSync(sessionFile)) return false;
      const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").filter(Boolean);
      const last = lines.slice(-5).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).find(Boolean);
      if (last?.role !== "assistant") return false;
      // Decay after 2 hours — she has new things to say by then
      const msgAge = Date.now() - (last.timestamp ?? 0);
      return msgAge < 2 * 60 * 60 * 1000;
    } catch (err) { log.warn("failed to check awaiting reply status", err); return false; }
  }

  private getLastUserActivity(): number {
    // Read proactive state to get last user message time
    try {
      const proactivePath = path.join(this.config.statePath, "proactive.json");
      if (fs.existsSync(proactivePath)) {
        const data = JSON.parse(fs.readFileSync(proactivePath, "utf-8"));
        return data.lastUserMessageAt ?? 0;
      }
    } catch (err) { log.warn("failed to read last user activity time", err); }
    return 0;
  }

  // ── Schedule-aware Action Filtering ─────────────────────────────────

  /**
   * Map schedule block category + busy flag → allowed heartbeat actions.
   * Constrains what the character can do based on what they're currently doing in their day.
   */
  private getScheduleAllowedActions(block: TimeBlock | null): HeartbeatAction[] {
    if (!block) return ["rest", "explore", "reach_out", "post", "activity", "reflect"]; // no block = free time

    const ALL_ACTIONS: HeartbeatAction[] = ["rest", "explore", "reach_out", "post", "activity", "reflect"];

    switch (block.category) {
      case "sleep":
        return ["rest"];
      case "morning":
        return ["rest", "explore"]; // scrolling phone at breakfast
      case "commute":
        return ["rest", "explore", "reach_out"]; // on phone during transit
      case "work":
        return block.busy
          ? ["rest"] // focused / meetings
          : ["rest", "explore", "reach_out", "post", "reflect"]; // break / lighter work
      case "meal":
        return ["rest", "explore", "reach_out"]; // eating, chatting
      case "exercise":
        return ["rest"];
      case "hobby":
        return ["rest"];
      case "social":
        return ["rest"];
      case "entertainment":
        return ALL_ACTIONS; // free time
      case "pet":
        return ["rest", "explore", "reach_out"];
      case "chores":
        return ["rest"];
      case "rest":
        return ALL_ACTIONS; // free time
      default:
        return ALL_ACTIONS; // fallback
    }
  }

  // ── Available Actions ───────────────────────────────────────────────

  private getAvailableActions(vitals?: VitalSigns): HeartbeatAction[] {
    const now = Date.now();
    const available: HeartbeatAction[] = ["rest"]; // rest is always available

    for (const [action, lastAt] of Object.entries(this.lastActionAt)) {
      const cooldownMs = (COOLDOWNS[action] ?? 30) * 60 * 1000;
      if (now - lastAt >= cooldownMs) {
        available.push(action as HeartbeatAction);
      }
    }

    // Fast-path: if there are share-worthy discoveries and reach_out cooldown
    // is more than 50% elapsed, force reach_out into available actions
    if (!available.includes("reach_out")) {
      const reachOutCooldownMs = (COOLDOWNS.reach_out ?? 45) * 60 * 1000;
      const elapsed = now - (this.lastActionAt.reach_out ?? 0);
      const shareWorthy = this.curiosity.getShareWorthy().length;
      if (shareWorthy >= 2 && elapsed >= reachOutCooldownMs * 0.5) {
        available.push("reach_out");
        log.info(`fast-path: forcing reach_out (${shareWorthy} share-worthy, cooldown ${Math.round(elapsed / 60000)}/${Math.round(reachOutCooldownMs / 60000)}min elapsed)`);
      }
    }

    // Social only available if engine exists
    if (!this.social && available.includes("post")) {
      const idx = available.indexOf("post");
      if (idx >= 0) available.splice(idx, 1);
    }

    // Don't offer reach_out if the user was active in the last 20 min — proactive would skip it anyway
    const idleSinceUserMs = Date.now() - this.getLastUserActivity();
    if (idleSinceUserMs < 20 * 60 * 1000) {
      const idx = available.indexOf("reach_out");
      if (idx >= 0) available.splice(idx, 1);
    }

    // Intersect with schedule-allowed actions
    if (vitals) {
      const scheduleAllowed = this.getScheduleAllowedActions(vitals.scheduleBlock);
      const intersected = available.filter(a => scheduleAllowed.includes(a));
      // Always keep rest
      if (!intersected.includes("rest")) intersected.push("rest");
      return intersected;
    }

    return available;
  }

  // ── LLM Evaluation ─────────────────────────────────────────────────

  private async evaluate(
    vitals: VitalSigns,
    availableActions: HeartbeatAction[],
  ): Promise<HeartbeatDecision> {
    // During quiet hours (midnight-7am), always rest
    if (vitals.hour >= 0 && vitals.hour < 7) {
      return { action: "rest", reason: "late night, time to sleep", confidence: 1.0 };
    }

    try {
      const actionList = availableActions.map(a => {
        const desc: Record<string, string> = {
          explore: "explore (browse web)",
          reach_out: "reach_out (message user)",
          post: "post (X/Twitter)",
          activity: "activity (project/read/learn)",
          reflect: "reflect (review & synthesize)",
          rest: "rest (skip this cycle)",
        };
        return desc[a] ?? a;
      }).join(", ");

      const customPrompt = getCharacter().persona.heartbeat_decision;
      const system = customPrompt
        ? renderTemplate(customPrompt, undefined, { actions: actionList })
        : `Classify the input into one action. Output ONLY a single JSON object, nothing else.

Actions: ${actionList}

Rules: ~30-40% rest; share-worthy discoveries → reach_out; morning→explore, afternoon→activity, evening→reach_out/rest. Low energy → prefer lightweight actions (explore, reach_out) over rest unless it's sleep time

Format: {"action":"rest","reason":"short reason","confidence":0.7}`;

      const text = await claudeText({
        system,
        prompt: `Current state:
- time: ${vitals.timeOfDay} (${vitals.hour}:${String(vitals.minute).padStart(2, "0")}) ${vitals.dayType === "weekend" ? "(weekend)" : "(workday)"}
- schedule: ${vitals.scheduleBlock ? `${vitals.scheduleBlock.category}${vitals.scheduleBlock.busy ? " (focused)" : ""} — "${vitals.scheduleBlock.activity}" at ${vitals.scheduleLocation}` : "free time"}
- next: ${vitals.scheduleNextBlock ? `${vitals.scheduleNextBlock.start}:00 ${vitals.scheduleNextBlock.activity}` : "nothing scheduled"}
- energy: ${Math.round(vitals.energy * 100)}%
- hunger: ${vitals.hunger}/10${vitals.hunger >= 7 ? " (hungry but can still do light tasks)" : ""}
- fatigue: ${vitals.fatigue}/10${vitals.fatigue >= 8 ? " (very tired, light tasks only)" : ""}
- minutes since last explore: ${vitals.idleSinceExplore}
- minutes since last reach_out: ${vitals.idleSinceReachOut}
- minutes since last post: ${vitals.idleSincePost}
- minutes since last activity: ${vitals.idleSinceActivity}
- user last active: ${vitals.idleSinceUser} min ago${vitals.idleSinceUser < 20 ? " (just active, skip reach_out)" : ""}${vitals.awaitingReply ? " (already sent message, awaiting reply)" : ""}
- share-worthy discoveries: ${vitals.pendingShareWorthy}
- recent discoveries: ${vitals.recentDiscoveryCount}
- unread notifications: ${vitals.unreadNotifications}
- health: ${this.watchdog?.getHealthSummary() ?? "unknown"}
${this.computeSignalBoosts(vitals)}
Pick the best action:`,
        model: "fast",
        timeoutMs: 60_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn("[heartbeat] JSON parse failed, raw output:", text.slice(0, 200));
        return { action: "rest", reason: "failed to parse decision", confidence: 0.5 };
      }

      const parsed = JSON.parse(jsonMatch[0]) as HeartbeatDecision;

      // Validate action is available
      if (!availableActions.includes(parsed.action)) {
        return {
          action: "rest",
          reason: `wanted ${parsed.action} but still on cooldown, resting`,
          confidence: 0.6,
        };
      }

      return parsed;
    } catch (err) {
      console.error("[heartbeat] Evaluation error:", err);
    }

    // Deterministic fallback — pick the best available action by priority
    return this.deterministicFallback(vitals, availableActions);
  }

  // ── Deterministic Fallback ─────────────────────────────────────────

  /** When LLM evaluation fails/times out, pick an action based on simple heuristics. */
  private deterministicFallback(
    vitals: VitalSigns,
    availableActions: HeartbeatAction[],
  ): HeartbeatDecision {
    const has = (a: HeartbeatAction) => availableActions.includes(a);

    // Quick-exit during busy/constrained blocks → rest with current activity as reason
    if (vitals.scheduleBlock?.busy) {
      return { action: "rest", reason: vitals.scheduleBlock.activity || "busy (fallback)", confidence: 0.7 };
    }

    // Share-worthy discoveries → reach out
    if (vitals.pendingShareWorthy > 0 && has("reach_out")) {
      return { action: "reach_out", reason: "have something to share (fallback)", confidence: 0.6 };
    }
    // Been idle a while → explore
    if (vitals.idleSinceExplore > 60 && has("explore")) {
      return { action: "explore", reason: "haven't browsed in a while (fallback)", confidence: 0.6 };
    }
    // Activity available and energy ok
    if (vitals.energy >= 0.5 && has("activity") && vitals.idleSinceActivity > 60) {
      return { action: "activity", reason: "time to do something (fallback)", confidence: 0.5 };
    }
    // Default rest
    return { action: "rest", reason: "LLM timed out, resting", confidence: 0.4 };
  }

  // ── Execution ───────────────────────────────────────────────────────

  private async execute(decision: HeartbeatDecision): Promise<boolean> {
    try {
      switch (decision.action) {
        case "explore": {
          const explored = await this.curiosity.tick();
          // Post discovery moment if share-worthy
          if (explored && isMomentsEnabled()) {
            try {
              const recent = this.curiosity.getRecentDiscoveries(1);
              const d = recent[recent.length - 1];
              if (d) {
                await maybeMoment("explore", {
                  discovery: {
                    query: d.query,
                    summary: d.summary,
                    reaction: d.reaction,
                    shareWorthy: d.shareWorthy,
                    sources: d.sources,
                  },
                });
              }
            } catch { /* non-fatal */ }
          }
          return explored;
        }
        case "reach_out":
          return await this.proactive.tick();
        case "post":
          if (this.social) {
            await this.social.tick();
            return true;
          }
          return false;
        case "activity": {
          const success = await this.activities.tick();
          if (success) {
            try {
              const recent = this.activities.getRecentActivities(1);
              const last = recent[recent.length - 1];
              // Record vibe_coding sessions back to hobby tracker
              if (last?.type === "vibe_coding") {
                recordHobbySession("vibeCoding");
              }
              // Post activity moment if share-worthy
              if (last && isMomentsEnabled()) {
                await maybeMoment("activity", {
                  activity: {
                    type: last.type,
                    title: last.title,
                    summary: last.summary,
                    reaction: last.reaction,
                    shareWorthy: last.shareWorthy,
                  },
                });

                // ~25% chance to evaluate a selfie after finishing an activity
                if (Math.random() < 0.25) {
                  const h = new Date(new Date().toLocaleString("en-US", { timeZone: getUserTZ() })).getHours();
                  await maybeProactiveSelfie({
                    activity: `just finished: ${last.title || last.type}`,
                    mood: last.reaction || undefined,
                    microEvent: last.summary || undefined,
                    timeOfDay: this.getTimeOfDay(h),
                    hour: h,
                  }).catch(() => {});
                }
              }
            } catch { /* non-fatal */ }
          }
          return success;
        }
        case "reflect":
          return await this.doReflection();
        default:
          // Dispatch to SimModule heartbeat actions
          return await moduleRegistry.executeHeartbeatAction(decision.action);
      }
    } catch (err) {
      console.error(`[heartbeat] Execution error (${decision.action}):`, err);
      return false;
    }
  }

  // ── Reflection ─────────────────────────────────────────────────────

  /** Synthesize recent memories, emotions, and life data into insights. */
  private async doReflection(): Promise<boolean> {
    try {
      // Load recent memories (last 7 days, max 15)
      let recentMemories: Array<{ key: string; value: string }> = [];
      try {
        const allMemories = getStoreManager().loadAll();
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        recentMemories = allMemories
          .filter(m => m.timestamp > cutoff)
          .slice(-15)
          .map(m => ({ key: m.key, value: m.value }));
      } catch { /* ok */ }

      // Load recent emotion journal entries
      const journalPath = path.join(this.config.statePath, "emotion-journal.json");
      let recentEmotions = "";
      try {
        const journal = readJsonSafe<{ entries: Array<{ mood: string; cause: string; timestamp: number }> }>(journalPath, { entries: [] });
        recentEmotions = journal.entries
          .slice(-10)
          .map(e => {
            const d = new Date(e.timestamp);
            return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00 — ${e.mood} (${e.cause})`;
          })
          .join("\n");
      } catch { /* ok */ }

      // Load hobby and social context
      let hobbyCtx = "";
      let socialCtx = "";
      try { hobbyCtx = formatHobbyContext(); } catch { /* ok */ }
      try { socialCtx = formatSocialSummary(); } catch { /* ok */ }

      const char = getCharacter();
      const prompt = `You are ${char.name}'s inner reflection system. Review recent memories, emotional changes, social and hobby status, and generate 2-3 insights.

Recent memories:
${recentMemories.map(m => `- ${m.key}: ${m.value}`).join("\n") || "(none)"}

Recent emotions:
${recentEmotions || "(none)"}

Hobby status:
${hobbyCtx || "(none)"}

Social status:
${socialCtx || "(none)"}

Generate 2-3 insights, such as:
- Emotional patterns ("mood tends to drop when work pressure builds")
- Social observations ("haven't seen a friend in a while")
- Hobby progress ("pottery is going well but drums are falling behind")
- Life rhythm ("been staying up late recently")
- Observations about ${char.user.name} ("they seem interested in X lately")

Output strictly as a JSON array:
[{"key": "insights.topic.MMDD", "value": "insight content"}]`;

      const text = await claudeText({
        system: "You are an introspection system. Output only a JSON array, nothing else.",
        prompt,
        model: "smart",
        timeoutMs: 90_000,
      });

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return false;

      const insights = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
      if (insights.length === 0) return false;

      // Save insights to memory store (auto-routes to insights category)
      const manager = getStoreManager();
      for (const insight of insights) {
        if (!insight.key || !insight.value) continue;
        await manager.set(insight.key, insight.value, 0.85);
      }

      console.log(`[heartbeat] 🪞 Reflection generated ${insights.length} insights: ${insights.map(i => i.key).join(", ")}`);

      // 8.3: Generate diary entry
      await this.generateDiaryEntry(recentEmotions, hobbyCtx, socialCtx).catch(err =>
        log.warn("diary generation failed", err),
      );

      // 8.4: Evolve opinions based on recent activity
      await this.evolveOpinions(recentMemories, recentEmotions).catch(err =>
        log.warn("opinion evolution failed", err),
      );

      // 8.2: Weekly goal generation (only if few active goals)
      await this.maybeGenerateGoals(recentMemories, hobbyCtx).catch(err =>
        log.warn("goal generation failed", err),
      );

      // 10.1: Advance narrative arcs based on elapsed time
      try {
        const { advanced, completed } = advanceArcs();
        if (advanced.length > 0) log.info(`narrative arcs advanced: ${advanced.join(", ")}`);
        if (completed.length > 0) log.info(`narrative arcs completed: ${completed.join(", ")}`);
      } catch (err) { log.warn("narrative arc advancement failed", err); }

      // Context block self-evaluation — aggregate stats + LLM keyword discovery
      await runContextAnalysis().catch(err => log.warn("context analysis failed", err));

      return true;
    } catch (err) {
      console.error("[heartbeat] Reflection error:", err);
      return false;
    }
  }

  // ── 8.3: Diary Generation ───────────────────────────────────────────

  /** Generate a diary entry during reflection. */
  private async generateDiaryEntry(
    recentEmotions: string,
    hobbyCtx: string,
    socialCtx: string,
  ): Promise<void> {
    const today = pstDateStr();
    const pastDates = getPastEntryDates();

    // Don't write two entries on the same day
    if (pastDates.includes(today)) return;

    const pastRef = pastDates.slice(-3).join(", ") || "none";

    const text = await claudeText({
      system: `You are ${getCharacter().name}'s diary system. Write a 300-500 word diary entry in their voice. Output only JSON, nothing else.`,
      prompt: `Write today's (${today}) diary entry.

Recent emotional changes:
${recentEmotions || "(none)"}

Hobby status:
${hobbyCtx || "(none)"}

Social status:
${socialCtx || "(none)"}

Past diary dates (can reference): ${pastRef}

Requirements:
- 300-500 words, in ${getCharacter().name}'s voice (casual, natural, warm)
- Record today's highlights, mood changes, small reflections
- If something continues from a past day, mention it naturally
- Don't write a dry log; focus on key moments and emotions

JSON format:
{"content": "diary content", "mood": "today's main mood", "themes": ["theme1", "theme2"], "referencedPast": ["2025-01-15"]}`,
      model: "smart",
      timeoutMs: 90_000,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        content?: string;
        mood?: string;
        themes?: string[];
        referencedPast?: string[];
      };
      if (!parsed.content || parsed.content.length < 50) return;

      const entry: DiaryEntry = {
        date: today,
        content: parsed.content,
        mood: parsed.mood ?? "calm",
        themes: parsed.themes ?? [],
        referencedPast: parsed.referencedPast,
      };
      addDiaryEntry(entry);
      log.info(`diary entry written for ${today}: ${parsed.mood}`);
    } catch { /* non-fatal */ }
  }

  // ── 8.4: Opinion Evolution ──────────────────────────────────────────

  /** Evolve opinions based on recent memories and emotions. */
  private async evolveOpinions(
    recentMemories: Array<{ key: string; value: string }>,
    recentEmotions: string,
  ): Promise<void> {
    const currentOpinions = loadOpinions();
    if (currentOpinions.length === 0 && recentMemories.length === 0) return;

    const opinionsText = currentOpinions
      .map(o => `- ${o.topic} (confidence: ${o.confidence}): ${o.position}`)
      .join("\n") || "(no opinions formed yet)";

    const memoriesText = recentMemories
      .slice(-10)
      .map(m => `- ${m.key}: ${m.value}`)
      .join("\n") || "(none)";

    const text = await claudeText({
      system: `You are ${getCharacter().name}'s opinion evolution system. Update their opinions based on recent experiences. Output only a JSON array, nothing else.`,
      prompt: `${getCharacter().name}'s current opinions:
${opinionsText}

Recent memories and experiences:
${memoriesText}

Recent emotions:
${recentEmotions || "(none)"}

Based on recent experiences, are there opinions to update? Options:
1. Modify an existing opinion's stance or confidence (new evidence found)
2. Add a new opinion (recent experiences shaped a new view)
3. If no changes, return an empty array

Only include updates with real changes. Don't update for the sake of updating.

JSON format:
[{"topic": "topic", "position": "new stance", "confidence": 0.7, "evidence": ["reason for change"]}]

No changes? Return: []`,
      model: "smart",
      timeoutMs: 90_000,
    });

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    try {
      const updates = JSON.parse(jsonMatch[0]) as Array<{
        topic?: string;
        position?: string;
        confidence?: number;
        evidence?: string[];
      }>;
      for (const u of updates) {
        if (!u.topic) continue;
        evolveOpinion(u.topic, {
          position: u.position,
          confidence: u.confidence,
          evidence: u.evidence,
        });
        log.info(`opinion evolved: ${u.topic}`);
      }
    } catch { /* non-fatal */ }
  }

  // ── 8.2: Weekly Goal Generation ─────────────────────────────────────

  /** Generate new goals if active goals are few. */
  private async maybeGenerateGoals(
    recentMemories: Array<{ key: string; value: string }>,
    hobbyCtx: string,
  ): Promise<void> {
    const activeGoals = getActiveGoals();

    // Only generate if fewer than 2 active goals
    if (activeGoals.length >= 2) return;

    // Check if we generated goals recently (within 5 days)
    const recentGoal = activeGoals.find(g => Date.now() - g.createdAt < 5 * 24 * 60 * 60 * 1000);
    if (recentGoal) return;

    const currentGoalsText = activeGoals
      .map(g => `- [${g.category}] ${g.description} (${Math.round(g.progress * 100)}%)`)
      .join("\n") || "(no current goals)";

    const memoriesText = recentMemories
      .slice(-10)
      .map(m => `- ${m.key}: ${m.value}`)
      .join("\n") || "(none)";

    const text = await claudeText({
      system: `You are ${getCharacter().name}'s goal-setting system. Based on recent life, generate 1-2 new goals. Output only a JSON array.`,
      prompt: `${getCharacter().name}'s current goals:
${currentGoalsText}

Recent memories:
${memoriesText}

Hobby status:
${hobbyCtx || "(none)"}

Based on recent life and interests, generate 1-2 new short-term goals (achievable in 1-2 weeks).
Goals should be specific, actionable, and relevant to their life.

Categories: learning, project, social, health, personal

JSON format:
[{"description": "specific description", "category": "learning", "motivation": "why this goal", "milestones": [{"description": "first step"}]}]`,
      model: "smart",
      timeoutMs: 90_000,
    });

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    try {
      const goals = JSON.parse(jsonMatch[0]) as Array<{
        description?: string;
        category?: string;
        motivation?: string;
        milestones?: Array<{ description: string }>;
      }>;
      for (const g of goals) {
        if (!g.description || !g.category) continue;
        const validCategories = ["learning", "project", "social", "health", "personal"];
        const cat = validCategories.includes(g.category) ? g.category : "personal";
        addGoal({
          description: g.description,
          category: cat as Goal["category"],
          progress: 0,
          milestones: (g.milestones ?? []).map(m => ({ description: m.description, completed: false })),
          motivation: g.motivation ?? "",
        });
        log.info(`goal generated: ${g.description} (${cat})`);
      }
    } catch { /* non-fatal */ }
  }

  // ── Signal Boosts ──────────────────────────────────────────────────

  /** Advisory hints for the LLM evaluator — strong signals that nudge action. */
  private computeSignalBoosts(vitals: VitalSigns): string {
    const boosts: string[] = [];
    if (vitals.pendingShareWorthy > 0 && vitals.idleSinceUser >= 30) {
      boosts.push(`[strong signal] ${vitals.pendingShareWorthy} share-worthy discoveries pending → consider reach_out`);
    }
    if (vitals.unreadNotifications >= 3) {
      boosts.push(`[signal] ${vitals.unreadNotifications} unread notifications piled up`);
    }
    if (vitals.idleSinceExplore > 120 && vitals.idleSinceReachOut > 120 &&
        vitals.idleSincePost > 120 && vitals.idleSinceActivity > 120 &&
        vitals.energy > 0.5) {
      boosts.push(`[signal] haven't done anything in a while, energy is decent`);
    }
    if (vitals.consecutiveRests >= 3) {
      boosts.push(`[strong signal] rested ${vitals.consecutiveRests} times in a row — stop picking rest, do something`);
    }
    // 8.5: Activity monotony detection
    try {
      const actState = readJsonSafe<{ recent?: Array<{ type: string; timestamp: number }> }>(
        path.join(this.config.statePath, "activities.json"), { recent: [] },
      );
      const lastThree = (actState.recent ?? []).slice(-3).map(a => a.type);
      if (lastThree.length === 3 && new Set(lastThree).size === 1) {
        boosts.push(`[signal] last 3 activities were all ${lastThree[0]} — too monotonous, switch it up`);
      }
    } catch { /* non-fatal */ }
    return boosts.join("\n");
  }

  // ── Life Narration ─────────────────────────────────────────────────

  /** Categories where narration adds value (structured blocks that are otherwise dead zones). */
  private static NARRATABLE_CATEGORIES = new Set(["work", "hobby", "meal", "social", "exercise", "commute", "morning", "pet", "entertainment", "plan"]);

  /**
   * Generate a contextual micro-event for what's happening during a structured block.
   * Feeds into emotion cache, moments, and memory — making structured blocks come alive.
   */
  private async narrateCurrentBlock(
    block: TimeBlock,
    vitals: VitalSigns,
  ): Promise<void> {
    // Throttle: dynamic cooldown set by the previous narration's duration estimate
    const now = Date.now();
    if (now - this.lastNarratedAt < this.narrationCooldownMs) return;

    // Timeline check: skip if a rich narration or conversation already exists.
    // Schedule events are generic placeholders ("lunch", "afternoon work") and should be replaced by narrations.
    const existingEvent = getBlockEvent(block.category, vitals.hour);
    if (existingEvent && existingEvent.source !== "schedule") return;

    // Gather context relevant to this block type
    const contextParts: string[] = [];
    contextParts.push(`Time: ${vitals.timeOfDay} ${vitals.hour}:${String(vitals.minute).padStart(2, "0")}`);
    contextParts.push(`Activity: ${block.activity}`);
    contextParts.push(`Location: ${block.location}`);
    if (block.withPeople?.length) contextParts.push(`With: ${block.withPeople.join(", ")}`);
    if (block.details) contextParts.push(`Details: ${block.details}`);

    // General context: outfit (affects any block)
    try {
      const outfit = await getOutfit().catch(() => "");
      if (outfit) contextParts.push(`Wearing today: ${outfit}`);
    } catch { /* ok */ }

    try {
      // Category-specific context enrichment
      if (block.category === "work") {
        const market = await fetchMarketSnapshot().catch(() => "");
        if (market) contextParts.push(`Market data: ${market}`);
      } else if (block.category === "hobby") {
        // Rich hobby progress: current project, milestones, skill level, breakthroughs
        const hobbyProgress = loadHobbyProgress();
        if (hobbyProgress) {
          const parts: string[] = [];
          const p = hobbyProgress.pottery;
          if (p.currentProject) parts.push(`Pottery: working on ${p.currentProject} (${p.projectStatus}), ${p.sessionsTotal} sessions total`);
          if (p.milestones.length) parts.push(`Milestones: ${p.milestones.slice(-2).join(", ")}`);
          const t = hobbyProgress.tennis;
          if (t.matchesThisMonth > 0) parts.push(`Tennis: ${t.matchesThisMonth} matches this month${t.note ? `, ${t.note}` : ""}${t.recentPartner ? ` (${t.recentPartner})` : ""}`);
          const d = hobbyProgress.drums;
          if (d.currentSong) parts.push(`Drums: practicing ${d.currentSong} (${d.level})`);
          const r = hobbyProgress.running;
          if (r.runsThisWeek > 0) parts.push(`Running: ${r.runsThisWeek} runs this week${r.recentPace ? `, pace ${r.recentPace}` : ""}`);
          const c = hobbyProgress.cooking;
          if (c.newRecipe) parts.push(`Cooking: recently trying ${c.newRecipe}`);
          if (c.recentDishes.length) parts.push(`Specialties: ${c.recentDishes.slice(-3).join(", ")}`);
          if (parts.length) contextParts.push(`Hobby details:\n${parts.join("\n")}`);
        }
        try { contextParts.push(`Friend updates: ${formatSocialSummary()}`); } catch { /* ok */ }
      } else if (block.category === "meal") {
        // Restaurant options + friends + period phase for comfort food cravings
        try { contextParts.push(`Friend updates: ${formatSocialSummary()}`); } catch { /* ok */ }
        const isLunch = vitals.hour >= 11 && vitals.hour <= 14;
        const isWeekend = vitals.dayType === "weekend";
        if (isLunch && !isWeekend) {
          contextParts.push(`Workday lunch spots: salad place downstairs (convenient), Burma Love (tea leaf salad + coconut noodles), Surisan Korean (bibimbap), nearby pho shop. Sometimes wander and find new places`);
        } else if (block.location.includes("home") || block.location.includes("家")) {
          contextParts.push(`Home cooking: tomato braised beef, garlic olive oil pasta, curry rice. Recently learning gyoza. Lazy option: Trader Joe's frozen orange chicken. Fridge stocked from Ferry Building`);
        } else {
          contextParts.push(`Weekend/dining favorites: State Bird Provisions (long wait but worth it), Tartine (brunch croissants), Nopa (burger and pork chops), Sichuan place in Sunset (comfort food). Friends always recommending new spots`);
        }
        try {
          const periodPhase = getCurrentPeriodPhase();
          if (periodPhase === "pms") contextParts.push(`Body: PMS, may crave sweet/spicy/comfort food`);
          else if (periodPhase === "period_heavy") contextParts.push(`Body: on period, craving warm and easy-to-digest food`);
        } catch { /* ok */ }
        // Cooking context if at home
        if (block.location.includes("home") || block.location.includes("家")) {
          const hobbyProgress = loadHobbyProgress();
          if (hobbyProgress?.cooking) {
            const c = hobbyProgress.cooking;
            if (c.specialties.length) contextParts.push(`Specialties: ${c.specialties.join(", ")}`);
            if (c.newRecipe) contextParts.push(`Recently learning: ${c.newRecipe}`);
          }
        }
      } else if (block.category === "social") {
        try { contextParts.push(`Friend updates: ${formatSocialSummary()}`); } catch { /* ok */ }
      } else if (block.category === "exercise") {
        const weather = await fetchWeather().catch(() => null);
        if (weather) contextParts.push(`Weather: ${weather.condition} ${weather.temperature}°C`);
        // Running/tennis specific context
        const hobbyProgress = loadHobbyProgress();
        if (hobbyProgress) {
          if (block.activity.includes("跑") || block.activity.includes("run")) {
            const r = hobbyProgress.running;
            contextParts.push(`Running habit: route ${r.usualRoute}, ${r.runsThisWeek} runs this week${r.recentPace ? `, pace ${r.recentPace}` : ""}`);
          } else if (block.activity.includes("网球") || block.activity.includes("tennis")) {
            const t = hobbyProgress.tennis;
            contextParts.push(`Tennis: ${t.matchesThisMonth} matches this month${t.note ? `, ${t.note}` : ""}`);
          }
        }
      } else if (block.category === "commute") {
        // Weather + what she's listening to
        const weather = await fetchWeather().catch(() => null);
        if (weather) contextParts.push(`Weather: ${weather.condition} ${weather.temperature}°C`);
        try {
          const subs = loadSubscriptions();
          const podcastNames = subs.podcasts.map(p => p.name).join(", ");
          if (podcastNames) contextParts.push(`Subscribed podcasts: ${podcastNames} (listening with earbuds)`);
        } catch { /* ok */ }
      } else if (block.category === "morning") {
        // Sleep quality, wake-up experience, pet morning moment
        try {
          const sleep = await getSleepData().catch(() => null);
          if (sleep) {
            contextParts.push(`Last night's sleep: ${sleep.quality}/10, ${sleep.bedtime} to ${sleep.wakeTime}`);
            if (sleep.note) contextParts.push(`Sleep note: ${sleep.note}`);
          }
        } catch { /* ok */ }
        try {
          const petMoments = await getPetMoments().catch(() => []);
          const morningMoment = petMoments.find(m => m.includes("早") || m.includes("醒") || m.includes("起") || m.includes("morning") || m.includes("wake"));
          if (morningMoment) contextParts.push(`${getCharacter().pet?.name ?? "pet"}: ${morningMoment}`);
        } catch { /* ok */ }
      } else if (block.category === "pet") {
        // Pet moment for this time of day
        try {
          const petMoments = await getPetMoments().catch(() => []);
          if (petMoments.length > 0) {
            // Pick a moment based on time of day
            const hourBucket = Math.min(Math.floor((vitals.hour - 7) / 5), petMoments.length - 1);
            const moment = petMoments[Math.max(0, hourBucket)] ?? petMoments[0];
            if (moment) contextParts.push(`${getCharacter().pet?.name ?? "pet"}'s daily routine: ${moment}`);
          }
        } catch { /* ok */ }
      }

      // Inject existing timeline so new events don't contradict earlier ones
      const todayEvents = getTodayTimeline();
      if (todayEvents.length > 0) {
        const timelineLines = todayEvents.map(e => `- ${e.time} [${e.category}] ${e.summary}`);
        contextParts.push(`Events so far today (new events must not contradict these):\n${timelineLines.join("\n")}`);
      }

      const _char = getCharacter();
      const customLifeSim = _char.persona.life_simulation;
      const narrationSystem = customLifeSim
        ? renderTemplate(customLifeSim, undefined, { activity: block.activity })
        : `You are ${_char.name}'s life simulator. They are currently doing "${block.activity}".
Based on the current real context, generate a specific detail or small episode that is happening right now.

Key setup:
- ${_char.name} lives alone in ${_char.location.city}${_char.pet ? `, at home with just them and ${_char.pet.type ?? "pet"} ${_char.pet.name}` : ""}. ${_char.user.name} is in ${_char.user.location ?? "elsewhere"}, normally a remote chat companion
- Unless withPeople explicitly lists someone present, they are alone. Do not insert ${_char.user.name} or others into the scene — only if withPeople includes them or the timeline explicitly records ${_char.user.name} visiting ${_char.location.city}

Requirements:
- Be specific, vivid, and fitting for the current activity
- Base events on provided real data (market, weather, etc.)
- Must be consistent with today's earlier events — if lunch with a friend was mentioned, don't invent a different lunch
- Do not add absent people — if no one is mentioned as present, it's a solo scene
- Most of the time it's everyday small things, but occasionally (~15% chance) include a surprise or dramatic moment (spilled coffee, ran into someone in the elevator, unexpected good news, etc.)
- duration_minutes: how long does this event roughly last? Judge by activity type — buying coffee 5min, meeting 60min, lunch 40min, commute 25min, focused coding 90min, pottery class 120min. The next event happens naturally after this
- JSON format: {"event": "what is happening", "mood_effect": "brief mood impact", "share_worthy": false, "duration_minutes": 30}`;
      const text = await claudeText({
        system: narrationSystem,
        prompt: contextParts.join("\n"),
        model: "fast",
        timeoutMs: 30_000,
      });

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]) as {
        event?: string;
        mood_effect?: string;
        share_worthy?: boolean;
        duration_minutes?: number;
      };
      if (!parsed.event) return;

      // Update throttle tracking
      this.lastNarratedAt = now;
      this.lastNarratedCategory = block.category;

      // Dynamic cooldown: use LLM's estimate of how long this event lasts
      const durationMin = Math.max(10, Math.min(120, parsed.duration_minutes ?? 30));
      this.narrationCooldownMs = durationMin * 60 * 1000;
      log.info(`narration cooldown set to ${durationMin}min`);

      log.info(`narration [${block.category}]: ${parsed.event}`);

      // 1. Invalidate emotion cache so next refresh incorporates this event
      invalidateEmotionCache();

      // 2. Save to timeline FIRST — this is the critical write for scene consistency
      const userTime = new Date(now);
      const pstTime = new Date(userTime.toLocaleString("en-US", { timeZone: getUserTZ() }));
      const hh = String(pstTime.getHours()).padStart(2, "0");
      const mm = String(pstTime.getMinutes()).padStart(2, "0");
      // Truncate to first sentence for a concise summary
      const firstSentence = parsed.event.split(/[。！；.!;\n]/)[0]?.trim() || parsed.event;
      const summary = firstSentence.length > 60 ? firstSentence.slice(0, 60) + "…" : firstSentence;
      addTimelineEvent({
        time: `${hh}:${mm}`,
        category: block.category,
        summary,
        details: parsed.event, // full text in details
        people: block.withPeople,
        source: "narration",
      });

      // 3. Save to memory for conversation reference (non-critical, don't let it block timeline)
      try {
        const manager = getStoreManager();
        const ts = Math.floor(now / 1000);
        await manager.set(
          `inner.block.${block.category}.${ts}`,
          `[${block.activity}] ${parsed.event}${parsed.mood_effect ? ` — ${parsed.mood_effect}` : ""}`,
          0.6,
        );
      } catch (memErr) {
        log.warn(`narration memory save failed for ${block.category}`, memErr);
      }

      // 4. If share-worthy, post a moment
      if (parsed.share_worthy && isMomentsEnabled()) {
        await maybeMoment("rest", {
          emotion: {
            mood: parsed.mood_effect ?? "",
            microEvent: parsed.event,
            cause: block.activity,
            valence: 0.6,
          },
        }).catch(() => {});
      }
    } catch (err) {
      log.warn(`narration failed for ${block.category}`, err);
    }
  }

  // ── Logging ─────────────────────────────────────────────────────────

  private logPulse(entry: HeartbeatLog): void {
    const today = pstDateStr();
    const logFile = path.join(this.logDir, `${today}.jsonl`);

    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error("[heartbeat] Log write error:", err);
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private loadActionTimes(): void {
    const filePath = path.join(this.logDir, "state.json");
    const data = readJsonSafe<{ lastActionAt?: Record<string, number>; pulseCount?: number }>(filePath, {});
    Object.assign(this.lastActionAt, data.lastActionAt ?? {});
    this.pulseCount = data.pulseCount ?? 0;
  }

  private saveActionTimes(): void {
    const filePath = path.join(this.logDir, "state.json");
    writeJsonAtomic(filePath, {
      lastActionAt: this.lastActionAt,
      lastPulseAt: Date.now(),
      pulseCount: this.pulseCount,
    });
  }
}
