/**
 * Health Diagnostic Report — CLI one-shot diagnostic
 *
 * Usage:  npm run health
 * Exit:   0 = all OK, 1 = has WARN, 2 = has FAIL
 *
 * Pure read-only — never modifies any file.
 */

import fs from "node:fs";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(import.meta.dirname ?? ".", "../data");

// ANSI helpers
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type Status = "ok" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonlTail(filePath: string, maxLines: number): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim());
    const tail = lines.slice(-maxLines);
    const results: Record<string, unknown>[] = [];
    for (const line of tail) {
      try { results.push(JSON.parse(line)); } catch { /* skip bad lines */ }
    }
    return results;
  } catch {
    return [];
  }
}

function pstDateStr(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function statusIcon(s: Status): string {
  if (s === "ok") return `${GREEN}OK${RESET}`;
  if (s === "warn") return `${YELLOW}WARN${RESET}`;
  return `${RED}FAIL${RESET}`;
}

// ── Checks ──────────────────────────────────────────────────────────

function checkCortexValidity(): CheckResult {
  const name = "C3/C4 cortex";
  const entries = readJsonlTail(path.join(DATA_DIR, "brainstem/cortex-log.jsonl"), 50);
  if (entries.length === 0) {
    return { name, status: "warn", detail: "no cortex-log entries" };
  }

  const c3 = entries.filter(e => e.cortexId === "c3");
  const c4 = entries.filter(e => e.cortexId === "c4");

  const c3Valid = c3.filter(e => e.outputValid === true).length;
  const c4Valid = c4.filter(e => e.outputValid === true).length;

  const c3Rate = c3.length > 0 ? c3Valid / c3.length : -1;
  const c4Rate = c4.length > 0 ? c4Valid / c4.length : -1;

  const parts: string[] = [];
  if (c3.length > 0) parts.push(`c3: ${c3Valid}/${c3.length} valid`);
  else parts.push("c3: 0 calls");
  if (c4.length > 0) parts.push(`c4: ${c4Valid}/${c4.length} valid`);
  else parts.push("c4: 0 calls (normal, requires low-confidence trigger)");

  // Check if all non-budget-exceeded entries are invalid
  const realEntries = entries.filter(e =>
    (e.cortexId === "c3" || e.cortexId === "c4") && e.degradedTo !== "budget_exceeded"
  );
  const allInvalid = realEntries.length > 0 && realEntries.every(e => e.outputValid === false);

  let status: Status = "ok";
  if (allInvalid) {
    status = "fail";
    parts.push("all parsing failed!");
  } else if ((c3Rate >= 0 && c3Rate < 0.5) || (c4Rate >= 0 && c4Rate < 0.5)) {
    status = "warn";
  }

  return { name, status, detail: parts.join(", ") };
}

function checkC3Pipeline(): CheckResult {
  const name = "C3 pipeline";
  const entries = readJsonlTail(path.join(DATA_DIR, "brainstem/cortex-log.jsonl"), 50);
  const c3 = entries.filter(e => e.cortexId === "c3");

  if (c3.length === 0) {
    return { name, status: "warn", detail: "no c3 entries in last 50 log lines" };
  }

  const latestTs = Math.max(...c3.map(e => (e.timestamp as number) || 0));
  const agoMin = Math.round((Date.now() - latestTs) / 60000);

  return {
    name,
    status: "ok",
    detail: `${c3.length} recent calls, latest ${agoMin}m ago`,
  };
}

function checkGroundingDiversity(): CheckResult {
  const name = "Grounding diversity";
  const state = readJsonSafe<{ thoughtHistory?: Array<{ grounding?: Array<{ id?: string }> }> }>(
    path.join(DATA_DIR, "brainstem/state.json"),
    {},
  );

  const history = (state.thoughtHistory ?? []).slice(-10);
  if (history.length === 0) {
    return { name, status: "warn", detail: "no thoughtHistory" };
  }

  const memIds = new Set<string>();
  for (const t of history) {
    for (const g of t.grounding ?? []) {
      if (g.id) memIds.add(g.id);
    }
  }

  const unique = memIds.size;
  let status: Status = "ok";
  if (unique <= 3) status = "warn";

  return {
    name,
    status,
    detail: `${history.length} thoughts referenced ${unique} unique memories${unique <= 3 ? " (monopoly risk)" : ""}`,
  };
}

function checkWeeklyClimateDupes(): CheckResult {
  const name = "Weekly climate";
  const data = readJsonSafe<Array<{ weekLabel?: string }>>(
    path.join(DATA_DIR, "weekly-climate.json"),
    [],
  );

  if (data.length === 0) {
    return { name, status: "ok", detail: "no data" };
  }

  const labels = data.map(d => d.weekLabel).filter(Boolean) as string[];
  const unique = new Set(labels);
  const dupes = labels.length - unique.size;

  if (dupes > 0) {
    return { name, status: "warn", detail: `${dupes} duplicate weekLabel(s)` };
  }

  return { name, status: "ok", detail: `no duplicate weekLabels (${labels.length} weeks)` };
}

function checkReconsolidation(): CheckResult {
  const name = "Reconsolidation";
  const data = readJsonSafe<{ proposals?: Array<{ status?: string }> }>(
    path.join(DATA_DIR, "memory/reconsolidation-proposals.json"),
    { proposals: [] },
  );

  const pending = (data.proposals ?? []).filter(p => p.status === "pending" || !p.status).length;

  if (pending > 10) {
    return { name, status: "warn", detail: `${pending} pending proposals (backlog)` };
  }

  return { name, status: "ok", detail: `${pending} pending proposals` };
}

function checkStyleLearning(): CheckResult {
  const name = "Style learning";
  const data = readJsonSafe<{ styleLearning?: { pairs?: unknown[]; patterns?: unknown[] } }>(
    path.join(DATA_DIR, "interaction-learning.json"),
    {},
  );

  const pairs = data.styleLearning?.pairs?.length ?? 0;
  const patterns = data.styleLearning?.patterns?.length ?? 0;

  if (pairs < 5) {
    return { name, status: "warn", detail: `${pairs} pairs, ${patterns} patterns (insufficient data)` };
  }

  return { name, status: "ok", detail: `${pairs} pairs, ${patterns} patterns` };
}

function checkMemoryAccessCount(): CheckResult {
  const name = "Memory access";
  const files = ["core.json", "emotional.json", "knowledge.json", "insights.json"];
  let maxAccess = 0;
  let maxKey = "";

  for (const file of files) {
    const data = readJsonSafe<{ memories?: Array<{ key?: string; accessCount?: number }> }>(
      path.join(DATA_DIR, "memory", file),
      { memories: [] },
    );
    for (const m of data.memories ?? []) {
      const ac = m.accessCount ?? 0;
      if (ac > maxAccess) {
        maxAccess = ac;
        maxKey = m.key ?? "unknown";
      }
    }
  }

  if (maxAccess >= 200) {
    return { name, status: "warn", detail: `max=${maxAccess} (${maxKey}) — inflation risk` };
  }

  return { name, status: "ok", detail: `max=${maxAccess} (healthy)` };
}

function checkCommitmentVisibility(): CheckResult {
  const name = "Commitment visible";
  const entries = readJsonlTail(path.join(DATA_DIR, "turn-directive.jsonl"), 20);

  if (entries.length === 0) {
    return { name, status: "warn", detail: "no turn-directive entries" };
  }

  const withMustMention = entries.filter(e => {
    const sc = e.surfacedCommitments as unknown[] | undefined;
    return sc && sc.length > 0;
  });

  if (withMustMention.length === 0) {
    return { name, status: "warn", detail: "no recent surfacedCommitments (may have no active commitments)" };
  }

  return { name, status: "ok", detail: `${withMustMention.length}/${entries.length} entries have surfaced commitments` };
}

function checkWatchdogOverall(): CheckResult {
  const name = "Watchdog";
  const data = readJsonSafe<{ overall?: string; uptime_hours?: number }>(
    path.join(DATA_DIR, "watchdog/health.json"),
    {},
  );

  const overall = data.overall ?? "unknown";
  const uptime = data.uptime_hours ?? 0;

  if (overall === "critical") {
    return { name, status: "fail", detail: `overall: ${overall}, uptime: ${uptime}h` };
  }
  if (overall === "warn") {
    return { name, status: "warn", detail: `overall: ${overall}, uptime: ${uptime}h` };
  }
  if (overall === "ok") {
    return { name, status: "ok", detail: `overall: ok, uptime: ${uptime}h` };
  }

  return { name, status: "warn", detail: `overall: ${overall} (unknown state)` };
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  const results: CheckResult[] = [
    checkCortexValidity(),
    checkC3Pipeline(),
    checkGroundingDiversity(),
    checkWeeklyClimateDupes(),
    checkReconsolidation(),
    checkStyleLearning(),
    checkMemoryAccessCount(),
    checkCommitmentVisibility(),
    checkWatchdogOverall(),
  ];

  console.log();
  console.log(`${BOLD}Health Diagnostic Report${RESET}`);
  console.log(`${DIM}${"=".repeat(54)}${RESET}`);

  for (const r of results) {
    const icon = statusIcon(r.status);
    const label = r.name.padEnd(22);
    console.log(`${icon}  ${label} ${DIM}${r.detail}${RESET}`);
  }

  const okCount = results.filter(r => r.status === "ok").length;
  const warnCount = results.filter(r => r.status === "warn").length;
  const failCount = results.filter(r => r.status === "fail").length;

  console.log(`${DIM}${"=".repeat(54)}${RESET}`);
  console.log(
    `Summary: ${GREEN}${okCount}${RESET} OK, ${YELLOW}${warnCount}${RESET} WARN, ${RED}${failCount}${RESET} FAIL`,
  );
  console.log();

  if (failCount > 0) process.exit(2);
  if (warnCount > 0) process.exit(1);
  process.exit(0);
}

main();
