#!/usr/bin/env npx tsx
/**
 * Researcher Watchdog — constitutional enforcer.
 *
 * Runs as an independent cron job (every 5 minutes).
 * Does NOT use LLM, does NOT think, only executes hard rules.
 *
 * All GitHub operations are idempotent (safe to re-run).
 *
 * Usage:
 *   npx tsx scripts/watchdog-researcher.ts [--data-root /path] [--selfcheck]
 *
 * Crontab:
 *   * /5 * * * * cd /path/to/MeAI && npx tsx scripts/watchdog-researcher.ts --data-root /path >> logs/watchdog.log 2>&1
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ── Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dataRoot = getArg("--data-root") ?? "/Users/allen/Documents/MeAI_data";
const selfCheckOnly = args.includes("--selfcheck");

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

// ── Paths ──────────────────────────────────────────────────────────

const SHARED = path.join(dataRoot, "shared-state");
const AGENDA = path.join(SHARED, "research-agenda.json");
const MODE_FILE = path.join(SHARED, "global-mode.json");
const LOG_FILE = path.join(SHARED, "watchdog-log.jsonl");
const STATUS_DIR = path.join(SHARED, "status");
const CLAIMS_DIR = path.join(SHARED, "message-claims");

// ── Types ──────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";

interface WatchdogEntry {
  timestamp: string;
  severity: Severity;
  rule: string;
  targetBot: string;
  targetPr?: number;
  detail: string;
  actionTaken: string;
  idempotent: boolean;
}

interface Topic {
  id: string;
  type: string;
  title: string;
  status: string;
  owner: string | null;
  leaseUntil: number | null;
  lastActivityAt: number;
  failureCount: number;
  prUrl: string | null;
}

// ── Logging ────────────────────────────────────────────────────────

function logEntry(entry: WatchdogEntry): void {
  const line = JSON.stringify(entry);
  console.log(`[watchdog] ${entry.severity}: ${entry.rule} — ${entry.detail} → ${entry.actionTaken}`);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch { /* ok */ }
}

// ── Helpers ────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readMode(): string {
  const data = readJson<{ mode: string }>(MODE_FILE, { mode: "normal" });
  return data.mode;
}

function readAgenda(): { topics: Topic[]; revision: number } {
  return readJson(AGENDA, { topics: [], revision: 0 });
}

function writeAgenda(data: { topics: Topic[]; revision: number }): void {
  data.revision++;
  const tmp = AGENDA + `.tmp.watchdog`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, AGENDA);
}

function gh(cmd: string): string {
  try {
    return execSync(`gh ${cmd}`, { encoding: "utf-8", timeout: 15000 }).trim();
  } catch (err: any) {
    return err.stdout ?? err.message;
  }
}

// ── Self-check (--selfcheck) ───────────────────────────────────────

function selfCheck(): void {
  console.log("[watchdog] Self-check...");

  // Ensure directories
  for (const dir of [SHARED, STATUS_DIR, CLAIMS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Ensure mode file
  if (!fs.existsSync(MODE_FILE)) {
    fs.writeFileSync(MODE_FILE, JSON.stringify({
      mode: "normal",
      updatedAt: new Date().toISOString(),
      updatedBy: "watchdog-selfcheck",
    }, null, 2));
    console.log("[watchdog] Created global-mode.json (normal)");
  }

  // Clean stale instance locks
  for (const bot of ["alpha", "beta", "gamma", "omega"]) {
    const lockFile = path.join(dataRoot, bot, "run.lock");
    if (fs.existsSync(lockFile)) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as { pid: number };
        try {
          process.kill(lock.pid, 0);
        } catch {
          // PID dead — stale lock
          fs.unlinkSync(lockFile);
          logEntry({
            timestamp: new Date().toISOString(),
            severity: "info",
            rule: "instance_lock_orphan",
            targetBot: bot,
            detail: `Stale lock removed (PID ${lock.pid} dead)`,
            actionTaken: "remove_lock",
            idempotent: true,
          });
        }
      } catch { /* corrupt lock, remove */
        fs.unlinkSync(lockFile);
      }
    }
  }

  console.log("[watchdog] Self-check complete.");
}

// ── Rule Checks ────────────────────────────────────────────────────

function checkLeaseExpiry(): void {
  const agenda = readAgenda();
  const now = Date.now();
  let changed = false;

  for (const topic of agenda.topics) {
    if (!topic.leaseUntil) continue;
    if (topic.leaseUntil > now) continue;
    if (!["claimed", "implementing"].includes(topic.status)) continue;

    logEntry({
      timestamp: new Date().toISOString(),
      severity: "warning",
      rule: "lease_expiry",
      targetBot: topic.owner ?? "unknown",
      detail: `Topic ${topic.id} (${topic.title}): lease expired`,
      actionTaken: "release_topic",
      idempotent: true,
    });

    topic.status = "accepted";
    topic.owner = null;
    topic.leaseUntil = null;
    topic.lastActivityAt = now;
    changed = true;
  }

  if (changed) writeAgenda(agenda);
}

function checkHeartbeatTimeout(): void {
  const now = Date.now();
  const timeout = 15 * 60 * 1000; // 15 minutes

  for (const bot of ["alpha", "beta", "gamma", "omega"]) {
    const statusFile = path.join(STATUS_DIR, `${bot}.json`);
    if (!fs.existsSync(statusFile)) continue;

    const status = readJson<{ lastHeartbeat: string; online: boolean }>(statusFile, { lastHeartbeat: "", online: false });
    if (!status.online) continue;

    const lastBeat = new Date(status.lastHeartbeat).getTime();
    if (isNaN(lastBeat)) continue;

    if (now - lastBeat > timeout) {
      logEntry({
        timestamp: new Date().toISOString(),
        severity: "critical",
        rule: "heartbeat_timeout",
        targetBot: bot,
        detail: `No heartbeat for ${Math.round((now - lastBeat) / 60000)}min`,
        actionTaken: "alert_allen",
        idempotent: true,
      });
    }
  }
}

function checkClaimCleanup(): void {
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  try {
    for (const f of fs.readdirSync(CLAIMS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(CLAIMS_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
  } catch { /* ok */ }

  if (removed > 0) {
    logEntry({
      timestamp: new Date().toISOString(),
      severity: "info",
      rule: "claim_cleanup",
      targetBot: "",
      detail: `Removed ${removed} expired claim file(s)`,
      actionTaken: "delete_files",
      idempotent: true,
    });
  }
}

// ── PR-Level Enforcement (GitHub) ───────────────────────────────

const FORBIDDEN_PATTERNS = [
  /^data\/config.*\.json$/,
  /^\.env/,
  /^\.oauth-tokens\.json$/,
  /^deploy\//,
  /^\.github\/workflows\//,
  /^src\/agent\/loop\.ts$/,
  /^src\/channel\//,
  /^src\/config\.ts$/,
  /^src\/registry\//,
  /^data\/skills\/research-coord\/tools\.ts$/,
];

function isForbiddenPath(filePath: string): boolean {
  return FORBIDDEN_PATTERNS.some(p => p.test(filePath.replace(/^\/+/, "")));
}

/** Get open PRs with agent-generated label. Idempotent. */
function getAgentPRs(): Array<{ number: number; author: string; files: string[]; additions: number; deletions: number; isDraft: boolean; labels: string[] }> {
  try {
    const raw = gh('pr list --label agent-generated --state open --json number,author,files,additions,deletions,isDraft,labels');
    const prs = JSON.parse(raw || "[]");
    return prs.map((pr: any) => ({
      number: pr.number,
      author: pr.author?.login ?? "",
      files: (pr.files ?? []).map((f: any) => f.path),
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      isDraft: pr.isDraft ?? false,
      labels: (pr.labels ?? []).map((l: any) => l.name),
    }));
  } catch {
    return [];
  }
}

/** Idempotent PR close */
function closePR(prNum: number, reason: string): void {
  try {
    // Check if already closed
    const state = gh(`pr view ${prNum} --json state --jq .state`);
    if (state === "CLOSED" || state === "MERGED") return;
    gh(`pr close ${prNum} --comment "Watchdog: ${reason}"`);
  } catch { /* idempotent */ }
}

/** Idempotent PR convert to draft + label + comment */
function draftPR(prNum: number, reason: string, label: string): void {
  try {
    const info = gh(`pr view ${prNum} --json isDraft,labels --jq '{isDraft,labels:[.labels[].name]}'`);
    const parsed = JSON.parse(info || "{}");

    // Add label if not present
    if (!parsed.labels?.includes(label)) {
      gh(`pr edit ${prNum} --add-label "${label}"`);
    }

    // Convert to draft if not already
    if (!parsed.isDraft) {
      gh(`pr ready ${prNum} --undo`);
    }

    // Add comment
    gh(`pr comment ${prNum} --body "Watchdog: ${reason}"`);
  } catch { /* idempotent */ }
}

function checkPREnforcement(): void {
  const mode = readMode();
  const prs = getAgentPRs();

  // Track per-bot PR counts
  const botPRCounts = new Map<string, number>();

  for (const pr of prs) {
    const botName = pr.author;
    botPRCounts.set(botName, (botPRCounts.get(botName) ?? 0) + 1);

    // ── Tier 1: Forbidden path → close PR ──
    const forbidden = pr.files.filter(isForbiddenPath);
    if (forbidden.length > 0) {
      logEntry({
        timestamp: new Date().toISOString(),
        severity: "critical",
        rule: "forbidden_path",
        targetBot: botName,
        targetPr: pr.number,
        detail: `PR touches forbidden: ${forbidden.join(", ")}`,
        actionTaken: "close_pr",
        idempotent: true,
      });
      closePR(pr.number, `Forbidden path(s): ${forbidden.join(", ")}`);
      continue;
    }

    // ── Tier 1: Mode violation → close PR ──
    if (mode !== "normal") {
      logEntry({
        timestamp: new Date().toISOString(),
        severity: "critical",
        rule: "mode_enforcement",
        targetBot: botName,
        targetPr: pr.number,
        detail: `PR created while system is in "${mode}" mode`,
        actionTaken: "close_pr",
        idempotent: true,
      });
      closePR(pr.number, `System is in "${mode}" mode. PRs not allowed.`);
      continue;
    }

    // ── Tier 2: Diff budget → draft + label ──
    const totalLines = pr.additions + pr.deletions;
    if (pr.files.length > 10 || totalLines > 500) {
      logEntry({
        timestamp: new Date().toISOString(),
        severity: "warning",
        rule: "diff_budget",
        targetBot: botName,
        targetPr: pr.number,
        detail: `${pr.files.length} files, ${totalLines} lines (max 10/500)`,
        actionTaken: "draft_pr",
        idempotent: true,
      });
      draftPR(pr.number, `Diff budget exceeded: ${pr.files.length} files, ${totalLines} lines. Please split.`, "needs-split");
    }
  }

  // ── Tier 1: PR quota → close newest ──
  for (const [botName, count] of botPRCounts) {
    if (count > 1) {
      // Find the newest PR by this bot and close it
      const botPRs = prs.filter(p => p.author === botName).sort((a, b) => b.number - a.number);
      for (let i = 1; i < botPRs.length; i++) {
        logEntry({
          timestamp: new Date().toISOString(),
          severity: "critical",
          rule: "pr_quota",
          targetBot: botName,
          targetPr: botPRs[i].number,
          detail: `${botName} has ${count} open PRs (max 1)`,
          actionTaken: "close_pr",
          idempotent: true,
        });
        closePR(botPRs[i].number, `PR quota exceeded: max 1 open PR per bot.`);
      }
    }
  }
}

function checkStaleImplementing(): void {
  const agenda = readAgenda();
  const now = Date.now();
  const threshold = 4 * 60 * 60 * 1000; // 4 hours

  for (const topic of agenda.topics) {
    if (topic.status !== "implementing") continue;
    if (now - topic.lastActivityAt < threshold) continue;

    // Composite stale check: also look at bot status
    const bot = topic.owner;
    if (bot) {
      const statusFile = path.join(STATUS_DIR, `${bot.toLowerCase()}.json`);
      const status = readJson<{ lastAction: string }>(statusFile, { lastAction: "" });

      // Don't flag as stale if bot is doing research/revise/review
      if (["research", "revise", "review"].includes(status.lastAction)) continue;
    }

    // Check if lease is expiring or no renew
    if (topic.leaseUntil && topic.leaseUntil > now + 30 * 60 * 1000) continue; // lease still has >30min

    logEntry({
      timestamp: new Date().toISOString(),
      severity: "warning",
      rule: "stale_implementing",
      targetBot: topic.owner ?? "unknown",
      detail: `Topic ${topic.id} (${topic.title}): implementing for ${Math.round((now - topic.lastActivityAt) / 3600000)}h, no recent progress`,
      actionTaken: "flag_stale",
      idempotent: true,
    });
  }
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  if (selfCheckOnly) {
    selfCheck();
    return;
  }

  const mode = readMode();
  console.log(`[watchdog] Running. Mode: ${mode}. Data root: ${dataRoot}`);

  // Always run these
  checkLeaseExpiry();
  checkHeartbeatTimeout();
  checkClaimCleanup();
  checkStaleImplementing();
  checkPREnforcement();

  console.log("[watchdog] Done.");
}

main();
