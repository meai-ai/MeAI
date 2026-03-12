/**
 * Behavioral Snapshot — pure data aggregation, zero LLM cost.
 * Reads existing state files and computes a point-in-time snapshot.
 */
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr } from "./lib/pst-date.js";

export interface BehavioralSnapshot {
  generatedAt: number;
  dateStr: string;
  values: {
    candidateCount: number; emergingCount: number; committedCount: number;
    domainDistribution: Record<string, number>;
    promotionHistory: number; decommitHistory: number;
  };
  emotion: {
    moodDiversity: number; dominantCauses: string[];
    volatility: number; avgValence: number; avgEnergy: number;
  };
  response: {
    avgLength: number; featureUsage: Record<string, number>;
    qualityTrend: number; topRelationalPatterns: string[];
  };
  proactive: {
    replyRate: number; bestTiming: string; worstTiming: string;
    topicEngagement: Record<string, number>; dailyAvg: number;
  };
  narrative: {
    currentSelfSense: string | null; themeTrajectories: string[];
    openQuestions: string[]; staleDays: number;
  };
  errors?: { topErrors: Array<{ key: string; count: number }>; totalCount: number };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.sqrt(nums.reduce((s, n) => s + (n - m) ** 2, 0) / nums.length);
}

function buildValues(sp: string): BehavioralSnapshot["values"] {
  const d = { candidateCount: 0, emergingCount: 0, committedCount: 0, domainDistribution: {} as Record<string, number>, promotionHistory: 0, decommitHistory: 0 };
  try {
    const vf = readJsonSafe<any>(path.join(sp, "value-formation.json"), null);
    if (!vf) return d;
    const cands: any[] = vf.candidates ?? [], emer: any[] = vf.emergingValues ?? vf.emerging ?? [];
    const comm: any[] = vf.committed ?? [];
    const dist: Record<string, number> = {};
    for (const v of [...cands, ...emer, ...comm]) { const k = v.domain ?? "unknown"; dist[k] = (dist[k] ?? 0) + 1; }
    return { candidateCount: cands.length, emergingCount: emer.length, committedCount: comm.length,
      domainDistribution: dist, promotionHistory: (vf.promotedValueIds ?? []).length, decommitHistory: (vf.decommitLog ?? []).length };
  } catch { return d; }
}

function buildEmotion(sp: string): BehavioralSnapshot["emotion"] {
  const d = { moodDiversity: 0, dominantCauses: [] as string[], volatility: 0, avgValence: 0, avgEnergy: 0 };
  try {
    const ej = readJsonSafe<any>(path.join(sp, "emotion-journal.json"), null);
    if (!ej) return d;
    const all: any[] = Array.isArray(ej) ? ej : ej.data?.entries ?? ej.entries ?? [];
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const recent = all.filter((e: any) => (e.timestamp ?? 0) > cutoff);
    if (!recent.length) return d;
    const moods = recent.map((e: any) => e.mood).filter(Boolean);
    const causeFreq: Record<string, number> = {};
    for (const e of recent) { const c = (e.cause ?? "").slice(0, 30); if (c) causeFreq[c] = (causeFreq[c] ?? 0) + 1; }
    const valences = recent.map((e: any) => e.valence ?? 0);
    const energies = recent.map((e: any) => e.energy ?? 0);
    return {
      moodDiversity: r2(moods.length ? new Set(moods).size / moods.length : 0),
      dominantCauses: Object.entries(causeFreq).sort(([, a], [, b]) => b - a).slice(0, 3).map(([c]) => c),
      volatility: r2(stddev(valences)),
      avgValence: r2(valences.reduce((a, b) => a + b, 0) / valences.length),
      avgEnergy: r2(energies.reduce((a, b) => a + b, 0) / energies.length),
    };
  } catch { return d; }
}

function buildResponse(sp: string): BehavioralSnapshot["response"] {
  const d = { avgLength: 0, featureUsage: {} as Record<string, number>, qualityTrend: 0, topRelationalPatterns: [] as string[] };
  try {
    const il = readJsonSafe<any>(path.join(sp, "interaction-learning.json"), null);
    if (!il) return d;
    const rm = il.responseMetrics ?? {}, rq: any[] = il.responseQuality ?? [];
    const avgLength = rm.avgLength ?? (rq.length ? r2(rq.reduce((s: number, e: any) => s + (e.depth ?? 0), 0) / rq.length) : 0);
    const featureUsage: Record<string, number> = rm.featureUsage ?? {};
    if (!Object.keys(featureUsage).length && rq.length)
      for (const e of rq) { const t = e.tone ?? "unknown"; featureUsage[t] = (featureUsage[t] ?? 0) + 1; }
    let qualityTrend = rm.qualityTrend ?? 0;
    if (qualityTrend === 0 && rq.length >= 4) {
      const h = Math.floor(rq.length / 2);
      const a1 = rq.slice(0, h).reduce((s: number, e: any) => s + (e.relevance ?? 0), 0) / h;
      const a2 = rq.slice(h).reduce((s: number, e: any) => s + (e.relevance ?? 0), 0) / (rq.length - h);
      qualityTrend = r2(a2 - a1);
    }
    const patterns: any[] = il.patterns ?? il.relationalPatterns ?? [];
    return { avgLength, featureUsage, qualityTrend, topRelationalPatterns: patterns.slice(0, 5).map((p: any) => p.pattern ?? String(p)) };
  } catch { return d; }
}

function buildProactive(sp: string): BehavioralSnapshot["proactive"] {
  const d = { replyRate: 0, bestTiming: "unknown", worstTiming: "unknown", topicEngagement: {} as Record<string, number>, dailyAvg: 0 };
  try {
    const il = readJsonSafe<any>(path.join(sp, "interaction-learning.json"), null);
    if (!il) return d;
    const signals: any[] = il.signals ?? il.proactiveHistory ?? [];
    if (!signals.length) return d;
    const sent = signals.filter((s: any) => s.type === "proactive_sent");
    const replied = signals.filter((s: any) => s.type === "proactive_replied");
    const replyRate = sent.length ? r2(replied.length / sent.length) : 0;
    const bk: Record<string, { s: number; r: number }> = {};
    for (const s of signals) {
      const b = s.hourBucket ?? "unknown";
      if (!bk[b]) bk[b] = { s: 0, r: 0 };
      if (s.type === "proactive_sent") bk[b].s++;
      if (s.type === "proactive_replied") bk[b].r++;
    }
    let bestTiming = "unknown", worstTiming = "unknown", bestR = -1, worstR = 2;
    for (const [b, st] of Object.entries(bk)) {
      if (!st.s) continue;
      const rate = st.r / st.s;
      if (rate > bestR) { bestR = rate; bestTiming = b; }
      if (rate < worstR) { worstR = rate; worstTiming = b; }
    }
    const topicEngagement: Record<string, number> = {};
    for (const tp of (il.topicPreferences ?? []).slice(0, 10)) topicEngagement[tp.topic] = tp.engagementScore ?? 0;
    const days = new Set(sent.map((s: any) => s.timestamp ? new Date(s.timestamp).toISOString().slice(0, 10) : ""));
    days.delete("");
    return { replyRate, bestTiming, worstTiming, topicEngagement, dailyAvg: days.size ? r2(sent.length / days.size) : 0 };
  } catch { return d; }
}

function buildNarrative(sp: string): BehavioralSnapshot["narrative"] {
  const d = { currentSelfSense: null as string | null, themeTrajectories: [] as string[], openQuestions: [] as string[], staleDays: -1 };
  try {
    const sn = readJsonSafe<any>(path.join(sp, "self-narrative.json"), null);
    if (!sn) return d;
    const cur = sn.current ?? sn; // nested { current: { ... } } or flat
    const upd = cur.generatedAt ?? sn.lastAttemptAt ?? sn.updatedAt ?? 0;
    return {
      currentSelfSense: cur.currentSelfSense ?? cur.currentSense ?? null,
      themeTrajectories: (cur.recurringThemes ?? cur.themes ?? []).map((t: any) => typeof t === "string" ? t : t.theme ?? t.name ?? String(t)),
      openQuestions: cur.openQuestions ?? [],
      staleDays: upd > 0 ? Math.floor((Date.now() - upd) / 86_400_000) : -1,
    };
  } catch { return d; }
}

function buildErrors(sp: string): BehavioralSnapshot["errors"] | undefined {
  try {
    const em = readJsonSafe<any>(path.join(sp, "error-metrics.json"), null);
    if (!em?.counters) return undefined;
    const entries = Object.entries(em.counters as Record<string, number>).map(([key, count]) => ({ key, count }));
    return { topErrors: entries.sort((a, b) => b.count - a.count).slice(0, 10), totalCount: entries.reduce((s, e) => s + e.count, 0) };
  } catch { return undefined; }
}

// ── Public API ───────────────────────────────────────────────────────

export function generateSnapshot(statePath: string): BehavioralSnapshot {
  return {
    generatedAt: Date.now(), dateStr: pstDateStr(),
    values: buildValues(statePath), emotion: buildEmotion(statePath),
    response: buildResponse(statePath), proactive: buildProactive(statePath),
    narrative: buildNarrative(statePath), errors: buildErrors(statePath),
  };
}

export function saveSnapshot(statePath: string, snapshot: BehavioralSnapshot): void {
  writeJsonAtomic(path.join(statePath, "behavioral-snapshots", `${snapshot.dateStr}.json`), snapshot);
}

export function diffSnapshots(a: BehavioralSnapshot, b: BehavioralSnapshot): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const cmp = (key: string, va: unknown, vb: unknown) => { if (va !== vb) diff[key] = { before: va, after: vb }; };
  cmp("values.candidateCount", a.values.candidateCount, b.values.candidateCount);
  cmp("values.emergingCount", a.values.emergingCount, b.values.emergingCount);
  cmp("values.committedCount", a.values.committedCount, b.values.committedCount);
  cmp("emotion.avgValence", a.emotion.avgValence, b.emotion.avgValence);
  cmp("emotion.avgEnergy", a.emotion.avgEnergy, b.emotion.avgEnergy);
  cmp("emotion.volatility", a.emotion.volatility, b.emotion.volatility);
  cmp("emotion.moodDiversity", a.emotion.moodDiversity, b.emotion.moodDiversity);
  cmp("response.qualityTrend", a.response.qualityTrend, b.response.qualityTrend);
  cmp("response.avgLength", a.response.avgLength, b.response.avgLength);
  cmp("proactive.replyRate", a.proactive.replyRate, b.proactive.replyRate);
  cmp("proactive.dailyAvg", a.proactive.dailyAvg, b.proactive.dailyAvg);
  cmp("proactive.bestTiming", a.proactive.bestTiming, b.proactive.bestTiming);
  cmp("narrative.staleDays", a.narrative.staleDays, b.narrative.staleDays);
  cmp("narrative.currentSelfSense", a.narrative.currentSelfSense, b.narrative.currentSelfSense);
  cmp("errors.totalCount", a.errors?.totalCount ?? 0, b.errors?.totalCount ?? 0);
  return diff;
}

export function formatSnapshotSummary(s: BehavioralSnapshot): string {
  const L: string[] = [];
  const p = (t: string) => L.push(t);
  p(`Behavioral Snapshot ${s.dateStr}`); p("");
  p(`[Values] Candidate ${s.values.candidateCount} / Emerging ${s.values.emergingCount} / Committed ${s.values.committedCount}`);
  const dom = Object.entries(s.values.domainDistribution);
  if (dom.length) p(`  Domains: ${dom.map(([d, n]) => `${d}(${n})`).join(", ")}`);
  if (s.values.promotionHistory || s.values.decommitHistory) p(`  History: promoted ${s.values.promotionHistory}, decommitted ${s.values.decommitHistory}`);
  p("");
  p(`[Emotion (7d)] Valence ${s.emotion.avgValence}, Energy ${s.emotion.avgEnergy}, Volatility ${s.emotion.volatility}, Diversity ${s.emotion.moodDiversity}`);
  if (s.emotion.dominantCauses.length) p(`  Causes: ${s.emotion.dominantCauses.join(" / ")}`);
  p("");
  p(`[Response Quality] Trend ${s.response.qualityTrend >= 0 ? "+" : ""}${s.response.qualityTrend}`);
  if (s.response.topRelationalPatterns.length) p(`  Relational patterns: ${s.response.topRelationalPatterns.join("; ")}`);
  p("");
  p(`[Proactive] Reply rate ${(s.proactive.replyRate * 100).toFixed(0)}%, daily avg ${s.proactive.dailyAvg}`);
  p(`  Best timing: ${s.proactive.bestTiming}, worst: ${s.proactive.worstTiming}`);
  const tt = Object.entries(s.proactive.topicEngagement).slice(0, 3);
  if (tt.length) p(`  Topics: ${tt.map(([t, v]) => `${t}(${v})`).join(", ")}`);
  p("");
  p(s.narrative.currentSelfSense ? `[Self-narrative] ${s.narrative.currentSelfSense}` : "[Self-narrative] (none yet)");
  if (s.narrative.themeTrajectories.length) p(`  Themes: ${s.narrative.themeTrajectories.join(", ")}`);
  if (s.narrative.openQuestions.length) p(`  Open questions: ${s.narrative.openQuestions.join("; ")}`);
  if (s.narrative.staleDays >= 0) p(`  Days since update: ${s.narrative.staleDays}`);
  if (s.errors && s.errors.totalCount > 0) {
    p(""); p(`[Errors] Total ${s.errors.totalCount}`);
    for (const e of s.errors.topErrors.slice(0, 5)) p(`  ${e.key}: ${e.count}`);
  }
  return L.join("\n");
}
