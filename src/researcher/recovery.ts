/**
 * Researcher Startup Recovery — Phase 5.
 *
 * Runs BEFORE skill loader in the bootstrap sequence.
 * Ensures consistent state after crash/restart.
 *
 * Fixed order (not skippable):
 * 1. Check global mode → paused = heartbeat only
 * 2. Release expired leases (mine and orphaned)
 * 3. Clean orphan worktree branches (researchers only)
 * 4. Flag open PRs needing attention (researchers only)
 * 5. Write status as online
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AppConfig } from "../types.js";
import { getResearcherPaths, type ResearcherPaths } from "../config.js";
import {
  initStore,
  readMode,
  readAgenda,
  writeAgendaWithRetry,
  writeStatus,
  acquireInstanceLock,
  releaseInstanceLock,
  type BotStatus,
} from "./store.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("researcher-recovery");

/**
 * Run the full recovery sequence.
 * Called from src/index.ts BEFORE skill loader.
 * Returns false if the bot should only run in minimal mode (paused).
 */
export async function researcherRecovery(config: AppConfig): Promise<{ proceed: boolean }> {
  const paths = getResearcherPaths(config);
  if (!paths) {
    // Not a researcher bot, skip
    return { proceed: true };
  }

  const botName = config.botName!;
  const isResearcher = botName.toLowerCase() !== "omega";

  log.info(`Starting recovery for ${botName}...`);

  // Initialize store with shared state path
  initStore(paths.sharedState);

  // Step 1: Acquire instance lock
  if (!acquireInstanceLock(botName, paths.botDataDir)) {
    log.error(`${botName} is already running. Exiting.`);
    process.exit(1);
  }

  // Register cleanup on exit
  const cleanup = () => {
    try {
      writeStatus(botName, {
        ...makeBaseStatus(botName),
        online: false,
        lastAction: "shutdown",
      });
      releaseInstanceLock(botName, paths.botDataDir);
    } catch { /* best effort */ }
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  // Step 2: Check global mode
  const mode = readMode();
  if (mode === "paused") {
    log.info(`Global mode is "paused". ${botName} will run heartbeat only.`);
    writeOnlineStatus(botName, "paused_recovery");
    return { proceed: false };
  }
  log.info(`Global mode: ${mode}`);

  // Step 3: Release expired leases
  releaseExpiredLeases(botName);

  // Step 4: Clean orphan worktree branches (researchers only)
  if (isResearcher) {
    cleanOrphanBranches(paths);
  }

  // Step 5: Flag open PRs (researchers only)
  if (isResearcher) {
    flagOpenPRs(botName, paths);
  }

  // Step 6: Reconstruct brainstem goals for uncompleted topics (closure drive recovery)
  reconstructGoals(botName);

  // Step 7: Write status as online
  writeOnlineStatus(botName, "recovery_complete");

  log.info(`Recovery complete for ${botName}`);
  return { proceed: true };
}

// ── Helpers ────────────────────────────────────────────────────────

function makeBaseStatus(botName: string): BotStatus {
  return {
    lastHeartbeat: new Date().toISOString(),
    online: true,
    lastAction: "boot",
    currentTopic: null,
    openPRs: 0,
    claimCount24h: 0,
    consecutiveWaits: 0,
    totalActionsToday: 0,
    recentFailures: 0,
  };
}

function writeOnlineStatus(botName: string, action: string): void {
  writeStatus(botName, {
    ...makeBaseStatus(botName),
    lastAction: action,
  });
}

function releaseExpiredLeases(botName: string): void {
  const now = Date.now();

  const ok = writeAgendaWithRetry(data => {
    let released = 0;
    for (const topic of data.topics) {
      if (!topic.leaseUntil) continue;
      if (topic.leaseUntil > now) continue;

      // Expired lease
      if (
        ["claimed", "implementing"].includes(topic.status) &&
        topic.owner
      ) {
        log.info(`Releasing expired lease: ${topic.id} (was owned by ${topic.owner})`);
        topic.status = "accepted";
        topic.owner = null;
        topic.leaseUntil = null;
        topic.lastActivityAt = now;
        released++;
      }
    }
    if (released > 0) {
      log.info(`Released ${released} expired lease(s)`);
    }
    return data;
  });

  if (!ok) {
    log.warn("Failed to release expired leases (CAS conflict)");
  }
}

function cleanOrphanBranches(paths: ResearcherPaths): void {
  const wt = paths.worktree;
  if (!fs.existsSync(wt)) return;

  try {
    // Check if worktree has any orphan branches for stale/abandoned topics
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: wt,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    if (branch === "main" || branch === "HEAD") return;

    // Check if the topic for this branch still exists and is active
    const { data } = readAgenda();
    const topicMatch = branch.match(/topic-([^\-]+)/);
    if (!topicMatch) return;

    const topicId = data.topics.find(t => branch.includes(t.id));
    if (topicId && ["stale", "abandoned", "rejected", "merged"].includes(topicId.status)) {
      log.info(`Cleaning orphan branch ${branch} (topic is ${topicId.status})`);
      try {
        execSync("git checkout main", { cwd: wt, timeout: 5000 });
        execSync(`git branch -D "${branch}"`, { cwd: wt, timeout: 5000 });
      } catch (err) {
        log.warn(`Failed to clean branch ${branch}:`, err);
      }
    }
  } catch {
    // No git repo or not initialized yet — fine
  }
}

// Stored during recovery, consumed by brainstem-bridge during its init
let _pendingGoalTopics: Array<{ id: string; title: string }> = [];

/** Get topics that need goal reconstruction (called by brainstem-bridge init) */
export function getPendingGoalTopics(): Array<{ id: string; title: string }> {
  const result = _pendingGoalTopics;
  _pendingGoalTopics = []; // consume once
  return result;
}

function reconstructGoals(botName: string): void {
  const { data } = readAgenda();
  const activeStatuses = ["claimed", "implementing", "pr_open", "under_review", "changes_requested"];
  const myActiveTopics = data.topics.filter(
    t => t.owner === botName && activeStatuses.includes(t.status)
  );

  if (myActiveTopics.length === 0) return;

  // Store for brainstem-bridge to consume during its init (runs later)
  _pendingGoalTopics = myActiveTopics.map(t => ({ id: t.id, title: t.title }));
  log.info(`Queued ${myActiveTopics.length} goal(s) for reconstruction:`);
  for (const t of myActiveTopics) {
    log.info(`  - ${t.id}: ${t.title} (${t.status})`);
  }
}

function flagOpenPRs(botName: string, paths: ResearcherPaths): void {
  const { data } = readAgenda();
  const myOpenPRs = data.topics.filter(
    t => t.owner === botName && ["pr_open", "under_review", "changes_requested"].includes(t.status)
  );

  if (myOpenPRs.length > 0) {
    log.info(`${botName} has ${myOpenPRs.length} open PR(s) needing attention:`);
    for (const t of myOpenPRs) {
      log.info(`  - ${t.id}: ${t.title} (${t.status})${t.prUrl ? ` ${t.prUrl}` : ""}`);
    }
  }
}
