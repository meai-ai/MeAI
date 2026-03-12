/**
 * Brainstem Engine — module entry point.
 *
 * BrainstemEngine class wires fast loop, slow loop, stabilizer,
 * world model, planner, and curiosity engine together.
 * Exports module-level API for integration with heartbeat/context.
 */

import {
  BRAINSTEM_CONFIG as C,
  PRODUCTION_CLOCK,
  type Clock,
  ResourceGovernor,
  mulberry32,
  MS_PER_HOUR,
  MS_PER_DAY,
  CONTRACT_VERSION,
  type AgentRole,
  AGENT_DEFAULTS,
  REWARD_WEIGHTS,
  ACTION_COSTS,
} from "./config.js";
import {
  type ConceptGraph,
  type AliasTable,
  boostNode,
  getTopK,
  computeEntropy,
  normalizeId,
  findOrCreateNode,
  buildSemanticEdges,
  addEdge,
  type ConceptSource,
  createAliasTable,
} from "./graph.js";
import {
  type BrainstemState,
  type MicroThoughtRecord,
  createDefaultState,
  migrateState,
  bootstrapGraph,
  getStatePath,
  getMetricsPath,
  getAuditPath,
  getReplayLogPath,
  wakeUpConsolidation,
  type LearnedSkillMapping,
} from "./bootstrap.js";
import {
  fastTick,
  createFastLoopMetrics,
  type FastLoopContext,
  type FastLoopMetrics,
  type ReplayEvent,
} from "./fast-loop.js";
import {
  slowLoopTick as runSlowLoop,
  type SlowLoopContext,
  type ActGateArm,
  type SlowLoopDecisionLog,
  getRecentThoughts,
  resetSlowLoopState,
} from "./thought-gate.js";
import { ConsciousnessStabilizer, type ControlPolicy } from "./stabilizer.js";
import { WorldModel, type ActionType, type OutcomeResult, type ExternalState, type InternalState, type WorldModelState } from "./world-model.js";
import { Planner, type ActionPreference, type GoalForPlanning } from "./planner.js";
import { generateCuriosityTargets, recordExploration, type OutcomeRecord, type ExplorationAction } from "./curiosity-engine.js";
import { OutcomeTracker, type GovernanceState } from "./governance.js";
import { SelfModel, type SelfState, type ActionFamily, type SelfBelief } from "./self-model.js";
import { CortexManager } from "./cortex.js";
import type { GoalInfo, ConceptDomain } from "./graph.js";
import type { AppConfig, Memory } from "../types.js";
import { addGoal, getActiveGoals, type Goal } from "../goals.js";
import { getStoreManager } from "../memory/store-manager.js";
import { MemorySearchEngine } from "../memory/search.js";
import { claudeText } from "../claude-runner.js";
import { runWithTrace } from "../lib/prompt-trace.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { computeCalibration, compactBrainstemData, learnPolicy, runCounterfactualReplay, aggregateRegret, computeAutoTune, readDecisionLogs } from "./debug.js";
import { SocialModel } from "./social-model.js";
import { type LTMGraph, loadLTM, saveLTM, selectWorkingSet, loadFromLTM, evictToLTM, nightlyConsolidation as ltmConsolidation } from "./ltm.js";
import { proposeConceptBirth, pruneDeadConcepts } from "./bootstrap.js";
import { CS7_CONFIG, CS8_CONFIG } from "./config.js";
import { updateEdgeDirections } from "./temporal-credit.js";
import { IdentityRegularizer, type IdentityProfile, type IdentityNarrative, type IdentityTrajectory } from "./identity.js";
import {
  type WorkingMemory,
  type SlotName,
  type WMSlot,
  createWorkingMemory,
  loadSlot,
  tickWorkingMemory,
  formatWorkingMemoryContext,
  serializeWorkingMemory,
  restoreWorkingMemory,
} from "./working-memory.js";
import { reviewGoals } from "../goals.js";
import { getCharacter } from "../character.js";
import { createLogger } from "../lib/logger.js";
import { onState, type StateEvent } from "../lib/state-bus.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const log = createLogger("brainstem");

// ── Intent → Skill Routing ──────────────────────────────────────────

interface IntentSkillMapping {
  intentPattern: RegExp;
  conceptDomains: ConceptDomain[];
  skillName: string;
  actionType: ActionType;
  minActivation: number;
}

const DEFAULT_INTENT_SKILL_MAP: IntentSkillMapping[] = [
  { intentPattern: /搜索|查找|了解|探索|search|learn about/i, conceptDomains: ["general", "quant", "creative"], skillName: "web-search", actionType: "explore", minActivation: 0.4 },
  { intentPattern: /阅读|读|深入|研究|read|study/i, conceptDomains: ["quant", "creative", "meta"], skillName: "deep-reading", actionType: "activity", minActivation: 0.5 },
  { intentPattern: /代码|编程|写|code|vibe/i, conceptDomains: ["quant", "creative"], skillName: "claude-code", actionType: "activity", minActivation: 0.5 },
  { intentPattern: /分享|发|post|tweet/i, conceptDomains: ["social", "creative"], skillName: "x-browser", actionType: "post", minActivation: 0.45 },
  { intentPattern: /聊|说|找.*聊|reach out/i, conceptDomains: ["social"], skillName: "tts", actionType: "reach_out", minActivation: 0.5 },
];

function resolveIntentToSkill(
  thought: MicroThoughtRecord,
  graph: ConceptGraph,
  learnedMappings?: LearnedSkillMapping[],
): { skillName: string; actionType: ActionType; confidence: number } | null {
  let bestMatch: { skillName: string; actionType: ActionType; confidence: number } | null = null;
  let bestScore = 0;

  // 1. Check default (hardcoded) mappings first — they take priority
  for (const mapping of DEFAULT_INTENT_SKILL_MAP) {
    if (!mapping.intentPattern.test(thought.content)) continue;

    let maxActivation = 0;
    for (const conceptId of thought.concepts) {
      const node = graph.nodes[conceptId];
      if (!node) continue;
      const domain = node.domain ?? "general";
      if (mapping.conceptDomains.includes(domain) && node.activation >= mapping.minActivation) {
        maxActivation = Math.max(maxActivation, node.activation);
      }
    }

    if (maxActivation < mapping.minActivation) continue;

    const score = maxActivation;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        skillName: mapping.skillName,
        actionType: mapping.actionType as ActionType,
        confidence: score,
      };
    }
  }

  // 2. Check learned mappings (lower priority — only win if default didn't match)
  if (!bestMatch && learnedMappings) {
    for (const lm of learnedMappings) {
      try {
        const regex = new RegExp(lm.pattern, "i");
        if (!regex.test(thought.content)) continue;
      } catch { continue; }

      // Weight by success rate
      const total = lm.successCount + lm.failCount;
      const successRate = total > 0 ? lm.successCount / total : 0.5;
      const score = successRate * 0.8; // learned mappings have 0.8 max confidence

      if (score > bestScore && score >= lm.minActivation * 0.5) {
        bestScore = score;
        bestMatch = {
          skillName: lm.skillName,
          actionType: lm.actionType as ActionType,
          confidence: score,
        };
      }
    }
  }

  return bestMatch;
}

// ── BrainstemEngine ──────────────────────────────────────────────────

class BrainstemEngine {
  private state: BrainstemState;
  private clock: Clock;
  private rng: () => number;
  private governor: ResourceGovernor;
  private stabilizer: ConsciousnessStabilizer;
  private worldModel: WorldModel;
  private selfModel: SelfModel;
  private planner: Planner;
  private outcomeTracker: OutcomeTracker;
  private identityRegularizer: IdentityRegularizer;
  private cortexManager: CortexManager;
  private socialModel: SocialModel;
  private ltm: LTMGraph;
  private workingMemory: WorkingMemory;
  private aliasTable: AliasTable;

  private fastInterval: ReturnType<typeof setInterval> | null = null;
  private slowTimeout: ReturnType<typeof setTimeout> | null = null;
  private metrics: FastLoopMetrics;
  private dataPath: string;
  private actGateArm: ActGateArm | null = null;
  private lastConversationAt = 0;
  private lastWinnerClusterId = "";
  private memoryCache: Memory[] = [];
  private memoryCacheAt = 0;
  private searchEngine = new MemorySearchEngine();
  private outcomes: OutcomeRecord[] = [];
  private started = false;
  private wasNightMode = false;
  private lastGoalProposedAt = 0;
  // M4: Event-loop lag detection
  private eventLoopLagMs = 0;
  private lagCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Observability: last consolidation stats
  private lastLtmPruned = 0;
  private lastLtmTotal = 0;
  // CS7: Track actual WM loads from LTM for conceptTurnover24h
  private ltmLoadTimestamps: number[] = [];

  constructor(private config: AppConfig) {
    this.dataPath = config.statePath;
    this.clock = PRODUCTION_CLOCK;
    this.governor = new ResourceGovernor(this.clock);
    this.stabilizer = new ConsciousnessStabilizer(this.clock);
    this.worldModel = new WorldModel(this.dataPath, this.clock);
    this.selfModel = new SelfModel(this.dataPath, this.clock);
    this.planner = new Planner(this.dataPath, this.clock);
    this.outcomeTracker = new OutcomeTracker(this.dataPath, this.clock);
    this.identityRegularizer = new IdentityRegularizer(this.dataPath, this.clock);
    this.cortexManager = new CortexManager(this.dataPath, this.clock);
    this.socialModel = new SocialModel(this.dataPath, this.clock);
    this.ltm = loadLTM(this.dataPath);
    this.workingMemory = createWorkingMemory();
    this.aliasTable = createAliasTable();

    // Load or create state
    const statePath = getStatePath(this.dataPath);
    const raw = readJsonSafe<Record<string, unknown>>(statePath, {});
    if (raw.version) {
      this.state = migrateState(raw);
    } else {
      this.state = createDefaultState();
    }

    // Restore persisted WM slots (must be after state load)
    if (this.state.workingMemorySlots) {
      restoreWorkingMemory(this.workingMemory, this.state.workingMemorySlots as Record<string, unknown>);
    }

    // Seed PRNG
    const seeds = this.state.seeds ?? {
      noise: Math.floor(Math.random() * 2147483647),
      replay: Math.floor(Math.random() * 2147483647),
      sampling: Math.floor(Math.random() * 2147483647),
    };
    this.state.seeds = seeds;
    this.rng = mulberry32(seeds.noise);

    // Load persisted alias table
    const aliasPath = path.join(this.dataPath, "brainstem", "alias-table.json");
    const persistedAlias = readJsonSafe<AliasTable>(aliasPath, createAliasTable());
    if (persistedAlias.canonical) this.aliasTable = persistedAlias;

    // Restore stabilizer state
    this.stabilizer.restoreState(
      this.state.csi,
      this.state.csiMode,
      this.state.lastModeTransitionAt,
      this.state.csiAtTransition,
    );

    // H3: configHash + CONTRACT_VERSION tracking — detect changes between restarts
    const configHash = createHash("sha256")
      .update(JSON.stringify(C))
      .digest("hex")
      .slice(0, 16);
    if (this.state.configHash && this.state.configHash !== configHash) {
      log.warn(`config changed since last run: ${this.state.configHash} → ${configHash}`);
      // Store snapshot for future diff capability
      if (this.state.lastConfigSnapshot) {
        log.info(`config diff: previous snapshot available. Current config keys: [${Object.keys(C).join(", ")}]`);
      }
    }
    this.state.configHash = configHash;
    this.state.lastConfigSnapshot = JSON.stringify(C);

    // Contract version tracking
    if (this.state.contractVersion && this.state.contractVersion !== CONTRACT_VERSION) {
      const [oldMajor] = this.state.contractVersion.split(".").map(Number);
      const [newMajor] = CONTRACT_VERSION.split(".").map(Number);
      if (oldMajor !== newMajor) {
        log.error(`CONTRACT_VERSION major change: ${this.state.contractVersion} → ${CONTRACT_VERSION} — potential breaking changes`);
      } else {
        log.info(`CONTRACT_VERSION changed: ${this.state.contractVersion} → ${CONTRACT_VERSION}`);
      }
    }
    this.state.contractVersion = CONTRACT_VERSION;

    this.metrics = createFastLoopMetrics();

    // Hydrate co-activation counts from persisted state
    if (this.state.coActivationCountsPersisted) {
      for (const [key, val] of Object.entries(this.state.coActivationCountsPersisted)) {
        this.metrics.coActivationCounts.set(key, val);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    // Bootstrap graph if empty
    if (Object.keys(this.state.graph.nodes).length === 0) {
      this.bootstrapFromExistingState();
    } else {
      // Rebuild edges on existing graph to apply connectivity fixes
      this.repairGraphConnectivity();
    }

    // Warmup dampening (first 5 min)
    log.info("🧠 Started");

    // M4: Event-loop lag detection — check every 10s
    this.lagCheckInterval = setInterval(() => {
      const start = Date.now();
      setImmediate(() => {
        this.eventLoopLagMs = Date.now() - start;
        if (this.eventLoopLagMs > 100) {
          log.warn(`event-loop lag: ${this.eventLoopLagMs}ms`);
        }
      });
    }, 10_000);

    // Fast loop: 3s interval
    this.fastInterval = setInterval(() => {
      try {
        this.runFastTick();
      } catch (err) {
        log.error("fast loop error", err);
      }
    }, C.tickSeconds * 1000);

    // Slow loop: recursive setTimeout (~60s)
    this.scheduleSlowLoop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.fastInterval) {
      clearInterval(this.fastInterval);
      this.fastInterval = null;
    }
    if (this.slowTimeout) {
      clearTimeout(this.slowTimeout);
      this.slowTimeout = null;
    }
    if (this.lagCheckInterval) {
      clearInterval(this.lagCheckInterval);
      this.lagCheckInterval = null;
    }

    // Persist final state
    this.persistState();
    this.worldModel.save();
    this.selfModel.save();
    this.socialModel.save();
    saveLTM(this.ltm, this.dataPath);

    log.info("🧠 Stopped");
  }

  // ── Fast tick ──────────────────────────────────────────────────

  private runFastTick(): void {
    const ctx: FastLoopContext = {
      graph: this.state.graph,
      state: this.state,
      clock: this.clock,
      rng: this.rng,
      getPolicy: () => this.stabilizer.getPolicy(),
      getActiveGoals: () => this.mapGoals(),
      getMemoriesForReplay: (mode, winnerId) => this.getReplayMemories(mode, winnerId),
      isConversationActive: () => this.isConversationActive(),
      governor: this.governor,
      onPersist: () => this.persistState(),
      onReplayEvent: (event) => this.writeReplayEvent(event),
      workingMemory: this.workingMemory,
    };

    fastTick(ctx, this.metrics);

    // CS5b: Sync CSI mode + affect_valence + passive recovery each fast tick
    this.selfModel.setCsiMode(this.stabilizer.getMode());
    const selfNode = this.state.graph.nodes["self"];
    if (selfNode) this.selfModel.syncAffectValence(selfNode.valence);
    this.selfModel.applyRecovery();
  }

  // ── Slow loop ──────────────────────────────────────────────────

  private scheduleSlowLoop(): void {
    if (!this.started) return;

    // Night mode: skip slow loop 0-7am
    const hour = new Date().getHours();
    const isNight = hour >= C.nightStartHour && hour < C.nightEndHour;

    if (isNight) {
      this.wasNightMode = true;
      this.slowTimeout = setTimeout(() => this.scheduleSlowLoop(), 60_000);
      return;
    }

    // Wake-up consolidation: runs once when exiting night mode
    if (this.wasNightMode) {
      this.wasNightMode = false;
      this.runWakeUpConsolidation().catch(err => log.error("wake-up consolidation error", err));
    }

    // M4: Under high event-loop lag, increase slow loop interval
    const lagAdjustedMin = this.eventLoopLagMs > 100 ? C.slowLoopMinMs * 2 : C.slowLoopMinMs;
    const lagAdjustedMax = this.eventLoopLagMs > 100 ? C.slowLoopMaxMs * 2 : C.slowLoopMaxMs;
    // Jittered interval 45-120s (or 90-240s under lag)
    const jitter = lagAdjustedMin + Math.random() * (lagAdjustedMax - lagAdjustedMin);

    this.slowTimeout = setTimeout(async () => {
      try {
        await this.runSlowLoopTick();
      } catch (err) {
        log.error("slow loop error", err);
      }
      this.scheduleSlowLoop();
    }, jitter);
  }

  private async runSlowLoopTick(): Promise<void> {
    const traceId = `bs_${Date.now()}`;
    return runWithTrace({ traceId, source: "brainstem" }, () => this._runSlowLoopTick());
  }

  private async _runSlowLoopTick(): Promise<void> {
    // CS7: Select working set from LTM every 30 min
    const now = this.clock.nowMs();
    if (now - (this.ltm.lastLoadAt ?? 0) > 30 * 60_000) {
      const wmSize = Object.keys(this.state.graph.nodes).length;
      const toLoad = selectWorkingSet(this.ltm, this.state, CS7_CONFIG.wmMaxNodes - wmSize);
      for (const id of toLoad) {
        loadFromLTM(this.ltm, this.state.graph, id);
        this.ltmLoadTimestamps.push(now);
      }
      // Prune load timestamps older than 24h
      const cutoff24h = now - 86_400_000;
      this.ltmLoadTimestamps = this.ltmLoadTimestamps.filter(t => t > cutoff24h);
      this.ltm.lastLoadAt = now;
    }

    // Auto-calibration rollback check
    const rollback = this.stabilizer.checkAutoTuneRollback(this.stabilizer.getCsi(), now);
    if (rollback) {
      this.outcomeTracker.writeAuditRecord({
        type: "brainstem_action",
        action: "auto_tune_rollback",
        timestamp: now,
        details: { revertedDeltas: rollback.deltas, triggerCsi: rollback.csi },
      });
    }

    const ctx: SlowLoopContext = {
      graph: this.state.graph,
      state: this.state,
      clock: this.clock,
      stabilizer: this.stabilizer,
      governor: this.governor,
      getMemories: () => this.getCachedMemories().map(m => ({ key: m.key, timestamp: m.timestamp })),
      getGoals: () => getActiveGoals().map(g => ({
        id: g.id,
        priority: g.priority ?? 0.5,
        progress: g.progress,
        relatedTopics: g.relatedTopics ?? [],
      })),
      getDiscoveries: () => this.getDiscoveries(),
      isConversationActive: () => this.isConversationActive(),
      isQuietHours: () => this.isQuietHours(),
      hasPendingInteraction: (targetId) => {
        return this.outcomeTracker.getPendingOutcomes().some(
          o => o.actionType === "reach_out" && o.triggeredBy.clusterConceptIds.some(
            id => id.includes(targetId),
          ),
        );
      },
      isConceptSuppressed: (conceptId) => this.outcomeTracker.isActivelySuppressed(conceptId),
      selfModel: this.selfModel,
      socialModel: this.socialModel,
      onThought: (thought) => {
        log.info(`thought: "${thought.content}" [${thought.anchor}]`);
        this.lastWinnerClusterId = thought.concepts.join("+");
      },
      onReflectArm: () => {
        log.info("reflect gate armed");
      },
      onActArm: (arm) => {
        this.actGateArm = arm;
        log.info(`act gate armed: target=${arm.targetId}`);
        // Write audit record with grounding evidence
        if (arm.evidencePacket) {
          this.outcomeTracker.writeAuditRecord({
            type: "brainstem_action",
            action: "act_gate_armed",
            decisionLogId: arm.microThoughtId,
            groundingSummary: arm.evidencePacket.groundingRefs
              .map(g => `${g.type}:${g.id}(w=${g.weight.toFixed(2)})`)
              .join(", "),
            timestamp: arm.evidencePacket.timestamp,
            details: {
              evidencePacket: arm.evidencePacket,
            },
          });
        }
      },
      workingMemory: this.workingMemory,
      onDecisionLog: (dl) => this.writeDecisionLog(dl),
      onMetrics: (m) => {
        this.writeMetrics(m);
        // L4: Update fast loop novelty for loop detection
        if (typeof m.noveltyAvg === "number") {
          this.metrics.lastNoveltyAvg = m.noveltyAvg;
        }
      },
      cortexBudgetCheck: (api, tokens) => this.cortexManager.trackExternalCall(api, tokens),
    };

    await runSlowLoop(ctx);

    // CS5b.9: Apply half-life decay to beliefs every slow-loop tick
    this.selfModel.tickBeliefDecay();

    // CS5b: Recompute self_coherence after slow loop (includes reflection, 5b.4)
    this.recomputeSelfCoherence();

    // T6: Controller replay — log (derivedState, policy) snapshot for future policy learning
    this.writeControllerSnapshot();

    // Sync stabilizer state back
    const prevMode = this.state.csiMode;
    this.state.csi = this.stabilizer.getCSI();
    this.state.csiMode = this.stabilizer.getMode();
    // Notify cortex of Red → non-Red transition (starts C-4 cooldown)
    if (prevMode === "red" && this.state.csiMode !== "red") {
      this.cortexManager.notifyRedModeExit();
    }
    // Notify cortex of Yellow mode for C-4 budget halving
    this.cortexManager.setYellowMode(this.state.csiMode === "yellow");

    // L13: Log curiosity metrics
    try {
      const curiosityTargets = this.getCuriosityTargets();
      if (curiosityTargets.length > 0) {
        const topTarget = curiosityTargets[0];
        this.writeMetrics({
          topLearningNeed: topTarget.learningNeed,
          topVOI: topTarget.voi,
          curiosityTargetCount: curiosityTargets.length,
          curiosityDirectedRate: curiosityTargets.filter(t => t.queryType === "search" || t.queryType === "re_observe").length / curiosityTargets.length,
        });
      }
    } catch { /* curiosity metrics are non-critical */ }

    // Plan generation: create/update plans based on current state
    await this.runPlanGeneration();
  }

  // ── Wake-up consolidation ─────────────────────────────────────

  private async runWakeUpConsolidation(): Promise<void> {
    log.info("wake-up consolidation starting");

    try {
      // 1. Graph consolidation (edge pruning, node eviction, merge scan, fragmentation repair)
      const coActivationCounts = this.metrics.coActivationCounts;
      const result = await wakeUpConsolidation(this.state.graph, coActivationCounts, this.clock, this.state.activationHistory, this.aliasTable, this.cortexManager);
      log.info(`consolidation: ${result.nodesEvicted} nodes evicted, ${result.edgesPruned} edges pruned, ${result.edgesStrengthened} edges strengthened, ${result.conceptsSynthesized} concepts synthesized`);

      // 1b. CS6: Concept birth + death
      try {
        const birthResult = await proposeConceptBirth(
          this.state.graph, coActivationCounts, this.state.activationHistory,
          this.clock, this.cortexManager, this.state,
        );
        const deathResult = pruneDeadConcepts(this.state.graph, coActivationCounts, this.clock, this.state);
        if (birthResult.count > 0 || deathResult.count > 0) {
          log.info(`CS6: ${birthResult.count} concept births, ${deathResult.count} concept deaths`);
          // Write individual audit records per birth/death event
          for (const birth of birthResult.births) {
            this.outcomeTracker.writeAuditRecord({
              type: "brainstem_action",
              action: "concept_birth",
              timestamp: this.clock.nowMs(),
              details: { id: birth.id, label: birth.label, members: birth.members },
            });
          }
          for (const death of deathResult.deaths) {
            this.outcomeTracker.writeAuditRecord({
              type: "brainstem_action",
              action: "concept_death",
              timestamp: this.clock.nowMs(),
              details: { id: death.id, label: death.label },
            });
          }
        }
      } catch { /* non-fatal */ }

      // 1c. CS7: Nightly LTM consolidation
      try {
        const ltmResult = ltmConsolidation(this.ltm, this.clock);
        this.lastLtmPruned = ltmResult.pruned;
        this.lastLtmTotal = ltmResult.total;
        log.info(`LTM consolidation: pruned=${ltmResult.pruned}, merged=${ltmResult.merged}, total=${ltmResult.total}`);
      } catch { /* non-fatal */ }

      // 1d. CS8: Daily social model decay
      try {
        this.socialModel.dailyDecay();
      } catch { /* non-fatal */ }

      // 1e. CS5b.9: Reflection loop for beliefs
      try {
        this.selfModel.reflectionUpdateBeliefs();
      } catch { /* non-fatal */ }

      // 1f. CS6b: Edge direction update
      try {
        if (!this.state.edgeDirectionStats) this.state.edgeDirectionStats = {};
        const dirUpdated = updateEdgeDirections(
          this.state.graph, this.state.activationHistory,
          this.state.edgeDirectionStats, this.clock.nowMs(),
        );
        if (dirUpdated > 0) log.info(`CS6b: ${dirUpdated} edge directions updated`);
      } catch { /* non-fatal */ }

      // 1g. Abandon stale plans
      this.planner.abandonStalePlans();

      // 2. Goal review (stale/orphaned/budget enforcement)
      const goalReview = reviewGoals();
      if (goalReview.stalled.length > 0) log.info(`goal review: ${goalReview.stalled.length} stalled`);
      if (goalReview.orphaned.length > 0) log.info(`goal review: ${goalReview.orphaned.length} orphaned`);
      if (goalReview.demoted.length > 0) log.info(`goal review: ${goalReview.demoted.length} demoted`);

      // 2b. Goal propose from micro-thought themes
      await this.proposeGoalFromThemes();

      // 2c. Monthly narrative self model
      await this.computeMonthlyNarrative();

      // 3. Auto-calibration (weekly, needs 500+ Green-mode ticks)
      const cal = computeCalibration(this.dataPath);
      if (cal) {
        this.stabilizer.setCalibration(cal.noveltyCenter, cal.rotationCenter, cal.entropyCenter);
        log.info(`calibration updated: novelty=${cal.noveltyCenter.toFixed(2)}, rotation=${cal.rotationCenter.toFixed(1)}, entropy=${cal.entropyCenter.toFixed(2)} (n=${cal.sampleSize})${cal.capped ? " [CAPPED]" : ""}`);
        this.outcomeTracker.writeAuditRecord({
          type: "brainstem_action",
          action: "auto_calibration",
          timestamp: this.clock.nowMs(),
          details: {
            noveltyCenter: cal.noveltyCenter,
            rotationCenter: cal.rotationCenter,
            entropyCenter: cal.entropyCenter,
            sampleSize: cal.sampleSize,
            capped: cal.capped ?? false,
          },
        });
      }

      // 3a2. Daily auto-tune: micro-parameter adjustments
      try {
        const autoTune = computeAutoTune(this.dataPath, this.getMetrics());
        if (autoTune) {
          this.stabilizer.applyAutoTune(autoTune.deltas, this.clock.nowMs());
          log.info(`auto-tune: ${autoTune.deltas.length} adjustments applied`);
        }
      } catch { /* non-fatal */ }

      // 3b. Policy learning from controller replay data
      const policyResult = learnPolicy(this.dataPath);
      if (policyResult) {
        const adjustments = policyResult.adjustments.map(a => ({
          knob: a.knob,
          delta: a.proposedValue - a.currentValue,
        }));
        this.stabilizer.applyLearnedAdjustments(adjustments);
        log.info(`policy learning: ${policyResult.adjustments.length} adjustments from ${policyResult.sampleSize} samples${policyResult.capped ? " [CAPPED]" : ""}`);
        this.outcomeTracker.writeAuditRecord({
          type: "brainstem_action",
          action: "policy_learning",
          timestamp: this.clock.nowMs(),
          details: {
            adjustments: policyResult.adjustments,
            sampleSize: policyResult.sampleSize,
            capped: policyResult.capped,
          },
        });
      }

      // 3c. Counterfactual replay: re-simulate past decisions with alternatives
      try {
        const cfResults = runCounterfactualReplay(this.dataPath, this.worldModel, this.clock);
        if (cfResults.length > 0) {
          const regretByAction = aggregateRegret(cfResults);
          this.planner.applyCounterfactualBias(regretByAction);
          log.info(`counterfactual replay: ${cfResults.length} decisions analyzed, avg regret by action: ${Object.entries(regretByAction).map(([a, r]) => `${a}=${r.toFixed(2)}`).join(", ")}`);
          this.outcomeTracker.writeAuditRecord({
            type: "brainstem_action",
            action: "counterfactual_replay",
            timestamp: this.clock.nowMs(),
            details: {
              decisionsAnalyzed: cfResults.length,
              regretByAction,
              topRegretDecision: cfResults[0] ? {
                action: cfResults[0].originalAction,
                regret: cfResults[0].regret,
              } : null,
            },
          });
        }
      } catch (err) {
        log.warn("counterfactual replay error", err);
      }

      // 4. Data compaction (all brainstem .jsonl files + gzip)
      const compaction = compactBrainstemData(this.dataPath);
      if (compaction.metrics.removed > 0) log.info(`metrics compacted: ${compaction.metrics.removed} removed, ${compaction.metrics.kept} kept`);
      if (compaction.audit.removed > 0) log.info(`audit compacted: ${compaction.audit.removed} removed, ${compaction.audit.kept} kept`);
      if (compaction.replay.removed > 0) log.info(`replay compacted: ${compaction.replay.removed} removed, ${compaction.replay.kept} kept`);
      if (compaction.compressed > 0) log.info(`${compaction.compressed} aged files compressed to .gz`);
    } catch (err) {
      log.error("wake-up consolidation error", err);
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────

  private bootstrapFromExistingState(): void {
    const memories = this.getCachedMemories();
    const goals = getActiveGoals();

    // Load legacy activations from heartbeat state
    const heartbeatState = readJsonSafe<Record<string, unknown>>(
      path.join(this.dataPath, "heartbeat", "state.json"),
      {},
    );
    const legacyActivations = (heartbeatState.activations ?? {}) as Record<string, { weight: number }>;

    // Load discoveries
    const discoveries = this.getDiscoveries();

    // Load opinions
    const opinions = readJsonSafe<{ opinions?: Array<{ topic: string; stance?: string; position?: string }> }>(
      path.join(this.dataPath, "opinions.json"),
      { opinions: [] },
    ).opinions ?? [];

    this.state.graph = bootstrapGraph(
      memories,
      goals,
      discoveries,
      opinions,
      legacyActivations,
      this.clock,
    );

    // CS5b: Cold start self-model from existing metrics
    const internal = this.buildInternalState();
    const selfNode = this.state.graph.nodes["self"];
    this.selfModel.coldStartFrom(internal, selfNode?.valence, this.state.avgPredictionError);

    log.info(`bootstrapped graph: ${Object.keys(this.state.graph.nodes).length} nodes, ${this.state.graph.edges.length} edges`);
  }

  private repairGraphConnectivity(): void {
    const graph = this.state.graph;
    const edgesBefore = graph.edges.length;

    // Rebuild semantic edges (includes bridge fix for disconnected nodes)
    buildSemanticEdges(graph);

    // Add prefix-based edges for memory nodes
    const prefixGroups = new Map<string, string[]>();
    for (const node of Object.values(graph.nodes)) {
      if (node.id === "self") continue;
      for (const key of node.memoryKeys) {
        const prefix = key.split(".")[0];
        if (!prefix) continue;
        if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
        prefixGroups.get(prefix)!.push(node.id);
      }
    }
    for (const [, group] of prefixGroups) {
      const unique = [...new Set(group)];
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length && j < i + 5; j++) {
          addEdge(graph, unique[i], unique[j], "semantic", 0.25);
        }
      }
    }

    // Warm up cold nodes only if graph has very low total energy
    // (avoids overriding natural decay on every restart)
    const totalA = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0);
    if (totalA < C.energyMax * 0.3) {
      for (const node of Object.values(graph.nodes)) {
        if (node.id === "self") continue;
        if (node.activation < 0.05) {
          switch (node.source) {
            case "memory":    node.activation = 0.1;  node.salience = 0.05; break;
            case "goal":      node.activation = 0.2;  node.salience = 0.1;  break;
            case "curiosity": node.activation = 0.15; node.salience = 0.08; break;
            case "reflection": node.activation = 0.1; node.salience = 0.05; break;
          }
        }
      }
      log.info("warmed up cold nodes (low total energy)");
    }

    log.info(`repaired connectivity: ${edgesBefore} → ${graph.edges.length} edges`);
  }

  // ── Memory cache ───────────────────────────────────────────────

  private getCachedMemories(): Memory[] {
    const now = this.clock.nowMs();
    if (now - this.memoryCacheAt > 10 * 60_000) { // refresh every 10 min
      try {
        const store = getStoreManager();
        this.memoryCache = store.loadAll();
        this.searchEngine.buildIndex(this.memoryCache);
      } catch {
        this.memoryCache = [];
      }
      this.memoryCacheAt = now;
    }
    return this.memoryCache;
  }

  // ── Helpers ────────────────────────────────────────────────────

  private mapGoals(): GoalInfo[] {
    return getActiveGoals().map(g => ({
      id: g.id,
      priority: g.priority ?? 0.5,
      progress: g.progress,
      relatedTopics: g.relatedTopics ?? [],
    }));
  }

  private getDiscoveries(): Array<{ query: string; timestamp: number; category: string }> {
    try {
      const curiosityState = readJsonSafe<{
        discoveries?: Array<{ query: string; timestamp: number; category: string }>;
      }>(path.join(this.dataPath, "curiosity.json"), { discoveries: [] });
      return (curiosityState.discoveries ?? []).slice(-20);
    } catch {
      return [];
    }
  }

  private getReplayMemories(
    mode: "similar" | "adjacent" | "goal" | "grounded" | "random" | "counter_evidence",
    winnerId?: string,
  ): Array<{ key: string; nodeId: string }> {
    const memories = this.getCachedMemories();
    if (memories.length === 0) return [];

    const graph = this.state.graph;
    const result: Array<{ key: string; nodeId: string }> = [];

    switch (mode) {
      case "similar":
        // Stage 1: Graph-link pre-filter — get all memories linked to winner and neighbors
        if (winnerId && graph.nodes[winnerId]) {
          const winnerNode = graph.nodes[winnerId];
          for (const key of winnerNode.memoryKeys) {
            result.push({ key, nodeId: winnerId });
          }
          // Also include 1-hop neighbor memories as candidates
          const neighborIds = graph.edges
            .filter(e => e.source === winnerId || e.target === winnerId)
            .map(e => e.source === winnerId ? e.target : e.source)
            .filter(id => id !== "self" && graph.nodes[id]?.memoryKeys.length > 0);
          for (const nId of neighborIds.slice(0, 5)) {
            for (const key of graph.nodes[nId].memoryKeys) {
              if (!result.some(r => r.key === key)) {
                result.push({ key, nodeId: nId });
              }
            }
          }

          // Stage 2: BM25 rerank — score candidates by relevance to winner's label
          if (result.length > 1) {
            const query = winnerNode.label;
            const searchResults = this.searchEngine.search(query, { limit: 20, applyDecay: true });
            const scoreMap = new Map<string, number>();
            for (const sr of searchResults) scoreMap.set(sr.memory.key, sr.score);
            result.sort((a, b) => (scoreMap.get(b.key) ?? 0) - (scoreMap.get(a.key) ?? 0));
          }
        }
        break;

      case "goal":
        // Find memories linked to goal-related nodes
        for (const node of Object.values(graph.nodes)) {
          if (node.drive > 0.3) {
            for (const key of node.memoryKeys) {
              result.push({ key, nodeId: node.id });
            }
          }
        }
        break;

      case "random":
        // Random node with memories
        const nodesWithMem = Object.values(graph.nodes).filter(n => n.memoryKeys.length > 0);
        if (nodesWithMem.length > 0) {
          const idx = Math.floor(this.rng() * nodesWithMem.length);
          const node = nodesWithMem[idx];
          for (const key of node.memoryKeys) {
            result.push({ key, nodeId: node.id });
          }
        }
        break;

      case "adjacent":
        // Neighbors of winner
        if (winnerId) {
          const neighbors = graph.edges
            .filter(e => e.source === winnerId || e.target === winnerId)
            .map(e => e.source === winnerId ? e.target : e.source)
            .filter(id => id !== "self" && graph.nodes[id]?.memoryKeys.length > 0);
          for (const nId of neighbors.slice(0, 3)) {
            for (const key of graph.nodes[nId].memoryKeys) {
              result.push({ key, nodeId: nId });
            }
          }
        }
        break;

      case "grounded":
        // Most strongly grounded nodes
        const grounded = Object.values(graph.nodes)
          .filter(n => n.memoryKeys.length > 0 && n.id !== "self")
          .sort((a, b) => b.memoryKeys.length - a.memoryKeys.length);
        for (const node of grounded.slice(0, 3)) {
          for (const key of node.memoryKeys) {
            result.push({ key, nodeId: node.id });
          }
        }
        break;

      case "counter_evidence": {
        // CS6: Find memories with opposite valence OR failure outcomes related to winner topic
        const winnerNode = winnerId ? graph.nodes[winnerId] : null;
        const winnerValence = winnerNode?.valence ?? 0;

        // Strategy 1: Opposite-valence memories
        for (const node of Object.values(graph.nodes)) {
          if (node.id === "self" || node.memoryKeys.length === 0) continue;
          if (node.drive > 0.3) continue; // skip goal-grounded
          if ((winnerValence >= 0 && node.valence < -0.2) ||
              (winnerValence < 0 && node.valence > 0.2)) {
            for (const key of node.memoryKeys) {
              result.push({ key, nodeId: node.id });
            }
          }
        }

        // Strategy 2: Failure-outcome memories from same action family
        const resolvedNegative = this.outcomes.filter(o =>
          o.outcome === "negative" && o.triggeredBy?.clusterConceptIds?.some(
            cid => winnerId && (cid === winnerId || graph.edges.some(
              e => (e.source === cid && e.target === winnerId) || (e.source === winnerId && e.target === cid),
            )),
          ),
        );
        for (const negOutcome of resolvedNegative.slice(0, 3)) {
          for (const cid of negOutcome.triggeredBy?.clusterConceptIds ?? []) {
            const node = graph.nodes[cid];
            if (node && node.memoryKeys.length > 0 && !result.some(r => r.nodeId === cid)) {
              for (const key of node.memoryKeys) {
                result.push({ key, nodeId: cid });
              }
            }
          }
        }

        // Sort by strength of opposition
        result.sort((a, b) => {
          const aV = graph.nodes[a.nodeId]?.valence ?? 0;
          const bV = graph.nodes[b.nodeId]?.valence ?? 0;
          return Math.abs(bV) - Math.abs(aV);
        });
        break;
      }
    }

    return result.slice(0, 5);
  }

  private isConversationActive(): boolean {
    return this.clock.nowMs() - this.lastConversationAt < 60_000;
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    return hour >= C.nightStartHour && hour < C.nightEndHour;
  }

  // ── Persistence ────────────────────────────────────────────────

  private persistState(): void {
    const statePath = getStatePath(this.dataPath);
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Persist co-activation counts (Map → Record for JSON serialization)
    const coActRecord: Record<string, number> = {};
    for (const [key, val] of this.metrics.coActivationCounts) {
      if (val > 0) coActRecord[key] = val;
    }
    this.state.coActivationCountsPersisted = coActRecord;
    this.state.workingMemorySlots = serializeWorkingMemory(this.workingMemory);

    writeJsonAtomic(statePath, this.state);
    writeJsonAtomic(path.join(this.dataPath, "brainstem", "alias-table.json"), this.aliasTable);
    this.selfModel.save();
    this.cortexManager.save();
    this.socialModel.save();

    // CS7: Evict inactive WM nodes to LTM (with swap penalty protection)
    const now = this.clock.nowMs();
    const inactiveNodes = Object.values(this.state.graph.nodes)
      .filter(n => n.id !== "self" && now - n.lastActivated > CS7_CONFIG.evictionInactivityMs);
    for (const node of inactiveNodes) {
      // Swap penalty: nodes with high activation lose 50% of co-activation stats (design doc)
      if (node.activation > 0.2) {
        for (const [key, val] of this.metrics.coActivationCounts) {
          if (key.includes(node.id)) {
            this.metrics.coActivationCounts.set(key, Math.floor(val * 0.5));
          }
        }
      }
      evictToLTM(this.state.graph, this.ltm, node.id, this.state.tickCount, this.metrics.coActivationCounts);
    }
    saveLTM(this.ltm, this.dataPath);
  }

  private writeDecisionLog(dl: SlowLoopDecisionLog): void {
    try {
      const metricsPath = getMetricsPath(this.dataPath);
      const dir = path.dirname(metricsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(metricsPath, JSON.stringify(dl) + "\n");
    } catch {
      // non-critical
    }
  }

  private writeMetrics(m: Record<string, number | string | boolean>): void {
    // Metrics are logged as part of decision log
  }

  private writeReplayEvent(event: ReplayEvent): void {
    try {
      const replayPath = getReplayLogPath(this.dataPath);
      const dir = path.dirname(replayPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(replayPath, JSON.stringify(event) + "\n");
    } catch {
      // non-critical
    }
  }

  /** T6: Log (derivedState, policy) pair for future controller/policy learning. */
  private writeControllerSnapshot(): void {
    try {
      const policy = this.stabilizer.getPolicy();
      const record = {
        type: "controller_snapshot" as const,
        timestamp: this.clock.nowMs(),
        tick: this.state.tickCount,
        derivedState: {
          csi: this.stabilizer.getCSI(),
          mode: this.stabilizer.getMode(),
          entropy: computeEntropy(this.state.graph),
          graphSize: Object.keys(this.state.graph.nodes).length,
          edgeCount: this.state.graph.edges.length,
          avgPredictionError: this.state.avgPredictionError,
        },
        // CS6/7/8 observability
        cs6: {
          conceptBirthsToday: this.state.conceptBirthsToday ?? 0,
          conceptDeathsToday: this.state.conceptDeathsToday ?? 0,
          causalEdgesFormed: this.state.causalEdgesFormed ?? 0,
          conceptBirthRate: (this.state.conceptBirthDates ?? []).length, // actual births in last 7d
        },
        cs7: {
          ltmSize: Object.keys(this.ltm.nodes).length,
          wmSize: Object.keys(this.state.graph.nodes).length,
          conceptTurnover24h: (() => {
            const wmSize = Object.keys(this.state.graph.nodes).length;
            return wmSize > 0 ? this.ltmLoadTimestamps.length / wmSize : 0;
          })(),
          ltmPruneRate: this.lastLtmPruned, // absolute count per consolidation (design doc range: 0-20)
        },
        cs8: {
          socialResponsiveness: this.socialModel.getTargetState(getCharacter().user.name.toLowerCase())?.responsivenessEwma ?? 0.5,
          socialGateBlocks: this.socialModel.getGateBlockCount(),
        },
        cs5b9: {
          selfBeliefCount: this.selfModel.getBeliefs().length,
          selfBeliefAvgConfidence: (() => {
            const beliefs = this.selfModel.getBeliefs();
            if (beliefs.length === 0) return 0;
            return beliefs.reduce((s, b) => s + b.confidence, 0) / beliefs.length;
          })(),
        },
        counterEvidenceReplayRate: this.metrics.diversityTracker.entrenchedReplays > 0
          ? this.metrics.diversityTracker.counterEvidenceReplays / this.metrics.diversityTracker.entrenchedReplays
          : 0,
        clusterLifetimeAvg: this.computeClusterLifetime().avg,
        clusterLifetimeP90: this.computeClusterLifetime().p90,
        policy: {
          mode: policy.mode,
          noiseScale: policy.noiseScale,
          spreadScale: policy.spreadScale,
          dethroneMarginDelta: policy.dethroneMarginDelta,
          thoughtBudgetScale: policy.thoughtBudgetScale,
          externalAbsorbScale: policy.externalAbsorbScale,
          freezeVerbalization: policy.freezeVerbalization,
          counterEvidence: policy.replayDistribution.counterEvidence,
          socialGateEnabled: policy.socialGateEnabled,
        },
      };
      const replayPath = getReplayLogPath(this.dataPath);
      fs.appendFileSync(replayPath, JSON.stringify(record) + "\n");
    } catch {
      // non-critical
    }
  }

  // ── Agent permissions ────────────────────────────────────────

  private checkPermission(op: string, agentRole: AgentRole, node?: { acl: { writableBy?: AgentRole[] } }): boolean {
    const allowed = AGENT_DEFAULTS[agentRole];
    if (!allowed.has(op)) {
      log.warn(`permission denied: ${op} for role ${agentRole}`);
      return false;
    }
    if (node?.acl?.writableBy && (op === "write" || op === "boost" || op === "forget")) {
      if (!node.acl.writableBy.includes(agentRole)) {
        log.warn(`permission denied: ${op} for role ${agentRole} on node with writableBy=${node.acl.writableBy}`);
        return false;
      }
    }
    if (op === "act" && agentRole !== "owner" && agentRole !== "system") {
      log.warn(`permission denied: act for role ${agentRole}`);
      return false;
    }
    return true;
  }

  // ── Public API ─────────────────────────────────────────────────

  boostConcept(topic: string, boost: number, source: ConceptSource, agentRole: AgentRole = "owner"): void {
    const id = normalizeId(topic);

    // CS8/L9: externalSourceFilter — in Red-Deep, only whitelisted sources can inject
    const policy = this.stabilizer.getPolicy();
    if (policy.externalSourceFilter) {
      if (!policy.externalSourceFilter.includes(source)) {
        log.info(`boostConcept blocked: source "${source}" not in externalSourceFilter [${policy.externalSourceFilter.join(",")}]`);
        return;
      }
    }

    // Find or create node
    findOrCreateNode(this.state.graph, topic, source, undefined, this.aliasTable);

    // Permission check
    const node = this.state.graph.nodes[id];
    if (node && !this.checkPermission("boost", agentRole, node)) return;

    boostNode(this.state.graph, id, boost, source, this.clock,
      policy.externalAbsorbScale);

    if (source === "conversation" || source === "curiosity" || source === "notification") {
      this.metrics.externalInjectionCount++;
      this.metrics.externalFamilyKeys.add(id);
    } else {
      this.metrics.internalInjectionCount++;
    }
  }

  /** Restore WM slots from a carryover snapshot (Phase C). */
  restoreWMFromSnapshot(data: Record<string, unknown>): void {
    restoreWorkingMemory(this.workingMemory, data);
  }

  /** Load a concept into a named WM slot from external callers (Phase C). */
  loadExternalSlot(slotName: SlotName, conceptId: string, label: string): void {
    loadSlot(this.workingMemory, slotName, conceptId, label, this.clock.nowMs());
  }

  getTopConcepts(k: number): Array<{ topic: string; weight: number }> {
    return getTopK(this.state.graph, k).map(n => ({
      topic: n.label,
      weight: n.activation,
    }));
  }

  getEntropy(): number {
    return computeEntropy(this.state.graph);
  }

  getRecentThoughts(n: number): MicroThoughtRecord[] {
    return getRecentThoughts(this.state, n);
  }

  wantsToAct(): ActGateArm | null {
    const arm = this.actGateArm;
    this.actGateArm = null;
    return arm;
  }

  markConversationActive(): void {
    this.lastConversationAt = this.clock.nowMs();
  }

  setEmotionValence(valence: number): void {
    this.state.selfValence = valence;
  }

  getSelfState(): SelfState {
    return this.selfModel.getState();
  }

  getSelfBeliefs(): SelfBelief[] {
    return this.selfModel.getBeliefs();
  }

  nudgeSelfEfficacy(delta: number): void {
    this.selfModel.nudgeSelfEfficacy(delta);
  }

  /** Birth a typed belief (narrow API for value promotion). */
  birthTypedBelief(
    statement: string,
    category: import("./self-model.js").BeliefCategory,
    domain: string,
    evidence: import("./self-model.js").BeliefEvidence[],
    sourceType: "observed" | "inferred" | "narrative",
  ): SelfBelief | null {
    return this.selfModel.birthTypedBelief(statement, category, domain, evidence, sourceType);
  }

  /** Remove a belief by ID or statement (narrow API for value decommitment). */
  removeBelief(idOrStatement: string): boolean {
    return this.selfModel.removeBelief(idOrStatement);
  }

  // ── Identity accessors ──────────────────────────────────────────

  getIdentityProfile(): IdentityProfile {
    return this.identityRegularizer.getProfile();
  }

  getIdentityNarrative(): IdentityNarrative {
    return this.identityRegularizer.getNarrative();
  }

  getIdentityTrajectory(): IdentityTrajectory {
    return this.identityRegularizer.getTrajectory();
  }

  // ── Identity event storage ──────────────────────────────────────

  private identityEvents: Array<{ type: "stance_expression" | "self_disclosure"; disagreementReadiness: number; adherenceScore: number; topicOwnership?: { caresAbout: string[]; memoryWorthiness: number; followupWorthiness: number }; timestamp: number }> = [];

  recordIdentityEvent(event: { type: "stance_expression" | "self_disclosure"; disagreementReadiness: number; adherenceScore: number; topicOwnership?: { caresAbout: string[]; memoryWorthiness: number; followupWorthiness: number }; timestamp: number }): void {
    this.identityEvents.push(event);
    if (this.identityEvents.length > 20) this.identityEvents.shift();
  }

  getRecentIdentityEvents(n: number): Array<{ type: "stance_expression" | "self_disclosure"; disagreementReadiness: number; adherenceScore: number; topicOwnership?: { caresAbout: string[]; memoryWorthiness: number; followupWorthiness: number }; timestamp: number }> {
    return this.identityEvents.slice(-n);
  }

  getCortexMetrics() {
    return this.cortexManager.getCortexMetrics();
  }

  /** CS5b: Recompute self_coherence from identity profile + recent thoughts (5b.4). */
  private recomputeSelfCoherence(): void {
    const recentThoughts = getRecentThoughts(this.state, 20);
    if (recentThoughts.length < 5) return; // not enough data

    // Extract themes from recent thought concepts
    const recentThemes = [...new Set(recentThoughts.flatMap(t => t.concepts))];

    // Get identity profile
    const profile = this.identityRegularizer.getProfile();
    const identityTopThemes = profile.topThemes.map(t => t.label);

    // Get active goal categories
    const activeGoals = getActiveGoals();
    const activeGoalCategories = [...new Set(activeGoals.map(g => g.category))];
    const identityGoalPortfolio = Object.keys(profile.goalPortfolio.categories);

    this.selfModel.recomputeCoherence(
      recentThemes,
      identityTopThemes,
      activeGoalCategories,
      identityGoalPortfolio,
    );
  }

  getSkillIntent(): { skillName: string; actionType: ActionType; confidence: number; reason: string } | null {
    const thoughts = getRecentThoughts(this.state, 1);
    if (thoughts.length === 0) return null;

    const latest = thoughts[thoughts.length - 1];
    const match = resolveIntentToSkill(latest, this.state.graph, this.state.learnedSkillMappings);
    if (!match || match.confidence <= 0.5) return null;

    return {
      ...match,
      reason: latest.content,
    };
  }

  getActionPreferences(): ActionPreference {
    const nodes = Object.values(this.state.graph.nodes).filter(n => n.id !== "self");
    return this.planner.computeActionPreference({
      avgU: nodes.length > 0 ? nodes.reduce((s, n) => s + n.uncertainty, 0) / nodes.length : 0,
      avgD: nodes.length > 0 ? nodes.reduce((s, n) => s + n.drive, 0) / nodes.length : 0,
      avgV: nodes.length > 0 ? nodes.reduce((s, n) => s + n.valence, 0) / nodes.length : 0,
      avgF: nodes.length > 0 ? nodes.reduce((s, n) => s + n.fatigue, 0) / nodes.length : 0,
      energyUtil: nodes.reduce((s, n) => s + n.activation, 0) / C.energyMax,
    });
  }

  getCuriosityTargets(): ExplorationAction[] {
    const internal = this.buildInternalState();
    const external = this.buildExternalState();
    const belief = this.worldModel.assembleBelief(internal, external);
    const plannerEU = this.planner.evaluateCurrentPlan(belief);
    return generateCuriosityTargets(
      this.state.graph, this.outcomes, this.worldModel, plannerEU, 3,
      (queryType) => this.selfModel.computeSelfCost(queryType),
    );
  }

  async recordOutcome(outcome: OutcomeRecord, agentRole: AgentRole = "owner"): Promise<void> {
    if (!this.checkPermission("write", agentRole)) return;
    this.outcomes.push(outcome);
    if (this.outcomes.length > 100) this.outcomes.shift();
    this.outcomeTracker.recordOutcome(outcome);

    // Update world model
    const external = this.buildExternalState();
    const result: OutcomeResult = {
      replyReceived: outcome.outcome === "positive",
      sentiment: outcome.outcome === "positive" ? 1 : outcome.outcome === "negative" ? -1 : 0,
    };
    this.worldModel.updateOnOutcome(outcome.actionType as ActionType, result, external);

    // C-3: Extract structured outcome via LLM when signal is available
    let c3Outcome: "positive" | "negative" | "neutral" | undefined;
    if (outcome.outcome !== "pending" && outcome.outcomeSignal) {
      try {
        const tr = this.worldModel.transition(
          this.worldModel.assembleBelief(this.buildInternalState(), external),
          outcome.actionType as ActionType,
        );
        const c3Result = await this.cortexManager.extractOutcome({
          action: { type: outcome.actionType as ActionType, description: outcome.outcomeSignal },
          rawExperience: { transcript: outcome.outcomeSignal },
          expectedOutcome: {
            replyReceived: tr.outcomeDistribution.replyReceived,
            sentiment: tr.outcomeDistribution.sentiment,
            goalProgressDelta: tr.outcomeDistribution.goalProgressDelta,
          },
        });
        if (c3Result && c3Result.confidence >= 0.5) {
          // Capture C-3's enriched outcome for self model update
          c3Outcome = c3Result.outcome;
          // Re-update world model with enriched data
          this.worldModel.updateOnOutcome(outcome.actionType as ActionType, {
            replyReceived: c3Result.fields.replyReceived,
            replyLatencyMinutes: c3Result.fields.replyLatencyMinutes,
            sentiment: c3Result.fields.sentiment,
            goalProgressDelta: c3Result.fields.goalProgressDelta,
            newInfoDelta: c3Result.fields.newInfoDiscovered ? 1 : 0,
          }, external);
          // Feed prediction error from surpriseScore
          if (c3Result.surpriseScore > 0.3) {
            this.state.predictionErrors.push(c3Result.surpriseScore);
            if (this.state.predictionErrors.length > 20) this.state.predictionErrors.shift();
            // CS5b.9: Prediction error → belief uncertainty update
            this.selfModel.updateBeliefFromPredictionError(outcome.actionType as ActionFamily);
            // Write prediction error back to U on action-related concept nodes
            // (Loop A: error → U → affects next thought competition)
            const actionNodeId = outcome.triggeredBy?.clusterConceptIds;
            if (actionNodeId) {
              for (const cid of actionNodeId) {
                const cNode = this.state.graph.nodes[cid];
                if (cNode) cNode.uncertainty = Math.min(1, cNode.uncertainty + c3Result.surpriseScore * 0.15);
              }
            }
          }
          // Record anomaly tags as curiosity boosts
          for (const tag of c3Result.anomalyTags) {
            const node = Object.values(this.state.graph.nodes)
              .find(n => n.label.includes(tag) || n.termVector.includes(tag));
            if (node) node.uncertainty = Math.min(1, node.uncertainty + 0.1);
          }
        }
      } catch {
        // C-3 failure is non-fatal
      }
    }

    // Track outcome processing for cortex3UsageRate metric
    if (outcome.outcome !== "pending") {
      this.cortexManager.recordOutcomeProcessed(c3Outcome !== undefined);
    }

    // CS8: Social model event hooks
    if (outcome.outcome !== "pending") {
      const sentiment = outcome.outcome === "positive" ? 1 : outcome.outcome === "negative" ? -1 : 0;
      if (outcome.actionType === "reach_out") {
        // Reply received → inbound
        this.socialModel.onInbound(getCharacter().user.name.toLowerCase(), sentiment);
      }
    }

    // CS5b.9: Update beliefs from outcome
    if (outcome.outcome !== "pending") {
      const selfOutcomeForBelief = c3Outcome ?? outcome.outcome;
      const beliefOutcome = selfOutcomeForBelief === "positive" ? "positive" : selfOutcomeForBelief === "negative" ? "negative" : "neutral";
      this.selfModel.updateBeliefFromOutcome(outcome.actionType as ActionFamily, beliefOutcome, outcome.actionType);
    }

    // CS5b: Update self-model from outcome (use C-3 enriched outcome when available)
    if (outcome.outcome !== "pending") {
      const enrichedOutcome = c3Outcome ?? outcome.outcome;
      const selfOutcome = enrichedOutcome === "positive" ? "positive" : enrichedOutcome === "negative" ? "negative" : "neutral";
      this.selfModel.selfOutcomeUpdate(outcome.actionType as ActionFamily, selfOutcome);

      // Active recovery on rest
      if (outcome.actionType === "rest") {
        this.selfModel.applyActiveRecovery();
      }
      // Conversation-driven recovery on positive reach_out
      if (outcome.actionType === "reach_out" && outcome.outcome === "positive") {
        this.selfModel.applyConversationRecovery(1.0);
      }
    }

    // Dynamic skill mapping: learn from outcome when skill is identifiable
    if (outcome.outcome !== "pending") {
      const thoughts = getRecentThoughts(this.state, 1);
      const latestThought = thoughts.length > 0 ? thoughts[thoughts.length - 1] : null;
      const skillMatch = resolveIntentToSkill(
        latestThought ?? { content: outcome.outcomeSignal, concepts: outcome.triggeredBy.clusterConceptIds } as MicroThoughtRecord,
        this.state.graph,
        this.state.learnedSkillMappings,
      );
      if (skillMatch) {
        this.recordSkillOutcome(
          skillMatch.skillName,
          outcome.actionType,
          outcome.outcome === "positive",
          latestThought?.content,
        );
      }
    }

    // Advance active plans whose goal relates to this outcome's concepts
    if (outcome.outcome !== "pending") {
      for (const plan of this.planner.getActivePlans()) {
        if (plan.status !== "active") continue;
        const planGoalId = plan.goalId;
        const conceptIds = outcome.triggeredBy.clusterConceptIds;
        // Check if outcome concepts overlap with plan's goal or related nodes
        const goalNode = this.state.graph.nodes[planGoalId];
        if (!goalNode) continue;
        const goalNeighbors = this.state.graph.edges
          .filter(e => e.source === planGoalId || e.target === planGoalId)
          .map(e => e.source === planGoalId ? e.target : e.source);
        const overlaps = conceptIds.some(id => id === planGoalId || goalNeighbors.includes(id));
        if (overlaps) {
          this.planner.advancePlan(plan.id, outcome.outcome === "positive" ? "positive" : "negative");
          // Full credit assignment: propagate credit through plan path
          this.outcomeTracker.propagatePlanCredit(outcome, plan, this.state.graph);

          // Loop B: Feed proposal feedback to cortex for prompt policy learning
          const currentStep = plan.bestPath[plan.currentStepIndex];
          if (currentStep !== undefined) {
            const stepNode = plan.nodes[currentStep];
            this.cortexManager.recordProposalFeedback({
              cortexCallId: plan.goalId,
              candidateIndex: currentStep,
              actionType: stepNode?.action,
              selected: true,
              outcomeIfSelected: outcome.outcome === "positive" ? "positive"
                : outcome.outcome === "negative" ? "negative" : "neutral",
            });
          }
        }
      }
    }
  }

  // ── Dynamic skill mapping ────────────────────────────────────────

  recordSkillOutcome(skillName: string, actionType: string, success: boolean, thought?: string): void {
    if (!this.state.learnedSkillMappings) this.state.learnedSkillMappings = [];

    // Update existing mapping if found
    const existing = this.state.learnedSkillMappings.find(
      m => m.skillName === skillName && m.actionType === actionType,
    );
    if (existing) {
      if (success) {
        existing.successCount++;
        existing.minActivation = Math.max(0.3, existing.minActivation - 0.05);
      } else {
        existing.failCount++;
        existing.minActivation = Math.min(0.9, existing.minActivation + 0.05);
      }
      existing.lastUsed = this.clock.nowMs();
    } else if (success && thought) {
      // Propose new mapping on first success
      this.proposeSkillMapping(thought, skillName, actionType);
    }

    // Prune bad mappings: >5 fails and <2 successes
    this.state.learnedSkillMappings = this.state.learnedSkillMappings.filter(
      m => !(m.failCount > 5 && m.successCount < 2),
    );

    // Cap at 20 mappings (evict oldest by lastUsed)
    if (this.state.learnedSkillMappings.length > 20) {
      this.state.learnedSkillMappings.sort((a, b) => b.lastUsed - a.lastUsed);
      this.state.learnedSkillMappings = this.state.learnedSkillMappings.slice(0, 20);
    }
  }

  private proposeSkillMapping(thought: string, skillName: string, actionType: string): void {
    if (!this.state.learnedSkillMappings) this.state.learnedSkillMappings = [];

    // Extract key terms from thought as OR regex pattern
    const words = thought
      .replace(/[^\w\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .slice(0, 5);
    if (words.length === 0) return;

    const pattern = words.join("|");

    // Check for duplicate patterns
    if (this.state.learnedSkillMappings.some(m => m.pattern === pattern)) return;

    this.state.learnedSkillMappings.push({
      pattern,
      skillName,
      actionType,
      minActivation: 0.7, // conservative start
      successCount: 1,
      failCount: 0,
      lastUsed: this.clock.nowMs(),
      createdAt: this.clock.nowMs(),
    });

    log.info(`skill mapping proposed: /${pattern}/i → ${skillName} (${actionType})`);
  }

  // L18: Active forgetting
  forgetConcept(conceptId: string): boolean {
    const id = normalizeId(conceptId);
    const node = this.state.graph.nodes[id];
    if (!node) return false;
    if (node.id === "self") return false; // never forget self

    // Remove node and all connected edges
    delete this.state.graph.nodes[id];
    this.state.graph.edges = this.state.graph.edges.filter(
      e => e.source !== id && e.target !== id,
    );
    // Remove from hypotheticals
    this.state.hypotheticalNodes = this.state.hypotheticalNodes.filter(x => x !== id);
    // Remove from activation history
    delete this.state.activationHistory[id];
    log.info(`forgot concept: "${node.label}" (${id})`);
    return true;
  }

  recordExplorationOutcome(
    conceptId: string,
    result: "informative" | "uninformative" | "surprising",
  ): void {
    // 1. Update world model with exploration outcome
    const external = this.buildExternalState();
    const outcome: OutcomeResult = {
      newInfoDelta: result === "surprising" ? 0.5 : result === "informative" ? 0.3 : -0.1,
      goalProgressDelta: result === "informative" ? 0.05 : 0,
    };
    this.worldModel.updateOnOutcome("explore", outcome, external);

    // 2. Update graph node uncertainty
    const node = this.state.graph.nodes[conceptId];
    if (node) {
      if (result === "informative" || result === "surprising") {
        node.uncertainty = Math.max(0, node.uncertainty - 0.15);
      } else {
        node.uncertainty = Math.max(0, node.uncertainty - 0.05);
      }
      node.lastExternalBoostAt = this.clock.nowMs();
    }

    // 3. Record exploration count
    recordExploration(conceptId);

    // 4. Check if re-planning needed for surprising results
    if (result === "surprising") {
      for (const plan of this.planner.getActivePlans()) {
        if (plan.status !== "active") continue;
        const goalNeighbors = this.state.graph.edges
          .filter(e => e.source === plan.goalId || e.target === plan.goalId)
          .map(e => e.source === plan.goalId ? e.target : e.source);
        if (goalNeighbors.includes(conceptId) || plan.goalId === conceptId) {
          this.planner.advancePlan(plan.id, "negative"); // triggers replanning
          log.info(`exploration surprise on "${conceptId}" triggered replan for goal "${plan.goalId}"`);
        }
      }
    }

    log.info(`exploration outcome: "${conceptId}" → ${result}`);
  }

  recordPendingReachOut(arm: ActGateArm): void {
    const outcome: OutcomeRecord = {
      actionType: "reach_out",
      triggeredBy: {
        clusterConceptIds: arm.concepts,
        groundingRefs: arm.grounding.map(g => ({ type: g.type, id: g.id, weight: g.weight })),
        decisionLogId: arm.microThoughtId,
      },
      outcome: "pending",
      outcomeSignal: "",
      creditUpdates: [],
      timestamp: this.clock.nowMs(),
    };
    this.outcomeTracker.recordOutcome(outcome);
    // CS8: Track outbound for social model
    this.socialModel.onOutbound(arm.targetId);
    log.info(`pending outcome recorded: reach_out, thought=${arm.microThoughtId}`);
  }

  /** Track outbound for social model (called from proactive.ts bypass path). */
  trackSocialOutbound(targetId: string, topics?: string[]): void {
    this.socialModel.onOutbound(targetId, topics);
    this.socialModel.save();
  }

  resolvePendingOutcomes(lastUserMessageAt: number): void {
    // Update commitment urgency
    this.outcomeTracker.updateCommitmentUrgency(this.clock);

    const pending = this.outcomeTracker.getPendingOutcomes();
    const now = this.clock.nowMs();
    const TWO_HOURS = 2 * (MS_PER_HOUR as number);
    const noReplyTimeout = CS8_CONFIG.noReplyTimeoutMs; // 4h from config

    for (const outcome of pending) {
      let resolvedOutcome: "positive" | "negative" | null = null;

      if (lastUserMessageAt > outcome.timestamp) {
        this.outcomeTracker.resolvePendingOutcome(
          outcome.triggeredBy.decisionLogId, "positive", "user_replied",
        );
        this.outcomeTracker.propagateCredit(
          { ...outcome, outcome: "positive" }, this.state.graph,
        );
        resolvedOutcome = "positive";
        // Social model: user replied
        if (outcome.actionType === "reach_out") {
          this.socialModel.onInbound(getCharacter().user.name.toLowerCase(), 1);
        }
        log.info(`outcome resolved positive: ${outcome.triggeredBy.decisionLogId}`);
      } else if (now - outcome.timestamp > noReplyTimeout) {
        // CS8: no-reply timeout from CS8_CONFIG — resolve negative + update social model
        this.outcomeTracker.resolvePendingOutcome(
          outcome.triggeredBy.decisionLogId, "negative", "no_reply_4h",
        );
        this.outcomeTracker.propagateCredit(
          { ...outcome, outcome: "negative" }, this.state.graph,
        );
        resolvedOutcome = "negative";
        if (outcome.actionType === "reach_out") {
          this.socialModel.onNoReply(getCharacter().user.name.toLowerCase());
        }
        log.info(`outcome resolved negative (4h timeout): ${outcome.triggeredBy.decisionLogId}`);
      } else if (now - outcome.timestamp > TWO_HOURS) {
        // 2h soft timeout: resolve outcome as negative but don't penalize social model yet
        this.outcomeTracker.resolvePendingOutcome(
          outcome.triggeredBy.decisionLogId, "negative", "no_reply_2h",
        );
        this.outcomeTracker.propagateCredit(
          { ...outcome, outcome: "negative" }, this.state.graph,
        );
        resolvedOutcome = "negative";
        log.info(`outcome resolved negative (2h timeout): ${outcome.triggeredBy.decisionLogId}`);
      }

      // Update self-model from resolved outcome (was previously skipped)
      if (resolvedOutcome) {
        const selfOutcome = resolvedOutcome === "positive" ? "positive" : "negative";
        this.selfModel.selfOutcomeUpdate(outcome.actionType as ActionFamily, selfOutcome);
        this.selfModel.updateBeliefFromOutcome(outcome.actionType as ActionFamily, selfOutcome, outcome.actionType);
        if (outcome.actionType === "reach_out" && resolvedOutcome === "positive") {
          this.selfModel.applyConversationRecovery(1.0);
        }
      }
    }
  }

  async proposeGoalFromThemes(): Promise<void> {
    const now = this.clock.nowMs();
    const ONE_DAY = MS_PER_DAY as number;

    // Rate limit: 1/day
    if (now - this.lastGoalProposedAt < ONE_DAY) return;

    // Need enough thoughts to extract themes
    if (this.state.thoughtHistory.length < 5) return;

    // Budget check: leave buffer for 15-goal cap
    const activeGoals = getActiveGoals();
    if (activeGoals.length >= 14) return;

    this.lastGoalProposedAt = now; // set early to prevent retry on error

    try {
      const recentThoughts = this.state.thoughtHistory.slice(-10)
        .map(t => `- ${t.content} (${t.trigger}, ${t.grounding[0]?.type ?? "无"}:${t.grounding[0]?.id ?? ""})`);
      const existingGoals = activeGoals
        .map(g => `- ${g.description} (${g.category})`);

      const prompt = `最近的潜意识想法：
${recentThoughts.join("\n")}

现有目标：
${existingGoals.length > 0 ? existingGoals.join("\n") : "（无）"}

根据这些想法中的反复主题，提议一个新的小目标。
如果没有明显的新主题，回答 SKIP。
否则回答 JSON：{"description":"...", "category":"learning|project|social|health|personal", "motivation":"...", "relatedTopics":["..."]}`;

      // Cortex unified budget: check goal slot
      if (!this.cortexManager.trackExternalCall("goal", 200)) {
        log.info("goal propose: skipped (cortex budget exceeded)");
        return;
      }

      const result = await claudeText({
        label: "brainstem.synthesizeGoal",
        system: `你是${getCharacter().name}的目标规划器。从潜意识想法中提炼出可执行的小目标。\n` +
          "description 必须简短自然（≤20字），像跟朋友说的一句话，不要写成工作计划书。\n" +
          "好的例子：「每天早上看一眼 dashboard」「试试用 Python 写个小爬虫」「读完那本陶瓷的书」\n" +
          "坏的例子：「制定 dashboard 日常使用的触发机制和仪式感：设计晨间打开……」（太长太正式）",
        prompt,
        model: "fast",
        timeoutMs: 30_000,
      });

      const trimmed = result.trim();
      if (trimmed === "SKIP" || trimmed.startsWith("SKIP")) {
        log.info("goal propose: SKIP (no clear theme)");
        return;
      }

      // Extract JSON from response
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.warn("goal propose: no JSON found in response");
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        description: string;
        category: string;
        motivation: string;
        relatedTopics: string[];
      };

      // Reject overly verbose descriptions — truncate to first clause
      if (parsed.description.length > 30) {
        const truncated = parsed.description.split(/[：:，；]/)[0].slice(0, 30);
        log.info(`goal propose: truncated "${parsed.description}" → "${truncated}"`);
        parsed.description = truncated;
      }

      const validCategories = ["learning", "project", "social", "health", "personal"];
      const category = validCategories.includes(parsed.category)
        ? parsed.category as "learning" | "project" | "social" | "health" | "personal"
        : "personal";

      const newGoal = addGoal({
        description: parsed.description,
        category,
        motivation: parsed.motivation,
        progress: 0,
        milestones: [],
        origin: "self_generated",
        priority: 0.4,
        goalLevel: "task",
        relatedTopics: parsed.relatedTopics ?? [],
      });

      // Create graph node for goal
      findOrCreateNode(this.state.graph, parsed.description, "goal", undefined, this.aliasTable);

      log.info(`goal proposed: "${newGoal.description}" (${category})`);
    } catch (err) {
      log.warn("goal propose error", err);
    }
  }

  private async computeMonthlyNarrative(): Promise<void> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const trajectory = this.identityRegularizer.getTrajectory();
    const lastSnapshotMonth = trajectory.snapshots.length > 0
      ? trajectory.snapshots[trajectory.snapshots.length - 1].month
      : "";
    if (currentMonth === lastSnapshotMonth) return;

    try {
      const recentThoughts = this.state.thoughtHistory.slice(-20);
      if (recentThoughts.length < 3) return;

      // Gather completed goals
      const completedGoals = getActiveGoals()
        .filter(g => g.progress >= 1)
        .map(g => g.description);

      // Generate insights via LLM
      const thoughtSummary = recentThoughts
        .map(t => `- ${t.content} (${t.trigger})`)
        .join("\n");

      let insights: string[] = [];
      if (!this.cortexManager.trackExternalCall("goal", 150)) {
        insights = [`本月主题：${recentThoughts[0]?.content ?? "未知"}`];
      } else {
        try {
          const result = await claudeText({
            label: "brainstem.reflect",
            system: `你是${getCharacter().name}的自我反思助手。从这个月的潜意识想法中提炼3-5条自我观察。每条一句话。`,
            prompt: `这个月的想法：\n${thoughtSummary}\n\n请用JSON数组格式回答：["观察1","观察2","观察3"]`,
            model: "fast",
            timeoutMs: 15_000,
          });
          const parsed = JSON.parse(result.trim());
          if (Array.isArray(parsed)) insights = parsed.slice(0, 5);
        } catch {
          insights = [`本月主题：${recentThoughts[0]?.content ?? "未知"}`];
        }
      }

      this.identityRegularizer.computeMonthlySnapshot(
        currentMonth, recentThoughts, completedGoals, insights,
      );
      this.identityRegularizer.updateProfile(recentThoughts, this.state.graph);

      log.info(`monthly narrative: ${currentMonth}, ${insights.length} insights`);
    } catch (err) {
      log.warn("monthly narrative error", err);
    }
  }

  /** Compute cluster winner hold time (seconds) from fast-loop winner history. */
  private computeClusterLifetime(): { avg: number; p90: number } {
    const hist = this.metrics.winnerHistory;
    if (hist.length < 2) return { avg: 0, p90: 0 };

    // Measure contiguous runs of same winner
    const runs: number[] = [];
    let runLen = 1;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i] === hist[i - 1]) {
        runLen++;
      } else {
        runs.push(runLen * C.tickSeconds); // convert ticks to seconds
        runLen = 1;
      }
    }
    runs.push(runLen * C.tickSeconds); // final run

    if (runs.length === 0) return { avg: 0, p90: 0 };
    const avg = runs.reduce((s, r) => s + r, 0) / runs.length;
    const sorted = [...runs].sort((a, b) => a - b);
    const p90idx = Math.min(Math.floor(sorted.length * 0.9), sorted.length - 1);
    return { avg, p90: sorted[p90idx] };
  }

  private getMetrics(): import("./debug.js").AutoTuneMetrics {
    // Compute rotation rate from winner history
    const winnerHist = this.metrics.winnerHistory;
    let rotationRate = 0;
    if (winnerHist.length >= 2) {
      let changes = 0;
      for (let i = 1; i < winnerHist.length; i++) {
        if (winnerHist[i] !== winnerHist[i - 1]) changes++;
      }
      // Approximate rotations per hour from recent fast ticks
      rotationRate = changes * (3600 / (winnerHist.length * C.tickSeconds));
    }

    // Grounding reject rate — compute from recent decision logs
    let groundingRejectRate = 0;
    try {
      const recentLogs = readDecisionLogs(this.dataPath, 24);
      if (recentLogs.length > 0) {
        const groundingRejects = recentLogs.filter(
          dl => !dl.thoughtGate.passed && dl.thoughtGate.rejectedReason === "no_grounding",
        ).length;
        groundingRejectRate = groundingRejects / recentLogs.length;
      }
    } catch { /* non-critical */ }

    // Loop detector trigger rate — actual triggers per day from fast-loop counter
    const oneDayAgo = this.clock.nowMs() - 86_400_000;
    const recentTriggers = this.metrics.loopDetectorTriggers.filter(t => t > oneDayAgo);
    const loopDetectorTriggerRate = recentTriggers.length;

    // Cluster lifetime: avg winner hold time (seconds)
    const clusterLifetimeAvg = this.computeClusterLifetime().avg;

    return {
      rotationRate,
      entropy: computeEntropy(this.state.graph),
      groundingRejectRate,
      loopDetectorTriggerRate,
      clusterLifetimeAvg,
    };
  }

  private buildInternalState(): InternalState {
    const nodes = Object.values(this.state.graph.nodes).filter(n => n.id !== "self");
    return {
      winnerClusterId: this.lastWinnerClusterId,
      noveltyAvg: 0.5,
      entropy: computeEntropy(this.state.graph),
      avgFatigue: nodes.length > 0 ? nodes.reduce((s, n) => s + n.fatigue, 0) / nodes.length : 0,
      csiMode: this.stabilizer.getMode(),
      energyUtilization: nodes.reduce((s, n) => s + n.activation, 0) / C.energyMax,
      pendingInteractions: this.outcomeTracker.getPendingOutcomes()
        .map(o => o.triggeredBy.decisionLogId),
    };
  }

  private toGoalForPlanning(g: Goal): GoalForPlanning {
    return {
      id: g.id,
      description: g.description,
      priority: g.priority ?? 0.5,
      progress: g.progress,
      relatedTopics: g.relatedTopics ?? [],
      category: g.category,
      milestones: g.milestones,
    };
  }

  private async runPlanGeneration(): Promise<void> {
    const activeGoals = getActiveGoals();
    if (activeGoals.length === 0) return;

    const internal = this.buildInternalState();
    const external = this.buildExternalState();
    const belief = this.worldModel.assembleBelief(internal, external);

    const goalsForPlanning = activeGoals.map(g => this.toGoalForPlanning(g));

    // 1. Handle re-planning for failed plans
    this.planner.replanIfNeeded(goalsForPlanning, belief, this.worldModel, this.selfModel);

    // 2. Generate new plans for goals without active plans
    const activePlanGoalIds = new Set(this.planner.getActivePlans().map(p => p.goalId));
    for (const goal of goalsForPlanning) {
      if (activePlanGoalIds.has(goal.id)) continue;
      if (goal.progress >= 1) continue;
      if (goal.priority < 0.3) continue;

      // C-2: Generate LLM-assisted action candidates
      try {
        const selfState = this.selfModel.getState();
        const recentOutcomes = this.outcomes.slice(-5).map(o => ({
          action: o.actionType,
          outcome: o.outcome,
          recency: (this.clock.nowMs() - o.timestamp) / 3_600_000,
        }));
        const c2Result = await this.cortexManager.generateProposals({
          goal: { description: goal.description, progress: goal.progress, milestones: goal.milestones?.map(m => m.description) ?? [] },
          beliefSnapshot: {
            selfState,
            worldState: {
              socialReceptivity: belief.latent.socialReceptivity,
              topicViability: belief.latent.topicViability,
              timeOfDay: belief.external.timeOfDay,
            },
            recentOutcomes,
          },
          constraints: {
            actionWhitelist: ["reach_out", "reflect", "explore", "post", "activity", "stay_silent"] as ActionType[],
            blockedActions: belief.internal.csiMode === "red" ? ["reach_out", "explore", "post", "activity"] as ActionType[] : [],
            maxSteps: 3,
            selfBudget: { energy: selfState.energy, social_energy: selfState.social_energy },
          },
        });
        if (c2Result) {
          const validCandidates = c2Result.candidates.map(c => ({
            type: c.action,
            target: c.target,
            description: c.description,
          }));
          this.planner.setCortexCandidates(validCandidates, c2Result.reasoningPaths);
        }
      } catch {
        // C-2 failure is non-fatal — planner falls back to heuristic candidates
      }

      const plan = this.planner.generatePlan(goal, belief, this.worldModel, this.state.graph, this.selfModel);
      if (plan) {
        log.info(`plan generated for "${goal.description}": ${plan.bestPath.length} steps, EU=${plan.totalReturn.toFixed(2)}`);

        // Loop B: Record rejected alternatives with rejectionReason
        for (const alt of plan.alternatives) {
          const altNode = plan.nodes[alt.path[0]];
          if (altNode) {
            this.cortexManager.recordProposalFeedback({
              cortexCallId: goal.id,
              candidateIndex: alt.path[0],
              actionType: altNode.action,
              selected: false,
              rejectionReason: `low_EU: ${alt.whyWorse}`,
            });
          }
        }

        // C-4: Augment low-confidence transitions with uncertainty simulation
        const policy = this.stabilizer.getPolicy();
        for (const stepIdx of plan.bestPath) {
          const step = plan.nodes[stepIdx];
          if (!step) continue;
          const tr = this.worldModel.transition(belief, step.action as ActionType);
          if (tr.confidence < 0.4) {
            try {
              const c4Result = await this.cortexManager.simulateOutcomes(
                {
                  belief,
                  selfState: this.selfModel.getState(),
                  action: step.action as ActionType,
                  target: step.target,
                  context: step.description,
                },
                policy.cortex4Enabled,
                tr.confidence,
              );
              if (c4Result) {
                // Validate selfEffects: if wildly divergent from action family table (>2×),
                // use table values instead (design doc spec)
                const selfExpected = this.selfModel.getActionFamilyDeltas(step.action as ActionType);
                if (selfExpected) {
                  for (const outcome of c4Result.outcomes) {
                    const se = outcome.selfEffects;
                    if (Math.abs(se.energyDelta) > Math.abs(selfExpected.energy) * 2 ||
                        Math.abs(se.socialEnergyDelta) > Math.abs(selfExpected.socialEnergy) * 2 ||
                        Math.abs(se.safetyMarginDelta) > Math.abs(selfExpected.safetyMargin) * 2) {
                      log.warn(`c4 selfEffects divergent for ${step.action}: cortex=${JSON.stringify(se)}, table=${JSON.stringify(selfExpected)}`);
                      // Replace with table values
                      outcome.selfEffects.energyDelta = selfExpected.energy;
                      outcome.selfEffects.socialEnergyDelta = selfExpected.socialEnergy;
                      outcome.selfEffects.safetyMarginDelta = selfExpected.safetyMargin;
                    }
                  }
                }
                // Feed C-4 augmented transition back into the plan node
                const augmented = this.worldModel.transitionWithCortex(belief, step.action as ActionType, c4Result);
                step.outcomeDistribution = augmented.outcomeDistribution;
                // Recompute EU from augmented outcome distribution (inline, not via
                // computeExpectedUtility which would re-run base transition)
                const od = augmented.outcomeDistribution;
                const selfReturn = this.selfModel.computeSelfReturn(
                  this.selfModel.selfTransition(step.action as ActionFamily),
                );
                const rGoal = od.goalProgressDelta * REWARD_WEIGHTS.goal;
                const rSocial = od.replyReceived * REWARD_WEIGHTS.social
                  - (1 - od.replyReceived) * 0.3 + od.sentiment[2] * 0.5;
                const rInfo = od.newInfoDelta * REWARD_WEIGHTS.info;
                const rStability = belief.internal.csiMode === "red" ? -1.0
                  : belief.internal.csiMode === "yellow" ? -0.3 : 0;
                const cost = ACTION_COSTS[step.action as ActionType] ?? 0;
                step.expectedUtility = rGoal + rSocial + rInfo
                  + rStability * REWARD_WEIGHTS.stability + selfReturn * REWARD_WEIGHTS.self - cost;
              }
            } catch {
              // C-4 failure is non-fatal
            }
          }
        }

        // Recompute plan.totalReturn after C-4 may have augmented step EUs
        plan.totalReturn = plan.bestPath.reduce((sum, idx) => {
          const node = plan.nodes[idx];
          return node ? sum + Math.pow(C.plannerDiscount, node.depth) * node.expectedUtility : sum;
        }, 0);

        // M7: Create temporary concept nodes for plan steps so they influence thinking
        for (const stepIdx of plan.bestPath) {
          const step = plan.nodes[stepIdx];
          if (!step) continue;
          const stepId = normalizeId(`plan-${step.action}-${step.description.slice(0, 20)}`);
          if (!this.state.graph.nodes[stepId]) {
            const node = findOrCreateNode(this.state.graph, step.description, "goal", undefined, this.aliasTable);
            node.drive = 0.5;
            node.uncertainty = 0.3;
            if (!this.state.hypotheticalNodes.includes(stepId)) {
              this.state.hypotheticalNodes.push(stepId);
            }
            // Link to goal node
            const goalNodeId = normalizeId(goal.description);
            if (this.state.graph.nodes[goalNodeId]) {
              addEdge(this.state.graph, stepId, goalNodeId, "semantic", 0.4);
            }
          }
        }
      }
    }
  }

  private buildExternalState(): ExternalState {
    const now = this.clock.nowMs();
    const timeSinceLastReply = this.lastConversationAt > 0
      ? (now - this.lastConversationAt) / 60_000
      : 120; // 2h default if never spoken
    const lastReplyReceived = timeSinceLastReply < 5; // within 5 min

    // Goal progress by category
    const goalProgressByCategory: Record<string, number> = {};
    for (const g of getActiveGoals()) {
      const cat = g.category;
      goalProgressByCategory[cat] = Math.max(goalProgressByCategory[cat] ?? 0, g.progress);
    }

    // Discovery freshness: hours since last actionable discovery
    const discoveries = this.getDiscoveries();
    const latestDiscovery = discoveries.length > 0
      ? Math.max(...discoveries.map(d => d.timestamp))
      : 0;
    const discoveryFreshness = latestDiscovery > 0
      ? (now - latestDiscovery) / (MS_PER_HOUR as number)
      : 48; // 48h if no discoveries

    return {
      timeSinceLastReply,
      lastReplyReceived,
      lastReplySentiment: 0, // updated on actual reply via recordOutcome
      goalProgressByCategory,
      discoveryFreshness,
      timeOfDay: this.getTimeOfDay(),
      dayOfWeek: new Date().getDay() >= 1 && new Date().getDay() <= 5 ? "weekday" : "weekend",
    };
  }

  private getTimeOfDay(): "morning" | "afternoon" | "evening" | "night" {
    const h = new Date().getHours();
    if (h < 7) return "night";
    if (h < 12) return "morning";
    if (h < 18) return "afternoon";
    if (h < 22) return "evening";
    return "night";
  }

  // ── Portability ──────────────────────────────────────────────

  exportBundle(): {
    manifest: { version: string; exportedAt: number; files: string[]; checksums: Record<string, string> };
    state: BrainstemState;
    aliasTable: AliasTable;
    worldModel: WorldModelState;
    governance: GovernanceState;
  } {
    const state = { ...this.state };
    const aliasTable = { ...this.aliasTable };
    const worldModel = this.worldModel.exportState();
    const governance = this.outcomeTracker.exportState();

    const checksums: Record<string, string> = {};
    const parts = { state, aliasTable, worldModel, governance };
    for (const [key, val] of Object.entries(parts)) {
      checksums[key] = createHash("sha256").update(JSON.stringify(val)).digest("hex").slice(0, 16);
    }

    return {
      manifest: {
        version: CONTRACT_VERSION,
        exportedAt: this.clock.nowMs(),
        files: Object.keys(parts),
        checksums,
      },
      state,
      aliasTable,
      worldModel,
      governance,
    };
  }

  importBundle(bundle: {
    manifest: { version: string; checksums: Record<string, string> };
    state: BrainstemState;
    aliasTable: AliasTable;
    worldModel: WorldModelState;
    governance: GovernanceState;
  }): void {
    // Validate version compatibility (major must match)
    const [bundleMajor] = bundle.manifest.version.split(".").map(Number);
    const [currentMajor] = CONTRACT_VERSION.split(".").map(Number);
    if (bundleMajor !== currentMajor) {
      log.error(`importBundle: incompatible major version ${bundle.manifest.version} vs ${CONTRACT_VERSION}`);
      return;
    }

    // Validate checksums
    const parts: Record<string, unknown> = {
      state: bundle.state,
      aliasTable: bundle.aliasTable,
      worldModel: bundle.worldModel,
      governance: bundle.governance,
    };
    for (const [key, val] of Object.entries(parts)) {
      const expected = bundle.manifest.checksums[key];
      const actual = createHash("sha256").update(JSON.stringify(val)).digest("hex").slice(0, 16);
      if (expected && actual !== expected) {
        log.error(`importBundle: checksum mismatch for ${key}`);
        return;
      }
    }

    // Apply state
    this.state = migrateState(bundle.state as unknown as Record<string, unknown>);
    this.aliasTable = bundle.aliasTable;
    this.worldModel.importState(bundle.worldModel);
    this.outcomeTracker.importState(bundle.governance);

    this.persistState();
    log.info(`importBundle: successfully imported bundle v${bundle.manifest.version}`);
  }

  /** Get the highest-drive concept node (what the character most wants to push forward). */
  getDriveSignal(): { description: string; strength: number } | null {
    let bestDrive = 0;
    let bestLabel = "";
    for (const node of Object.values(this.state.graph.nodes)) {
      if (node.drive > bestDrive) {
        bestDrive = node.drive;
        bestLabel = node.label;
      }
    }
    if (bestDrive < 0.1) return null;
    return { description: bestLabel, strength: bestDrive };
  }

  /** Get CSI value and mode for export. */
  getCSI(): { value: number; mode: "green" | "yellow" | "red" } {
    return {
      value: this.stabilizer.getCSI(),
      mode: this.stabilizer.getMode(),
    };
  }

  /** Get working memory slots for export. */
  getWorkingMemorySlots(): WMSlot[] {
    return Object.values(this.workingMemory.slots).filter(s => s.conceptId !== null);
  }

  /** Aggregate internal state into a single read-only DTO for TurnDirective. */
  getTurnSignals(): BrainstemTurnSignals {
    return {
      slots: { ...this.workingMemory.slots },
      openCommitments: this.outcomeTracker.getOpenCommitments()
        .map(c => ({ content: c.content, urgency: c.urgency, createdAt: c.createdAt })),
      selfState: { ...this.selfModel.getState() },
      topConcepts: this.getTopConcepts(3),
      activeGoals: getActiveGoals().map(g => ({
        id: g.id, description: g.description, category: g.category,
        priority: g.priority ?? 0.5, relatedTopics: g.relatedTopics ?? [],
      })),
      csi: this.getCSI(),
      driveSignal: this.getDriveSignal(),
      affectRegulation: {
        strategy: this.stabilizer.getAffectState().regulationStrategy,
        intensity: this.stabilizer.getAffectState().regulationIntensity,
      },
    };
  }

  /** Feed conversation data into WM slots (open_question + background). */
  feedConversation(userText: string, assistantPrevText?: string): void {
    const now = this.clock.nowMs();

    // Detect open questions from user
    const isQuestion = /[?？]/.test(userText) ||
      /^(为什么|怎么|什么|哪|谁|几|多少|how|what|why|where|when|which|who)/i.test(userText.trim());
    if (isQuestion && userText.length > 5) {
      const label = userText.slice(0, 60).replace(/\n/g, " ");
      loadSlot(this.workingMemory, "open_question", `q_${now}`, label, now);
    }

    // Extract background topic from previous assistant response
    if (assistantPrevText && assistantPrevText.length > 10) {
      const label = assistantPrevText.slice(0, 60).replace(/\n/g, " ");
      loadSlot(this.workingMemory, "background", `bg_${now}`, label, now);
    }
  }

  formatContext(): string {
    const top = this.getTopConcepts(3);
    const thoughts = this.getRecentThoughts(2);

    if (top.length === 0 && thoughts.length === 0) return "";

    const lines: string[] = [];
    lines.push("## 我脑子里在转的");

    if (top.length > 0) {
      lines.push(`脑子里在转的：${top.map(t => t.topic).join("、")}`);
    }

    if (thoughts.length > 0) {
      const latest = thoughts[thoughts.length - 1];
      lines.push(`刚才在想：${latest.content}`);
    }

    // Drive signal — what the character most wants to push forward
    const drive = this.getDriveSignal();
    if (drive && drive.strength > 0.3) {
      lines.push(`当前驱动力：${drive.description}`);
    }

    // CSI mode — only show when non-green
    const csi = this.getCSI();
    if (csi.mode !== "green") {
      const modeDesc: Record<string, string> = { yellow: "注意力有点分散", red: "状态不太好，需要收敛" };
      lines.push(`认知模式：${modeDesc[csi.mode]}`);
    }

    // Inner state — only show when abnormal
    const self = this.selfModel.getState();
    if (self.energy < 0.4 || self.social_energy < 0.3) {
      const e = Math.round(self.energy * 10);
      const s = Math.round(self.social_energy * 10);
      lines.push(`内在状态：精力 ${e}/10，社交能量 ${s}/10`);
    }

    // Affect regulation context
    const affect = this.stabilizer.getAffectState();
    if (affect.regulationStrategy !== "none") {
      const strategyNames: Record<string, string> = {
        reappraisal: "认知重评",
        distraction: "注意力转移",
        suppression: "情绪抑制",
      };
      lines.push(`情绪调节: ${strategyNames[affect.regulationStrategy] ?? affect.regulationStrategy} (强度: ${affect.regulationIntensity.toFixed(1)})`);
    }

    // Open commitments
    const openCommitments = this.outcomeTracker.getOpenCommitments();
    if (openCommitments.length > 0) {
      const maxUrgency = Math.max(...openCommitments.map(c => c.urgency));
      lines.push(`待完成承诺: ${openCommitments.length}项 (最高紧急度: ${maxUrgency.toFixed(1)})`);
    }

    lines.push("这些是你潜意识里的念头——不需要主动说出来，只在自然聊到的时候才带出来。");

    // Working memory context
    const wmCtx = formatWorkingMemoryContext(this.workingMemory);
    if (wmCtx) lines.push(wmCtx);

    // Identity context (interests, trajectory)
    const identityCtx = this.identityRegularizer.formatIdentityContext();
    if (identityCtx) lines.push(identityCtx);

    return lines.join("\n");
  }
}

// ── Module-level singleton ───────────────────────────────────────────

let instance: BrainstemEngine | null = null;

export function initBrainstem(config: AppConfig): void {
  if (instance) return;
  instance = new BrainstemEngine(config);

  // Subscribe to state bus — brainstem senses all state changes
  subscribeToBus();
}

/** Wire brainstem to the state bus — called once from initBrainstem. */
function subscribeToBus(): void {
  onState("commitment:new", (e) => {
    if (e.type === "commitment:new") {
      brainstemBoostNode(e.what, 0.3, "conversation");
      log.info(`bus: commitment:new → boost "${e.what}"`);
    }
  });

  onState("emotion:updated", (e) => {
    if (e.type === "emotion:updated") {
      brainstemSetEmotion(e.valence);
    }
  });

  onState("episode:added", (e) => {
    if (e.type === "episode:added") {
      brainstemBoostNode(e.topic, 0.2 * Math.min(e.significance, 1), "memory");
    }
  });

  onState("goal:progress", (e) => {
    if (e.type === "goal:progress") {
      brainstemBoostNode(e.goalId, 0.15 * Math.abs(e.delta), "goal");
    }
  });

  log.info("bus: brainstem subscriptions registered");
}

export function startBrainstem(): void {
  instance?.start();
}

export function stopBrainstem(): void {
  instance?.stop();
}

export function formatBrainstemContext(): string {
  return instance?.formatContext() ?? "";
}

export function brainstemRestoreWM(data: Record<string, unknown>): void {
  instance?.restoreWMFromSnapshot(data);
}

export function brainstemLoadSlot(slotName: SlotName, conceptId: string, label: string): void {
  instance?.loadExternalSlot(slotName, conceptId, label);
}

export function brainstemBoostNode(topic: string, boost: number, source: ConceptSource): void {
  instance?.boostConcept(topic, boost, source);
}

export function brainstemGetTopK(k: number): Array<{ topic: string; weight: number }> {
  return instance?.getTopConcepts(k) ?? [];
}

export function brainstemGetEntropy(): number {
  return instance?.getEntropy() ?? 0;
}

export function getBrainstemRecentThoughts(n: number): MicroThoughtRecord[] {
  return instance?.getRecentThoughts(n) ?? [];
}

export function brainstemWantsToAct(): ActGateArm | null {
  return instance?.wantsToAct() ?? null;
}

export function brainstemMarkConversation(): void {
  instance?.markConversationActive();
}

export function brainstemSetEmotion(valence: number): void {
  instance?.setEmotionValence(valence);
}

export function brainstemGetActionPreferences(): ActionPreference {
  return instance?.getActionPreferences() ?? {
    explore: 0, reach_out: 0, post: 0, activity: 0, reflect: 0, rest: 0,
  };
}

export function brainstemGetCuriosityTargets(): ExplorationAction[] {
  return instance?.getCuriosityTargets() ?? [];
}

export function brainstemRecordOutcome(outcome: OutcomeRecord): void {
  instance?.recordOutcome(outcome);
}

export function brainstemRecordPendingReachOut(arm: ActGateArm): void {
  instance?.recordPendingReachOut(arm);
}

export function brainstemResolvePendingOutcomes(lastUserMessageAt: number): void {
  instance?.resolvePendingOutcomes(lastUserMessageAt);
}

export function brainstemRecordExplorationOutcome(
  conceptId: string,
  result: "informative" | "uninformative" | "surprising",
): void {
  instance?.recordExplorationOutcome(conceptId, result);
}

// L18: Active forgetting API
export function brainstemForgetConcept(conceptId: string): boolean {
  return instance?.forgetConcept(conceptId) ?? false;
}

// V2: Intent → Skill routing
export function brainstemGetSkillIntent(): { skillName: string; actionType: ActionType; confidence: number; reason: string } | null {
  return instance?.getSkillIntent() ?? null;
}

// V2: Dynamic skill mapping — record outcome for learning
export function brainstemRecordSkillOutcome(skillName: string, actionType: string, success: boolean, thought?: string): void {
  instance?.recordSkillOutcome(skillName, actionType, success, thought);
}

// Cognitive controller exports
export function brainstemGetCSI(): { value: number; mode: "green" | "yellow" | "red" } | null {
  return instance?.getCSI() ?? null;
}

export function brainstemGetWorkingMemory(): WMSlot[] {
  return instance?.getWorkingMemorySlots() ?? [];
}

export function brainstemGetDriveSignal(): { description: string; strength: number } | null {
  return instance?.getDriveSignal() ?? null;
}

// CS5b: Self-model state
export function brainstemGetSelfState(): SelfState | null {
  return instance?.getSelfState() ?? null;
}

// CS5b.9: Self-beliefs
export function brainstemGetBeliefs(): SelfBelief[] {
  return instance?.getSelfBeliefs() ?? [];
}

export function brainstemNudgeSelfEfficacy(delta: number): void {
  instance?.nudgeSelfEfficacy(delta);
}

// 4.1B: Narrow API for value promotion — only these wrappers can create/remove value beliefs
export function brainstemBirthTypedBelief(
  statement: string,
  category: "value",
  domain: string,
  evidence: Array<{ text: string; timestamp: number; type: "outcome"; polarity: "support"; refId: string; weight: number }>,
  sourceType: "observed",
): SelfBelief | null {
  return instance?.birthTypedBelief(statement, category, domain, evidence, sourceType) ?? null;
}

export function brainstemRemoveBelief(idOrStatement: string): void {
  instance?.removeBelief(idOrStatement);
}

// Cortex: metrics
export function brainstemGetCortexMetrics(): ReturnType<CortexManager["getCortexMetrics"]> | null {
  return instance?.getCortexMetrics() ?? null;
}

/**
 * Feed user message into WM slots:
 * - open_question: if message contains question patterns
 * - background: previous conversation topic (from assistant's last message)
 */
export function brainstemFeedConversation(userText: string, assistantPrevText?: string): void {
  instance?.feedConversation(userText, assistantPrevText);
}

// ── TurnDirective support ────────────────────────────────────────────

export interface BrainstemTurnSignals {
  slots: Record<SlotName, WMSlot>;
  openCommitments: Array<{ content: string; urgency: number; createdAt: number }>;
  selfState: SelfState;
  topConcepts: Array<{ topic: string; weight: number }>;
  activeGoals: Array<{
    id: string; description: string; category: string;
    priority: number; relatedTopics: string[];
  }>;
  csi: { value: number; mode: "green" | "yellow" | "red" };
  driveSignal: { description: string; strength: number } | null;
  affectRegulation: { strategy: string; intensity: number };
}

export function brainstemGetTurnSignals(): BrainstemTurnSignals | null {
  return instance?.getTurnSignals() ?? null;
}

// ── Identity exports ─────────────────────────────────────────────────

export type { IdentityProfile, IdentityNarrative, IdentityTrajectory } from "./identity.js";
export type { SelfBelief } from "./self-model.js";

export function brainstemGetIdentityProfile(): IdentityProfile | null {
  return instance?.getIdentityProfile() ?? null;
}

export function brainstemGetIdentityNarrative(): IdentityNarrative | null {
  return instance?.getIdentityNarrative() ?? null;
}

export function brainstemGetIdentityTrajectory(): IdentityTrajectory | null {
  return instance?.getIdentityTrajectory() ?? null;
}

// ── Identity event recording ─────────────────────────────────────────

export interface IdentityEvent {
  type: "stance_expression" | "self_disclosure";
  disagreementReadiness: number;
  adherenceScore: number;
  topicOwnership?: { caresAbout: string[]; memoryWorthiness: number; followupWorthiness: number };
  timestamp: number;
}

export function brainstemRecordIdentityEvent(event: IdentityEvent): void {
  instance?.recordIdentityEvent(event);
}

export function brainstemGetRecentIdentityEvents(n = 10): IdentityEvent[] {
  return instance?.getRecentIdentityEvents(n) ?? [];
}

/** Track outbound message on the social model (called from proactive.ts). */
export function brainstemSocialOnOutbound(targetId: string, topics?: string[]): void {
  instance?.trackSocialOutbound(targetId, topics);
}

