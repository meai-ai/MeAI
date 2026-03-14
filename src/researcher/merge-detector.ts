/**
 * Merge Detector — polls GitHub for merged PRs.
 *
 * Allen merges PRs on GitHub. This detector picks up those events
 * and triggers the appropriate brainstem bridge signals + agenda updates.
 *
 * Runs every 5 minutes. Only for researcher bots (not Omega).
 */

import { execSync } from "node:child_process";
import {
  readAgenda,
  writeAgendaWithRetry,
} from "./store.js";
import { onPRMerged, onAllenMergePR } from "./brainstem-bridge.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("merge-detector");

let _timer: ReturnType<typeof setInterval> | null = null;
let _botName = "";
let _repoRoot = "";

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function startMergeDetector(botName: string, repoRoot: string): void {
  if (botName.toLowerCase() === "omega") return; // Omega doesn't own PRs
  _botName = botName;
  _repoRoot = repoRoot;

  log.info(`Starting merge detector for ${botName}`);
  // First check after 1 minute
  setTimeout(() => {
    checkMergedPRs();
    _timer = setInterval(checkMergedPRs, CHECK_INTERVAL);
  }, 60 * 1000);
}

export function stopMergeDetector(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function checkMergedPRs(): void {
  const { data } = readAgenda();

  // Find my topics that are pr_open or under_review with a PR URL
  const myPRTopics = data.topics.filter(
    t => t.owner === _botName &&
      ["pr_open", "under_review", "changes_requested"].includes(t.status) &&
      t.prUrl
  );

  if (myPRTopics.length === 0) return;

  for (const topic of myPRTopics) {
    try {
      // Extract PR number from URL
      const prMatch = topic.prUrl!.match(/\/pull\/(\d+)/);
      if (!prMatch) continue;
      const prNumber = prMatch[1];

      // Check PR state via gh CLI
      const result = execSync(
        `gh pr view ${prNumber} --json state,mergedBy --jq '{state,mergedBy:.mergedBy.login}'`,
        { cwd: _repoRoot, encoding: "utf-8", timeout: 10000 },
      ).trim();

      const { state, mergedBy } = JSON.parse(result);

      if (state === "MERGED") {
        log.info(`PR #${prNumber} for topic ${topic.id} merged by ${mergedBy}`);

        // Update agenda
        writeAgendaWithRetry(d => {
          const t = d.topics.find(x => x.id === topic.id);
          if (t && t.status !== "merged") {
            t.status = "merged";
            t.lastActivityAt = Date.now();
          }
          return d;
        });

        // Trigger brainstem events
        try { onPRMerged(topic.id); } catch { /* ok */ }
        if (mergedBy && mergedBy !== _botName.toLowerCase()) {
          try { onAllenMergePR(topic.id); } catch { /* ok */ }
        }
      }
    } catch (err) {
      // gh CLI might fail if offline or rate-limited — that's fine
      log.warn(`Failed to check PR for topic ${topic.id}:`, err);
    }
  }
}
