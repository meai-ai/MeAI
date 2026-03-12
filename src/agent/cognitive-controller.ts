/**
 * Cognitive Controller V1 — deterministic "prefrontal cortex" for MeAI.
 *
 * Provides signal gathering (CognitiveSignals) and retrieval policy routing.
 * Style computation (stance, length, suppressions) has been absorbed into
 * TurnDirective (turn-directive.ts) as the single decision authority.
 *
 * Brainstem dependency: optional. When brainstem is not initialized,
 * brainstem-derived signals are omitted gracefully.
 */

// Brainstem imports — optional module, may not be present
let brainstemGetCSI: (() => { mode: "green" | "yellow" | "red"; value: number } | null) | undefined;
let brainstemGetSelfState: (() => { energy: number; social_energy: number; fatigue?: number; self_coherence: number } | null) | undefined;
let brainstemGetDriveSignal: (() => { description: string; strength: number } | null) | undefined;
let brainstemGetWorkingMemory: (() => Array<{ name: string; label: string; strength: number }>) | undefined;
let brainstemGetIdentityProfile: (() => { coreValues?: string[] } | null) | undefined;

try {
  // Dynamic import attempt — will fail silently if brainstem module doesn't exist
  const brainstem = await import("../brainstem/index.js").catch(() => null);
  if (brainstem) {
    brainstemGetCSI = brainstem.brainstemGetCSI;
    brainstemGetSelfState = brainstem.brainstemGetSelfState;
    brainstemGetDriveSignal = brainstem.brainstemGetDriveSignal;
    brainstemGetWorkingMemory = brainstem.brainstemGetWorkingMemory;
    brainstemGetIdentityProfile = brainstem.brainstemGetIdentityProfile;
  }
} catch { /* brainstem not available */ }

// ── Types ────────────────────────────────────────────────────────────

export interface CognitiveSignals {
  conversationMode: string;
  userTextLength: number;
  shortMessageCount: number;
  emotion?: { energy: number; valence: number };
  csiMode?: "green" | "yellow" | "red";
  selfState?: { energy: number; social_energy: number; fatigue?: number };
  driveSignal?: { description: string; strength: number } | null;
  currentFocus?: { label: string; strength: number } | null;
  conversationContext?: string;
  identityCoherence?: number;
  identityCoreValues?: string[];
}

export interface RetrievalPolicy {
  buckets: {
    emotional: number;
    knowledge: number;
    character: number;
    insights: number;
    commitment: number;
  };
  categoryBonus: Record<string, number>;
  scoreWeights: {
    semantic: number;
    bm25: number;
    recency: number;
  };
  softPenalty: Record<string, number>;
  crossCategoryAnchors: number;
}

// ── Conversation Mode Classifier ─────────────────────────────────────

export function classifyConversationMode(text: string): string {
  const lower = text.toLowerCase();

  if (/code|bug|api|deploy|git|server|model|algorithm|architecture|technical|python|react|agent/.test(lower)) return "technical";
  if (/sad|upset|stress|anxiety|happy|excited|annoyed|tired|afraid|angry|moved|mood|cry|lonely|homesick/.test(lower)) return "emotional";
  if (/meaning|life|free.?will|existence|values|belief|philosophy|thinking|essence/.test(lower)) return "philosophical";
  if (/plan|intend|prepare|should.?i|weekend|travel|itinerary|arrange|what.?to.?do/.test(lower)) return "planning";
  return "casual";
}

// ── Signal Gathering ─────────────────────────────────────────────────

export function gatherSignals(
  history: Array<{ role: string; content: string | unknown }>,
  userText: string,
  emotionalState: { energy: number; valence: number } | null | undefined,
  _bodyState: { fatigue: number } | null | undefined,
): CognitiveSignals {
  const conversationMode = classifyConversationMode(userText);

  // Recent user messages for engagement analysis
  const recentUserTexts = history
    .filter(e => e.role === "user")
    .slice(-5)
    .map(e => typeof e.content === "string" ? e.content : "");
  const shortMessageCount = recentUserTexts.filter(t => t.length > 0 && t.length < 10).length;

  // Brainstem signals (optional)
  const csi = brainstemGetCSI?.() ?? null;
  const selfState = brainstemGetSelfState?.() ?? null;
  const driveSignal = brainstemGetDriveSignal?.() ?? null;

  // Current focus from working memory
  let currentFocus: { label: string; strength: number } | null = null;
  try {
    const slots = brainstemGetWorkingMemory?.();
    if (slots) {
      const focus = slots.find(s => s.name === "current_focus");
      if (focus?.label && focus.strength > 0.1) {
        currentFocus = { label: focus.label, strength: focus.strength };
      }
    }
  } catch { /* brainstem may not be initialized */ }

  // Identity signals
  let identityCoherence: number | undefined;
  let identityCoreValues: string[] | undefined;
  try {
    const identityProfile = brainstemGetIdentityProfile?.();
    if (identityProfile) identityCoreValues = identityProfile.coreValues;
    if (selfState) identityCoherence = selfState.self_coherence;
  } catch { /* brainstem may not be initialized */ }

  return {
    conversationMode,
    userTextLength: userText.length,
    shortMessageCount,
    emotion: emotionalState ? { energy: emotionalState.energy, valence: emotionalState.valence } : undefined,
    csiMode: csi?.mode,
    selfState: selfState ? { energy: selfState.energy, social_energy: selfState.social_energy, fatigue: selfState.fatigue } : undefined,
    driveSignal,
    currentFocus,
    identityCoherence,
    identityCoreValues,
  };
}

// ── Retrieval Policy ─────────────────────────────────────────────────

const RETRIEVAL_POLICIES: Record<string, RetrievalPolicy> = {
  subdued: {
    buckets: { emotional: 4, knowledge: 2, character: 1, insights: 2, commitment: 1 },
    categoryBonus: {},
    scoreWeights: { semantic: 1, bm25: 1, recency: 1.2 },
    softPenalty: { knowledge: 0.3 },
    crossCategoryAnchors: 1,
  },
  emotional: {
    buckets: { emotional: 10, knowledge: 2, character: 3, insights: 2, commitment: 2 },
    categoryBonus: { emotional: 0.3, character: 0.15 },
    scoreWeights: { semantic: 0.8, bm25: 0.8, recency: 1.5 },
    softPenalty: { knowledge: 0.4 },
    crossCategoryAnchors: 1,
  },
  technical: {
    buckets: { emotional: 2, knowledge: 8, character: 2, insights: 3, commitment: 1 },
    categoryBonus: { knowledge: 0.3 },
    scoreWeights: { semantic: 1.3, bm25: 1.2, recency: 0.7 },
    softPenalty: { emotional: 0.5 },
    crossCategoryAnchors: 1,
  },
  planning: {
    buckets: { emotional: 3, knowledge: 5, character: 3, insights: 4, commitment: 5 },
    categoryBonus: { knowledge: 0.2, character: 0.15, commitment: 0.3 },
    scoreWeights: { semantic: 1.0, bm25: 1.2, recency: 1.3 },
    softPenalty: { emotional: 0.5 },
    crossCategoryAnchors: 1,
  },
  philosophical: {
    buckets: { emotional: 4, knowledge: 3, character: 5, insights: 3, commitment: 2 },
    categoryBonus: { character: 0.3, emotional: 0.1 },
    scoreWeights: { semantic: 0.9, bm25: 0.9, recency: 1.0 },
    softPenalty: {},
    crossCategoryAnchors: 2,
  },
  casual: {
    buckets: { emotional: 5, knowledge: 3, character: 4, insights: 3, commitment: 3 },
    categoryBonus: { character: 0.2 },
    scoreWeights: { semantic: 1.0, bm25: 1.0, recency: 1.2 },
    softPenalty: {},
    crossCategoryAnchors: 1,
  },
};

export function computeRetrievalPolicy(style: { stance: string; priorityCategories: string[] }): RetrievalPolicy {
  // Hard-capped (subdued stance) → subdued retrieval
  if (style.stance === "subdued") return RETRIEVAL_POLICIES.subdued;

  // Route by primary priority category → conversation mode
  const primary = style.priorityCategories[0];
  if (primary === "emotional") return RETRIEVAL_POLICIES.emotional;
  if (primary === "knowledge") {
    // Distinguish technical vs planning by checking if character is also prioritized
    if (style.priorityCategories.includes("character")) return RETRIEVAL_POLICIES.planning;
    return RETRIEVAL_POLICIES.technical;
  }
  if (primary === "character") return RETRIEVAL_POLICIES.philosophical;
  return RETRIEVAL_POLICIES.casual;
}
