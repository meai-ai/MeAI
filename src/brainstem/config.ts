/**
 * Brainstem centralized configuration.
 *
 * All time-dependent constants are configured as half-lives in seconds,
 * then derived to per-tick coefficients at module load.
 * Single source of truth for all brainstem parameters.
 */

// ── Clock interface (enables deterministic test/replay) ──────────────

export interface Clock {
  nowMs(): number;
}

export const PRODUCTION_CLOCK: Clock = { nowMs: () => Date.now() };

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Derived coefficients ─────────────────────────────────────────────

export function halfLifeToDecay(halfLifeSeconds: number, tickSeconds: number): number {
  return 1 - Math.pow(2, -tickSeconds / halfLifeSeconds);
}

export function halfLifeToFactor(halfLifeSeconds: number, tickSeconds: number): number {
  return Math.pow(2, -tickSeconds / halfLifeSeconds);
}

// ── Main config ──────────────────────────────────────────────────────

export const BRAINSTEM_CONFIG = {
  // ── Tick ──
  tickSeconds: 3,
  slowLoopIntervalMs: 60_000,
  slowLoopMinMs: 45_000,
  slowLoopMaxMs: 120_000,

  // ── Time-based (configured as half-lives) ──
  activationHalfLife: 525,          // seconds (~9 min)
  salienceHalfLife: 70,             // seconds
  inputSatiationHalfLife: 29,       // seconds

  // ── Non-time-based (per-tick at 3s, auto-scaled) ──
  fatigueRecovery: 0.005,           // per tick @ 3s
  fatigueGainPerTick: 0.03,         // per tick @ 3s, only when A > 0.25
  fatigueInhibitionK: 0.12,         // A -= k*F per tick @ 3s
  noiseAmplitude: 0.015,            // per tick @ 3s

  // ── Fixed (tick-independent) ──
  spreadFactor: 0.15,               // damping factor α for normalized propagation
  jaccardEdgeThreshold: 0.15,       // min similarity to create semantic edge
  maxNodes: 100,
  maxEdges: 500,
  energyMax: 10.0,                  // global energy budget: sum(A) ≤ this
  bgFloorFrac: 0.1,                 // background nodes get ≥10% of ENERGY_MAX
  salienceBoostK: 0.6,              // S += kS × boost. Not gated by IS
  clusterEdgeThreshold: 0.35,       // min edge weight for clustering
  inputSatiationGain: 0.15,         // IS += gain × boost × exp(-Δt/20)
  externalAbsorbBudgetPerMin: 2.4,  // total external boost quantity per minute

  // ── Winner competition ──
  winnerMinDwellMs: 120_000,        // 120s minimum dwell
  dethroneMargin: 0.07,             // challenger must beat EMA + margin
  dethroneEmaAlpha: 0.3,            // EMA smoothing for incumbent score
  spikeThreshold: 0.3,              // score jump to override dwell protection

  // ── Novelty ──
  noveltyStructThreshold: 0.35,     // Jaccard distance on IDs
  noveltySemanticThreshold: 0.3,    // embedding cosine distance

  // ── Thought budget ──
  thoughtBudgetBase: 12,            // micro-thoughts/hour
  thoughtBudgetFloor: 4,
  thoughtBudgetCeiling: 18,

  // ── Replay ──
  replayCooldownMs: 45 * 60_000,    // 45 min cooldown per memory key
  replayHighRelevanceOverride: 0.9, // similarity above this overrides cooldown
  replayBoostAmount: 0.15,          // activation boost per replay event

  // ── Loop detection ──
  loopDominanceThreshold: 0.75,     // same node top-1 for 75%+ of last 200 ticks
  loopNoveltyThreshold: 0.3,        // noveltyAvg below this counts as stuck
  loopExternalDiversityThreshold: 0.3,

  // ── Gates ──
  thoughtScoreMin: 0.08,            // minimum cluster score to verbalize
  reflectMaxPerHours: 4,            // max 1 reflection per 4 hours
  actGateMaxActivation: 0.7,        // max activation threshold for act gate (person targets)
  actGateSelfActivation: 0.25,       // lower threshold for self-directed activities
  actGateDailyCapDefault: 2,        // per-target daily cap

  // ── Prediction ──
  predictionBufferSize: 20,
  predictionSurpriseThreshold: 0.4,
  predictionConfirmThreshold: 0.15,

  // ── Temporal credit ──
  temporalCreditWindowMs: 90_000,   // 30-90s temporal window
  temporalCreditMinMs: 30_000,
  temporalCreditEdgeDelta: 0.008,
  temporalCreditWeakenDelta: 0.003,
  temporalCreditConfidenceRevertThreshold: 3,
  temporalCreditConfidenceLearnedThreshold: 10,

  // ── Hierarchy (CS3) ──
  hierarchyBottomUpFactor: 0.15,
  hierarchyTopDownFactor: 0.08,
  maxHierarchyDepth: 3,

  // ── Self node (CS5) ──
  selfActivationFloor: 0.3,
  selfScoreDiscount: 0.5,

  // ── Future sim (CS4) ──
  maxHypotheticalNodes: 3,
  hypotheticalTTLMs: 2 * 60 * 60_000,  // 2 hours

  // ── Night mode ──
  nightStartHour: 0,
  nightEndHour: 7,

  // ── State persistence ──
  persistIntervalTicks: 100,        // persist every ~5 min

  // ── Stabilizer ──
  csiWeights: {
    G: 0.22,
    Gc: 0.05,
    N: 0.20,
    Rh: 0.15,
    Eh: 0.13,
    Vh: 0.15,
    Pe: 0.10,
  },
  csiGreenThreshold: 0.7,
  csiYellowThreshold: 0.45,
  csiRedShallowThreshold: 0.35,
  yellowToGreenHysteresis: 0.75,
  redToYellowHysteresis: 0.55,
  redDeepToShallowHysteresis: 0.40,
  rampDurationMs: 120_000,          // 2 min recovery ramp

  // ── Rotation ──
  rotationWindowMs: 3_600_000,      // 1 hour window
  rotationHealthCenter: 9,          // ideal rotations/hour

  // ── Entropy ──
  entropyTarget: 2.5,               // target entropy for 100-node graph

  // ── Valence ──
  valenceExtremeThreshold: 0.8,
  valenceTrendTicks: 5,
  valTanhK: 2.0,

  // ── World model ──
  worldModelContextBins: {
    receptivity: [0.3, 0.7],        // low/mid/high
    trust: [0.5],                   // cool/warm
  },
  worldModelEwmaAlpha: 0.3,

  // ── Planner ──
  plannerBeamWidth: 3,
  plannerMaxDepth: 3,
  plannerDiscount: 0.8,
  plannerNodeBudget: 30,
  plannerMaxActivePlans: 3,
  plannerMinIntervalMs: 30 * 60_000,
  plannerLlmCallsPerDay: 3,
  plannerTimeoutMs: 24 * 60 * 60_000,

  // ── MCTS ──
  mctsIterations: 50,
  mctsExplorationC: 1.414,               // sqrt(2)
  mctsProgressiveWidening: 0.5,          // exponent for max children = ceil(visits^exp)

  // ── Resource budgets ──
  maxCpuMsPerMinute: 500,
  maxIoOpsPerMinute: 60,
  maxDiskWriteMbPerDay: 50,

  // ── Energy scaling ──
  energyProtectedN: 3,
  energyProtectedExpandedN: 5,
  energyClippingRateExpansionThreshold: 0.6,
} as const;

export type BrainstemConfig = typeof BRAINSTEM_CONFIG;

/** Per-source TTL in days. Infinity = never auto-evict, 0 = handled separately (e.g. hypotheticalTTLMs). */
export const DEFAULT_TTL_DAYS_BY_SOURCE: Record<string, number> = {
  memory: 30,
  curiosity: 7,
  notification: 7,
  goal: Infinity,
  conversation: 14,
  emotion: 30,
  reflection: 30,
  simulation: 0,
  replay: 30,
  cortex: 14,
  structure_learning: 14,
};

// ── Derived per-tick constants (computed once at load) ────────────────

const T = BRAINSTEM_CONFIG.tickSeconds;

export const DERIVED = {
  activationDecay: halfLifeToDecay(BRAINSTEM_CONFIG.activationHalfLife, T),
  salienceDecay: halfLifeToDecay(BRAINSTEM_CONFIG.salienceHalfLife, T),
  isFactor: halfLifeToFactor(BRAINSTEM_CONFIG.inputSatiationHalfLife, T),
  fatigueRecovery: BRAINSTEM_CONFIG.fatigueRecovery * (3 / T),
  fatigueGainPerTick: BRAINSTEM_CONFIG.fatigueGainPerTick * (T / 3),
  fatigueInhibitionK: BRAINSTEM_CONFIG.fatigueInhibitionK * (T / 3),
  noiseAmplitude: BRAINSTEM_CONFIG.noiseAmplitude * Math.sqrt(T / 3),
} as const;

// ── Concept ACL defaults ─────────────────────────────────────────────

// ── Agent identity & permissions ─────────────────────────────────────

export type AgentRole = "owner" | "system" | "external" | "readonly";

export interface AgentIdentity {
  id: string;
  role: AgentRole;
  allowedOps: Set<"read" | "write" | "boost" | "forget" | "act">;
}

export const AGENT_DEFAULTS: Record<AgentRole, Set<string>> = {
  owner: new Set(["read", "write", "boost", "forget", "act"]),
  system: new Set(["read", "write", "boost"]),
  external: new Set(["read"]),
  readonly: new Set(["read"]),
};

export interface ConceptACL {
  entityType: "person" | "project" | "topic" | "meta" | "sensitive";
  externalCreation: boolean;
  actTargetEligible: boolean;
  proactiveVerbalize: boolean;
  sensitive: boolean;
  writableBy?: AgentRole[];
}

export const ACL_DEFAULTS: Record<ConceptACL["entityType"], ConceptACL> = {
  person: { entityType: "person", externalCreation: false, actTargetEligible: false, proactiveVerbalize: true, sensitive: false },
  project: { entityType: "project", externalCreation: true, actTargetEligible: false, proactiveVerbalize: true, sensitive: false },
  topic: { entityType: "topic", externalCreation: true, actTargetEligible: false, proactiveVerbalize: true, sensitive: false },
  meta: { entityType: "meta", externalCreation: false, actTargetEligible: false, proactiveVerbalize: false, sensitive: false },
  sensitive: { entityType: "sensitive", externalCreation: true, actTargetEligible: false, proactiveVerbalize: false, sensitive: true },
};

// ── Resource budget tracker ──────────────────────────────────────────

export interface ResourceBudgets {
  maxCpuMsPerMinute: number;
  maxIoOpsPerMinute: number;
  maxDiskWriteMbPerDay: number;
  maxPendingSlowLoops: number;
}

export class ResourceGovernor {
  private cpuUsed = 0;
  private ioOps = 0;
  private diskWriteMb = 0;
  private lastMinuteReset = 0;
  private lastDayReset = 0;
  private pendingSlowLoops = 0;

  constructor(private clock: Clock) {
    this.lastMinuteReset = clock.nowMs();
    this.lastDayReset = clock.nowMs();
  }

  private resetIfNeeded(): void {
    const now = this.clock.nowMs();
    if (now - this.lastMinuteReset > 60_000) {
      this.cpuUsed = 0;
      this.ioOps = 0;
      this.lastMinuteReset = now;
    }
    if (now - this.lastDayReset > 86_400_000) {
      this.diskWriteMb = 0;
      this.lastDayReset = now;
    }
  }

  requestCpu(ms: number): boolean {
    this.resetIfNeeded();
    if (this.cpuUsed + ms > BRAINSTEM_CONFIG.maxCpuMsPerMinute) return false;
    this.cpuUsed += ms;
    return true;
  }

  requestIo(ops: number): boolean {
    this.resetIfNeeded();
    if (this.ioOps + ops > BRAINSTEM_CONFIG.maxIoOpsPerMinute) return false;
    this.ioOps += ops;
    return true;
  }

  requestDiskWrite(mb: number): boolean {
    this.resetIfNeeded();
    if (this.diskWriteMb + mb > BRAINSTEM_CONFIG.maxDiskWriteMbPerDay) return false;
    this.diskWriteMb += mb;
    return true;
  }

  acquireSlowLoop(): boolean {
    if (this.pendingSlowLoops >= 1) return false;
    this.pendingSlowLoops++;
    return true;
  }

  releaseSlowLoop(): void {
    this.pendingSlowLoops = Math.max(0, this.pendingSlowLoops - 1);
  }
}

// ── Act targets ──────────────────────────────────────────────────────

export interface ActTarget {
  type: "person" | "platform";
  id: string;
  conceptPatterns: string[];
  requiresPendingInteraction: boolean;
  cooldownMinutes: number;
  dailyCap: number;
}

export const DEFAULT_ACT_TARGETS: ActTarget[] = [
  {
    type: "person",
    id: "user",
    conceptPatterns: ["user", "user-"],
    requiresPendingInteraction: true,
    cooldownMinutes: 180,
    dailyCap: 2,
  },
  {
    type: "platform",
    id: "self",
    conceptPatterns: [],              // empty = matches any concept
    requiresPendingInteraction: false,
    cooldownMinutes: 60,
    dailyCap: 4,
  },
];

// ── Action costs (for planner EU computation) ────────────────────────

export const ACTION_COSTS: Record<string, number> = {
  reach_out: 0.3,
  explore: 0.1,
  reflect: 0.05,
  post: 0.2,
  activity: 0.15,
  stay_silent: 0.0,
};

export const REWARD_WEIGHTS = {
  goal: 2.0,
  social: 1.0,
  info: 1.5,
  stability: 1.0,
  self: 0.4,
} as const;

export const CS6_CONFIG = {
  maxBirthsPerDay: 2,
  maxSyntheticNodes: 15,
  coActivationThreshold: 0.15,
  conceptDeathDays: 7,
  directionConfidenceThreshold: 0.6,
  minDirectionObservations: 10,
} as const;

export const CS7_CONFIG = {
  wmMaxNodes: 100,
  ltmMaxNodes: 10_000,
  evictionInactivityMs: 48 * 3_600_000,
  pruneAgeDays: 90,
  pruneSalienceThreshold: 0.1,
  pruneMinAccessCount: 3,
  mergeJaccardThreshold: 0.7,
  importanceDecayPerDay: 0.99,
  loadDiversityMaxPerGroup: 2,
} as const;

export const CS8_CONFIG = {
  ewmaAlpha: 0.15,
  noReplyTimeoutMs: 4 * 3_600_000,
  lowResponsivenessThreshold: 0.2,
  cooldownMultiplier: 3.0,
  closenessDecayPerDay: 0.995,
  trustDecayPerDay: 0.998,
  pendingReplyTimeoutMs: 48 * 3_600_000,
} as const;

export const CORTEX_LIMITS = {
  c1: { perDay: 3 },
  c2: { perHour: 8, perDay: 96 },
  c3: { perDay: 20 },
  c4: { perHour: 3, perDay: 12 },
  verbalize: { perHour: 18 },
  sanity: { perDay: 4 },
  goal: { perDay: 5 },
  globalTokenCeiling: 100_000,
} as const;

export interface SelfGatePolicy {
  minSocialEnergy: number;
  maxFatigue: number;
  minSafetyMargin: number;
  minCoherence: number;
}

export const DEFAULT_SELF_GATE: SelfGatePolicy = {
  minSocialEnergy: 0.25,
  maxFatigue: 0.75,
  minSafetyMargin: 0.30,
  minCoherence: 0.40,
};

// ── Time unit constants & helpers ────────────────────────────────────

export type Milliseconds = number & { readonly __ms: unique symbol };
export type Minutes = number & { readonly __min: unique symbol };
export type Hours = number & { readonly __hr: unique symbol };

export const MS_PER_MINUTE = 60_000 as unknown as Milliseconds;
export const MS_PER_HOUR = 3_600_000 as unknown as Milliseconds;
export const MS_PER_DAY = 86_400_000 as unknown as Milliseconds;

// ── Contract version ─────────────────────────────────────────────────

export const CONTRACT_VERSION = "2.1.0"; // major.minor.patch
// major: breaking changes to brainstem API surface
// minor: new features, backwards compatible
// patch: bug fixes, parameter tuning

export function msToMinutes(ms: number): number { return ms / 60_000; }
export function msToHours(ms: number): number { return ms / 3_600_000; }
export function minutesToMs(min: number): number { return min * 60_000; }
export function hoursToMs(hr: number): number { return hr * 3_600_000; }
