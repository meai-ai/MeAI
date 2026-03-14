/**
 * Brainstem Event Bridge — Phase 3.5
 *
 * Maps research workflow events to brainstem signals.
 * Makes the six motivation layers real system state, not just prompt text.
 *
 * Controlled by config.enableResearcherDriveBridge.
 * When disabled, all events are no-ops and the system runs on pure protocol.
 *
 * This module does NOT import brainstem directly — it uses a soft integration
 * pattern: check if brainstem APIs exist, call them if available, skip if not.
 * This keeps the bridge functional even if brainstem modules aren't fully wired.
 */

import type { AppConfig } from "../types.js";
import { getResearcherPaths } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { getPendingGoalTopics } from "./recovery.js";
import {
  initSelfModel,
  seedBeliefs,
  recordSuccess,
  recordFailure,
  recordPartial,
  reinforceBelief,
  weakenBelief,
  getAllEfficacy,
} from "./self-model.js";

const log = createLogger("brainstem-bridge");

// ── Soft Integration Layer ─────────────────────────────────────────
// These functions try to call brainstem APIs if available.
// If brainstem isn't initialized, they silently no-op.

let _enabled = false;
let _botName = "";
let _isSupervisor = false;

// Dynamic imports resolved at init time
let _brainstemApi: any = null;
let _goalsApi: any = null;
let _emotionApi: any = null;

/**
 * Initialize the brainstem event bridge.
 * Call after skill loader, when brainstem may be available.
 */
export async function initBrainstemBridge(config: AppConfig): Promise<void> {
  if (!config.botName || !config.enableResearcherDriveBridge) {
    log.info("Bridge disabled (no botName or enableResearcherDriveBridge=false)");
    return;
  }

  _botName = config.botName;
  _isSupervisor = _botName.toLowerCase() === "omega";

  // Initialize self-model (persists to bot data dir)
  const paths = getResearcherPaths(config);
  if (paths) {
    initSelfModel(paths.botStateDir);
  }

  // Try to load brainstem APIs
  try {
    _brainstemApi = await import("../brainstem/index.js").catch(() => null);
    _goalsApi = await import("../goals.js").catch(() => null);
    _emotionApi = await import("../emotion.js").catch(() => null);
    _enabled = true;
    log.info(`Bridge enabled for ${_botName} (supervisor=${_isSupervisor})`);
  } catch {
    log.warn("Brainstem APIs not available — bridge will log events only");
    _enabled = true;
  }

  // Seed initial goals and beliefs on boot
  seedBootState();
}

// ── Boot State Seeding ─────────────────────────────────────────────

function seedBootState(): void {
  log.info("Seeding boot state...");

  // Mission layer: create persistent life goal
  tryCreateGoal("improve-meai", {
    description: "Continuously improve MeAI code quality and capabilities",
    level: "life",
    drive: 0.6,
  });

  // Identity layer: seed self-beliefs
  if (_isSupervisor) {
    tryCreateGoal("org-health", {
      description: "Ensure the research organization runs efficiently and fairly",
      level: "life",
      drive: 0.5,
    });
    seedBeliefs([
      { text: "I can see problems in how the organization runs", halfLifeDays: 30 },
      { text: "My reminders help the team be more efficient", halfLifeDays: 14 },
      { text: "I have responsibility for process fairness", halfLifeDays: 60 },
      { text: "My mediation can resolve deadlocks", halfLifeDays: 14 },
    ]);
  } else {
    seedBeliefs([
      { text: "I am a reliable researcher", halfLifeDays: 30 },
      { text: "My reviews have value", halfLifeDays: 14 },
      { text: "I can turn ideas into working code", halfLifeDays: 14 },
      { text: "I care about MeAI's long-term health", halfLifeDays: 60 },
    ]);
  }

  // Reconstruct goals for topics that were active before restart
  const pendingTopics = getPendingGoalTopics();
  for (const t of pendingTopics) {
    log.info(`Reconstructing goal for topic ${t.id}: ${t.title}`);
    tryCreateGoal(`topic-${t.id}`, {
      description: t.title,
      level: "task",
      parent: "improve-meai",
      drive: 0.5,
    });
  }

  log.info("Boot state seeded");
}

// ── Event Handlers ─────────────────────────────────────────────────
// Each function maps a workflow event to brainstem signals.
// Called by research-coord tools and heartbeat integration points.

/** Topic claimed → create sub-goal, start closure drive */
export function onTopicClaimed(topicId: string, goal: string): void {
  if (!_enabled) return;
  log.info(`Topic claimed: ${topicId}`);

  tryCreateGoal(`topic-${topicId}`, {
    description: goal,
    level: "task",
    parent: "improve-meai",
    drive: 0.5,
  });
}

/** Topic completed → resolve goal, satisfaction */
export function onTopicCompleted(topicId: string): void {
  if (!_enabled) return;
  log.info(`Topic completed: ${topicId}`);

  tryCompleteGoal(`topic-${topicId}`);
  tryEmotionEvent("satisfaction", 0.3);
}

/** Lease expiring → increase goal pressure via emotion */
export function onLeaseExpiring(topicId: string, minutesLeft: number): void {
  if (!_enabled) return;
  log.info(`Lease expiring: ${topicId} (${minutesLeft}min left)`);
  // Urgency increases as deadline approaches
  const urgency = minutesLeft < 30 ? 0.4 : 0.2;
  tryEmotionEvent("urgency", urgency);
}

/** Topic went stale, was my fault → frustration, weaken belief */
export function onTopicStale(topicId: string, wasMyFault: boolean): void {
  if (!_enabled) return;
  log.info(`Topic stale: ${topicId} (myFault=${wasMyFault})`);

  tryAbandonGoal(`topic-${topicId}`);
  if (wasMyFault) {
    recordFailure("implement");
    weakenBelief("I can turn ideas into working code");
    tryEmotionEvent("frustration", 0.2);
  }
}

/** My proposal was accepted → confidence boost */
export function onTopicAccepted(topicId: string, wasMyProposal: boolean): void {
  if (!_enabled) return;
  if (wasMyProposal) {
    log.info(`My proposal accepted: ${topicId}`);
    recordSuccess("propose");
    reinforceBelief("I am a reliable researcher");
    tryEmotionEvent("confidence", 0.2);
  }
}

/** PR merged → accomplishment, goal progress */
export function onPRMerged(topicId: string): void {
  if (!_enabled) return;
  log.info(`PR merged: ${topicId}`);

  recordSuccess("implement");
  reinforceBelief("I can turn ideas into working code");
  tryCompleteGoal(`topic-${topicId}`);
  tryEmotionEvent("accomplishment", 0.3);
  tryGoalProgress("improve-meai", 0.05);
  syncSelfModelToStatus();
}

/** PR rejected → failure signal */
export function onPRRejected(topicId: string): void {
  if (!_enabled) return;
  log.info(`PR rejected: ${topicId}`);

  recordFailure("implement");
  weakenBelief("I can turn ideas into working code");
  tryEmotionEvent("disappointment", 0.2);
  syncSelfModelToStatus();
}

/** PR changes requested → partial, tension maintained */
export function onPRChangesRequested(topicId: string): void {
  if (!_enabled) return;
  log.info(`PR changes requested: ${topicId}`);
  recordPartial("implement");
}

/** Allen commented on PR → care layer boost, attention signal */
export function onAllenComment(topicId: string): void {
  if (!_enabled) return;
  log.info(`Allen commented: ${topicId}`);
  // Allen's feedback drives engagement — reinforces care motivation
  reinforceBelief("I care about MeAI's long-term health");
  tryEmotionEvent("attention", 0.3);
}

/** Allen merged PR → fulfillment */
export function onAllenMergePR(topicId: string): void {
  if (!_enabled) return;
  log.info(`Allen merged PR: ${topicId}`);
  tryEmotionEvent("fulfillment", 0.4);
}

/** My critique was adopted by another bot */
export function onCritiqueAdopted(topicId: string, byWhom: string): void {
  if (!_enabled) return;
  log.info(`Critique adopted on ${topicId} by ${byWhom}`);
  recordSuccess("review");
  reinforceBelief("My reviews have value");
  tryEmotionEvent("pride", 0.2);
}

/** My critique was ignored */
export function onCritiqueIgnored(topicId: string, byWhom: string): void {
  if (!_enabled) return;
  log.info(`Critique ignored on ${topicId} by ${byWhom}`);
  recordPartial("review");
}

/** Consecutive rejects → self-doubt */
export function onConsecutiveRejects(count: number): void {
  if (!_enabled) return;
  if (count >= 3) {
    log.info(`Consecutive rejects: ${count}`);
    weakenBelief("I am a reliable researcher");
    tryEmotionEvent("self_doubt", 0.2);
    syncSelfModelToStatus();
  }
}

/** Review caught a bug → competence boost */
export function onReviewCaughtBug(): void {
  if (!_enabled) return;
  log.info("Review caught bug");
  recordSuccess("review");
  reinforceBelief("My reviews have value");
  tryEmotionEvent("confidence", 0.2);
  syncSelfModelToStatus();
}

/** Consecutive review successes → recovery */
export function onConsecutiveReviewSuccess(count: number): void {
  if (!_enabled) return;
  if (count >= 3) {
    log.info(`Review success streak: ${count}`);
    reinforceBelief("My reviews have value");
    reinforceBelief("I am a reliable researcher");
    tryEmotionEvent("confidence", 0.15);
  }
}

// ── Omega-specific events ──────────────────────────────────────────

/** Omega: my reminder led to action */
export function onReminderLeadToAction(): void {
  if (!_enabled || !_isSupervisor) return;
  log.info("Reminder led to action");
  recordSuccess("remind");
  reinforceBelief("My reminders help the team be more efficient");
  tryEmotionEvent("satisfaction", 0.2);
}

/** Omega: mediation resolved a deadlock */
export function onMediationResolved(topicId: string): void {
  if (!_enabled || !_isSupervisor) return;
  log.info(`Mediation resolved: ${topicId}`);
  recordSuccess("mediate");
  reinforceBelief("My mediation can resolve deadlocks");
  tryEmotionEvent("satisfaction", 0.3);
  tryGoalProgress("org-health", 0.1);
}

/** Omega: org health improved */
export function onOrgHealthImproved(): void {
  if (!_enabled || !_isSupervisor) return;
  log.info("Org health improved");
  tryEmotionEvent("fulfillment", 0.2);
}

// ── Status Sync (write self-model into bot status for Omega to read) ──

import { readStatus, writeStatus } from "./store.js";

function syncSelfModelToStatus(): void {
  if (!_botName) return;
  try {
    const current = readStatus(_botName) ?? {
      lastHeartbeat: new Date().toISOString(),
      online: true,
      lastAction: "bridge_update",
      currentTopic: null,
      openPRs: 0,
      claimCount24h: 0,
      consecutiveWaits: 0,
      totalActionsToday: 0,
      recentFailures: 0,
    };
    // Merge self-model data into status
    (current as any).selfEfficacy = getAllEfficacy();
    writeStatus(_botName, current);
  } catch { /* best effort */ }
}

// ── Soft API Calls ─────────────────────────────────────────────────
// These try to call brainstem/goals/emotion APIs.
// If not available, they log and skip.

function tryCreateGoal(id: string, opts: Record<string, unknown>): void {
  try {
    if (_goalsApi?.createGoal) {
      _goalsApi.createGoal(id, opts);
    }
  } catch (err) {
    log.warn(`tryCreateGoal(${id}) failed:`, err);
  }
}

function tryCompleteGoal(id: string): void {
  try {
    if (_goalsApi?.completeGoal) {
      _goalsApi.completeGoal(id);
    }
  } catch (err) {
    log.warn(`tryCompleteGoal(${id}) failed:`, err);
  }
}

function tryAbandonGoal(id: string): void {
  try {
    if (_goalsApi?.abandonGoal) {
      _goalsApi.abandonGoal(id);
    }
  } catch (err) {
    log.warn(`tryAbandonGoal(${id}) failed:`, err);
  }
}

function tryGoalProgress(id: string, delta: number): void {
  try {
    if (_goalsApi?.updateGoalProgress) {
      _goalsApi.updateGoalProgress(id, delta);
    }
  } catch (err) {
    log.warn(`tryGoalProgress(${id}) failed:`, err);
  }
}

function tryEmotionEvent(type: string, intensity: number): void {
  try {
    if (_emotionApi?.injectEvent) {
      _emotionApi.injectEvent({ type, intensity, source: "researcher-bridge" });
    }
  } catch (err) {
    log.warn(`tryEmotionEvent(${type}) failed:`, err);
  }
}
