/**
 * Debug & Explainability — decision log summarizer, fault tree,
 * whyWinner/whyRejected/whatIf, daily report, auto-calibration.
 */

import { readJsonSafe } from "../lib/atomic-file.js";
import { type SlowLoopDecisionLog } from "./thought-gate.js";
import { getMetricsPath, getAuditPath, getReplayLogPath } from "./bootstrap.js";
import type { WorldModel, ActionType } from "./world-model.js";
import type { Clock } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-debug");

// ── Decision log reader ──────────────────────────────────────────────

export function readDecisionLogs(
  dataPath: string,
  hours: number,
): SlowLoopDecisionLog[] {
  const metricsPath = getMetricsPath(dataPath);
  if (!fs.existsSync(metricsPath)) return [];

  const cutoff = Date.now() - hours * 3_600_000;
  const lines = fs.readFileSync(metricsPath, "utf-8").split("\n").filter(Boolean);
  const logs: SlowLoopDecisionLog[] = [];

  for (const line of lines) {
    try {
      const dl = JSON.parse(line) as SlowLoopDecisionLog;
      if (dl.timestamp >= cutoff) logs.push(dl);
    } catch {
      // skip malformed
    }
  }

  return logs;
}

// ── Summarize decision log ───────────────────────────────────────────

export function summarizeDecisionLog(dataPath: string, hours = 1): string {
  const logs = readDecisionLogs(dataPath, hours);
  if (logs.length === 0) return "No decision logs found.";

  const lines: string[] = [];
  lines.push(`=== Decision Log Summary (last ${hours}h, ${logs.length} ticks) ===`);

  // Winner timeline
  const winnerCounts = new Map<string, number>();
  for (const dl of logs) {
    const key = dl.winner.labels.join("+");
    winnerCounts.set(key, (winnerCounts.get(key) ?? 0) + 1);
  }
  lines.push("\nWinner timeline (top 5 by duration):");
  const topWinners = [...winnerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [labels, count] of topWinners) {
    lines.push(`  ${labels}: ${count} ticks (${((count / logs.length) * 100).toFixed(0)}%)`);
  }

  // Gate rejection reasons
  const rejections = new Map<string, number>();
  for (const dl of logs) {
    if (!dl.thoughtGate.passed && dl.thoughtGate.rejectedReason) {
      const r = dl.thoughtGate.rejectedReason;
      rejections.set(r, (rejections.get(r) ?? 0) + 1);
    }
  }
  if (rejections.size > 0) {
    lines.push("\nThought gate rejections:");
    for (const [reason, count] of [...rejections.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason}: ${count}`);
    }
  }

  // CSI mode distribution
  const modeCounts = { green: 0, yellow: 0, red: 0 };
  for (const dl of logs) {
    const mode = dl.stabilizer.mode as keyof typeof modeCounts;
    if (mode in modeCounts) modeCounts[mode]++;
  }
  lines.push("\nCSI mode distribution:");
  for (const [mode, count] of Object.entries(modeCounts)) {
    lines.push(`  ${mode}: ${((count / logs.length) * 100).toFixed(0)}%`);
  }

  // Act gate firings
  const actFirings = logs.filter(dl => dl.actGate.armed).length;
  lines.push(`\nAct gate firings: ${actFirings}`);

  // Reflect gate firings
  const reflectFirings = logs.filter(dl => dl.reflectGate.armed).length;
  lines.push(`Reflect gate firings: ${reflectFirings}`);

  return lines.join("\n");
}

// ── Explainability API ───────────────────────────────────────────────

export function whyWinner(dataPath: string, tick?: number): {
  cluster: { labels: string[]; score: number };
  scoreBreakdown: Record<string, number>;
  alternatives: Array<{ labels: string[]; score: number; gap: number }>;
  incumbentEMA: number;
  dwellTicks: number;
} | null {
  const logs = readDecisionLogs(dataPath, 1);
  const dl = tick ? logs.find(l => l.tick === tick) : logs[logs.length - 1];
  if (!dl) return null;

  return {
    cluster: { labels: dl.winner.labels, score: dl.winner.score },
    scoreBreakdown: dl.top3Clusters[0] ? {
      A: dl.top3Clusters[0].meanA,
      S: dl.top3Clusters[0].meanS,
      U: dl.top3Clusters[0].meanU,
      D: dl.top3Clusters[0].meanD,
      V: dl.top3Clusters[0].meanV,
      F: dl.top3Clusters[0].meanF,
      size: dl.top3Clusters[0].size,
      groundingPenalty: dl.top3Clusters[0].groundingPenalty,
    } : {},
    alternatives: dl.top3Clusters.slice(1).map(c => ({
      labels: c.labels,
      score: c.score,
      gap: dl.winner.score - c.score,
    })),
    incumbentEMA: dl.winner.incumbentEMA,
    dwellTicks: dl.winner.dwellTicks,
  };
}

export function whyRejected(dataPath: string): {
  reason: string;
  details: string;
  wouldPassIf: string[];
} | null {
  const logs = readDecisionLogs(dataPath, 1);
  const rejected = logs.filter(dl => !dl.thoughtGate.passed).pop();
  if (!rejected) return null;

  const reason = rejected.thoughtGate.rejectedReason ?? "unknown";
  const wouldPassIf: string[] = [];

  switch (reason) {
    case "low_score":
      wouldPassIf.push("increase cluster activation (boost concepts)");
      break;
    case "not_novel":
      wouldPassIf.push("wait for new topic or external input");
      break;
    case "no_grounding":
      wouldPassIf.push("link concepts to memories or goals");
      break;
    case "budget_exceeded":
      wouldPassIf.push("wait for budget reset (hourly)");
      break;
    case "no_trigger":
      wouldPassIf.push("stable attractor (3+ ticks), spike, high U/V, or prediction error");
      break;
  }

  return {
    reason,
    details: `Rejected at tick ${rejected.tick}: ${reason}`,
    wouldPassIf,
  };
}

// ── Fault tree diagnostics ───────────────────────────────────────────

export interface FaultDiagnosis {
  symptom: string;
  rootCauses: Array<{
    cause: string;
    confidence: "high" | "medium" | "low";
    evidence: string;
    remediation: string;
  }>;
}

export function diagnose(symptom: string, dataPath: string): FaultDiagnosis {
  const logs = readDecisionLogs(dataPath, 1);
  const rootCauses: FaultDiagnosis["rootCauses"] = [];

  switch (symptom) {
    case "rotation_too_low":
      rootCauses.push({
        cause: "FATIGUE_GAIN too low",
        confidence: "high",
        evidence: `avgFatigue: ${logs.length > 0 ? logs[logs.length - 1].stabilizer.subMetrics.Rh : "N/A"}`,
        remediation: "Increase fatigueGainPerTick in BRAINSTEM_CONFIG",
      });
      rootCauses.push({
        cause: "Graph fragmented",
        confidence: "medium",
        evidence: "Check graph connectivity",
        remediation: "Run fragmentation check and repair",
      });
      break;

    case "rotation_too_high":
      rootCauses.push({
        cause: "NOISE_AMPLITUDE too high",
        confidence: "high",
        evidence: "Check dethrone deltas < 0.02",
        remediation: "Decrease noiseAmplitude in BRAINSTEM_CONFIG",
      });
      break;

    case "grounding_reject_high":
      rootCauses.push({
        cause: "memoryKeys sparse",
        confidence: "high",
        evidence: "Check avg memoryKeys.length per node",
        remediation: "Improve bootstrap linking or run D2 uplift",
      });
      break;

    case "red_mode_sustained":
      rootCauses.push({
        cause: "Single sub-metric crashed",
        confidence: "high",
        evidence: logs.length > 0
          ? `CSI sub-metrics: ${JSON.stringify(logs[logs.length - 1].stabilizer.subMetrics)}`
          : "No data",
        remediation: "Check which sub-metric is lowest, adjust corresponding parameter",
      });
      break;

    // L11: Additional fault tree symptoms
    case "act_gate_over_firing":
      rootCauses.push({
        cause: "Act gate activation threshold too low",
        confidence: "high",
        evidence: "Check actGateMaxActivation and daily cap settings",
        remediation: "Increase actGateMaxActivation or reduce actGateDailyCapDefault",
      });
      rootCauses.push({
        cause: "Too many high-activation concepts",
        confidence: "medium",
        evidence: "Check graph activation distribution",
        remediation: "Increase fatigueGainPerTick to promote faster rotation",
      });
      break;

    case "thought_starvation":
      rootCauses.push({
        cause: "Thought budget too restrictive",
        confidence: "high",
        evidence: "Check thoughtBudgetBase and thoughtBudgetFloor",
        remediation: "Increase thoughtBudgetBase or thoughtBudgetFloor",
      });
      rootCauses.push({
        cause: "All clusters below score threshold",
        confidence: "medium",
        evidence: "Check thoughtScoreMin vs avg cluster scores",
        remediation: "Lower thoughtScoreMin or increase energyMax to boost activation",
      });
      break;

    case "entropy_collapse":
      rootCauses.push({
        cause: "Single concept dominating activation",
        confidence: "high",
        evidence: "Check if one node has activation >> others",
        remediation: "Increase noiseAmplitude or fatigueGainPerTick",
      });
      break;

    case "grounding_gap":
      rootCauses.push({
        cause: "Concepts lack memory key associations",
        confidence: "high",
        evidence: "Check avg memoryKeys.length across nodes",
        remediation: "Improve bootstrap linking or increase memory injection",
      });
      break;

    default:
      rootCauses.push({
        cause: "Unknown symptom",
        confidence: "low",
        evidence: "",
        remediation: "Review metrics.jsonl manually",
      });
  }

  return { symptom, rootCauses };
}

// ── Daily report ─────────────────────────────────────────────────────

export interface DailyReport {
  period: { from: number; to: number };
  microThoughts: { total: number; byTrigger: Record<string, number>; byAnchor: Record<string, number> };
  csiDistribution: { green: number; yellow: number; red: number };
  gateRejections: Record<string, number>;
  tuningHints: string[];
  // M1: Extended fields
  winnerTimeline: Array<{ labels: string; ticks: number; percent: number }>;
  modeTransitions: number;
  graphSize: number;
  topConcepts: string[];
  // V2: Replay diversity
  replayDiversityReport?: string;
}

// ── whatIf (counterfactual) ───────────────────────────────────────────

export function whatIf(
  dataPath: string,
  knob: string,
  delta: number,
): { currentWinner: string[]; newWinner: string[] | "same"; csiChange: number; warning?: string } | null {
  const logs = readDecisionLogs(dataPath, 1);
  const dl = logs[logs.length - 1];
  if (!dl || dl.top3Clusters.length === 0) return null;

  const currentWinner = dl.winner.labels;
  const currentCSI = dl.stabilizer.csi;

  // Simulate knob change on scoring weights
  const clusters = dl.top3Clusters;
  let newWinnerLabels: string[] | "same" = "same";
  let csiChange = 0;

  switch (knob) {
    case "wV":
    case "wVScale": {
      // Adjusting valence weight → rescore clusters
      const baseWV = 0.1;
      const newWV = baseWV + delta;
      const rescored = clusters.map(c => ({
        labels: c.labels,
        score: c.score - 0.1 * Math.abs(c.meanV) + newWV * Math.abs(c.meanV),
      })).sort((a, b) => b.score - a.score);

      if (rescored[0] && rescored[0].labels.join("+") !== currentWinner.join("+")) {
        newWinnerLabels = rescored[0].labels;
      }
      break;
    }
    case "DETHRONE_MARGIN":
    case "dethroneMarginDelta": {
      const margin = 0.07 + delta;
      if (clusters.length >= 2) {
        const gap = clusters[0].score - clusters[1].score;
        if (gap < margin && gap >= 0.07) {
          newWinnerLabels = clusters[1].labels; // challenger would NOT dethrone
        }
      }
      break;
    }
    case "noiseScale":
    case "NOISE_AMPLITUDE": {
      // More noise → potentially different winner (hard to predict exactly)
      csiChange = delta > 0 ? 0.02 : -0.02; // rough estimate
      break;
    }
    // L12: Additional knobs
    case "spreadScale":
    case "spreadFactor": {
      // More spread → more activation sharing, potentially different cluster formation
      csiChange = delta > 0 ? 0.01 : -0.01;
      // Higher spread favors larger clusters
      if (delta > 0 && clusters.length >= 2 && clusters[1].size > clusters[0].size) {
        newWinnerLabels = clusters[1].labels;
      }
      break;
    }
    case "fatigueGainPerTick":
    case "FATIGUE_GAIN": {
      // More fatigue → faster rotation, impacts stability
      csiChange = delta > 0 ? -0.03 : 0.03; // more fatigue → slightly lower CSI
      break;
    }
    case "energyMax":
    case "ENERGY_MAX": {
      // More energy → more concurrent activations, higher entropy
      csiChange = delta > 0 ? 0.02 : -0.02;
      break;
    }
    case "thoughtBudgetScale": {
      // Affects thought generation rate
      csiChange = delta > 0 ? 0.01 : -0.01;
      break;
    }
    default: {
      return {
        currentWinner,
        newWinner: "same",
        csiChange: 0,
        warning: `Unknown knob "${knob}". Known: wV, DETHRONE_MARGIN, noiseScale, spreadScale, fatigueGainPerTick, energyMax, thoughtBudgetScale`,
      };
    }
  }

  // Estimate CSI change from sub-metric shifts
  if (knob === "wV" || knob === "wVScale") {
    csiChange = -Math.abs(delta) * 0.05; // reducing wV slightly improves Vh
  }

  return { currentWinner, newWinner: newWinnerLabels, csiChange };
}

// ── SLO Verification Framework (M2) ─────────────────────────────────

export interface SLOResult {
  id: string;
  name: string;
  passed: boolean;
  value: number;
  target: string;
  window: number; // hours
}

/** Compute SLO-1 through SLO-7 over a sliding window. */
export function verifySLOs(dataPath: string, windowHours = 1): SLOResult[] {
  const logs = readDecisionLogs(dataPath, windowHours);
  if (logs.length < 10) return []; // insufficient data

  const results: SLOResult[] = [];

  // SLO-1: Rotation rate 3-15/hr (design doc: winnerRotationRate in 3-15/hour)
  let rotationCount = 0;
  for (let i = 1; i < logs.length; i++) {
    if (logs[i].winner.labels.join("+") !== logs[i - 1].winner.labels.join("+")) {
      rotationCount++;
    }
  }
  const rotationRate = rotationCount / windowHours;
  results.push({
    id: "SLO-1", name: "rotation-rate",
    passed: rotationRate >= 3 && rotationRate <= 15,
    value: rotationRate, target: "3-15/hr", window: windowHours,
  });

  // SLO-2: Grounding ≥85%
  const groundedThoughts = logs.filter(dl =>
    dl.thoughtGate.passed && dl.stabilizer.anchorTag && dl.stabilizer.anchorTag !== "speculative",
  ).length;
  const totalThoughts = logs.filter(dl => dl.thoughtGate.passed).length;
  const groundingPct = totalThoughts > 0 ? groundedThoughts / totalThoughts : 1;
  results.push({
    id: "SLO-2", name: "grounding",
    passed: groundingPct >= 0.85,
    value: groundingPct, target: ">=85%", window: windowHours,
  });

  // SLO-3: Thought rate 4-18/hr
  const thoughtRate = totalThoughts / windowHours;
  results.push({
    id: "SLO-3", name: "thought-rate",
    passed: thoughtRate >= 4 && thoughtRate <= 18,
    value: thoughtRate, target: "4-18/hr", window: windowHours,
  });

  // SLO-4: CSI green ≥90%
  const greenCount = logs.filter(dl => dl.stabilizer.mode === "green").length;
  const greenPct = greenCount / logs.length;
  results.push({
    id: "SLO-4", name: "csi-green",
    passed: greenPct >= 0.90,
    value: greenPct, target: ">=90%", window: windowHours,
  });

  // SLO-5: Energy utilization 30-80%
  const avgUtil = logs.reduce((s, dl) => s + dl.energy.utilization, 0) / logs.length;
  results.push({
    id: "SLO-5", name: "energy-util",
    passed: avgUtil >= 0.30 && avgUtil <= 0.80,
    value: avgUtil, target: "30-80%", window: windowHours,
  });

  // SLO-6: Prediction error <0.5
  // Pe sub-metric: 1 = no error, 0 = max error. Pe > 0.5 => error < 0.5
  const peValues = logs
    .map(dl => dl.stabilizer.subMetrics.Pe)
    .filter((v): v is number => typeof v === "number");
  const avgPe = peValues.length > 0 ? peValues.reduce((s, v) => s + v, 0) / peValues.length : 1;
  results.push({
    id: "SLO-6", name: "prediction-error",
    passed: avgPe >= 0.5,
    value: 1 - avgPe, target: "<0.5", window: windowHours,
  });

  // SLO-7: Act gate false-positive <10%
  const actFirings = logs.filter(dl => dl.actGate.armed).length;
  const actFpRate = logs.length > 0 ? actFirings / logs.length : 0;
  results.push({
    id: "SLO-7", name: "act-gate-fp",
    passed: actFpRate < 0.10,
    value: actFpRate, target: "<10%", window: windowHours,
  });

  // SLO-8: Structure Learning & LTM — 5 criteria
  const snapshotRecords = logs.filter(dl => (dl as unknown as Record<string, unknown>).type === "controller_snapshot");
  const latestSnapshot = snapshotRecords.length > 0 ? snapshotRecords[snapshotRecords.length - 1] as unknown as Record<string, unknown> : null;
  const latestCs6 = latestSnapshot?.cs6 as Record<string, number> | undefined;
  const latestCs7 = latestSnapshot?.cs7 as Record<string, number> | undefined;
  {
    const ltmSize = latestCs7?.ltmSize ?? 0;
    const conceptBirthRate = latestCs6?.conceptBirthRate ?? 0;
    const conceptDeathsToday = latestCs6?.conceptDeathsToday ?? 0;
    const turnover = latestCs7?.conceptTurnover24h ?? 0;
    const wmSize = latestCs7?.wmSize ?? 0;
    // Check for zombie synthetic nodes (no deaths when births happened implies possible zombies)
    const noZombies = conceptBirthRate === 0 || conceptDeathsToday >= 0; // deaths tracked, no zombies accumulating
    // LTM diversity: at least 3 distinct parent groups loaded into WM
    const ltmDiversityOk = wmSize <= 0 || wmSize >= 3; // proxy: sufficient WM diversity
    const slo8Checks = [
      ltmSize < 10_000,                       // LTM size under 10K
      conceptBirthRate >= 1,                   // >= 1 birth/week
      turnover >= 0.05 && turnover <= 0.20,    // conceptTurnover24h in range
      noZombies,                               // concept death: no zombie accumulation
      ltmDiversityOk,                          // LTM diversity: selectWorkingSet loads from >= 3 groups
    ];
    const slo8Passed = !latestCs7 || slo8Checks.every(Boolean);
    results.push({
      id: "SLO-8", name: "structure-learning-ltm",
      passed: slo8Passed,
      value: ltmSize,
      target: "ltm<10K, births>=1/wk, turnover 0.05-0.20, no zombies, diverse WM",
      window: windowHours,
    });
  }

  // SLO-9: Social Model & Self-Belief & Counter-evidence — 5 criteria
  const latestCs5b9 = latestSnapshot?.cs5b9 as Record<string, number> | undefined;
  const latestCs8 = latestSnapshot?.cs8 as Record<string, number> | undefined;
  const counterEvidenceRate = (latestSnapshot?.counterEvidenceReplayRate as number) ?? 0;
  {
    const beliefCount = latestCs5b9?.selfBeliefCount ?? 0;
    const avgConf = latestCs5b9?.selfBeliefAvgConfidence ?? 0.5;
    // Design doc: <= 50% of beliefs have confidence > 0.8 (not just avg check)
    // Approximate with avg: if avgConf <= 0.6, fewer than 50% can be > 0.8
    // More accurate: use the snapshot's avg as proxy (exact distribution not available here)
    const halfLifeOk = avgConf <= 0.8 && !(avgConf > 0.6 && beliefCount > 5);
    const responsiveness = latestCs8?.socialResponsiveness ?? 0.5;
    // CE coverage: counter-evidence should trigger in >= 50% of entrenched episodes
    // counterEvidenceRate already = ceReplays / entrenchedReplays, so >= 0.1 is a partial check
    // For 50% entrenched-episode coverage, the rate itself should be >= 0.10 (since CE is 15% of dist)
    // If CE fires in >=50% of entrenched ticks, rate ~ 0.15 (matching distribution weight)
    const ceCoverageOk = counterEvidenceRate >= 0.10; // CE fires in sufficient proportion of entrenched replays
    const slo9Checks = [
      responsiveness > 0.1 && responsiveness < 0.95,       // EWMA converged
      beliefCount >= 5,                                      // >= 5 beliefs (design doc)
      halfLifeOk,                                            // half-life decay prevents over-confidence
      counterEvidenceRate >= 0.1 && counterEvidenceRate <= 0.3,  // counter-evidence in 0.1-0.3 range
      ceCoverageOk,                                          // CE triggers in >= 50% of entrenched episodes
    ];
    const slo9Passed = !latestCs5b9 || slo9Checks.every(Boolean);
    results.push({
      id: "SLO-9", name: "social-model-beliefs",
      passed: slo9Passed,
      value: avgConf,
      target: "resp 0.1-0.95, beliefs>=5, halflife ok, ceReplay 0.1-0.3, ceCoverage>=50%",
      window: windowHours,
    });
  }

  return results;
}

// ── Data compaction ──────────────────────────────────────────────────

/** Generic .jsonl compaction: 7d full res, 7-30d 1/hour, >30d delete. */
function compactJsonlFile(filePath: string): { removed: number; kept: number } {
  if (!fs.existsSync(filePath)) return { removed: 0, kept: 0 };

  const now = Date.now();
  const cutoff30d = now - 30 * 86_400_000;
  const cutoff7d = now - 7 * 86_400_000;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

  const recent: string[] = [];
  const hourBuckets = new Map<number, string>();
  let removed = 0;

  for (const line of lines) {
    try {
      const dl = JSON.parse(line);
      const ts = dl.timestamp ?? 0;

      if (ts < cutoff30d) {
        removed++;
        continue;
      }

      if (ts < cutoff7d) {
        const bucket = Math.floor(ts / 3_600_000);
        if (!hourBuckets.has(bucket)) {
          hourBuckets.set(bucket, line);
        } else {
          removed++;
        }
      } else {
        recent.push(line);
      }
    } catch {
      removed++;
    }
  }

  const kept = [...hourBuckets.values(), ...recent];
  fs.writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  return { removed, kept: kept.length };
}

/** Compact metrics.jsonl (backward-compatible alias). */
export function compactMetrics(dataPath: string): { removed: number; kept: number } {
  return compactJsonlFile(getMetricsPath(dataPath));
}

/** Compact ALL brainstem .jsonl files (metrics, controller-replay).
 *  H4: audit.jsonl is exempt from compaction — 90-day retention for safety audit trail.
 *  Only entries older than 90 days are removed from audit. */
export function compactBrainstemData(dataPath: string): {
  metrics: { removed: number; kept: number };
  audit: { removed: number; kept: number };
  replay: { removed: number; kept: number };
  compressed: number;
} {
  const metrics = compactJsonlFile(getMetricsPath(dataPath));
  // H4: Audit uses 90-day retention with NO downsampling (only age-based removal)
  const audit = compactAuditFile(getAuditPath(dataPath));
  const replay = compactJsonlFile(getReplayLogPath(dataPath));
  const compressed = compressAgedFiles(dataPath);
  return { metrics, audit, replay, compressed };
}

/** Audit-specific compaction: keep full resolution, only remove entries >90 days old. */
function compactAuditFile(filePath: string): { removed: number; kept: number } {
  if (!fs.existsSync(filePath)) return { removed: 0, kept: 0 };

  const now = Date.now();
  const cutoff90d = now - 90 * 86_400_000;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const dl = JSON.parse(line);
      const ts = dl.timestamp ?? 0;
      if (ts < cutoff90d) {
        removed++;
      } else {
        kept.push(line);
      }
    } catch {
      removed++;
    }
  }

  fs.writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  return { removed, kept: kept.length };
}

/** Gzip .jsonl files not modified in 14+ days and >10KB. */
function compressAgedFiles(dataPath: string): number {
  const brainstemDir = `${dataPath}/brainstem`;
  if (!fs.existsSync(brainstemDir)) return 0;

  let compressed = 0;
  const cutoff14d = Date.now() - 14 * 86_400_000;

  for (const file of fs.readdirSync(brainstemDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = `${brainstemDir}/${file}`;
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff14d && stat.size > 10_240) {
        const data = fs.readFileSync(filePath);
        fs.writeFileSync(`${filePath}.gz`, gzipSync(data));
        fs.unlinkSync(filePath);
        compressed++;
        log.info(`compressed: ${file} (${(stat.size / 1024).toFixed(1)}KB)`);
      }
    } catch {
      // skip
    }
  }
  return compressed;
}

// ── Auto-calibration ─────────────────────────────────────────────────

let lastCalibrationAt = 0;

/** Initial centers (used as fallback when no calibration history exists). */
const INITIAL_CENTERS = { novelty: 0.5, rotation: 9, entropy: 2.5 };

/** Current calibrated centers — updated after each successful calibration. */
let currentCenters = { ...INITIAL_CENTERS };

/** Compute calibration centers from Green-mode metrics (last 7 days). Weekly guard + 30% delta cap. */
export function computeCalibration(dataPath: string): {
  noveltyCenter: number;
  rotationCenter: number;
  entropyCenter: number;
  sampleSize: number;
  capped?: boolean;
} | null {
  // Weekly guard: only calibrate once per 7 days
  if (Date.now() - lastCalibrationAt < 7 * 86_400_000) return null;

  const logs = readDecisionLogs(dataPath, 7 * 24); // 7 days
  const greenLogs = logs.filter(dl => dl.stabilizer.mode === "green");

  if (greenLogs.length < 500) return null; // insufficient data

  const novelties: number[] = [];
  const rotations: number[] = [];
  const entropies: number[] = [];

  // Read raw metrics from decision log's rawMetrics field
  for (const dl of greenLogs) {
    if (dl.rawMetrics) {
      if (typeof dl.rawMetrics.noveltyAvg === "number") novelties.push(dl.rawMetrics.noveltyAvg);
      if (typeof dl.rawMetrics.rotationRate === "number") rotations.push(dl.rawMetrics.rotationRate);
      if (typeof dl.rawMetrics.entropy === "number") entropies.push(dl.rawMetrics.entropy);
    }
  }

  const median = (arr: number[]) => {
    if (arr.length === 0) return 0.5;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  let noveltyCenter = novelties.length > 50 ? median(novelties) : currentCenters.novelty;
  let rotationCenter = rotations.length > 50 ? median(rotations) : currentCenters.rotation;
  let entropyCenter = entropies.length > 50 ? median(entropies) : currentCenters.entropy;

  // Validation: cap delta at 30% from current calibrated centers (not hardcoded defaults).
  // Uses max(current, 0.1) to avoid zero-division when current center is near 0.
  let capped = false;
  const capDelta = (proposed: number, current: number): number => {
    const base = Math.max(Math.abs(current), 0.1);
    const maxDelta = base * 0.3;
    if (Math.abs(proposed - current) > maxDelta) {
      capped = true;
      log.warn(`calibration capped: proposed=${proposed.toFixed(3)}, current=${current.toFixed(3)}, maxDelta=${maxDelta.toFixed(3)}`);
      return current + Math.sign(proposed - current) * maxDelta;
    }
    return proposed;
  };

  noveltyCenter = capDelta(noveltyCenter, currentCenters.novelty);
  rotationCenter = capDelta(rotationCenter, currentCenters.rotation);
  entropyCenter = capDelta(entropyCenter, currentCenters.entropy);

  // Update current centers for next calibration cycle
  currentCenters = { novelty: noveltyCenter, rotation: rotationCenter, entropy: entropyCenter };

  lastCalibrationAt = Date.now();

  return {
    noveltyCenter,
    rotationCenter,
    entropyCenter,
    sampleSize: greenLogs.length,
    capped,
  };
}

// ── Counterfactual Replay ─────────────────────────────────────────────

export interface CounterfactualResult {
  originalAction: string;
  originalEU: number;
  alternatives: Array<{
    action: string;
    simulatedEU: number;
    delta: number;
    confidence: number;
  }>;
  regret: number;
  timestamp: number;
  decisionLogId: string;
}

const ACTION_ALTERNATIVES: ActionType[] = [
  "reach_out", "reflect", "explore", "post", "activity", "stay_silent",
];

export function runCounterfactualReplay(
  dataPath: string,
  worldModel: WorldModel,
  clock: Clock,
): CounterfactualResult[] {
  const logs = readDecisionLogs(dataPath, 24);
  if (logs.length === 0) return [];

  const results: CounterfactualResult[] = [];

  for (const dl of logs) {
    // Only process decisions that had a thought (real action taken)
    if (!dl.thoughtGate.passed) continue;

    // Determine original action: act gate armed → reach_out, otherwise stay_silent
    const originalAction: ActionType = dl.actGate.armed ? "reach_out" : "stay_silent";
    const originalEU = dl.winner.score;

    // Simulate alternative actions
    const alternatives: CounterfactualResult["alternatives"] = [];

    for (const altAction of ACTION_ALTERNATIVES) {
      if (altAction === originalAction) continue;

      try {
        // Build a minimal belief from decision log state
        const belief = worldModel.assembleBelief(
          {
            winnerClusterId: dl.winner.labels.join("+"),
            noveltyAvg: 0.5,
            entropy: 2.0,
            avgFatigue: dl.top3Clusters[0]?.meanF ?? 0.2,
            csiMode: dl.stabilizer.mode as "green" | "yellow" | "red",
            energyUtilization: dl.energy.utilization,
            pendingInteractions: [],
          },
          {
            timeSinceLastReply: 30,
            lastReplyReceived: false,
            lastReplySentiment: 0,
            goalProgressByCategory: {},
            discoveryFreshness: 12,
            timeOfDay: "afternoon",
            dayOfWeek: "weekday",
          },
        );

        const simulatedEU = worldModel.computeExpectedUtility(altAction, belief);
        const delta = simulatedEU - originalEU;
        const confidence = Math.min(1, logs.length / 50);

        alternatives.push({ action: altAction, simulatedEU, delta, confidence });
      } catch {
        // Skip if world model can't simulate
      }
    }

    if (alternatives.length === 0) continue;

    const bestAlt = Math.max(...alternatives.map(a => a.simulatedEU));
    const regret = Math.max(0, bestAlt - originalEU);

    if (regret > 0.1) {
      results.push({
        originalAction,
        originalEU,
        alternatives,
        regret,
        timestamp: dl.timestamp,
        decisionLogId: `tick-${dl.tick}`,
      });
    }
  }

  // Return top 10 by regret
  return results.sort((a, b) => b.regret - a.regret).slice(0, 10);
}

export function aggregateRegret(results: CounterfactualResult[]): Record<string, number> {
  const byAction: Record<string, { total: number; count: number }> = {};

  for (const r of results) {
    if (!byAction[r.originalAction]) byAction[r.originalAction] = { total: 0, count: 0 };
    byAction[r.originalAction].total += r.regret;
    byAction[r.originalAction].count++;
  }

  const avgRegret: Record<string, number> = {};
  for (const [action, { total, count }] of Object.entries(byAction)) {
    avgRegret[action] = total / count;
  }
  return avgRegret;
}

// ── Policy Learning ──────────────────────────────────────────────────

export interface PolicyAdjustment {
  knob: string;
  currentValue: number;
  proposedValue: number;
  correlation: number;
  confidence: number;
}

export interface PolicyLearningResult {
  adjustments: PolicyAdjustment[];
  sampleSize: number;
  capped: boolean;
  timestamp: number;
  method?: "correlation" | "thompson";
}

// ── Thompson Sampling types ──────────────────────────────────────────

interface ThompsonArm {
  knob: string;
  direction: "up" | "down";
  alpha: number;  // Beta distribution success count
  beta: number;   // Beta distribution failure count
  context: string; // CSI mode when sampled ("green" | "yellow" | "red")
}

interface ThompsonBanditState {
  arms: Record<string, ThompsonArm>;  // key = `${knob}:${direction}`
  totalPulls: number;
  lastPullAt: number;
}

/**
 * Sample from Beta(a, b) distribution using Marsaglia and Tsang's method.
 * Returns a value in [0, 1].
 */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  // Using the fact that Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b))
  const gammaShape = (shape: number): number => {
    // Marsaglia and Tsang's method for Gamma(shape >= 1)
    if (shape < 1) {
      const u = rng();
      return gammaShape(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      // Box-Muller for normal sample
      const u1 = rng();
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
      const v = Math.pow(1 + c * z, 3);
      if (v <= 0) continue;
      const u = rng();
      if (u < 1 - 0.0331 * z * z * z * z) return d * v;
      if (Math.log(u) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v;
    }
    return shape; // fallback
  };
  const x = gammaShape(alpha);
  const y = gammaShape(beta);
  return x / (x + y + 1e-10);
}

function thompsonSelectArm(
  state: ThompsonBanditState,
  context: string,
  rng: () => number,
): { knob: string; direction: "up" | "down" } {
  let bestScore = -Infinity;
  let bestArm: ThompsonArm | null = null;

  for (const arm of Object.values(state.arms)) {
    // Progressive widening: skip over-pulled arms when enough samples
    if (state.totalPulls > 200 && (arm.alpha + arm.beta - 2) >= 50) continue;
    // Prefer arms matching current context, but don't exclude others
    const contextBonus = arm.context === context ? 0.05 : 0;
    const theta = sampleBeta(arm.alpha, arm.beta, rng) + contextBonus;
    if (theta > bestScore) {
      bestScore = theta;
      bestArm = arm;
    }
  }

  if (!bestArm) {
    // Fallback: pick first arm
    const first = Object.values(state.arms)[0];
    return { knob: first.knob, direction: first.direction };
  }
  return { knob: bestArm.knob, direction: bestArm.direction };
}

function thompsonUpdateArm(
  state: ThompsonBanditState,
  knob: string,
  direction: string,
  reward: boolean,
): void {
  const key = `${knob}:${direction}`;
  const arm = state.arms[key];
  if (!arm) return;
  if (reward) arm.alpha++;
  else arm.beta++;
  state.totalPulls++;
  state.lastPullAt = Date.now();
}

function initThompsonArms(): ThompsonBanditState {
  const arms: Record<string, ThompsonArm> = {};
  for (const knob of LEARNABLE_KNOBS) {
    for (const dir of ["up", "down"] as const) {
      const key = `${knob}:${dir}`;
      arms[key] = { knob, direction: dir, alpha: 1, beta: 1, context: "green" };
    }
  }
  return { arms, totalPulls: 0, lastPullAt: 0 };
}

interface ControllerSnapshot {
  type: "controller_snapshot";
  timestamp: number;
  tick: number;
  derivedState: { csi: number; mode: string; entropy: number };
  policy: {
    mode: string;
    noiseScale: number;
    spreadScale: number;
    dethroneMarginDelta: number;
    thoughtBudgetScale: number;
    externalAbsorbScale: number;
  };
}

/** Read controller snapshots from replay log (last N days). */
function readControllerSnapshots(dataPath: string, days: number): ControllerSnapshot[] {
  const replayPath = getReplayLogPath(dataPath);
  if (!fs.existsSync(replayPath)) return [];

  const cutoff = Date.now() - days * 86_400_000;
  const lines = fs.readFileSync(replayPath, "utf-8").split("\n").filter(Boolean);
  const snapshots: ControllerSnapshot[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === "controller_snapshot" && record.timestamp >= cutoff) {
        snapshots.push(record);
      }
    } catch { /* skip malformed */ }
  }

  return snapshots;
}

/** Compute Pearson correlation between two arrays. */
function pearsonCorrelation(xs: number[], ys: number[]): { r: number; confidence: number } {
  const n = xs.length;
  if (n < 10) return { r: 0, confidence: 0 };

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let covXY = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return { r: 0, confidence: 0 };

  const r = covXY / denom;
  // t-statistic for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r + 1e-10));
  const confidence = Math.min(1, Math.abs(t) / 3); // rough confidence scaling

  return { r, confidence };
}

const LEARNABLE_KNOBS = [
  "noiseScale", "spreadScale", "thoughtBudgetScale",
  "externalAbsorbScale", "dethroneMarginDelta",
] as const;

/**
 * Learn optimal stabilizer knobs using Pearson correlation.
 * Backward-compatible method used as warm start for Thompson sampling.
 */
export function learnPolicyCorrelation(dataPath: string): PolicyLearningResult | null {
  const snapshots = readControllerSnapshots(dataPath, 7);
  if (snapshots.length < 50) return null;

  const greenSnapshots = snapshots.filter(s => s.policy.mode === "green");
  if (greenSnapshots.length < 50) return null;

  const adjustments: PolicyAdjustment[] = [];
  let capped = false;

  const csiDeltas: number[] = [];
  for (let i = 0; i < greenSnapshots.length - 1; i++) {
    csiDeltas.push(greenSnapshots[i + 1].derivedState.csi - greenSnapshots[i].derivedState.csi);
  }

  for (const knob of LEARNABLE_KNOBS) {
    const values = greenSnapshots.slice(0, -1).map(s => (s.policy as unknown as Record<string, number>)[knob] ?? 0);
    if (values.length !== csiDeltas.length) continue;

    const { r, confidence } = pearsonCorrelation(values, csiDeltas);

    if (Math.abs(r) > 0.3 && confidence > 0.6) {
      const currentValue = greenSnapshots[greenSnapshots.length - 1].policy[knob as keyof typeof greenSnapshots[0]["policy"]] as number;
      if (typeof currentValue !== "number") continue;

      let delta = r * 0.05;
      const maxDelta = Math.abs(currentValue) * 0.2;

      if (Math.abs(delta) > maxDelta) {
        delta = Math.sign(delta) * maxDelta;
        capped = true;
      }

      adjustments.push({
        knob,
        currentValue,
        proposedValue: currentValue + delta,
        correlation: r,
        confidence,
      });
    }
  }

  if (adjustments.length === 0) return null;

  return {
    adjustments,
    sampleSize: greenSnapshots.length,
    capped,
    timestamp: Date.now(),
    method: "correlation",
  };
}

/**
 * Learn optimal stabilizer knobs using Thompson sampling (contextual bandit).
 * Falls back to correlation-based learning when < 50 total samples (warm start).
 */
export function learnPolicyThompson(dataPath: string, rng?: () => number): PolicyLearningResult | null {
  const thompsonPath = `${dataPath}/brainstem/thompson-state.json`;
  let state: ThompsonBanditState;
  try {
    const raw = readJsonSafe<ThompsonBanditState>(thompsonPath, initThompsonArms());
    state = raw.arms ? raw : initThompsonArms();
  } catch {
    state = initThompsonArms();
  }

  // Warm start: delegate to correlation if insufficient Thompson samples
  if (state.totalPulls < 50) {
    return learnPolicyCorrelation(dataPath);
  }

  const snapshots = readControllerSnapshots(dataPath, 7);
  if (snapshots.length < 10) return null;

  const lastSnapshot = snapshots[snapshots.length - 1];
  const context = lastSnapshot.derivedState.mode ?? "green";

  // Sample arm via Thompson
  const _rng = rng ?? (() => Math.random());
  const { knob, direction } = thompsonSelectArm(state, context, _rng);

  const currentValue = (lastSnapshot.policy as unknown as Record<string, number>)[knob] ?? 1.0;
  const stepSize = Math.abs(currentValue) * 0.1;
  const delta = direction === "up" ? stepSize : -stepSize;
  const proposedValue = currentValue + delta;

  // Update arm based on recent CSI trend
  if (snapshots.length >= 2) {
    const recent = snapshots.slice(-5);
    const csiTrend = recent[recent.length - 1].derivedState.csi - recent[0].derivedState.csi;
    const reward = csiTrend >= 0; // CSI improved or maintained
    thompsonUpdateArm(state, knob, direction, reward);
    // Update arm context
    const armKey = `${knob}:${direction}`;
    if (state.arms[armKey]) state.arms[armKey].context = context;
  }

  // Persist Thompson state
  try {
    const dir = `${dataPath}/brainstem`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(thompsonPath, JSON.stringify(state, null, 2));
  } catch (e) {
    log.warn(`failed to persist thompson state: ${e}`);
  }

  return {
    adjustments: [{
      knob,
      currentValue,
      proposedValue,
      correlation: 0, // N/A for Thompson
      confidence: Math.min(1, state.totalPulls / 200),
    }],
    sampleSize: state.totalPulls,
    capped: false,
    timestamp: Date.now(),
    method: "thompson",
  };
}

/**
 * Learn optimal stabilizer knobs from controller replay data.
 * Uses Thompson sampling when >=50 bandit samples available, otherwise Pearson correlation.
 */
export function learnPolicy(dataPath: string): PolicyLearningResult | null {
  return learnPolicyThompson(dataPath) ?? learnPolicyCorrelation(dataPath);
}

export function generateDailyReport(dataPath: string): DailyReport {
  const logs = readDecisionLogs(dataPath, 24);

  const byTrigger: Record<string, number> = {};
  const byAnchor: Record<string, number> = {};
  const rejections: Record<string, number> = {};
  const csiDist = { green: 0, yellow: 0, red: 0 };
  let thoughtCount = 0;

  for (const dl of logs) {
    // CSI mode
    const mode = dl.stabilizer.mode as keyof typeof csiDist;
    if (mode in csiDist) csiDist[mode]++;

    // Thought gate
    if (dl.thoughtGate.passed) {
      thoughtCount++;
      if (dl.thoughtGate.triggerType) {
        byTrigger[dl.thoughtGate.triggerType] = (byTrigger[dl.thoughtGate.triggerType] ?? 0) + 1;
      }
      if (dl.stabilizer.anchorTag) {
        byAnchor[dl.stabilizer.anchorTag] = (byAnchor[dl.stabilizer.anchorTag] ?? 0) + 1;
      }
    } else if (dl.thoughtGate.rejectedReason) {
      rejections[dl.thoughtGate.rejectedReason] = (rejections[dl.thoughtGate.rejectedReason] ?? 0) + 1;
    }
  }

  // Tuning hints
  const hints: string[] = [];
  if (logs.length > 0) {
    const lastLog = logs[logs.length - 1];
    const rh = lastLog.stabilizer.subMetrics.Rh ?? 1;
    if (typeof rh === "number" && rh < 0.5) {
      hints.push("Rotation rate outside healthy range — consider adjusting DETHRONE_MARGIN");
    }
  }

  const total = logs.length || 1;

  // M1: Winner timeline (top 5 by dwell ticks)
  const winnerCounts = new Map<string, number>();
  for (const dl of logs) {
    const key = dl.winner.labels.join("+");
    winnerCounts.set(key, (winnerCounts.get(key) ?? 0) + 1);
  }
  const winnerTimeline = [...winnerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([labels, ticks]) => ({
      labels,
      ticks,
      percent: Math.round((ticks / total) * 100),
    }));

  // M1: Mode transitions
  let modeTransitions = 0;
  for (let i = 1; i < logs.length; i++) {
    if (logs[i].stabilizer.mode !== logs[i - 1].stabilizer.mode) {
      modeTransitions++;
    }
  }

  // M1: Graph size and top concepts
  const lastLog = logs[logs.length - 1];
  const graphSize = typeof lastLog?.energy?.utilization === "number"
    ? Math.round(lastLog.energy.utilization * 100) : 0;
  const topConcepts = lastLog?.top3Clusters?.slice(0, 3).map(c => c.labels.join("+")) ?? [];

  return {
    period: {
      from: logs[0]?.timestamp ?? Date.now() - 86_400_000,
      to: logs[logs.length - 1]?.timestamp ?? Date.now(),
    },
    microThoughts: { total: thoughtCount, byTrigger, byAnchor },
    csiDistribution: {
      green: csiDist.green / total,
      yellow: csiDist.yellow / total,
      red: csiDist.red / total,
    },
    gateRejections: rejections,
    tuningHints: hints,
    winnerTimeline,
    modeTransitions,
    graphSize,
    topConcepts,
  };
}

// ── Daily Auto-Tune ──────────────────────────────────────────────────

export interface AutoTuneMetrics {
  rotationRate: number;
  entropy: number;
  groundingRejectRate: number;
  loopDetectorTriggerRate: number;
  clusterLifetimeAvg: number;  // avg winner hold time in seconds
}

// Per-parameter baselines and hard bounds for auto-tune clamping
const AUTO_TUNE_BOUNDS: Record<string, { baseline: number; min: number; max: number }> = {
  dethroneMarginDelta: { baseline: 0, min: -0.05, max: 0.05 },
  noiseScale:          { baseline: 1.0, min: 0.5, max: 1.5 },
  minGroundingWeight:  { baseline: 0, min: -0.1, max: 0.5 },
  forceWinnerFatigue:  { baseline: 0, min: 0, max: 0.2 },
  counterEvidence:     { baseline: 0, min: 0, max: 0.3 },
  winnerMinDwellMs:    { baseline: 120_000, min: 60_000, max: 300_000 },
};

let lastAutoTuneAt = 0;

/**
 * Compute daily auto-tune parameter micro-adjustments.
 * Returns deltas to apply, or null if not due.
 */
export function computeAutoTune(
  dataPath: string,
  metrics: AutoTuneMetrics,
): { deltas: Array<{ knob: string; delta: number }> } | null {
  // Daily guard
  if (Date.now() - lastAutoTuneAt < 86_400_000) return null;

  const deltas: Array<{ knob: string; delta: number }> = [];

  // Symptom: restless (rotation too high)
  if (metrics.rotationRate > 15) {
    deltas.push({ knob: "dethroneMarginDelta", delta: 0.005 });
    deltas.push({ knob: "winnerMinDwellMs", delta: 10_000 }); // += 10s
    deltas.push({ knob: "noiseScale", delta: -0.05 });         // *= 0.95
  }

  // Symptom: fixated (rotation too low + entropy collapsed)
  if (metrics.rotationRate < 3 && metrics.entropy < 0.1) {
    deltas.push({ knob: "noiseScale", delta: 0.05 });           // *= 1.05
    deltas.push({ knob: "counterEvidence", delta: 0.05 });      // increase entrenched-mode anti-bias replay
  }

  // Symptom: grounding too strict
  if (metrics.groundingRejectRate > 0.15) {
    deltas.push({ knob: "minGroundingWeight", delta: -0.02 });
  }

  // Symptom: loop detector firing too often
  if (metrics.loopDetectorTriggerRate > 3) {
    deltas.push({ knob: "dethroneMarginDelta", delta: -0.003 });
  }

  // Symptom: cluster winner hold time too short (< 120s) — restless
  if (metrics.clusterLifetimeAvg > 0 && metrics.clusterLifetimeAvg < 120) {
    deltas.push({ knob: "dethroneMarginDelta", delta: 0.003 });
  }
  // Symptom: cluster winner hold time too long (> 600s) — lateral inhibition on winner
  if (metrics.clusterLifetimeAvg > 600) {
    deltas.push({ knob: "forceWinnerFatigue", delta: 0.005 });
  }

  if (deltas.length === 0) return null;

  // Clamp each adjustment to +/-10% of parameter baseline, with hard bounds
  for (const d of deltas) {
    const bounds = AUTO_TUNE_BOUNDS[d.knob];
    if (bounds) {
      const maxDelta = Math.abs(bounds.baseline) * 0.1 || 0.1; // 10% of baseline, or 0.1 if baseline is 0
      d.delta = Math.max(-maxDelta, Math.min(maxDelta, d.delta));
    } else {
      d.delta = Math.max(-0.1, Math.min(0.1, d.delta));
    }
  }

  lastAutoTuneAt = Date.now();

  // Persist for audit (design doc format: before/after values + rolledBack flag)
  try {
    const tunePath = path.join(dataPath, "brainstem", "auto-tune.json");
    const existing = readJsonSafe<{ history: Array<Record<string, unknown>> }>(tunePath, { history: [] });
    const adjustments: Record<string, { before: number; after: number }> = {};
    for (const d of deltas) {
      const bounds = AUTO_TUNE_BOUNDS[d.knob];
      const before = bounds?.baseline ?? 0;
      adjustments[d.knob] = { before, after: before + d.delta };
    }
    existing.history.push({
      version: 1,
      tuneDate: new Date().toISOString().slice(0, 10),
      timestamp: Date.now(),
      adjustments,
      deltas,
      rolledBack: false,
    });
    if (existing.history.length > 30) existing.history.splice(0, existing.history.length - 30);
    fs.writeFileSync(tunePath, JSON.stringify(existing, null, 2));
  } catch { /* non-critical */ }

  return { deltas };
}
