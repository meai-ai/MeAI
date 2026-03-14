/**
 * Research Coordination Store — unified helpers for all shared state.
 *
 * All shared state reads/writes go through this module.
 * No other code should directly read/write shared-state files.
 *
 * Concurrency model (single machine):
 * - Topic agenda: large JSON + CAS (revision field + fs.renameSync)
 * - Message claims: fine-grained atomic files (O_CREAT|O_EXCL)
 * - Bot status: per-bot files, no contention
 * - Mode: single writer (Allen), read-only for bots
 */

import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("research-store");

// ── Types ──────────────────────────────────────────────────────────

export type TopicType = "research" | "design" | "implementation" | "review";

export type TopicStatus =
  | "proposed"
  | "discussing"
  | "accepted"
  | "rejected"
  | "claimed"
  | "implementing"
  | "pr_open"
  | "under_review"
  | "merged"
  | "changes_requested"
  | "abandoned"
  | "stale";

export type AcceptType = "consensus_clear" | "deadlock_resolution";

export interface TopicDecision {
  scope: string;
  nonGoals: string[];
  successCheck: string[];
  riskNote: string;
  acceptedBy: string;
  acceptedReason: string;
  acceptType: AcceptType;
}

export interface Topic {
  id: string;
  type: TopicType;
  title: string;
  description: string;
  status: TopicStatus;
  proposedBy: string;
  proposedAt: number;
  owner: string | null;
  leaseUntil: number | null;
  decision: TopicDecision | null;
  prUrl: string | null;
  critiques: Array<{ by: string; content: string; at: number }>;
  failureCount: number;
  lastActivityAt: number;
}

export interface Agenda {
  revision: number;
  topics: Topic[];
}

export type GlobalMode = "normal" | "read-only" | "paused";

export interface ModeFile {
  mode: GlobalMode;
  updatedAt: string;
  updatedBy: string;
}

export interface BotStatus {
  lastHeartbeat: string;
  online: boolean;
  lastAction: string;
  currentTopic: string | null;
  openPRs: number;
  claimCount24h: number;
  consecutiveWaits: number;
  totalActionsToday: number;
  recentFailures: number;
  [key: string]: unknown;
}

export interface MessageClaim {
  botName: string;
  claimedAt: string;
}

// ── Path Resolution ────────────────────────────────────────────────

let _sharedStatePath = "";

export function initStore(sharedStatePath: string): void {
  _sharedStatePath = sharedStatePath;
  // Ensure subdirectories exist
  for (const sub of ["message-claims", "status"]) {
    fs.mkdirSync(path.join(_sharedStatePath, sub), { recursive: true });
  }
}

function sp(): string {
  if (!_sharedStatePath) throw new Error("Store not initialized — call initStore() first");
  return _sharedStatePath;
}

// ── Topic Agenda (CAS-protected JSON) ──────────────────────────────

const AGENDA_FILE = () => path.join(sp(), "research-agenda.json");

export function readAgenda(): { data: Agenda; revision: number } {
  const file = AGENDA_FILE();
  if (!fs.existsSync(file)) {
    const empty: Agenda = { revision: 0, topics: [] };
    return { data: empty, revision: 0 };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Agenda;
    return { data: raw, revision: raw.revision };
  } catch {
    log.warn("Failed to parse agenda, returning empty");
    return { data: { revision: 0, topics: [] }, revision: 0 };
  }
}

/**
 * Write agenda with compare-and-swap.
 * Returns true on success, false on revision conflict.
 */
export function writeAgenda(data: Agenda, expectedRevision: number): boolean {
  const file = AGENDA_FILE();
  // CAS check
  const current = readAgenda();
  if (current.revision !== expectedRevision) {
    log.warn(`CAS conflict: expected rev ${expectedRevision}, got ${current.revision}`);
    return false;
  }
  // Bump revision
  data.revision = expectedRevision + 1;
  // Atomic write: tmp file + rename
  const tmpFile = file + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, file);
  return true;
}

/**
 * Write agenda with automatic CAS retry (up to 3 attempts).
 * The mutator function receives current data and returns modified data.
 */
export function writeAgendaWithRetry(
  mutator: (data: Agenda) => Agenda,
  maxRetries = 3,
): boolean {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, revision } = readAgenda();
    const updated = mutator(data);
    if (writeAgenda(updated, revision)) return true;
    log.info(`CAS retry ${attempt + 1}/${maxRetries}`);
  }
  log.error("writeAgendaWithRetry: all retries exhausted");
  return false;
}

// ── Message Claims (fine-grained atomic files) ─────────────────────

const CLAIMS_DIR = () => path.join(sp(), "message-claims");

/**
 * Attempt to claim a message. Returns true if this bot won the claim.
 * Uses O_CREAT|O_EXCL (wx flag) for atomic uniqueness.
 */
export function claimMessage(msgId: string, botName: string): boolean {
  const file = path.join(CLAIMS_DIR(), `${msgId}.json`);
  const data: MessageClaim = { botName, claimedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    // EEXIST means another bot already claimed
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    log.error("claimMessage error:", err);
    return false;
  }
}

export function getMessageClaim(msgId: string): MessageClaim | null {
  const file = path.join(CLAIMS_DIR(), `${msgId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as MessageClaim;
  } catch {
    return null;
  }
}

/**
 * Clean up expired claim files. Returns count of removed files.
 */
export function cleanExpiredClaims(maxAgeMs = 24 * 60 * 60 * 1000): number {
  const dir = CLAIMS_DIR();
  let removed = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
  } catch { /* ok */ }
  return removed;
}

// ── Global Mode (with audit trail) ─────────────────────────────────

const MODE_FILE = () => path.join(sp(), "global-mode.json");
const MODE_CHANGELOG = () => path.join(sp(), "mode-changelog.jsonl");

export function readMode(): GlobalMode {
  const file = MODE_FILE();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as ModeFile;
    if (["normal", "read-only", "paused"].includes(raw.mode)) return raw.mode;
  } catch { /* ok */ }
  return "normal"; // default
}

export function readModeFile(): ModeFile {
  const file = MODE_FILE();
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as ModeFile;
  } catch {
    return { mode: "normal", updatedAt: new Date().toISOString(), updatedBy: "system" };
  }
}

export function writeMode(mode: GlobalMode, updatedBy: string): void {
  if (!["normal", "read-only", "paused"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }
  const prev = readMode();
  const modeFile: ModeFile = {
    mode,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  // Atomic write
  const file = MODE_FILE();
  const tmpFile = file + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(modeFile, null, 2));
  fs.renameSync(tmpFile, file);
  // Append changelog
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    from: prev,
    to: mode,
    updatedBy,
  });
  fs.appendFileSync(MODE_CHANGELOG(), logEntry + "\n");
}

// ── Bot Status (per-bot files, no contention) ──────────────────────

const STATUS_DIR = () => path.join(sp(), "status");

export function writeStatus(botName: string, status: BotStatus): void {
  const file = path.join(STATUS_DIR(), `${botName.toLowerCase()}.json`);
  const tmpFile = file + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(status, null, 2));
  fs.renameSync(tmpFile, file);
}

export function readStatus(botName: string): BotStatus | null {
  const file = path.join(STATUS_DIR(), `${botName.toLowerCase()}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as BotStatus;
  } catch {
    return null;
  }
}

export function readAllStatus(): Record<string, BotStatus> {
  const dir = STATUS_DIR();
  const result: Record<string, BotStatus> = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const name = f.replace(".json", "");
      try {
        result[name] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as BotStatus;
      } catch { /* skip */ }
    }
  } catch { /* ok */ }
  return result;
}

// ── Instance Lock (PID-based) ──────────────────────────────────────

export function acquireInstanceLock(botName: string, dataDir: string): boolean {
  const lockFile = path.join(dataDir, "run.lock");
  const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  if (fs.existsSync(lockFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, "utf-8")) as { pid: number };
      // Check if PID is still alive
      try {
        process.kill(existing.pid, 0); // signal 0 = existence check
        // PID is alive → another instance is running
        return false;
      } catch {
        // PID is dead → stale lock, safe to override
        log.info(`Cleaning stale lock for ${botName} (PID ${existing.pid})`);
      }
    } catch {
      // Corrupt lock file, safe to override
    }
  }

  fs.writeFileSync(lockFile, lockData);
  return true;
}

export function releaseInstanceLock(botName: string, dataDir: string): void {
  const lockFile = path.join(dataDir, "run.lock");
  try {
    fs.unlinkSync(lockFile);
  } catch { /* ok */ }
}

// ── Mode Enforcement Helper ────────────────────────────────────────

/**
 * Check if a write operation is allowed under current mode.
 * Call this at the top of every write tool (edit_file, commit, create_pr).
 * Throws if mode is not "normal".
 */
export function enforceWriteMode(): void {
  const mode = readMode();
  if (mode !== "normal") {
    throw new Error(`Write operation blocked: system is in "${mode}" mode`);
  }
}
