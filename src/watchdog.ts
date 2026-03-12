/**
 * Immune System — the character's self-protection mechanism.
 *
 * Like a biological immune system, this layer silently monitors the health
 * of all systems and intervenes when something goes wrong:
 *
 *   1. Heartbeat monitor — detect if the heartbeat stops
 *   2. API circuit breaker — stop wasting money on failing APIs
 *   3. Resource monitor — disk, file sizes, memory store growth
 *   4. Behavior guardrails — prevent runaway posting/messaging
 *   5. Memory integrity — ensure store.json isn't corrupted
 *   6. Health dashboard — centralized status + Telegram alerts
 *
 * Architecture:
 *   - Runs independently on a 10-minute check cycle
 *   - Can pause/unpause the heartbeat when critical issues detected
 *   - Sends Telegram alerts for severe problems
 *   - Writes health reports to data/watchdog/health.json
 *
 * Design philosophy:
 *   - Silent when healthy (no noise)
 *   - Loud when sick (Telegram alert)
 *   - Self-healing when possible (auto-recover from transient failures)
 *   - Conservative (pause first, investigate later)
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { getStoreManager } from "./memory/store-manager.js";
import type { AppConfig } from "./types.js";
import type { Heartbeat } from "./heartbeat.js";

// ── Constants ────────────────────────────────────────────────────────

/** How often the watchdog checks (10 minutes) */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** Heartbeat is considered stalled if no pulse for this long (15 min) */
const HEARTBEAT_STALL_MS = 15 * 60 * 1000;

/** Circuit breaker: trip after this many consecutive API errors */
const CIRCUIT_BREAKER_THRESHOLD = 5;

/** Circuit breaker: auto-reset after this long (30 min) */
const CIRCUIT_BREAKER_RESET_MS = 30 * 60 * 1000;

/** Memory store file size warning threshold (5 MB) */
const MEMORY_SIZE_WARN_BYTES = 5 * 1024 * 1024;

/** Heartbeat log directory max size (10 GB) */
const LOG_DIR_WARN_BYTES = 10 * 1024 * 1024 * 1024;

/** Daily budget limits — hard stops beyond what modules enforce */
const DAILY_LIMITS = {
  posts: 5,          // Max tweets per day (social enforces 3, this is safety net)
  proactive: 8,      // Max proactive messages per day
  explorations: 20,  // Max curiosity explorations per day
  activities: 10,    // Max activities per day
};

// ── Types ────────────────────────────────────────────────────────────

type Severity = "ok" | "warn" | "critical";

interface HealthCheck {
  name: string;
  status: Severity;
  message: string;
  timestamp: number;
}

interface HealthReport {
  timestamp: number;
  uptime_hours: number;
  overall: Severity;
  checks: HealthCheck[];
  circuitBreaker: {
    tripped: boolean;
    consecutiveErrors: number;
    lastErrorAt: number;
    lastResetAt: number;
  };
  dailyCounters: Record<string, number>;
}

type AlertFn = (text: string) => Promise<void>;

// ── Watchdog Engine ──────────────────────────────────────────────────

export class WatchdogEngine {
  private config: AppConfig;
  private heartbeat: Heartbeat | null = null;
  private alertFn: AlertFn | null = null;
  private stopped = false;
  private startedAt = Date.now();

  // Circuit breaker state
  private consecutiveApiErrors = 0;
  private lastApiErrorAt = 0;
  private circuitTripped = false;
  private circuitTrippedAt = 0;

  // Daily counters (reset at midnight)
  private dailyCounters: Record<string, number> = {
    posts: 0,
    proactive: 0,
    explorations: 0,
    activities: 0,
    api_errors: 0,
  };
  private dailyDate = "";

  // Alert deduplication — don't spam the same alert
  private lastAlertKeys = new Map<string, number>();
  private readonly ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per alert type

  // Sleep detection — if the gap between checks is much larger than the interval,
  // the machine was likely asleep (laptop lid closed). Suppress false stall alerts.
  private lastCheckAt = Date.now();

  // Health report directory
  private watchdogDir: string;

  constructor(config: AppConfig) {
    this.config = config;
    this.watchdogDir = path.join(config.statePath, "watchdog");
    fs.mkdirSync(this.watchdogDir, { recursive: true });
    this.loadState();
  }

  /** Connect to the heartbeat for monitoring + pausing */
  setHeartbeat(heartbeat: Heartbeat): void {
    this.heartbeat = heartbeat;
  }

  /** Connect Telegram for critical alerts */
  setAlertFn(fn: AlertFn): void {
    this.alertFn = fn;
  }

  start(): void {
    console.log("[watchdog] 🛡️ Immune system active — checking every 10 minutes");
    // First check after 5 minutes (let systems warm up)
    setTimeout(() => this.check(), 5 * 60 * 1000);
  }

  stop(): void {
    this.stopped = true;
  }

  // ── Public API: called by other modules ────────────────────────────

  /**
   * Report an API error. Called by any module when an API call fails.
   * Increments circuit breaker counter.
   */
  reportApiError(module: string, error: string): void {
    this.consecutiveApiErrors++;
    this.lastApiErrorAt = Date.now();
    this.incrementDaily("api_errors");

    console.warn(`[watchdog] API error from ${module}: ${error} (${this.consecutiveApiErrors}/${CIRCUIT_BREAKER_THRESHOLD})`);

    if (this.consecutiveApiErrors >= CIRCUIT_BREAKER_THRESHOLD && !this.circuitTripped) {
      this.tripCircuitBreaker(module, error);
    }
  }

  /**
   * Report a successful API call. Resets circuit breaker counter.
   */
  reportApiSuccess(): void {
    if (this.consecutiveApiErrors > 0) {
      this.consecutiveApiErrors = 0;
    }
  }

  /**
   * Record an action for daily budget tracking.
   */
  recordAction(action: "posts" | "proactive" | "explorations" | "activities"): void {
    this.resetDailyIfNeeded();
    this.incrementDaily(action);
  }

  /**
   * Check if an action is within daily budget.
   * Returns true if the action is allowed.
   */
  isActionAllowed(action: keyof typeof DAILY_LIMITS): boolean {
    this.resetDailyIfNeeded();
    const count = this.dailyCounters[action] ?? 0;
    const limit = DAILY_LIMITS[action];
    return count < limit;
  }

  /**
   * Check if the circuit breaker is tripped.
   * If tripped, no API calls should be made.
   */
  isCircuitOpen(): boolean {
    if (!this.circuitTripped) return false;

    // Auto-reset after timeout
    if (Date.now() - this.circuitTrippedAt > CIRCUIT_BREAKER_RESET_MS) {
      this.resetCircuitBreaker();
      return false;
    }

    return true;
  }

  /**
   * Get a compact health summary for the heartbeat context.
   */
  getHealthSummary(): string {
    const parts: string[] = [];

    if (this.circuitTripped) {
      parts.push("⚠️ API circuit breaker OPEN");
    }

    for (const [action, limit] of Object.entries(DAILY_LIMITS)) {
      const count = this.dailyCounters[action] ?? 0;
      if (count >= limit * 0.8) {
        parts.push(`${action}: ${count}/${limit} (near limit)`);
      }
    }

    return parts.length > 0 ? parts.join("; ") : "healthy";
  }

  // ── Core Check Loop ────────────────────────────────────────────────

  private async check(): Promise<void> {
    if (this.stopped) return;

    try {
      // Detect machine sleep: if gap since last check is >2x the interval,
      // the laptop was likely closed. Give heartbeat a grace period to catch up.
      const sinceLastCheck = Date.now() - this.lastCheckAt;
      const resumingFromSleep = sinceLastCheck > CHECK_INTERVAL_MS * 2;
      this.lastCheckAt = Date.now();

      this.resetDailyIfNeeded();
      const checks: HealthCheck[] = [];

      // Run all health checks (skip heartbeat stall check right after sleep)
      checks.push(resumingFromSleep ? this.sleepGraceHeartbeat() : this.checkHeartbeat());
      checks.push(this.checkCircuitBreaker());
      checks.push(this.checkMemoryIntegrity());
      checks.push(this.checkDiskUsage());
      checks.push(this.checkDailyBudgets());
      checks.push(this.checkLogGrowth());

      // Determine overall health
      const hasCritical = checks.some((c) => c.status === "critical");
      const hasWarn = checks.some((c) => c.status === "warn");
      const overall: Severity = hasCritical ? "critical" : hasWarn ? "warn" : "ok";

      // Build report
      const report: HealthReport = {
        timestamp: Date.now(),
        uptime_hours: Math.round((Date.now() - this.startedAt) / 3600000 * 10) / 10,
        overall,
        checks,
        circuitBreaker: {
          tripped: this.circuitTripped,
          consecutiveErrors: this.consecutiveApiErrors,
          lastErrorAt: this.lastApiErrorAt,
          lastResetAt: this.circuitTrippedAt,
        },
        dailyCounters: { ...this.dailyCounters },
      };

      // Save report
      this.saveReport(report);

      // Log summary
      const statusEmoji = overall === "ok" ? "✅" : overall === "warn" ? "⚠️" : "🚨";
      console.log(
        `[watchdog] ${statusEmoji} Health check: ${overall}` +
        ` | uptime: ${report.uptime_hours}h` +
        ` | circuit: ${this.circuitTripped ? "OPEN" : "closed"}` +
        ` | daily: ${Object.entries(this.dailyCounters).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      );

      // Alert on critical issues
      if (hasCritical) {
        const criticals = checks.filter((c) => c.status === "critical");
        for (const c of criticals) {
          await this.alert(`critical:${c.name}`, `🚨 ${c.name}: ${c.message}`);
        }
      }

      this.saveState();
    } catch (err) {
      console.error("[watchdog] Check error:", err);
    }

    // Schedule next check
    setTimeout(() => this.check(), CHECK_INTERVAL_MS);
  }

  // ── Individual Health Checks ───────────────────────────────────────

  /** Check if the heartbeat is still beating */
  private checkHeartbeat(): HealthCheck {
    const name = "heartbeat_alive";

    if (!this.heartbeat) {
      return { name, status: "warn", message: "Heartbeat not connected", timestamp: Date.now() };
    }

    // Read heartbeat state to check last pulse time
    try {
      const stateFile = path.join(this.config.statePath, "heartbeat", "state.json");
      if (!fs.existsSync(stateFile)) {
        return { name, status: "warn", message: "No heartbeat state file yet", timestamp: Date.now() };
      }

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Use lastPulseAt (updated every pulse including rest) for stall detection
      // Fall back to max(lastActionAt) for older state files without lastPulseAt
      const lastActionTimes = Object.values(state.lastActionAt ?? {}) as number[];
      const lastPulseAt = state.lastPulseAt ?? Math.max(...lastActionTimes, 0);

      // If heartbeat has been running for a while but no recent pulse
      const uptimeMs = Date.now() - this.startedAt;
      if (uptimeMs > HEARTBEAT_STALL_MS && lastPulseAt > 0) {
        const stalledMs = Date.now() - lastPulseAt;
        if (stalledMs > HEARTBEAT_STALL_MS) {
          return {
            name,
            status: "critical",
            message: `Heartbeat stalled — no pulse for ${Math.round(stalledMs / 60000)} minutes`,
            timestamp: Date.now(),
          };
        }
      }

      return {
        name,
        status: "ok",
        message: `Pulse #${state.pulseCount ?? 0}, last pulse ${lastPulseAt > 0 ? Math.round((Date.now() - lastPulseAt) / 60000) + "m ago" : "none yet"}`,
        timestamp: Date.now(),
      };
    } catch {
      return { name, status: "warn", message: "Cannot read heartbeat state", timestamp: Date.now() };
    }
  }

  /** After machine sleep, skip stall detection — heartbeat hasn't had time to resume */
  private sleepGraceHeartbeat(): HealthCheck {
    console.log("[watchdog] Machine resumed from sleep — skipping heartbeat stall check");
    return {
      name: "heartbeat_alive",
      status: "ok",
      message: "Grace period after machine sleep",
      timestamp: Date.now(),
    };
  }

  /** Check circuit breaker status */
  private checkCircuitBreaker(): HealthCheck {
    const name = "circuit_breaker";

    if (this.circuitTripped) {
      const trippedMinAgo = Math.round((Date.now() - this.circuitTrippedAt) / 60000);
      const autoResetMin = Math.round((CIRCUIT_BREAKER_RESET_MS - (Date.now() - this.circuitTrippedAt)) / 60000);
      return {
        name,
        status: "critical",
        message: `OPEN — tripped ${trippedMinAgo}m ago, auto-reset in ${Math.max(0, autoResetMin)}m`,
        timestamp: Date.now(),
      };
    }

    if (this.consecutiveApiErrors > 0) {
      return {
        name,
        status: this.consecutiveApiErrors >= 3 ? "warn" : "ok",
        message: `${this.consecutiveApiErrors}/${CIRCUIT_BREAKER_THRESHOLD} consecutive errors`,
        timestamp: Date.now(),
      };
    }

    return { name, status: "ok", message: "Closed, no errors", timestamp: Date.now() };
  }

  /** Check memory store file integrity (checks all 5 category files) */
  private checkMemoryIntegrity(): HealthCheck {
    const name = "memory_integrity";

    try {
      const manager = getStoreManager();
      const categoryNames = ["core", "emotional", "knowledge", "insights", "system"] as const;
      let totalMemories = 0;
      let totalSize = 0;
      let dupeCount = 0;
      const allKeys = new Set<string>();

      for (const cat of categoryNames) {
        const filePath = path.join(this.config.statePath, "memory", `${cat}.json`);
        if (!fs.existsSync(filePath)) continue;

        const raw = fs.readFileSync(filePath, "utf-8");
        totalSize += Buffer.byteLength(raw, "utf-8");

        const memories = manager.loadCategory(cat);
        totalMemories += memories.length;

        // Check for duplicate keys across categories
        for (const m of memories) {
          if (allKeys.has(m.key)) dupeCount++;
          else allKeys.add(m.key);
        }
      }

      if (totalMemories === 0) {
        return { name, status: "warn", message: "No memories in any category file", timestamp: Date.now() };
      }

      if (totalSize > MEMORY_SIZE_WARN_BYTES) {
        return {
          name,
          status: "warn",
          message: `Memory store large: ${Math.round(totalSize / 1024)}KB, ${totalMemories} memories across 5 categories`,
          timestamp: Date.now(),
        };
      }

      const msg = `${totalMemories} memories across 5 categories, ${Math.round(totalSize / 1024)}KB` +
        (dupeCount > 0 ? ` (${dupeCount} duplicate keys!)` : "");

      return { name, status: dupeCount > 0 ? "warn" : "ok", message: msg, timestamp: Date.now() };
    } catch (err) {
      return {
        name,
        status: "critical",
        message: `Memory store unreadable: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      };
    }
  }

  /** Check disk usage of state directories */
  private checkDiskUsage(): HealthCheck {
    const name = "disk_usage";

    try {
      const dirs = ["sessions/archive", "heartbeat", "evolution/history", "watchdog"];
      let totalBytes = 0;
      const issues: string[] = [];

      for (const dir of dirs) {
        const fullPath = path.join(this.config.statePath, dir);
        if (!fs.existsSync(fullPath)) continue;

        const dirSize = this.getDirSize(fullPath);
        totalBytes += dirSize;

        if (dirSize > LOG_DIR_WARN_BYTES) {
          issues.push(`${dir}: ${Math.round(dirSize / 1024 / 1024)}MB`);
        }
      }

      if (issues.length > 0) {
        return {
          name,
          status: "warn",
          message: `Large directories: ${issues.join(", ")}`,
          timestamp: Date.now(),
        };
      }

      return {
        name,
        status: "ok",
        message: `Total state: ${Math.round(totalBytes / 1024)}KB`,
        timestamp: Date.now(),
      };
    } catch {
      return { name, status: "ok", message: "Could not measure disk usage", timestamp: Date.now() };
    }
  }

  /** Check daily budget limits */
  private checkDailyBudgets(): HealthCheck {
    const name = "daily_budgets";

    const exceeded: string[] = [];
    const nearLimit: string[] = [];

    for (const [action, limit] of Object.entries(DAILY_LIMITS)) {
      const count = this.dailyCounters[action] ?? 0;
      if (count >= limit) {
        exceeded.push(`${action}: ${count}/${limit}`);
      } else if (count >= limit * 0.8) {
        nearLimit.push(`${action}: ${count}/${limit}`);
      }
    }

    if (exceeded.length > 0) {
      return {
        name,
        status: "warn",
        message: `Budget exceeded: ${exceeded.join(", ")}`,
        timestamp: Date.now(),
      };
    }

    if (nearLimit.length > 0) {
      return {
        name,
        status: "ok",
        message: `Near limit: ${nearLimit.join(", ")}`,
        timestamp: Date.now(),
      };
    }

    return { name, status: "ok", message: "All budgets within limits", timestamp: Date.now() };
  }

  /** Check heartbeat log file growth */
  private checkLogGrowth(): HealthCheck {
    const name = "log_growth";

    try {
      const heartbeatDir = path.join(this.config.statePath, "heartbeat");
      if (!fs.existsSync(heartbeatDir)) {
        return { name, status: "ok", message: "No log directory yet", timestamp: Date.now() };
      }

      const files = fs.readdirSync(heartbeatDir).filter((f) => f.endsWith(".jsonl"));
      let totalLines = 0;

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(heartbeatDir, file), "utf-8");
          totalLines += content.split("\n").filter((l) => l.trim()).length;
        } catch { /* skip unreadable */ }
      }

      // Clean up old log files (keep last 7 days)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const cutoffStr = pstDateStr(cutoff);
      let cleaned = 0;

      for (const file of files) {
        const dateStr = file.replace(".jsonl", "");
        if (dateStr < cutoffStr) {
          fs.unlinkSync(path.join(heartbeatDir, file));
          cleaned++;
        }
      }

      return {
        name,
        status: "ok",
        message: `${files.length} log files, ${totalLines} pulses recorded${cleaned > 0 ? `, cleaned ${cleaned} old files` : ""}`,
        timestamp: Date.now(),
      };
    } catch {
      return { name, status: "ok", message: "Could not check logs", timestamp: Date.now() };
    }
  }

  // ── Circuit Breaker ────────────────────────────────────────────────

  private tripCircuitBreaker(module: string, error: string): void {
    this.circuitTripped = true;
    this.circuitTrippedAt = Date.now();

    console.error(
      `[watchdog] 🔴 Circuit breaker TRIPPED — ${this.consecutiveApiErrors} consecutive errors from ${module}`,
    );

    this.alert(
      "circuit_breaker",
      `🔴 API circuit breaker triggered\n${this.consecutiveApiErrors} consecutive API errors\nLast error from: ${module}\nError: ${error}\nAuto-recovery: in 30 minutes`,
    ).catch(() => {});

    // Pause the heartbeat to stop further API calls
    if (this.heartbeat) {
      this.heartbeat.stop();
      console.warn("[watchdog] Heartbeat paused by circuit breaker");
    }

    // Auto-reset timer
    setTimeout(() => {
      this.resetCircuitBreaker();
    }, CIRCUIT_BREAKER_RESET_MS);

    this.saveState();
  }

  private resetCircuitBreaker(): void {
    if (!this.circuitTripped) return;

    this.circuitTripped = false;
    this.consecutiveApiErrors = 0;
    console.log("[watchdog] 🟢 Circuit breaker RESET — resuming normal operations");

    // Resume heartbeat
    if (this.heartbeat) {
      this.heartbeat.start();
      console.log("[watchdog] Heartbeat resumed");
    }

    this.alert(
      "circuit_reset",
      "🟢 API circuit breaker recovered\nSystem resuming normal operations",
    ).catch(() => {});

    this.saveState();
  }

  // ── Alerts ─────────────────────────────────────────────────────────

  private async alert(key: string, message: string): Promise<void> {
    // Deduplicate: don't send same alert type within cooldown
    const lastSent = this.lastAlertKeys.get(key) ?? 0;
    if (Date.now() - lastSent < this.ALERT_COOLDOWN_MS) return;

    this.lastAlertKeys.set(key, Date.now());

    if (this.alertFn) {
      try {
        await this.alertFn(`[🛡️ Immune System]\n${message}`);
      } catch (err) {
        console.error("[watchdog] Alert delivery failed:", err);
      }
    } else {
      console.warn(`[watchdog] ALERT (no Telegram): ${message}`);
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  private saveReport(report: HealthReport): void {
    writeJsonAtomic(path.join(this.watchdogDir, "health.json"), report);
  }

  private saveState(): void {
    writeJsonAtomic(path.join(this.watchdogDir, "state.json"), {
      consecutiveApiErrors: this.consecutiveApiErrors,
      lastApiErrorAt: this.lastApiErrorAt,
      circuitTripped: this.circuitTripped,
      circuitTrippedAt: this.circuitTrippedAt,
      dailyCounters: this.dailyCounters,
      dailyDate: this.dailyDate,
    });
  }

  private loadState(): void {
    const filePath = path.join(this.watchdogDir, "state.json");
    const data = readJsonSafe<Record<string, unknown>>(filePath, {});
    this.consecutiveApiErrors = (data.consecutiveApiErrors as number) ?? 0;
    this.lastApiErrorAt = (data.lastApiErrorAt as number) ?? 0;
    this.circuitTripped = (data.circuitTripped as boolean) ?? false;
    this.circuitTrippedAt = (data.circuitTrippedAt as number) ?? 0;
    this.dailyCounters = (data.dailyCounters as Record<string, number>) ?? {};
    this.dailyDate = (data.dailyDate as string) ?? "";
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private incrementDaily(key: string): void {
    this.resetDailyIfNeeded();
    this.dailyCounters[key] = (this.dailyCounters[key] ?? 0) + 1;
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: getUserTZ() });
    if (this.dailyDate !== today) {
      this.dailyDate = today;
      for (const key of Object.keys(this.dailyCounters)) {
        this.dailyCounters[key] = 0;
      }
    }
  }

  private getDirSize(dirPath: string): number {
    let total = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
          total += fs.statSync(fullPath).size;
        } else if (entry.isDirectory()) {
          total += this.getDirSize(fullPath);
        }
      }
    } catch { /* skip inaccessible */ }
    return total;
  }
}
