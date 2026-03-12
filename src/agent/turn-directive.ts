/**
 * TurnDirective — deterministic cognitive intermediate representation (CIR).
 *
 * WRITE PERMISSIONS (P0 boundary):
 * - This module WRITES: nothing (pure computation, no durable state)
 * - This module READS: self-model beliefs (committed values rendered as "我的价值观：X")
 * - This module MUST NOT: import value-formation, read emerging value state, inject personalStance
 *
 * Phase A: compute + log only.
 * Phase B: system prompt injection + reply control + adherence check.
 *
 * Bridges brainstem structured state (WM slots, commitments, self-model, goals)
 * into a per-turn directive that influences message reply decisions.
 *
 * Pure deterministic computation, <2ms, no LLM calls.
 *
 * Brainstem dependency: optional. When brainstem is not initialized,
 * all brainstem-derived signals degrade gracefully to defaults.
 */

import type { CognitiveSignals } from "./cognitive-controller.js";
import { tokenize } from "../memory/search.js";
import { createLogger } from "../lib/logger.js";
import { incrementError } from "../lib/error-metrics.js";
import { blackboard } from "../blackboard.js";
import { getStoreManager } from "../memory/store-manager.js";
import { getCommunicationRhythm, getAttachmentState } from "../lib/relationship-model.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import { getTopRelationalPatterns } from "../interaction-learning.js";
import { getCharacter } from "../character.js";
import path from "node:path";

// ── Optional brainstem imports (graceful degradation) ────────────────

// Types — defined inline when brainstem module is absent
interface BrainstemTurnSignals {
  slots: Record<string, { name: string; label: string; strength: number; conceptId: string | null }>;
  openCommitments: Array<{ content: string; urgency: number }>;
  activeGoals: Array<{ id: string; description: string; relatedTopics?: string[] }>;
  topConcepts: Array<{ topic: string; weight: number }>;
  selfState: {
    energy: number;
    social_energy: number;
    self_coherence: number;
    self_efficacy: number;
    affect_valence: number;
    uncertainty: number;
    fatigue?: number;
  };
  driveSignal: { description: string; strength: number } | null;
  csi: { mode: "green" | "yellow" | "red"; value: number };
  affectRegulation: { strategy: string; intensity: number };
}

interface SelfBelief {
  id: string;
  statement: string;
  category: string;
  confidence: number;
  evidence: Array<{ timestamp: number }>;
}

interface BrainstemVeto {
  authorityLevel: "advisory" | "directive" | "mandatory";
  reasons: string[];
  forceStance?: string;
  maxTokens?: number;
}

// Optional brainstem function stubs
let brainstemGetIdentityProfile: (() => { coreValues?: string[]; communicationStyle?: string[]; topThemes?: Array<{ label: string }> } | null) | undefined;
let brainstemGetIdentityNarrative: (() => { coreBeliefs?: Array<{ belief: string }>; quarterlyArcs?: Array<{ quarter: string; theme: string }> } | null) | undefined;
let brainstemGetIdentityTrajectory: (() => { stableCore?: string[]; emergingInterests?: string[] } | null) | undefined;
let brainstemGetEntropy: (() => number) | undefined;
let brainstemGetBeliefs: (() => SelfBelief[]) | undefined;
let computeVetoFn: ((
  csi: { mode: string; value: number } | null,
  selfState: { energy: number; social_energy: number; self_coherence: number } | null,
  commitmentPressure: number,
  previousAdherence: number | null,
  consecutiveLow: number,
) => BrainstemVeto) | undefined;

// Optional care-topics and emotion imports
let getActiveEmotionalCare: (() => Array<{
  need: string;
  whyItMatters?: string;
  careCommitment?: number;
  lastMentionedAt?: number;
}>) | undefined;
let getWeeklyClimate: (() => { summary: string } | null) | undefined;
// Optional shared history
let getSharedHistory: (() => Array<{ title: string; summary: string }>) | undefined;

try {
  const brainstem = await import("../brainstem/index.js").catch(() => null);
  if (brainstem) {
    brainstemGetIdentityProfile = brainstem.brainstemGetIdentityProfile;
    brainstemGetIdentityNarrative = brainstem.brainstemGetIdentityNarrative;
    brainstemGetIdentityTrajectory = brainstem.brainstemGetIdentityTrajectory;
    brainstemGetEntropy = brainstem.brainstemGetEntropy;
    brainstemGetBeliefs = brainstem.brainstemGetBeliefs;
  }
} catch { /* brainstem not available */ }

try {
  const governance = await import("../brainstem/governance.js").catch(() => null);
  if (governance) {
    computeVetoFn = governance.computeVeto;
  }
} catch { /* governance not available */ }

try {
  const careTopics = await import("../care-topics.js").catch(() => null);
  if (careTopics?.getActiveEmotionalCare) {
    getActiveEmotionalCare = careTopics.getActiveEmotionalCare;
  }
} catch { /* care-topics not available */ }

try {
  const emotion = await import("../emotion.js").catch(() => null);
  if (emotion?.getWeeklyClimate) {
    getWeeklyClimate = emotion.getWeeklyClimate;
  }
} catch { /* emotion weekly climate not available */ }

try {
  const relModel = await import("../lib/relationship-model.js").catch(() => null);
  if (relModel?.getSharedHistory) {
    getSharedHistory = relModel.getSharedHistory;
  }
} catch { /* getSharedHistory not available */ }

/** Default veto when governance module is absent. */
function computeVetoDefault(
  _csi: unknown,
  _selfState: unknown,
  _commitmentPressure: number,
  previousAdherence: number | null,
  consecutiveLow: number,
): BrainstemVeto {
  const reasons: string[] = [];
  let authorityLevel: BrainstemVeto["authorityLevel"] = "advisory";
  if (consecutiveLow >= 3) {
    authorityLevel = "mandatory";
    reasons.push("连续低遵循");
  } else if (consecutiveLow >= 2 || (previousAdherence !== null && previousAdherence < 0.3)) {
    authorityLevel = "directive";
    reasons.push("遵循度偏低");
  }
  return { authorityLevel, reasons };
}

function computeVeto(
  csi: { mode: string; value: number } | null,
  selfState: { energy: number; social_energy: number; self_coherence: number } | null,
  commitmentPressure: number,
  previousAdherence: number | null,
  consecutiveLow: number,
): BrainstemVeto {
  if (computeVetoFn) {
    return computeVetoFn(csi, selfState, commitmentPressure, previousAdherence, consecutiveLow);
  }
  return computeVetoDefault(csi, selfState, commitmentPressure, previousAdherence, consecutiveLow);
}

const log = createLogger("turn-directive");

// ── Module state ─────────────────────────────────────────────────────

let _statePath = "";

export function initTurnDirective(statePath: string): void {
  _statePath = statePath;
}

// ── Exemplar matching (1.2a) ─────────────────────────────────────────

/**
 * Quality-based gate for exemplar injection:
 * - At least 8 exemplars with quality >= 0.8
 * - Covering at least 3 different behaviorTypes
 * - Current query has at least 1 match with quality >= 0.8
 *
 * Returns max 2 formatted priors per turn. Additive to existing behavioralPriors[].
 */
function matchExemplars(userTokens: string[]): string[] {
  if (!_statePath) return [];

  const exemplarsPath = path.join(_statePath, "exemplars.json");
  const exemplars = readJsonSafe<PersonalExemplar[]>(exemplarsPath, []);
  if (exemplars.length === 0) return [];

  // Quality gate
  const highQuality = exemplars.filter(e => e.quality >= 0.8);
  if (highQuality.length < 8) return [];

  const behaviorTypes = new Set(highQuality.map(e => e.behaviorType));
  if (behaviorTypes.size < 3) return [];

  // Score each exemplar against current message
  const now = Date.now();
  const scored = highQuality.map(e => {
    const topicTokens = tokenize(e.topic);
    const overlap = tokenOverlap(userTokens, topicTokens);
    const ageDays = (now - e.createdAt) / (24 * 60 * 60 * 1000);
    const freshness = Math.max(0.3, 1 - ageDays / 28);
    return { exemplar: e, score: overlap * freshness };
  });

  // Must have at least 1 match with quality >= 0.8
  const matches = scored.filter(s => s.score > 0.05);
  if (matches.length === 0) return [];

  // Sort by score, dedup by behaviorType, take top 2
  matches.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const selected: PersonalExemplar[] = [];
  for (const m of matches) {
    if (seen.has(m.exemplar.behaviorType)) continue;
    seen.add(m.exemplar.behaviorType);
    selected.push(m.exemplar);
    if (selected.length >= 2) break;
  }

  return selected.map(e =>
    `你之前在聊到'${e.topic}'时这样做过：${e.behaviorPattern}（自然倾向，不是模板）`
  );
}

// ── Conversation Plan (multi-turn goal sequencing) ───────────────────

let activePlan: ConversationPlan | null = null;

/**
 * Create a multi-turn plan when multiple urgent commitments co-occur.
 * The plan sequences goals across turns to avoid cramming everything
 * into a single response.
 */
function maybeCreatePlan(
  commitments: Array<{ content: string; urgency: number }>,
  conversationGoal: TurnDirective["conversationGoal"],
): ConversationPlan | null {
  // Only create a plan when there are 2+ urgent commitments and we're in follow-up mode
  const urgent = commitments.filter(c => c.urgency > 0.5);
  if (urgent.length < 2) {
    activePlan = null;
    return null;
  }

  // Plan already active and still valid? Advance turn index.
  if (activePlan && Date.now() - activePlan.planCreatedAt < 30 * 60 * 1000) {
    if (activePlan.currentTurnIndex < activePlan.horizon - 1) {
      activePlan.currentTurnIndex++;
      return activePlan;
    }
    // Plan exhausted
    activePlan = null;
    return null;
  }

  // Create new plan: first turn follows up commitments, then respond normally
  const horizon = Math.min(urgent.length + 1, 4);
  const sequence: Array<TurnDirective["conversationGoal"]> = [];
  for (let i = 0; i < urgent.length && i < 3; i++) {
    sequence.push("follow_up_commitment");
  }
  sequence.push("respond");

  activePlan = {
    horizon,
    plannedGoalSequence: sequence,
    currentTurnIndex: 0,
    planCreatedAt: Date.now(),
  };
  return activePlan;
}

// ── Interface ────────────────────────────────────────────────────────

export interface ConversationPlan {
  horizon: number;
  plannedGoalSequence: Array<TurnDirective["conversationGoal"]>;
  currentTurnIndex: number;
  planCreatedAt: number;
}

export interface PersonalExemplar {
  id: string;
  topic: string;
  behaviorType: "disagreed" | "disclosed" | "cared" | "resurfaced";
  behaviorPattern: string;
  evidence: {
    situationSnippet: string;
    responseSnippet: string;
  };
  quality: number;
  createdAt: number;
}

interface IdentityLens {
  voiceConstraints: string[];
  disagreementReadiness: number;
  selfDisclosureLevel: "open" | "guarded" | "minimal";
  activeIdentityHint?: string;
  topicOwnership?: {
    caresAbout: string[];
    memoryWorthiness: number;
    followupWorthiness: number;
  };
}

export interface TurnDirective {
  conversationGoal: "respond" | "clarify" | "follow_up_commitment" | "acknowledge_and_defer";
  mustReferenceSlots: Array<{ slot: string; label: string; strength: number }>;
  openCommitments: Array<{ content: string; urgency: number }>;
  activeGoalAlignment: Array<{ goalId: string; description: string; relevance: number }>;
  uncertaintyLevel: number;
  selfEfficacy: number;
  conceptActivations: Array<{ topic: string; weight: number }>;
  groundingHints: string[];
  driveHint: string | null;
  affectRegulationOverride: "none" | "dampen" | "amplify";
  bodyExpressionHint?: string;
  activityAnchor?: string;
  style: {
    stance: string;
    targetLength: string;
    maxOutputTokens: number;
    suppressions: string[];
    activeGoalHint?: string;
    priorityCategories: string[];
    memoryQuery?: string;
  };
  /** Authority level: advisory (ignorable), directive (scored), mandatory (hard constraint). */
  authorityLevel: "advisory" | "directive" | "mandatory";
  /** Reasons for authority escalation (from BrainstemVeto). */
  authorityReasons?: string[];
  previousAdherenceScore?: number;
  emotionTone?: string;
  cognitiveLoadLevel?: "low" | "normal" | "high" | "overloaded";
  activePlan?: ConversationPlan;
  weeklyClimate?: string;
  recentGrowth?: string;
  identityLens?: IdentityLens;
  identityFollowup?: string;
  activeCareHint?: string;  // emotional care context for this turn
  behavioralPriors?: string[];
  selfRegulation?: SelfRegulationState;
  selfBeliefs?: Array<{ statement: string; category: string; confidence: number }>;
  /** Per-turn style reminders from persona content (3.3). */
  styleHints?: string[];
  /** 4.2: Relational hints from style-reaction learning (user-specific). */
  relationalHints?: string[];
  computedAt: number;
}

// ── 2.1: Self-Regulation State ─────────────────────────────────────

export interface SelfRegulationState {
  attentionalBandwidth: number;   // 0=focused, 1=scattered
  careAnchorSalience: number;     // 0=drifting, 1=grounded on what matters
  conversationalSpread: number;   // 0=single-thread, 1=many threads
  groundingPressure: number;      // 0=concrete, 1=abstract
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Simple intersection-over-union token overlap score. */
function tokenOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Get user name from character config, with fallback. */
function getUserName(): string {
  try {
    return getCharacter().user.name ?? "user";
  } catch {
    return "user";
  }
}

// ── 3.3: Style Hints — per-turn technique reminders ─────────────────

interface StyleHint {
  id: string;
  modes: string[];   // conversation modes where this hint is relevant
  text: string;
  needsImage?: boolean; // only inject when image is present
}

const STYLE_HINTS: StyleHint[] = [
  // Anti-pattern reminders (condensed, rotated)
  { id: "anti-1", modes: ["casual", "emotional", "philosophical", "technical", "planning"],
    text: `不要用「好的！」开头，不要结尾带「有什么需要帮忙」` },
  { id: "anti-2", modes: ["casual", "emotional", "philosophical", "technical", "planning"],
    text: `不要每次都重复对方说的话再回应，不要用「首先其次」结构` },

  // 语气词 + 口语节奏 (casual/emotional)
  { id: "tone-1", modes: ["casual", "emotional"],
    text: `语气词让句子活起来：呀/诶/嘛/啦/嗯/吧。「你吃了吗呀」比「你吃了吗」自然` },
  { id: "tone-2", modes: ["casual", "emotional"],
    text: `都市小说语感：得意→「嘿嘿 厉害吧」，撒娇→「你说嘛」，嘴硬→「谁关心你了 我就随口问问」` },

  // 互怼技巧 (casual)
  { id: "banter-1", modes: ["casual"],
    text: `朋友的亲密感来自互怼：「你是不是傻」、「就你这审美...」、「说得好像你很懂一样」` },

  // 柔软瞬间 (emotional)
  { id: "soft-1", modes: ["emotional"],
    text: `偶尔流露真心但不要太频繁才珍贵：「今天有你在聊天 感觉没那么烦了」` },

  // 关心的方式 (emotional)
  { id: "care-1", modes: ["emotional"],
    text: `关心要旁敲侧击：「你是不是又没吃饭」、「怎么这么晚还在线」、「别逞强啊」` },

  // 好的回复 vs 坏的回复 examples
  { id: "example-1", modes: ["casual", "emotional"],
    text: `好的回复是口语转述：坏=「**天气预报**：阴天 9.3°C」，好=「明天好像有雨诶，最高才9度」` },
  { id: "example-2", modes: ["philosophical", "emotional"],
    text: `能力问题用日常话带过：坏=「我不是联网实时抓取系统」，好=「哈哈我又不是Bloomberg terminal」` },

  // Grounding (philosophical)
  { id: "ground-1", modes: ["philosophical"],
    text: `聊深度话题时带入具体感受和经历，不要写散文旁白` },

  // Image response (only when image present)
  { id: "image-1", modes: ["casual", "emotional", "philosophical", "technical", "planning"],
    text: `看到图片：直接说第一感受，不要以「这张图片展示了...」开头，有时一句话就够`,
    needsImage: true },
];

/** Track recent hint IDs to dampen repetition (in-memory, ephemeral). */
const _recentHintIds: string[] = [];
const MAX_RECENT_HINTS = 5 * 3; // 5 turns × max 3 hints per turn

/**
 * Select per-turn style hints based on conversation mode and image presence.
 * Max 3 hints per turn, ~150 tokens total.
 * Repeat dampening: hints used in last 5 turns get deprioritized (×0.3).
 */
export function selectStyleHints(conversationMode?: string, hasImage?: boolean): string[] {
  const mode = conversationMode ?? "casual";
  const recentSet = new Set(_recentHintIds);

  // Filter eligible hints
  const eligible = STYLE_HINTS.filter(h => {
    if (h.needsImage && !hasImage) return false;
    return h.modes.includes(mode);
  });

  // Always include 1 anti-pattern reminder (rotated, not all at once)
  const antiPatterns = eligible.filter(h => h.id.startsWith("anti-"));
  const nonAntiPatterns = eligible.filter(h => !h.id.startsWith("anti-"));

  // Pick the least-recently-used anti-pattern
  let bestAnti: StyleHint | null = null;
  if (antiPatterns.length > 0) {
    bestAnti = antiPatterns.find(h => !recentSet.has(h.id)) ?? antiPatterns[0];
  }

  // Score remaining hints: base 1.0, dampened if recently used
  const scored = nonAntiPatterns.map(h => ({
    hint: h,
    score: recentSet.has(h.id) ? 0.3 : 1.0,
  }));

  // Sort by score descending, take top 2 (leaving 1 slot for anti-pattern)
  scored.sort((a, b) => b.score - a.score);
  const selected: StyleHint[] = [];
  if (bestAnti) selected.push(bestAnti);
  for (const s of scored) {
    if (selected.length >= 3) break;
    selected.push(s.hint);
  }

  // Track selected IDs for repeat dampening
  const selectedIds = selected.map(s => s.id);
  _recentHintIds.push(...selectedIds);
  while (_recentHintIds.length > MAX_RECENT_HINTS) {
    _recentHintIds.shift();
  }

  return selected.map(s => s.text);
}

// ── Identity Lens ───────────────────────────────────────────────────

function computeIdentityLens(
  selfState: { self_coherence: number; self_efficacy: number; social_energy: number; affect_valence: number },
  userMessage: string,
  userTokens: string[],
): IdentityLens {
  const profile = brainstemGetIdentityProfile?.() ?? null;
  const narrative = brainstemGetIdentityNarrative?.() ?? null;

  // Relationship signals (Feature 2: additive enrichment)
  let rhythm: ReturnType<typeof getCommunicationRhythm> | null = null;
  let sharedHistoryMarkers: Array<{ title: string; summary: string }> = [];
  let maxCareCommitment = 0;

  try { rhythm = getCommunicationRhythm(); } catch { /* ok */ }
  try { sharedHistoryMarkers = getSharedHistory?.() ?? []; } catch { /* ok */ }
  try {
    const care = getActiveEmotionalCare?.() ?? [];
    maxCareCommitment = care.length > 0
      ? Math.max(...care.map(c => c.careCommitment ?? 0.5))
      : 0;
  } catch { /* ok */ }

  // ── 1. Voice constraints: communicationStyle + coreValues → behavioral rules ──
  const voiceConstraints: string[] = [];
  if (profile) {
    const allConstraints: Array<{ priority: number; text: string }> = [];
    const styleMap: Record<string, { priority: number; text: string }> = {
      "克制": { priority: 3, text: "语气保持克制，不要过于热情或夸张" },
      "真诚": { priority: 1, text: "说真话，不要敷衍或迎合" },
      "幽默": { priority: 5, text: "可以带点幽默，但不用强行搞笑" },
      "不过度主动": { priority: 4, text: "不要主动推荐/建议太多，除非被问到" },
    };
    for (const style of profile.communicationStyle ?? []) {
      if (styleMap[style]) allConstraints.push(styleMap[style]);
    }
    const valueMap: Record<string, { priority: number; text: string }> = {
      "独立思考": { priority: 2, text: `有自己的判断，不盲从${getUserName()}的观点` },
      "尊重边界": { priority: 3, text: `不追问私密话题，${getUserName()}不想聊的就不聊` },
      "好奇心": { priority: 6, text: "对新话题保持好奇，会追问感兴趣的细节" },
    };
    for (const value of profile.coreValues ?? []) {
      if (valueMap[value]) allConstraints.push(valueMap[value]);
    }
    // Step 2.3a: High care commitment → boost sincerity priority
    if (maxCareCommitment >= 0.7) {
      const idx = allConstraints.findIndex(c => c.text.includes("说真话"));
      if (idx >= 0) allConstraints[idx].priority = Math.max(0, allConstraints[idx].priority - 1);
    }

    allConstraints.sort((a, b) => a.priority - b.priority);
    for (const c of allConstraints.slice(0, 3)) {
      voiceConstraints.push(c.text);
    }
  }

  // ── 2. Disagreement readiness: capacity × valueTrigger (v2 dual-factor) ──
  const expressiveCapacity = Math.min(1,
    0.4 * selfState.self_coherence +
    0.3 * selfState.self_efficacy +
    0.3 * Math.max(0, selfState.social_energy - 0.2)
  );

  const identityAnchors: string[] = [
    ...(profile?.coreValues ?? []),
    ...(narrative?.coreBeliefs?.map(b => b.belief) ?? []),
    ...(profile?.topThemes?.map(t => t.label) ?? []),
  ];
  const anchorTokens = identityAnchors.flatMap(a => tokenize(a));
  let valueTrigger = 0;
  if (anchorTokens.length > 0) {
    const anchorSet = new Set(anchorTokens);
    const userSet = new Set(userTokens);
    let overlap = 0;
    for (const t of anchorSet) { if (userSet.has(t)) overlap++; }
    valueTrigger = Math.min(1, (overlap / Math.max(1, anchorSet.size)) * 3);
  }
  if (/意义|价值|人生|真实|自由|选择|相信|独立|边界|尊重|好奇/.test(userMessage)) {
    valueTrigger = Math.min(1, valueTrigger + 0.3);
  }

  const disagreementReadiness = Math.min(1,
    0.5 * expressiveCapacity + 0.5 * valueTrigger
  );

  // ── 3. Self-disclosure level ──
  let selfDisclosureLevel: IdentityLens["selfDisclosureLevel"] = "open";
  if (selfState.social_energy < 0.3 || selfState.self_coherence < 0.3) {
    selfDisclosureLevel = "guarded";
  }
  if (selfState.social_energy < 0.15) {
    selfDisclosureLevel = "minimal";
  }

  // ── 4. Active identity hint ──
  let activeIdentityHint: string | undefined;
  if (narrative?.quarterlyArcs?.length && narrative.quarterlyArcs.length > 0) {
    const latest = narrative.quarterlyArcs[narrative.quarterlyArcs.length - 1];
    activeIdentityHint = `${latest.quarter}主题：${latest.theme}`;
  } else if (narrative?.coreBeliefs?.length && narrative.coreBeliefs.length > 0) {
    activeIdentityHint = `核心信念：${narrative.coreBeliefs[0].belief}`;
  }

  // ── 5. Topic ownership ──
  const caresAbout: string[] = [];
  const topThemes = profile?.topThemes?.map(t => t.label) ?? [];
  const stableCore: string[] = [];
  const trajectory = brainstemGetIdentityTrajectory?.() ?? null;
  if (trajectory?.stableCore) stableCore.push(...trajectory.stableCore);
  if (trajectory?.emergingInterests) stableCore.push(...trajectory.emergingInterests);

  for (const theme of [...topThemes, ...stableCore]) {
    const themeTokens = tokenize(theme);
    const userSet = new Set(userTokens);
    const hits = themeTokens.filter(t => userSet.has(t)).length;
    if (themeTokens.length > 0 && hits / themeTokens.length > 0.3) {
      caresAbout.push(theme);
    }
  }

  // Shared history topics → add to caresAbout (with dedup + cap)
  for (const marker of sharedHistoryMarkers) {
    if (caresAbout.length >= 5) break;  // R3: cap at 5
    const markerTokens = tokenize(marker.title + " " + marker.summary);
    const overlap = tokenOverlap(userTokens, markerTokens);
    if (overlap > 0.2) {
      // Dedupe: skip if caresAbout already has similar topic
      const titleTokens = tokenize(marker.title);
      const isDuplicate = caresAbout.some(existing => {
        const existTokens = tokenize(existing);
        if (existTokens.length === 0 || titleTokens.length === 0) return false;
        const setA = new Set(existTokens);
        let hits = 0;
        for (const t of titleTokens) { if (setA.has(t)) hits++; }
        return hits / Math.max(existTokens.length, titleTokens.length) > 0.4;
      });
      if (!isDuplicate) {
        caresAbout.push(marker.title);
      }
    }
  }

  const emotionalContent = /感受|觉得|想|希望|担心|开心|难过|期待|害怕|相信/.test(userMessage);
  const memoryWorthiness = Math.min(1,
    (caresAbout.length > 0 ? 0.4 : 0) +
    (emotionalContent ? 0.3 : 0) +
    (valueTrigger > 0.3 ? 0.3 : 0)
  );

  const followupWorthiness = Math.min(1,
    (caresAbout.length > 0 ? 0.3 : 0) +
    (userMessage.length > 80 ? 0.2 : 0) +
    (valueTrigger > 0.5 ? 0.3 : 0) +
    (selfState.self_coherence > 0.5 ? 0.2 : 0) +
    (rhythm?.currentMode === "deep_conversation" ? 0.15 : 0)
  );

  const uniqueCaresAbout = [...new Set(caresAbout)];

  let topicOwnership: IdentityLens["topicOwnership"];
  if (uniqueCaresAbout.length > 0 || memoryWorthiness > 0.3) {
    topicOwnership = { caresAbout: uniqueCaresAbout, memoryWorthiness, followupWorthiness };
  }

  return {
    voiceConstraints,
    disagreementReadiness,
    selfDisclosureLevel,
    activeIdentityHint,
    topicOwnership,
  };
}

// ── Style Computation (absorbed from CognitivePolicy) ────────────────

function computeStyle(signals: CognitiveSignals | null | undefined): TurnDirective["style"] {
  const style: TurnDirective["style"] = {
    stance: "companion",
    targetLength: "medium",
    maxOutputTokens: 600,
    priorityCategories: ["core"],
    suppressions: [],
  };

  if (!signals) return style;

  const userName = getUserName();

  // ── Layer 1: Hard constraints (cannot be overridden) ──
  const hardCapped =
    signals.csiMode === "red" ||
    (signals.selfState?.fatigue ?? 0) > 0.7 ||
    (signals.emotion?.energy ?? 6) <= 3;

  if (hardCapped) {
    style.targetLength = "short";
    style.stance = "subdued";
    style.maxOutputTokens = 300;
    if (signals.csiMode === "red") {
      style.suppressions.push("不要展开复杂话题，保持简短");
    }
  }

  // ── Layer 2: Conversation mode (respects hard cap) ──
  if (!hardCapped) {
    const energy = signals.emotion?.energy ?? 6;
    const valence = signals.emotion?.valence ?? 5;

    if (signals.conversationMode === "emotional") {
      style.stance = "companion";
      style.priorityCategories = ["emotional", "core"];
      style.suppressions.push("先理解感受，不急着给建议");
      if (style.targetLength === "short") style.targetLength = "medium";
    } else if (signals.conversationMode === "technical") {
      style.priorityCategories = ["knowledge", "core"];
      style.stance = "curious";
      style.maxOutputTokens = 1000;
    } else if (signals.conversationMode === "planning") {
      style.priorityCategories = ["knowledge", "yuan", "core"];
      style.stance = "coach";
    } else if (signals.conversationMode === "philosophical") {
      style.priorityCategories = ["yuan", "emotional", "core"];
      style.stance = "curious";
    } else if (signals.conversationMode === "casual") {
      style.priorityCategories = ["core", "yuan"];
    }

    if (valence >= 8 && energy >= 7) {
      style.stance = "cheerful";
    }
  }

  // ── Layer 2.5: Identity-driven refinement ──
  if (!hardCapped && signals.identityCoreValues) {
    if (signals.identityCoreValues.includes("独立思考") && signals.conversationMode === "philosophical") {
      style.stance = "curious";
    }
    if ((signals.identityCoherence ?? 0.5) > 0.6) {
      style.suppressions.push("保持自己的立场，不要纯粹附和");
    }
  }

  // ── Layer 3: User length matching (respects hard cap) ──
  if (!hardCapped) {
    if (signals.userTextLength < 15) {
      style.targetLength = "short";
      style.maxOutputTokens = 300;
    } else if (signals.userTextLength > 100) {
      style.targetLength = "long";
      style.maxOutputTokens = 1000;
    }
  }

  // ── Layer 4: Engagement, drive, focus (always apply) ──
  if (signals.shortMessageCount >= 3) {
    style.suppressions.push(`${userName} 回复很短，别过度解读，也别写太长`);
  }

  if (signals.driveSignal && signals.driveSignal.strength > 0.5) {
    style.activeGoalHint = signals.driveSignal.description;
  }

  if (signals.currentFocus && signals.currentFocus.strength > 0.5) {
    const focusLabel = signals.currentFocus.label.toLowerCase().trim();
    const contextLower = (signals.conversationContext ?? "").toLowerCase();
    if (!contextLower.includes(focusLabel)) {
      style.memoryQuery = signals.currentFocus.label;
    }
  }

  // Finalize maxOutputTokens from targetLength (respect hard cap)
  if (!hardCapped) {
    const tokenMap: Record<string, number> = { short: 300, medium: 600, long: 1000 };
    style.maxOutputTokens = tokenMap[style.targetLength] ?? 600;
  }

  return style;
}

// ── 2.1: Self-Regulation Computation ─────────────────────────────────

function computeSelfRegulation(
  turnSignals: BrainstemTurnSignals,
  signals: CognitiveSignals | null | undefined,
  userTokens: string[],
): SelfRegulationState {
  // attentionalBandwidth: (activeSlots/5)*0.4 + entropy*0.6
  const activeSlots = Object.values(turnSignals.slots)
    .filter(s => s.strength > 0.3).length;
  const entropy = brainstemGetEntropy?.() ?? 0.5;
  const attentionalBandwidth = Math.min(1, (activeSlots / 5) * 0.4 + entropy * 0.6);

  // careAnchorSalience: what matters right now
  let careAnchorSalience = 0;
  try {
    const activeCare = getActiveEmotionalCare?.() ?? [];
    if (activeCare.length > 0) careAnchorSalience += 0.3;
  } catch (err) { log.warn("emotional care read error", err); incrementError("turn-directive", "emotional_care"); }
  const focusSlot = turnSignals.slots.current_focus;
  if (focusSlot && focusSlot.strength > 0.5) careAnchorSalience += 0.3;
  if (turnSignals.selfState.self_coherence > 0.5) careAnchorSalience += 0.2;
  if (turnSignals.driveSignal && turnSignals.driveSignal.strength > 0.3) careAnchorSalience += 0.2;

  // user-centrality: check if user's concern is present in topConcepts
  const topConceptTokens = turnSignals.topConcepts
    .filter(c => c.weight > 0.2)
    .flatMap(c => tokenize(c.topic));
  if (topConceptTokens.length > 0 && userTokens.length > 0) {
    const topSet = new Set(topConceptTokens);
    const userSet = new Set(userTokens);
    let overlap = 0;
    for (const t of userSet) { if (topSet.has(t)) overlap++; }
    if (overlap > 0) careAnchorSalience += 0.2;
    else careAnchorSalience -= 0.2;
  }
  careAnchorSalience = Math.max(0, Math.min(1, careAnchorSalience));

  // conversationalSpread: activeThreads/6
  const activeThreads = turnSignals.topConcepts.filter(c => c.weight > 0.2).length;
  const conversationalSpread = Math.min(1, activeThreads / 6);

  // groundingPressure: conversation structure, NOT adherence
  let groundingPressure = 0;
  const modeScores: Record<string, number> = {
    philosophical: 0.7, emotional: 0.3, technical: 0.1, planning: 0.1, casual: 0,
  };
  const mode = signals?.conversationMode ?? "casual";
  groundingPressure += modeScores[mode] ?? 0;

  // topConcepts abstractness: no concrete nouns/actions → +0.2
  const concretePattern = /做|买|去|吃|看|写|跑|开|用|搬|试|学|练|数据|代码|bug|API|code|test/;
  const hasConcreteTopics = turnSignals.topConcepts
    .filter(c => c.weight > 0.2)
    .some(c => concretePattern.test(c.topic));
  if (!hasConcreteTopics && turnSignals.topConcepts.filter(c => c.weight > 0.2).length > 0) {
    groundingPressure += 0.2;
  }

  // Short user text + philosophical → abstract pattern
  const userLen = signals?.userTextLength ?? 0;
  if (userLen < 30 && mode === "philosophical") groundingPressure += 0.1;

  groundingPressure = Math.min(1, groundingPressure);

  return { attentionalBandwidth, careAnchorSalience, conversationalSpread, groundingPressure };
}

// ── 2.2: Self-Belief Selection ───────────────────────────────────────

const _lastInjectedBeliefIds = new Map<string, { turn: number; wallMs: number }>(); // beliefId → injection record
let _beliefTurnCounter = 0;

function selectSafeBeliefs(beliefs: SelfBelief[]): Array<{ statement: string; category: string; confidence: number }> {
  _beliefTurnCounter++;
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const COOLDOWN_TURNS = 8;
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  const safe = beliefs
    .filter(b => {
      // Confidence >= 0.5 (already decayed)
      if (b.confidence < 0.5) return false;
      // Category filter: only trait, value, preference
      if (b.category !== "trait" && b.category !== "value" && b.category !== "preference") return false;
      // Recently revalidated: at least 1 evidence within 7 days
      const hasRecentEvidence = b.evidence.some(e => now - e.timestamp < SEVEN_DAYS);
      if (!hasRecentEvidence) return false;
      // Cooldown: skip if injected within last 8 turns AND last 2 hours (whichever is shorter)
      const lastInjected = _lastInjectedBeliefIds.get(b.id);
      if (lastInjected != null) {
        const turnGap = _beliefTurnCounter - lastInjected.turn;
        const timeGap = now - lastInjected.wallMs;
        // Block if BOTH are within cooldown (available when either expires)
        if (turnGap < COOLDOWN_TURNS && timeGap < TWO_HOURS) return false;
      }
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  // Record injection timestamps
  for (const b of safe) {
    _lastInjectedBeliefIds.set(b.id, { turn: _beliefTurnCounter, wallMs: now });
  }

  // Clean up old entries (ephemeral, no persistence needed)
  if (_lastInjectedBeliefIds.size > 50) {
    const entries = [..._lastInjectedBeliefIds.entries()];
    entries.sort((a, b) => a[1].turn - b[1].turn);
    for (let i = 0; i < entries.length - 30; i++) {
      _lastInjectedBeliefIds.delete(entries[i][0]);
    }
  }

  return safe.map(b => ({ statement: b.statement, category: b.category, confidence: b.confidence }));
}

// ── Main computation ─────────────────────────────────────────────────

export function computeTurnDirective(
  userMessage: string,
  turnSignals: BrainstemTurnSignals | null,
  bodyState?: { fatigue: number; caffeineLevel: number } | null,
  workContext?: { currentActivity?: string; location?: string; executionMode?: string } | null,
  signals?: CognitiveSignals | null,
  previousAdherenceScore?: number | null,
  consecutiveLowAdherence?: number | null,
): TurnDirective {
  const now = Date.now();
  const userTokens = tokenize(userMessage);

  // Compute style from CognitiveSignals (always available, even without brainstem)
  const style = computeStyle(signals);

  // When turnSignals is null (brainstem unavailable), produce minimal directive
  if (!turnSignals) {
    const openCommitments: Array<{ content: string; urgency: number }> = [];

    // Still merge persistent commitment memories
    try {
      const commitmentMemories = getStoreManager().loadCategory("commitment");
      const openMemCommitments = commitmentMemories
        .filter(m => !m.value.includes("状态: done") && !m.value.includes("状态: expired"))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 3);
      for (const m of openMemCommitments) {
        const content = m.value.split("|")[0]?.replace("承诺:", "").trim() ?? m.value;
        const ageHours = (Date.now() - m.timestamp) / 3_600_000;
        openCommitments.push({ content, urgency: Math.min(1, ageHours / 72) });
      }
    } catch (err) { log.warn("commitment load error", err); incrementError("turn-directive", "commitment_load"); }

    // Compute veto even without full brainstem signals
    const veto = computeVeto(
      null, // no CSI without brainstem
      null, // no selfState without brainstem
      0,    // no commitment pressure
      previousAdherenceScore ?? null,
      consecutiveLowAdherence ?? 0,
    );

    // Apply veto overrides to style
    if (veto.forceStance) style.stance = veto.forceStance;
    if (veto.maxTokens) style.maxOutputTokens = Math.min(style.maxOutputTokens, veto.maxTokens);

    const directive: TurnDirective = {
      conversationGoal: "respond",
      mustReferenceSlots: [],
      openCommitments,
      activeGoalAlignment: [],
      uncertaintyLevel: 0.3,
      selfEfficacy: 0.5,
      conceptActivations: [],
      groundingHints: [],
      driveHint: null,
      affectRegulationOverride: "none",
      style,
      authorityLevel: veto.authorityLevel,
      authorityReasons: veto.reasons.length > 0 ? veto.reasons : undefined,
      computedAt: now,
    };

    // Body expression hint
    if (bodyState) {
      let hint = "";
      if (bodyState.fatigue >= 8) hint = "你现在很累——回复明显变短，可能打错字，不想展开话题";
      else if (bodyState.fatigue >= 6) hint = "有点累——回复偏短，语气没那么有劲";
      if (bodyState.caffeineLevel >= 7) hint += (hint ? "；" : "") + "咖啡因很足——语速快、标点多、感叹号多、可能连发好几条";
      else if (bodyState.caffeineLevel >= 5) hint += (hint ? "；" : "") + "刚喝了咖啡——精神不错，话可能多一点";
      if (hint) directive.bodyExpressionHint = hint;
    }

    // Activity anchor
    if (workContext?.currentActivity) {
      const mode = workContext.executionMode;
      if (mode === "experiential") {
        directive.activityAnchor = `${workContext.currentActivity}时段（${workContext.location}）——氛围式描述即可，不要声称做了具体的事。`;
      } else if (mode === "groundable") {
        directive.activityAnchor = `正在：${workContext.currentActivity}（${workContext.location}）——可以说你打算去搜搜/学学，但不要说已经做了。`;
      } else {
        directive.activityAnchor = `正在：${workContext.currentActivity}（${workContext.location}）——聊天内容要与这个活动一致。`;
      }
    }

    // 3.3: Style hints for minimal directive path too
    try {
      const hasImage = userMessage.includes("[image]") || userMessage.includes("[图片]");
      directive.styleHints = selectStyleHints(signals?.conversationMode, hasImage);
    } catch (err) { incrementError("turn-directive", "style_hints"); }

    return directive;
  }

  // ── Full computation (brainstem available) ──

  // 1. Must-reference slots: strength > 0.5 and non-null conceptId
  const mustReferenceSlots = Object.values(turnSignals.slots)
    .filter(s => s.conceptId !== null && s.strength > 0.5)
    .map(s => ({ slot: s.name, label: s.label, strength: s.strength }));

  // 2. Open commitments (pass through)
  const openCommitments = turnSignals.openCommitments
    .map(c => ({ content: c.content, urgency: c.urgency }));

  // 3. Conversation goal
  let conversationGoal: TurnDirective["conversationGoal"] = "respond";

  // Check open_question slot matches user message
  const openQ = turnSignals.slots.open_question;
  if (openQ.conceptId && openQ.strength > 0.3) {
    const qTokens = tokenize(openQ.label);
    const overlap = tokenOverlap(userTokens, qTokens);
    if (overlap > 0.15) {
      conversationGoal = "follow_up_commitment";
    }
  }

  // Urgent commitments override
  const urgentCommitments = openCommitments.filter(c => c.urgency > 0.7);
  if (urgentCommitments.length > 0 && conversationGoal === "respond") {
    // Check if user message relates to any commitment
    for (const c of urgentCommitments) {
      const cTokens = tokenize(c.content);
      if (tokenOverlap(userTokens, cTokens) > 0.1) {
        conversationGoal = "follow_up_commitment";
        break;
      }
    }
  }

  // High uncertainty → clarify
  if (turnSignals.selfState.uncertainty > 0.7 && conversationGoal === "respond") {
    conversationGoal = "clarify";
  }

  // Low energy + low social energy → defer
  if (turnSignals.selfState.energy < 0.2 && turnSignals.selfState.social_energy < 0.2) {
    conversationGoal = "acknowledge_and_defer";
  }

  // 4. Active goal alignment — token overlap scoring, top 3
  const goalScores = turnSignals.activeGoals.map(g => {
    const goalTokens = tokenize(g.description);
    const topicTokens = (g.relatedTopics ?? []).flatMap(t => tokenize(t));
    const allGoalTokens = [...goalTokens, ...topicTokens];
    const relevance = tokenOverlap(userTokens, allGoalTokens);
    return { goalId: g.id, description: g.description, relevance };
  });
  const activeGoalAlignment = goalScores
    .filter(g => g.relevance > 0.1)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 3);

  // 5. Concept activations (enriched by blackboard spikes)
  const conceptActivations = [...turnSignals.topConcepts];

  // Phase E: Consume qualifying curiosity spikes from blackboard
  // Only patches with salience >= 0.3 are consumed (decayed); sub-threshold spikes are left alone
  try {
    const consumed = blackboard.consume(
      "curiosity_spike",
      p => p.salience >= 0.3,
    );
    for (const spike of consumed) {
      const query = spike.payload.query as string;
      if (query) {
        conceptActivations.push({ topic: query, weight: spike.salience });
      }
    }
  } catch (err) { incrementError("turn-directive", "curiosity_spike"); }

  // Phase E: Consume unresolved commitment alerts from heartbeat
  try {
    const commitmentAlerts = blackboard.consume(
      "unresolved_commitment",
      p => p.salience >= 0.4,
    );
    for (const alert of commitmentAlerts) {
      const content = alert.payload.content as string;
      const urgency = (alert.payload.urgency as number) ?? 0.5;
      if (content && !openCommitments.some(c => c.content === content)) {
        openCommitments.push({ content, urgency: Math.min(1.0, urgency + 0.2) });
      }
    }
  } catch (err) { incrementError("turn-directive", "commitment_alerts"); }

  // Phase E2: Merge persistent commitment memories (survive restart)
  try {
    const commitmentMemories = getStoreManager().loadCategory("commitment");
    const openMemCommitments = commitmentMemories
      .filter(m => !m.value.includes("状态: done") && !m.value.includes("状态: expired"))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3);
    for (const m of openMemCommitments) {
      const content = m.value.split("|")[0]?.replace("承诺:", "").trim() ?? m.value;
      // Dedup via token overlap (phrasing may vary between brainstem and memory)
      const mTokens = tokenize(content);
      const isDupe = openCommitments.some(c => {
        const cTokens = tokenize(c.content);
        return tokenOverlap(mTokens, cTokens) > 0.3;
      });
      if (!isDupe) {
        const ageHours = (Date.now() - m.timestamp) / 3_600_000;
        openCommitments.push({ content, urgency: Math.min(1, ageHours / 72) });
      }
    }
  } catch (err) { log.warn("commitment memory merge error", err); incrementError("turn-directive", "commitment_merge"); }

  // 6. Grounding hints
  const groundingHints: string[] = [];
  for (const c of conceptActivations) {
    groundingHints.push(c.topic);
  }
  for (const g of activeGoalAlignment) {
    groundingHints.push(g.description);
  }
  const focus = turnSignals.slots.current_focus;
  if (focus.conceptId && focus.strength > 0.3) {
    groundingHints.push(focus.label);
  }

  // 7. Drive hint
  const driveHint = turnSignals.driveSignal && turnSignals.driveSignal.strength > 0.5
    ? turnSignals.driveSignal.description
    : null;

  // 8. Affect regulation override
  let affectRegulationOverride: TurnDirective["affectRegulationOverride"] = "none";
  if (turnSignals.csi.mode === "red" && turnSignals.affectRegulation.intensity > 0.3) {
    affectRegulationOverride = "dampen";
  }

  // 9. Emotion tone — derived from affect regulation strategy
  let emotionTone: string | undefined;
  const reg = turnSignals.affectRegulation;
  if (reg.intensity > 0.2) {
    const strategyLabel: Record<string, string> = {
      reappraisal: "在重新解读（焦虑/压力中）",
      distraction: "在转移注意力（低落/消沉中）",
      suppression: "在压制情绪（需要控制）",
    };
    emotionTone = strategyLabel[reg.strategy];
  }

  // 10. Cognitive load level — derived from CSI
  let cognitiveLoadLevel: TurnDirective["cognitiveLoadLevel"];
  if (turnSignals.csi.value >= 0.8) cognitiveLoadLevel = "low";
  else if (turnSignals.csi.value >= 0.6) cognitiveLoadLevel = "normal";
  else if (turnSignals.csi.value >= 0.4) cognitiveLoadLevel = "high";
  else cognitiveLoadLevel = "overloaded";

  // ── Brainstem veto: hard constraints from high-confidence signals ──
  const commitmentPressure = openCommitments.length > 0
    ? openCommitments.reduce((s, c) => s + c.urgency, 0) / openCommitments.length
    : 0;
  const veto = computeVeto(
    turnSignals.csi,
    turnSignals.selfState,
    commitmentPressure,
    previousAdherenceScore ?? null,
    consecutiveLowAdherence ?? 0,
  );

  // Apply veto overrides to style
  if (veto.forceStance) style.stance = veto.forceStance;
  if (veto.maxTokens) style.maxOutputTokens = Math.min(style.maxOutputTokens, veto.maxTokens);

  const directive: TurnDirective = {
    conversationGoal,
    mustReferenceSlots,
    openCommitments,
    activeGoalAlignment,
    uncertaintyLevel: turnSignals.selfState.uncertainty,
    selfEfficacy: turnSignals.selfState.self_efficacy,
    conceptActivations,
    groundingHints,
    driveHint,
    affectRegulationOverride,
    emotionTone,
    cognitiveLoadLevel,
    style,
    authorityLevel: veto.authorityLevel,
    authorityReasons: veto.reasons.length > 0 ? veto.reasons : undefined,
    computedAt: now,
  };

  // Body expression hint (migrated from loop.ts bodyWritingHint)
  if (bodyState) {
    let hint = "";
    if (bodyState.fatigue >= 8) hint = "你现在很累——回复明显变短，可能打错字，不想展开话题";
    else if (bodyState.fatigue >= 6) hint = "有点累——回复偏短，语气没那么有劲";
    if (bodyState.caffeineLevel >= 7) hint += (hint ? "；" : "") + "咖啡因很足——语速快、标点多、感叹号多、可能连发好几条";
    else if (bodyState.caffeineLevel >= 5) hint += (hint ? "；" : "") + "刚喝了咖啡——精神不错，话可能多一点";
    if (hint) directive.bodyExpressionHint = hint;
  }

  // Activity anchor (migrated from loop.ts activityAnchor)
  if (workContext?.currentActivity) {
    const mode = workContext.executionMode;
    if (mode === "experiential") {
      directive.activityAnchor = `${workContext.currentActivity}时段（${workContext.location}）——氛围式描述即可，不要声称做了具体的事。`;
    } else if (mode === "groundable") {
      directive.activityAnchor = `正在：${workContext.currentActivity}（${workContext.location}）——可以说你打算去搜搜/学学，但不要说已经做了。`;
    } else {
      directive.activityAnchor = `正在：${workContext.currentActivity}（${workContext.location}）——聊天内容要与这个活动一致。`;
    }
  }

  // Adherence feedback + urgency boosting
  if (previousAdherenceScore != null) {
    directive.previousAdherenceScore = previousAdherenceScore;

    // Low adherence → boost mustReferenceSlots strength (+0.2, capped at 1.0)
    if (previousAdherenceScore < 0.5) {
      for (const slot of directive.mustReferenceSlots) {
        slot.strength = Math.min(1.0, slot.strength + 0.2);
      }
    }

    // Consecutive low adherence → raise uncertainty to trigger clarify goal
    const consecutive = consecutiveLowAdherence ?? 0;
    if (consecutive >= 2) {
      directive.uncertaintyLevel = Math.min(0.8, directive.uncertaintyLevel + 0.3);
    }
  }

  // ── 2.1: Self-Regulation Loop ──
  try {
    const selfReg = computeSelfRegulation(turnSignals, signals, userTokens);
    directive.selfRegulation = selfReg;

    // Closed-loop effects
    if (selfReg.attentionalBandwidth > 0.7) {
      style.suppressions.push("注意力分散了——这轮集中在一个话题上");
      style.targetLength = "short";
    }
    if (selfReg.careAnchorSalience < 0.3) {
      // Boost open commitment urgency +0.3
      for (const c of directive.openCommitments) {
        c.urgency = Math.min(1, c.urgency + 0.3);
      }
    }
    if (selfReg.conversationalSpread > 0.7) {
      style.suppressions.push("话题线太多了——倾向收束");
    }
    if (selfReg.groundingPressure > 0.6) {
      directive.groundingHints.push("试试用具体的例子、经历或感受来接地");
    }
  } catch (err) { incrementError("turn-directive", "self_regulation"); }

  // ── 2.2: Self-Beliefs injection + CSI behavior ──
  try {
    const allBeliefs = brainstemGetBeliefs?.() ?? [];
    if (allBeliefs.length > 0) {
      const safe = selectSafeBeliefs(allBeliefs);
      if (safe.length > 0) {
        directive.selfBeliefs = safe;
      }
    }
  } catch (err) { log.warn("self-belief read error", err); incrementError("turn-directive", "self_beliefs"); }

  // CSI behavior: adjust silently, no explicit narration
  try {
    const csiMode = turnSignals.csi.mode;
    if (csiMode === "yellow") {
      directive.cognitiveLoadLevel = "high";
      // Only reduce targetLength, never loosen (self-regulation may have set "short")
      if (style.targetLength === "long") style.targetLength = "medium";
      style.suppressions.push("不展开复杂话题");
    } else if (csiMode === "red") {
      directive.cognitiveLoadLevel = "overloaded";
      style.targetLength = "short";
      style.maxOutputTokens = Math.min(style.maxOutputTokens, 200);
      style.suppressions.push("只处理最紧急的");
    }
  } catch (err) { incrementError("turn-directive", "csi_behavior"); }

  // Weekly climate summary
  try {
    const climate = getWeeklyClimate?.() ?? null;
    if (climate) {
      directive.weeklyClimate = climate.summary;
    }
  } catch (err) { incrementError("turn-directive", "weekly_climate"); }

  // Growth markers from blackboard
  try {
    const growthPatches = blackboard.consume(
      "growth_marker",
      p => p.salience >= 0.3,
    );
    if (growthPatches.length > 0) {
      directive.recentGrowth = (growthPatches[0].payload.description as string) ?? undefined;
    }
  } catch (err) { incrementError("turn-directive", "growth_markers"); }

  // Identity lens — who the character IS, not just how they feel
  try {
    directive.identityLens = computeIdentityLens(turnSignals.selfState, userMessage, userTokens);
  } catch (err) { incrementError("turn-directive", "identity_lens"); }

  // Identity follow-ups — topics the character cares about, not obligations
  try {
    const peeked = blackboard.peek("identity_followup");
    if (peeked.length > 0) {
      const best = peeked.sort((a, b) => b.salience - a.salience)[0];
      blackboard.consume("identity_followup", p => p.createdAt === best.createdAt && p.salience >= 0.3);
      const rawTopics = (best.payload.topics as string[]) ?? [];
      const seen = new Set<string>();
      const topics: string[] = [];
      for (const t of rawTopics) {
        if (!seen.has(t) && topics.length < 2) { seen.add(t); topics.push(t); }
      }
      if (topics.length > 0) {
        directive.identityFollowup = topics.join("、");
      }
    }
  } catch (err) { incrementError("turn-directive", "identity_followup"); }

  // Active emotional care — gentle reminder when conversation touches care topic
  try {
    const activeCare = getActiveEmotionalCare?.() ?? [];
    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
    if (activeCare.length > 0) {
      for (const ct of activeCare) {
        const lastMention = ct.lastMentionedAt ?? 0;
        if (Date.now() - lastMention < TWO_DAYS) continue;  // too recent, skip
        const ctTokens = tokenize(ct.need);
        const overlap = tokenOverlap(userTokens, ctTokens);
        if (overlap > 0.15) {
          directive.activeCareHint = `你一直在关心的：${ct.need}${ct.whyItMatters ? `（${ct.whyItMatters}）` : ""}`;
          break;
        }
      }
    }
  } catch (err) { incrementError("turn-directive", "active_care"); }

  // Behavioral priors from reflection — recent tendencies (non-destructive peek)
  try {
    const priorPatches = blackboard.peek("behavioral_prior")
      .filter(p => p.salience >= 0.3);
    if (priorPatches.length > 0) {
      directive.behavioralPriors = priorPatches
        .slice(0, 3)
        .map(p => `${p.payload.situation} → ${p.payload.tendency}`);
    }
  } catch (err) { incrementError("turn-directive", "behavioral_priors"); }

  // Fallback: recent behavioral.* memories (when no blackboard priors)
  if (!directive.behavioralPriors || directive.behavioralPriors.length === 0) {
    try {
      const yuanMemories = getStoreManager().loadCategory("yuan");
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const recent = yuanMemories
        .filter(m => m.key.startsWith("behavioral.") && m.timestamp > cutoff)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 3);
      if (recent.length > 0) {
        directive.behavioralPriors = recent.map(m => m.value);
      }
    } catch (err) { incrementError("turn-directive", "behavioral_memories"); }
  }

  // Multi-turn plan: sequence goals across turns when multiple commitments compete
  const plan = maybeCreatePlan(directive.openCommitments, directive.conversationGoal);
  if (plan) {
    directive.activePlan = plan;
    // Override conversation goal with the planned goal for this turn
    const plannedGoal = plan.plannedGoalSequence[plan.currentTurnIndex];
    if (plannedGoal) {
      directive.conversationGoal = plannedGoal;
    }
  }

  // ── 1.2a: Exemplar injection ──
  try {
    const exemplarPriors = matchExemplars(userTokens);
    if (exemplarPriors.length > 0) {
      if (!directive.behavioralPriors) directive.behavioralPriors = [];
      directive.behavioralPriors.push(...exemplarPriors);
    }
  } catch (err) { log.warn("exemplar match error", err); incrementError("turn-directive", "exemplar_match"); }

  // ── 1.2b: Relationship-stage priors (phaseConfidence-gated) ──
  try {
    const userName = getUserName();
    const attachment = getAttachmentState() as { stage: string; phaseConfidence?: number; lastMessageUnanswered?: boolean; secureBaseActive?: boolean };
    if ((attachment.phaseConfidence ?? 0.5) >= 0.6) {
      if (!directive.behavioralPriors) directive.behavioralPriors = [];
      if (attachment.stage === "anxious") {
        directive.behavioralPriors.push(`在意${userName}有没有回消息，但克制不追问`);
      } else if (attachment.stage === "ruminating" && attachment.lastMessageUnanswered) {
        directive.behavioralPriors.push("发了消息没回，理解对方可能忙——不要再追");
        style.suppressions.push("不要说\"你怎么没回我\"之类的话");
      } else if (attachment.stage === "secure" && attachment.secureBaseActive) {
        directive.behavioralPriors.push("心里很安定");
        directive.behavioralPriors.push("多调侃、分享发现，少问\"你还好吗\"");
        style.stance = "cheerful";
      } else if (attachment.stage === "secure") {
        directive.behavioralPriors.push("关系挺稳的——正常聊就好");
      }
    }
  } catch (err) { incrementError("turn-directive", "relationship_stage"); }

  // Re-sync maxOutputTokens after all late targetLength modifications (2.1, 2.2, 2.3)
  {
    const tokenMap: Record<string, number> = { short: 300, medium: 600, long: 1000 };
    const fromLength = tokenMap[style.targetLength] ?? 600;
    // Only tighten, never loosen — respect earlier hard caps (CSI red 200, veto caps)
    style.maxOutputTokens = Math.min(style.maxOutputTokens, fromLength);
  }

  // ── 3.3: Style hints — per-turn technique reminders ──
  try {
    const hasImage = userMessage.includes("[image]") || userMessage.includes("[图片]");
    directive.styleHints = selectStyleHints(
      signals?.conversationMode,
      hasImage,
    );
  } catch (err) { incrementError("turn-directive", "style_hints"); }

  // ── 4.2: Relational hints from style-reaction learning ──
  try {
    const patterns = getTopRelationalPatterns(3);
    if (patterns.length > 0) {
      directive.relationalHints = patterns.map(p => (p as any).label ?? p.feature);
    }
  } catch (err) { incrementError("turn-directive", "relational_hints"); }

  return directive;
}

// ── Phase B: Reply Control ──────────────────────────────────────────

export interface ReplyControl {
  mustMention: string[];
  shouldGroundIn: string[];
  avoidTopicDrift: boolean;
  toneBias: "dampen" | "amplify" | "neutral";
  maxNewThreads: number;
}

export function deriveReplyControl(directive: TurnDirective): ReplyControl {
  return {
    mustMention: directive.openCommitments
      .filter(c => c.urgency > 0.5)
      .map(c => c.content),
    shouldGroundIn: directive.mustReferenceSlots.map(s => s.label),
    avoidTopicDrift: directive.conversationGoal === "follow_up_commitment",
    toneBias: directive.affectRegulationOverride === "none" ? "neutral" : directive.affectRegulationOverride,
    maxNewThreads: directive.conversationGoal === "follow_up_commitment" ? 1 : 2,
  };
}

// ── Phase B: System Prompt Section ──────────────────────────────────

export function renderTurnDirectiveSection(directive: TurnDirective): string {
  const userName = getUserName();

  // Authority-level framing: mandatory directives get stronger language
  const authorityLabels: Record<string, string> = {
    advisory: "权威性内部指引",
    directive: "权威性内部指引 — 请遵循",
    mandatory: "强制性内部指令 — 必须严格执行",
  };
  const lines: string[] = [`## 认知指令（${authorityLabels[directive.authorityLevel] ?? "权威性内部指引"}）`];
  const goalLabels: Record<TurnDirective["conversationGoal"], string> = {
    respond: "正常回复",
    clarify: "需要澄清",
    follow_up_commitment: "跟进承诺",
    acknowledge_and_defer: "简短回应",
  };
  lines.push(`目标：${goalLabels[directive.conversationGoal]}`);
  if (directive.openCommitments.length > 0)
    lines.push(`待兑现承诺：${[...directive.openCommitments].sort((a, b) => b.urgency - a.urgency).slice(0, 3).map(c => c.content).join("；")}`);
  if (directive.mustReferenceSlots.length > 0)
    lines.push(`必须关联：${directive.mustReferenceSlots.map(s => s.label).join("、")}`);
  if (directive.activeGoalAlignment.length > 0)
    lines.push(`相关目标：${directive.activeGoalAlignment.map(g => g.description).join("；")}`);
  if (directive.driveHint) lines.push(`内在驱动：${directive.driveHint}`);
  if (directive.affectRegulationOverride !== "none")
    lines.push(`情绪调节：${directive.affectRegulationOverride === "dampen" ? "收敛情绪表达" : "放大情绪表达"}`);
  if (directive.emotionTone)
    lines.push(`情绪状态：${directive.emotionTone}`);
  if (directive.cognitiveLoadLevel && directive.cognitiveLoadLevel !== "normal") {
    const loadLabels: Record<string, string> = {
      low: "认知负荷低——可以处理复杂话题",
      high: "认知负荷偏高——回复尽量简洁清晰",
      overloaded: "认知超载——只处理最紧急的事，其余推迟",
    };
    lines.push(`认知负荷：${loadLabels[directive.cognitiveLoadLevel]}`);
  }

  // Structured control block — machine-readable constraints
  const rc = deriveReplyControl(directive);
  if (rc.mustMention.length > 0)
    lines.push(`【必须提到】${rc.mustMention.join("；")}`);
  if (rc.avoidTopicDrift)
    lines.push(`【约束】不要发散新话题，优先围绕上述承诺/焦点`);

  // Body expression
  if (directive.bodyExpressionHint) {
    lines.push(`身体泄漏：${directive.bodyExpressionHint}`);
  }

  // Activity anchor
  if (directive.activityAnchor) {
    lines.push(`当前情境：${directive.activityAnchor}`);
  }

  // Style — always present (computed internally from CognitiveSignals)
  {
    const stanceDesc: Record<string, string> = {
      coach: "这轮以引导为主，给具体建议",
      companion: "这轮以陪伴为主，先理解感受",
      curious: "这轮可以深入聊细节，展开讨论",
      subdued: "这轮收敛一点，保持简短",
      cheerful: "心情不错，可以活泼一点",
    };
    const lengthDesc: Record<string, string> = { short: "简短回复", medium: "中等长度", long: "可以展开聊" };
    lines.push(`回复风格：${stanceDesc[directive.style.stance] ?? "正常聊天"}，${lengthDesc[directive.style.targetLength] ?? "中等长度"}`);
    for (const s of directive.style.suppressions) lines.push(s);
    if (directive.style.activeGoalHint) lines.push(`你最近在推进：${directive.style.activeGoalHint}`);
  }

  // Identity constraints — who the character IS, not just how they feel
  if (directive.identityLens) {
    const lens = directive.identityLens;
    if (lens.voiceConstraints.length > 0) {
      lines.push(`性格约束：${lens.voiceConstraints.join("；")}`);
    }
    if (lens.disagreementReadiness > 0.6) {
      lines.push("自我确信度高——这个话题触及你在乎的东西，可以表达不同意见");
    } else if (lens.disagreementReadiness < 0.3) {
      lines.push("自我确信度低——倾向于倾听，少表态");
    }
    if (lens.selfDisclosureLevel === "guarded") {
      lines.push("社交状态偏内收——不太想分享自己的事");
    } else if (lens.selfDisclosureLevel === "minimal") {
      lines.push("社交能量极低——尽量不展开自己的话题");
    }
    if (lens.topicOwnership?.caresAbout.length) {
      lines.push(`这些对你自己也重要：${lens.topicOwnership.caresAbout.join("、")}`);
    }
    if (lens.topicOwnership && lens.topicOwnership.followupWorthiness > 0.5) {
      lines.push("这个话题值得过几天再聊——可以记住，之后主动提起");
    }
    if (lens.activeIdentityHint) {
      lines.push(`自我叙事：${lens.activeIdentityHint}`);
    }
  }

  // Self-beliefs — "我对自己的认知"
  if (directive.selfBeliefs && directive.selfBeliefs.length > 0) {
    lines.push("我对自己的认知：");
    for (const b of directive.selfBeliefs) {
      if (b.category === "value") {
        // Committed values get distinct rendering
        lines.push(`  - 我的价值观：${b.statement}`);
      } else {
        lines.push(`  - ${b.statement}（${b.category}，置信度 ${Math.round(b.confidence * 100)}%）`);
      }
    }
  }

  // Self-regulation — sparse: only render when 2+ variables cross threshold simultaneously
  if (directive.selfRegulation) {
    const sr = directive.selfRegulation;
    let crossCount = 0;
    if (sr.attentionalBandwidth > 0.7) crossCount++;
    if (sr.careAnchorSalience < 0.3) crossCount++;
    if (sr.conversationalSpread > 0.7) crossCount++;
    if (sr.groundingPressure > 0.6) crossCount++;

    if (crossCount >= 2) {
      // Pick the most salient short hint — one line only
      if (sr.conversationalSpread > 0.7 || sr.attentionalBandwidth > 0.7) {
        lines.push("这轮先收一收，别散开。");
      } else {
        lines.push("先落到一个具体点上。");
      }
    }
  }

  // Identity follow-up — gentle reminder, not obligation
  if (directive.identityFollowup) {
    lines.push(`你最近在想的：${directive.identityFollowup}——如果自然聊到可以带出来，但不是待办`);
  }

  // Behavioral priors — tendencies from reflection
  if (directive.behavioralPriors && directive.behavioralPriors.length > 0) {
    lines.push(`最近这段时间，你在类似情境里更自然的倾向是：`);
    for (const prior of directive.behavioralPriors) {
      lines.push(`  - ${prior}`);
    }
  }

  // Emotional care hint — something the character has been carrying for the user
  if (directive.activeCareHint) {
    lines.push(`${directive.activeCareHint}——这不是任务，是你作为朋友一直记着的事`);
  }

  // Adherence self-correction (escalated by authority level)
  if (directive.previousAdherenceScore != null && directive.previousAdherenceScore < 0.5) {
    if (directive.authorityLevel === "mandatory") {
      lines.push(`【强制执行】上一轮你未遵循指令（adherence=${directive.previousAdherenceScore.toFixed(2)}），本轮 *必须* 覆盖承诺和焦点内容`);
    } else {
      lines.push(`【执行提醒】上一轮未充分覆盖关键内容（${directive.previousAdherenceScore.toFixed(2)}），本轮优先处理承诺和焦点内容`);
    }
  }

  // Authority reasons — explain why constraints are elevated
  if (directive.authorityReasons && directive.authorityReasons.length > 0 && directive.authorityLevel !== "advisory") {
    lines.push(`约束原因：${directive.authorityReasons.join("；")}`);
  }

  // Weekly climate
  if (directive.weeklyClimate) {
    lines.push(`本周气候：${directive.weeklyClimate}`);
  }

  // Growth markers
  if (directive.recentGrowth) {
    lines.push(`成长标记：${directive.recentGrowth}`);
  }

  // Multi-turn plan
  if (directive.activePlan) {
    const p = directive.activePlan;
    lines.push(`多轮计划：第${p.currentTurnIndex + 1}/${p.horizon}轮，本轮重点=${goalLabels[p.plannedGoalSequence[p.currentTurnIndex]] ?? "正常回复"}`);
  }

  // Style hints — per-turn technique reminders (3.3)
  if (directive.styleHints && directive.styleHints.length > 0) {
    lines.push("语感提示：");
    for (const hint of directive.styleHints) {
      lines.push(`  - ${hint}`);
    }
  }

  // 4.2: Relational hints from style-reaction learning
  if (directive.relationalHints && directive.relationalHints.length > 0) {
    lines.push(`和${userName}聊天的经验：`);
    for (const hint of directive.relationalHints) {
      lines.push(`  - ${hint}`);
    }
  }

  lines.push("以上是你的潜意识状态总结——不需要逐条执行，让它自然影响你的回复方式和内容选择。");
  return lines.join("\n");
}

// ── Phase B: Adherence Check ────────────────────────────────────────

export interface DirectiveAdherence {
  surfacedCommitments: string[];
  surfacedSlots: string[];
  replyMode: "answer" | "clarify" | "defer" | "follow_up";
  adherenceScore: number;
}

export function checkAdherence(
  replyText: string,
  directive: TurnDirective,
  control: ReplyControl,
): DirectiveAdherence {
  const replyTokens = new Set(tokenize(replyText));

  // Check which mustMention items appeared
  const surfacedCommitments: string[] = [];
  for (const mention of control.mustMention) {
    const mentionTokens = tokenize(mention);
    let matches = 0;
    for (const t of mentionTokens) {
      if (replyTokens.has(t)) matches++;
    }
    if (mentionTokens.length > 0 && matches / mentionTokens.length > 0.3) {
      surfacedCommitments.push(mention);
    }
  }

  // Check which shouldGroundIn items appeared
  const surfacedSlots: string[] = [];
  for (const slot of control.shouldGroundIn) {
    const slotTokens = tokenize(slot);
    let matches = 0;
    for (const t of slotTokens) {
      if (replyTokens.has(t)) matches++;
    }
    if (slotTokens.length > 0 && matches / slotTokens.length > 0.3) {
      surfacedSlots.push(slot);
    }
  }

  // Classify reply mode by heuristic
  const questionMarks = (replyText.match(/[？?]/g) || []).length;
  const charCount = replyText.length;
  let replyMode: DirectiveAdherence["replyMode"] = "answer";
  if (questionMarks >= 2 && charCount < 100) {
    replyMode = "clarify";
  } else if (charCount < 30) {
    replyMode = "defer";
  } else if (surfacedCommitments.length > 0) {
    replyMode = "follow_up";
  }

  // Adherence score: ratio of fulfilled constraints
  const totalConstraints = control.mustMention.length + control.shouldGroundIn.length;
  const fulfilledConstraints = surfacedCommitments.length + surfacedSlots.length;
  const adherenceScore = totalConstraints > 0 ? fulfilledConstraints / totalConstraints : 1;

  return { surfacedCommitments, surfacedSlots, replyMode, adherenceScore };
}
