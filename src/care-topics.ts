/**
 * Care Topics — proactively gather resources for the user.
 *
 * Detects concrete needs expressed in conversation (find tutorials, recommendations, etc.),
 * stores them, searches via curiosity, and shares naturally through proactive messaging.
 *
 * Lifecycle: pending → found → shared → followed_up | expired
 */

import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";

// ── Types ────────────────────────────────────────────────────────────

export interface CareTopic {
  id: string;                // "care_1772900000000_a3f2"
  need: string;              // "找架子鼓基本功教程"
  sourceSnippet: string;     // user's original words
  searchQueries: string[];   // ["drum rudiments tutorial beginner", "架子鼓基本功教程 YouTube"]
  status: "pending" | "found" | "shared" | "followed_up" | "expired"
        | "active" | "lingering" | "resolved";
  priority: "high" | "medium";
  createdAt: number;
  searchAttempts: number;
  lastSearchedAt?: number;
  foundAt?: number;
  sharedAt?: number;
  followedUpAt?: number;
  discoveryId?: string;
  context?: string;          // contextual note about why user needs this

  // Emotional care fields (flat, backward-compatible)
  domain?: "resource" | "emotional";
  emotionalWeight?: number;              // 0-1
  careCommitment?: number;               // 0-1, decision to keep carrying this
  whyItMatters?: string;                 // one-sentence from character's perspective
  lastReflectedAt?: number;              // last heartbeat reflection that touched this
  lastMentionedAt?: number;              // last proactive/conversation mention
  lastCareAction?: "remembered" | "reflected" | "reframed" | "mentioned";
}

// ── Module state ─────────────────────────────────────────────────────

let _statePath = "";
let _topics: CareTopic[] = [];

function getFilePath(): string {
  return path.join(_statePath, "care-topics.json");
}

function load(): void {
  _topics = readJsonSafe<CareTopic[]>(getFilePath(), []);
}

function save(): void {
  writeJsonAtomic(getFilePath(), _topics);
}

// ── Init ─────────────────────────────────────────────────────────────

export function initCareTopics(statePath: string): void {
  _statePath = statePath;
  load();
  expireStaleCareTopics();
  const pending = _topics.filter(t => t.status === "pending").length;
  const found = _topics.filter(t => t.status === "found").length;
  console.log(`[care-topics] Initialized: ${_topics.length} total (${pending} pending, ${found} found)`);
}

// ── Keyword extraction ───────────────────────────────────────────────

const STOP_KEYWORDS = new Set([
  "教程", "推荐", "资料", "学习", "怎么", "什么", "好的",
  "一下", "找找", "看看", "不错", "哪里", "哪个", "有没有",
]);

export function extractKeywords(text: string): string[] {
  const keywords: string[] = [];
  // English words
  const engWords = text.match(/[a-zA-Z]{2,}/g) ?? [];
  keywords.push(...engWords.map(w => w.toLowerCase()));
  // Chinese: continuous segments, split into 2-3 char ngrams
  const cnSegments = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const seg of cnSegments) {
    if (seg.length <= 3) { keywords.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) {
      keywords.push(seg.slice(i, i + 2));
      if (i + 3 <= seg.length) keywords.push(seg.slice(i, i + 3));
    }
  }
  return [...new Set(keywords)]
    .map(kw => kw.toLowerCase())
    .filter(kw => !STOP_KEYWORDS.has(kw));
}

// ── Dedup ────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.replace(/[，。！？、；：""''（）\s]+/g, " ").trim().toLowerCase();
}

function isDuplicate(need: string): boolean {
  const normNew = normalize(need);
  if (normNew.length < 3) return false;
  const kwsNew = extractKeywords(need);
  if (kwsNew.length === 0) return false;

  return _topics.some(t => {
    if (t.status === "expired") return false;
    const kwsExisting = extractKeywords(t.need);
    if (kwsExisting.length === 0) return false;
    const intersection = kwsNew.filter(kw => kwsExisting.includes(kw));
    const smaller = Math.min(kwsNew.length, kwsExisting.length);
    return intersection.length / smaller > 0.6;
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────

export function addCareTopic(opts: {
  need: string;
  sourceSnippet: string;
  searchQueries: string[];
  context?: string;
  priority?: "high" | "medium";
}): CareTopic | null {
  expireStaleCareTopics();
  if (isDuplicate(opts.need)) {
    console.log(`[care-topics] Skipped duplicate: "${opts.need}"`);
    return null;
  }

  const topic: CareTopic = {
    id: `care_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    need: opts.need,
    sourceSnippet: opts.sourceSnippet,
    searchQueries: opts.searchQueries,
    status: "pending",
    priority: opts.priority ?? "medium",
    createdAt: Date.now(),
    searchAttempts: 0,
    context: opts.context,
  };

  _topics.push(topic);
  save();
  console.log(`[care-topics] Added: "${topic.need}" (priority=${topic.priority})`);
  return topic;
}

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

export function getPendingCareTopics(): CareTopic[] {
  expireStaleCareTopics();
  const now = Date.now();
  return _topics
    .filter(t =>
      t.status === "pending" &&
      (!t.lastSearchedAt || now - t.lastSearchedAt >= TWELVE_HOURS),
    )
    .sort((a, b) => {
      // priority desc (high > medium)
      if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
      // searchAttempts asc
      if (a.searchAttempts !== b.searchAttempts) return a.searchAttempts - b.searchAttempts;
      // createdAt desc (newest first)
      return b.createdAt - a.createdAt;
    });
}

export function getFoundCareTopics(): CareTopic[] {
  expireStaleCareTopics();
  return _topics.filter(t => t.status === "found");
}

export function markFound(id: string, discoveryId: string): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic) return;
  topic.searchAttempts++;
  topic.lastSearchedAt = Date.now();
  topic.status = "found";
  topic.foundAt = Date.now();
  topic.discoveryId = discoveryId;
  save();
  console.log(`[care-topics] Found resources for: "${topic.need}"`);
}

export function markSearched(id: string): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic) return;
  topic.searchAttempts++;
  topic.lastSearchedAt = Date.now();
  save();
  console.log(`[care-topics] Searched (no quality match): "${topic.need}" (attempts=${topic.searchAttempts})`);
}

export function markShared(id: string): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic || topic.status !== "found") return;
  topic.status = "shared";
  topic.sharedAt = Date.now();
  save();
  console.log(`[care-topics] Shared with user: "${topic.need}"`);

  // Auto-close matching commitment memories
  try {
    const { getStoreManager } = require("./memory/store-manager.js");
    const manager = getStoreManager();
    const commitments = manager.loadCategory("commitment");
    const needKws = extractKeywords(topic.need);
    for (const m of commitments) {
      if (!m.value.includes("状态: open")) continue;
      const valLower = m.value.toLowerCase();
      const hits = needKws.filter(kw => valLower.includes(kw));
      if (hits.length >= 2 || hits.some(h => h.length >= 4)) {
        const updated = m.value.replace("状态: open", "状态: done");
        manager.set(m.key, updated, m.confidence);
        console.log(`[care-topics] Auto-closed commitment: "${m.key}"`);
      }
    }
  } catch { /* non-fatal — commitment module may not be ready */ }
}

export function markFollowedUp(id: string): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic || topic.status !== "shared") return;
  topic.status = "followed_up";
  topic.followedUpAt = Date.now();
  save();
  console.log(`[care-topics] Followed up: "${topic.need}" (terminal)`);
}

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

export function getShareFollowUps(): CareTopic[] {
  expireStaleCareTopics();
  const now = Date.now();
  return _topics.filter(t =>
    t.status === "shared" && t.sharedAt && now - t.sharedAt >= TWO_DAYS,
  );
}

// ── Emotional Care CRUD ──────────────────────────────────────────────

const MAX_EMOTIONAL_PER_DAY = 2;

export function addEmotionalCareTopic(opts: {
  need: string;
  sourceSnippet: string;
  whyItMatters: string;
  emotionalWeight?: number;
  context?: string;
}): CareTopic | null {
  // Rate limit: max 2 emotional per day
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todayCount = _topics.filter(t =>
    t.domain === "emotional" && t.createdAt >= todayStart
  ).length;
  if (todayCount >= MAX_EMOTIONAL_PER_DAY) return null;

  // Dedup (reuse existing isDuplicate)
  if (isDuplicate(opts.need)) return null;

  const topic: CareTopic = {
    id: `care_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    need: opts.need,
    sourceSnippet: opts.sourceSnippet,
    searchQueries: [],          // emotional care doesn't search
    status: "active",           // starts active, not pending
    priority: "high",
    createdAt: Date.now(),
    searchAttempts: 0,
    context: opts.context,
    domain: "emotional",
    emotionalWeight: opts.emotionalWeight ?? 0.5,
    careCommitment: 0.5,        // initial commitment, reflection adjusts
    whyItMatters: opts.whyItMatters,
  };

  _topics.push(topic);
  save();
  console.log(`[care-topics] Added emotional: "${topic.need}" (weight=${topic.emotionalWeight})`);
  return topic;
}

export function getActiveEmotionalCare(): CareTopic[] {
  return _topics.filter(t =>
    t.domain === "emotional" &&
    (t.status === "active" || t.status === "lingering")
  );
}

export function getResurfacingCandidates(): Array<CareTopic & { readiness: number }> {
  const now = Date.now();
  return getActiveEmotionalCare()
    .map(t => {
      const daysSinceMention = (now - (t.lastMentionedAt ?? t.createdAt)) / (24 * 60 * 60 * 1000);
      if (daysSinceMention < 2) return { ...t, readiness: 0 }; // too soon
      const timeFactor = Math.min(1, daysSinceMention / 5);     // peaks at 5 days
      const readiness = Math.min(1,
        0.4 * timeFactor +
        0.3 * (t.careCommitment ?? 0.5) +
        0.3 * (t.emotionalWeight ?? 0.5)
      );
      return { ...t, readiness };
    })
    .filter(t => t.readiness >= 0.4)
    .sort((a, b) => b.readiness - a.readiness);
}

export function logCareAction(id: string, type: "remembered" | "reflected" | "reframed" | "mentioned", ts: number): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic) return;
  topic.lastCareAction = type;
  if (type === "mentioned") topic.lastMentionedAt = ts;
  if (type === "reflected") topic.lastReflectedAt = ts;
  save();
}

export function updateCareCommitment(id: string, commitment: number): void {
  const topic = _topics.find(t => t.id === id);
  if (!topic) return;
  topic.careCommitment = Math.max(0, Math.min(1, commitment));
  save();
}

function decayEmotionalCare(): void {
  const now = Date.now();
  let changed = false;
  for (const t of _topics) {
    if (t.domain !== "emotional") continue;
    const lastTouch = Math.max(t.lastMentionedAt ?? 0, t.lastReflectedAt ?? 0, t.createdAt);
    const daysSinceTouch = (now - lastTouch) / (24 * 60 * 60 * 1000);
    if (t.status === "active" && daysSinceTouch > 14) {
      t.status = "lingering";
      changed = true;
    } else if (t.status === "lingering" && daysSinceTouch > 21) {
      t.status = "resolved";
      changed = true;
    }
  }
  if (changed) save();
}

// ── Expiration ───────────────────────────────────────────────────────

const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;

export function expireStaleCareTopics(): void {
  const now = Date.now();
  let changed = false;

  for (const topic of _topics) {
    if (topic.status !== "pending") continue;
    if (now - topic.createdAt > FOURTEEN_DAYS || topic.searchAttempts >= 3) {
      topic.status = "expired";
      changed = true;
      console.log(`[care-topics] Expired: "${topic.need}" (age=${Math.round((now - topic.createdAt) / 86400000)}d, attempts=${topic.searchAttempts})`);
    }
  }

  if (changed) save();

  // Decay emotional care topics: active → lingering → resolved
  decayEmotionalCare();
}
