/**
 * Omega Monitor — proactive soft supervision.
 *
 * Runs as a periodic check (every 10 minutes) inside Omega's heartbeat.
 * Detects situations that need Omega's attention and sends messages
 * to the group chat.
 *
 * This is the "soft monitoring" layer. Hard enforcement is in watchdog.
 */

import type { AppConfig } from "../types.js";
import type { Channel } from "../channel/types.js";
import {
  readAgenda,
  readAllStatus,
  readMode,
  type TopicStatus,
  type BotStatus,
} from "./store.js";
import { getAllEfficacy, getBeliefs } from "./self-model.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("omega-monitor");

let _channel: Channel | null = null;
let _config: AppConfig | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _lastSummaryAt = 0;

const CHECK_INTERVAL = 10 * 60 * 1000;  // 10 minutes
const SUMMARY_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const PR_REVIEW_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Start the Omega monitor. Only runs if botName is "Omega".
 */
export function startOmegaMonitor(config: AppConfig, channel: Channel): void {
  if (config.botName?.toLowerCase() !== "omega") return;

  _config = config;
  _channel = channel;

  log.info("Omega monitor starting...");

  // First check after 2 minutes (let system stabilize)
  setTimeout(() => {
    runChecks();
    _timer = setInterval(runChecks, CHECK_INTERVAL);
  }, 2 * 60 * 1000);
}

export function stopOmegaMonitor(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

// ── Check Functions ────────────────────────────────────────────────

async function runChecks(): Promise<void> {
  if (!_channel) return;

  try {
    await checkPRReviewTimeout();
    await checkFairnessImbalance();
    await checkLowEfficacyBots();
    await checkStalledTopics();
    await maybeSendPeriodicSummary();
  } catch (err) {
    log.error("Omega check failed:", err);
  }
}

/** PRs open >24h without review → remind in group */
async function checkPRReviewTimeout(): Promise<void> {
  const { data } = readAgenda();
  const now = Date.now();

  for (const topic of data.topics) {
    if (topic.status !== "pr_open") continue;
    if (now - topic.lastActivityAt < PR_REVIEW_TIMEOUT) continue;

    const hours = Math.round((now - topic.lastActivityAt) / (60 * 60 * 1000));
    await sendMessage(
      `Topic ${topic.id} (${topic.title}) has had an open PR for ${hours}h without review. ` +
      `${topic.owner}'s work is waiting — who can review?`
    );
  }
}

/** One bot doing too much / too little → fairness warning */
async function checkFairnessImbalance(): Promise<void> {
  const { data } = readAgenda();
  const allStatus = readAllStatus();
  const terminal: TopicStatus[] = ["merged", "rejected", "abandoned", "stale"];

  // Count active claims per researcher
  const claimCounts: Record<string, number> = {};
  const researchers = ["alpha", "beta", "gamma"];

  for (const bot of researchers) {
    claimCounts[bot] = data.topics.filter(
      t => t.owner?.toLowerCase() === bot && !terminal.includes(t.status)
    ).length;
  }

  const counts = Object.values(claimCounts);
  const max = Math.max(...counts);
  const min = Math.min(...counts);

  // Alert if one bot has 3+ more active topics than another
  if (max - min >= 3) {
    const heavy = Object.entries(claimCounts).find(([, v]) => v === max)?.[0];
    const light = Object.entries(claimCounts).find(([, v]) => v === min)?.[0];
    await sendMessage(
      `Fairness notice: ${heavy} has ${max} active topics while ${light} has ${min}. ` +
      `Consider redistributing work.`
    );
  }
}

/** Bot with consistently low self-efficacy → suggest recovery */
async function checkLowEfficacyBots(): Promise<void> {
  const allStatus = readAllStatus();

  for (const [bot, status] of Object.entries(allStatus)) {
    if (bot === "omega") continue;
    if (!status.online) continue;

    // Check if efficacy data is in status
    const efficacy = (status as any).selfEfficacy as Record<string, number> | undefined;
    if (!efficacy) continue;

    const lowAreas = Object.entries(efficacy)
      .filter(([, v]) => v < 0.35)
      .map(([k]) => k);

    if (lowAreas.length >= 2) {
      await sendMessage(
        `${bot}'s confidence has been low in: ${lowAreas.join(", ")}. ` +
        `Maybe try a different type of task (review, research) to rebuild momentum?`
      );
    }
  }
}

/** Topics stuck in discussing/claimed for >12h */
async function checkStalledTopics(): Promise<void> {
  const { data } = readAgenda();
  const now = Date.now();
  const threshold = 12 * 60 * 60 * 1000;

  for (const topic of data.topics) {
    if (!["discussing", "claimed"].includes(topic.status)) continue;
    if (now - topic.lastActivityAt < threshold) continue;

    const hours = Math.round((now - topic.lastActivityAt) / (60 * 60 * 1000));
    await sendMessage(
      `Topic ${topic.id} (${topic.title}) has been in "${topic.status}" for ${hours}h. ` +
      `${topic.status === "discussing" ? "Can we reach consensus or table this?" : `${topic.owner}, do you need help?`}`
    );
  }
}

/** Periodic summary every 6 hours */
async function maybeSendPeriodicSummary(): Promise<void> {
  const now = Date.now();
  if (now - _lastSummaryAt < SUMMARY_INTERVAL) return;

  const { data } = readAgenda();
  const allStatus = readAllStatus();
  const mode = readMode();
  const terminal: TopicStatus[] = ["merged", "rejected", "abandoned", "stale"];

  const active = data.topics.filter(t => !terminal.includes(t.status));
  const merged = data.topics.filter(t => t.status === "merged").length;

  const onlineBots = Object.entries(allStatus)
    .filter(([, s]) => s.online)
    .map(([name]) => name);

  const summary = [
    `**Org Status Summary**`,
    `Mode: ${mode} | Online: ${onlineBots.join(", ") || "none"}`,
    `Active topics: ${active.length} | Completed: ${merged}`,
  ];

  if (active.length > 0) {
    summary.push("");
    summary.push("Active:");
    for (const t of active.slice(0, 5)) {
      summary.push(`- ${t.id}: ${t.title} (${t.status}${t.owner ? `, ${t.owner}` : ""})`);
    }
  }

  await sendMessage(summary.join("\n"));
  _lastSummaryAt = now;
}

// ── Helper ─────────────────────────────────────────────────────────

async function sendMessage(text: string): Promise<void> {
  if (!_channel) return;
  try {
    await _channel.sendMessage(text);
    log.info(`Sent: ${text.slice(0, 80)}...`);
  } catch (err) {
    log.error("Failed to send message:", err);
  }
}
