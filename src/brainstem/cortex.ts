/**
 * Cortex API Layer — 4 typed, budgeted, degradable LLM interfaces.
 *
 * C-1 Semantic Compressor: consolidation-time concept extraction
 * C-2 Proposal Generator: planning-time action candidates
 * C-3 Outcome Extractor: post-action structured parsing
 * C-4 Uncertainty Simulator: imagination under low confidence
 *
 * The LLM is treated as an advisor (generates candidates, extracts structure,
 * imagines outcomes). The OS (brainstem) remains the decision maker.
 */

import { CORTEX_LIMITS, DEFAULT_ACT_TARGETS, type Clock } from "./config.js";
import type { ActionType, BeliefState } from "./world-model.js";
import type { SelfState } from "./self-model.js";
import { claudeText } from "../claude-runner.js";
import { getCharacter } from "../character.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { createLogger } from "../lib/logger.js";
import fs from "node:fs";
import path from "node:path";

const log = createLogger("brainstem-cortex");

// ── C-1: Semantic Compressor ──────────────────────────────────────────

export interface CortexSemanticInput {
  fragments: Array<{
    text: string;
    source: "conversation" | "memory" | "discovery" | "reflection";
    timestamp: number;
  }>;
  existingConcepts: string[];
  targetAbstractionLevel?: "specific" | "general" | "mixed";
}

export interface CortexSemanticOutput {
  concepts: Array<{
    label: string;
    definition: string;
    parentCandidate?: string;
    confidence: number;
    evidenceSpans: number[];
  }>;
  relations: Array<{
    source: string;
    target: string;
    type: "semantic" | "causal" | "co_occurrence";
    weight: number;
    confidence: number;
  }>;
  salienceHints: Array<{ concept: string; salience: number; reason: string }>;
}

// ── C-2: Proposal Generator ──────────────────────────────────────────

export interface CortexProposalInput {
  goal: { description: string; progress: number; milestones: string[] };
  beliefSnapshot: {
    selfState: SelfState;
    worldState: { socialReceptivity: number; topicViability: number; timeOfDay: string };
    recentOutcomes: Array<{ action: string; outcome: string; recency: number }>;
  };
  constraints: {
    actionWhitelist: ActionType[];
    blockedActions: ActionType[];
    maxSteps: number;
    selfBudget: { energy: number; social_energy: number };
  };
}

export interface CortexProposalOutput {
  candidates: Array<{
    action: ActionType;
    target?: string;
    description: string;
    rationale: string;
    expectedBenefit: string;  // qualitative, logged for audit but NOT used for EU scoring
    risk: string;             // qualitative risk description, NOT used for EU scoring
  }>;
  reasoningPaths?: Array<{ steps: string[]; conclusion: string }>;
}

// ── C-3: Outcome Extractor ───────────────────────────────────────────

export interface CortexOutcomeInput {
  action: { type: ActionType; target?: string; description: string };
  rawExperience: {
    transcript?: string;
    toolOutput?: string;
    timingMs?: number;
  };
  expectedOutcome: {
    replyReceived?: number;
    sentiment?: [number, number, number];
    goalProgressDelta?: number;
  };
}

export interface CortexOutcomeOutput {
  outcome: "positive" | "negative" | "neutral";
  fields: {
    replyReceived: boolean;
    replyLatencyMinutes: number;
    sentiment: -1 | 0 | 1;
    newInfoDiscovered: boolean;
    goalProgressDelta: number;
  };
  confidence: number;
  anomalyTags: string[];
  surpriseScore: number;
}

// ── C-4: Uncertainty Simulator ───────────────────────────────────────

export interface CortexSimulationInput {
  belief: BeliefState;
  selfState: SelfState;
  action: ActionType;
  target?: string;
  context: string;
}

export interface CortexSimulationOutput {
  outcomes: Array<{
    description: string;
    probability: number;
    latentEffects: { socialReceptivity: number; topicViability: number; goalMomentum: number };
    selfEffects: { energyDelta: number; socialEnergyDelta: number; safetyMarginDelta: number };
  }>;
  confidence: number;
  reasoning: string;
  caveats: string[];
}

// ── Budget, Logging, Loop B ──────────────────────────────────────────

export type CortexApiId = "c1" | "c2" | "c3" | "c4" | "verbalize" | "sanity" | "goal";

export interface CortexBudgetState {
  perApi: Record<CortexApiId, { usedToday: number; usedThisHour: number }>;
  globalTokensToday: number;
  lastDayReset: number;
  lastHourReset: number;
}

export interface CortexLogEntry {
  cortexId: CortexApiId;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outputValid: boolean;
  outputUsed: boolean;
  degradedTo: string | null;
}

export interface ProposalFeedback {
  cortexCallId: string;
  candidateIndex: number;
  actionType?: string;
  selected: boolean;
  outcomeIfSelected?: "positive" | "negative" | "neutral";
  rejectionReason?: string;
}

export interface PromptPolicy {
  goodExamples: Array<{ goal: string; action: string; rationale: string; outcome: string }>;
  avoidPatterns: string[];
  preferredActionDistribution: Record<string, number>;
  lastUpdated: number;
}

// Priority order: c3 (6) > verbalize (5) > c2 (4) > sanity (3) > c1 (2) > c4 (1)
const PRIORITY: Record<CortexApiId, number> = {
  c3: 6, verbalize: 5, c2: 4, sanity: 3, c1: 2, c4: 1, goal: 4,
};

function createEmptyBudget(): CortexBudgetState {
  const empty = { usedToday: 0, usedThisHour: 0 };
  return {
    perApi: {
      c1: { ...empty }, c2: { ...empty }, c3: { ...empty }, c4: { ...empty },
      verbalize: { ...empty }, sanity: { ...empty }, goal: { ...empty },
    },
    globalTokensToday: 0,
    lastDayReset: Math.floor(Date.now() / 86_400_000),
    lastHourReset: Date.now(),
  };
}

function createDefaultPolicy(): PromptPolicy {
  return {
    goodExamples: [],
    avoidPatterns: [],
    preferredActionDistribution: {},
    lastUpdated: Date.now(),
  };
}

// ── CortexManager ────────────────────────────────────────────────────

const CORTEX4_COOLDOWN_AFTER_RED_MS = 30 * 60_000; // 30 min cooldown after Red mode exit

export class CortexManager {
  private budget: CortexBudgetState;
  private policy: PromptPolicy;
  private dataPath: string;
  private degradationCount = 0;
  private totalCalls = 0;
  private c2AcceptCount = 0;
  private yellowMode = false;
  private c2TotalCount = 0;
  private c4TriggerCount = 0;
  private c3OutcomesTotal = 0;  // total outcomes processed (C-3 + hand-coded)
  private c3OutcomesParsed = 0; // outcomes parsed via C-3
  private lastRedModeExitAt = 0;

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.budget = readJsonSafe<CortexBudgetState>(
      path.join(dataPath, "brainstem", "cortex-budget.json"),
      createEmptyBudget(),
    );
    this.policy = readJsonSafe<PromptPolicy>(
      path.join(dataPath, "brainstem", "cortex-policy.json"),
      createDefaultPolicy(),
    );
  }

  /** Called when stabilizer exits Red mode — starts C-4 cooldown timer. */
  notifyRedModeExit(): void {
    this.lastRedModeExitAt = this.clock.nowMs();
  }

  /** Track outcome processing for cortex3UsageRate metric. */
  recordOutcomeProcessed(viaCortex3: boolean): void {
    this.c3OutcomesTotal++;
    if (viaCortex3) this.c3OutcomesParsed++;
  }

  /** Called by engine when CSI mode changes — Yellow mode halves C-4 budget. */
  setYellowMode(active: boolean): void {
    this.yellowMode = active;
  }

  // ── Budget enforcement ──────────────────────────────────────────

  canCall(api: CortexApiId): boolean {
    this.resetIfNeeded();
    const entry = this.budget.perApi[api];
    const limits = CORTEX_LIMITS[api] as { perDay?: number; perHour?: number };

    // Per-API limits (C-4 halved in Yellow mode per design doc)
    let dayLimit = limits.perDay;
    let hourLimit = limits.perHour;
    if (api === "c4" && this.yellowMode) {
      if (dayLimit !== undefined) dayLimit = Math.floor(dayLimit / 2);
      if (hourLimit !== undefined) hourLimit = Math.floor(hourLimit / 2);
    }
    if (dayLimit !== undefined && entry.usedToday >= dayLimit) return false;
    if (hourLimit !== undefined && entry.usedThisHour >= hourLimit) return false;

    // Global token ceiling with priority queue
    const pct = this.budget.globalTokensToday / CORTEX_LIMITS.globalTokenCeiling;
    const rank = PRIORITY[api];
    if (pct > 0.95 && rank < 5) return false;  // only c3 + verbalize
    if (pct > 0.90 && rank < 3) return false;  // also defer sanity
    if (pct > 0.85 && rank < 2) return false;  // also defer c1
    if (pct > 0.80 && rank < 1) return false;  // defer c4

    return true;
  }

  private resetIfNeeded(): void {
    const now = this.clock.nowMs();
    const currentDay = Math.floor(now / 86_400_000);

    // Day reset
    if (currentDay !== this.budget.lastDayReset) {
      for (const entry of Object.values(this.budget.perApi)) {
        entry.usedToday = 0;
        entry.usedThisHour = 0;
      }
      this.budget.globalTokensToday = 0;
      this.budget.lastDayReset = currentDay;
      this.budget.lastHourReset = now;
    }

    // Hour reset
    if (now - this.budget.lastHourReset > 3_600_000) {
      for (const entry of Object.values(this.budget.perApi)) {
        entry.usedThisHour = 0;
      }
      this.budget.lastHourReset = now;
    }
  }

  private incrementBudget(api: CortexApiId, tokens: number): void {
    const entry = this.budget.perApi[api];
    entry.usedToday++;
    entry.usedThisHour++;
    this.budget.globalTokensToday += tokens;
  }

  /**
   * Track an existing (non-cortex) LLM call under the unified budget.
   * Used for verbalize (micro-thought), sanity check, goal progress calls.
   * Returns false if budget is exceeded (caller should skip the LLM call).
   */
  trackExternalCall(api: CortexApiId, estimatedTokens: number): boolean {
    if (!this.canCall(api)) return false;
    this.incrementBudget(api, estimatedTokens);
    this.totalCalls++;
    return true;
  }

  // ── Call logging ────────────────────────────────────────────────

  private logCall(entry: CortexLogEntry): void {
    try {
      const logPath = path.join(this.dataPath, "brainstem", "cortex-log.jsonl");
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
    } catch {
      // non-critical
    }
  }

  // ── Output validation ──────────────────────────────────────────

  private validateOutput<T>(raw: string, requiredKeys: string[]): T | null {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const cleaned = match[0]
        .replace(/,\s*([\]}])/g, "$1")
        .replace(/[\x00-\x1f]/g, (c) => (c === "\n" || c === "\t" ? c : ""));
      const obj = JSON.parse(cleaned);
      for (const key of requiredKeys) {
        if (!(key in obj)) return null;
      }
      return obj as T;
    } catch {
      return null;
    }
  }

  // ── Token estimation ───────────────────────────────────────────

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3);
  }

  // ── C-1: Semantic Compressor ───────────────────────────────────

  async compressSemantics(input: CortexSemanticInput): Promise<CortexSemanticOutput> {
    const empty: CortexSemanticOutput = { concepts: [], relations: [], salienceHints: [] };
    this.totalCalls++;

    if (!this.canCall("c1")) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c1", timestamp: this.clock.nowMs(),
        inputTokens: 0, outputTokens: 0, latencyMs: 0,
        outputValid: false, outputUsed: false, degradedTo: "empty_fallback",
      });
      return empty;
    }

    const charName = getCharacter().name;
    const system = `你是${charName}的语义压缩器。从碎片中提取概念、关系和显著性线索。
输出严格JSON：{ "concepts": [...], "relations": [...], "salienceHints": [...] }
concepts: { label, definition, parentCandidate?, confidence(0-1), evidenceSpans(碎片索引数组) }
relations: { source, target, type("semantic"|"causal"|"co_occurrence"), weight(0-1), confidence(0-1) }
salienceHints: { concept, salience(0-1), reason }
只输出JSON，不要其他文字。`;

    const abstraction = input.targetAbstractionLevel ?? "mixed";
    const prompt = `已有概念: ${input.existingConcepts.join(", ") || "（无）"}
抽象层级: ${abstraction}

碎片:
${input.fragments.map((f, i) => `[${i}] (${f.source}) ${f.text}`).join("\n")}

提取新概念和关系：`;

    const startMs = this.clock.nowMs();
    try {
      const raw = await claudeText({ label: "brainstem.semanticAnalysis", system, prompt, model: "fast", timeoutMs: 15_000 });
      const latencyMs = this.clock.nowMs() - startMs;
      const result = this.validateOutput<CortexSemanticOutput>(raw, ["concepts", "relations", "salienceHints"]);

      if (!result) {
        this.degradationCount++;
        this.logCall({
          cortexId: "c1", timestamp: startMs,
          inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
          latencyMs, outputValid: false, outputUsed: false, degradedTo: "parse_failure",
        });
        return empty;
      }

      const tokens = this.estimateTokens(prompt) + this.estimateTokens(raw);
      this.incrementBudget("c1", tokens);
      this.logCall({
        cortexId: "c1", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
        latencyMs, outputValid: true, outputUsed: true, degradedTo: null,
      });
      return result;
    } catch (err) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c1", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: 0,
        latencyMs: this.clock.nowMs() - startMs,
        outputValid: false, outputUsed: false, degradedTo: "call_error",
      });
      log.warn("c1 compressSemantics failed", err);
      return empty;
    }
  }

  // ── C-2: Proposal Generator ────────────────────────────────────

  async generateProposals(input: CortexProposalInput): Promise<CortexProposalOutput | null> {
    this.totalCalls++;

    if (!this.canCall("c2")) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c2", timestamp: this.clock.nowMs(),
        inputTokens: 0, outputTokens: 0, latencyMs: 0,
        outputValid: false, outputUsed: false, degradedTo: "budget_exceeded",
      });
      return null;
    }

    const charName = getCharacter().name;
    const policySuffix = this.getC2PromptSuffix();
    const validTargetIds = DEFAULT_ACT_TARGETS.map(t => t.id);
    const system = `你是${charName}的行动提案生成器。根据目标、信念和约束，提出候选行动。
允许的行动类型: ${input.constraints.actionWhitelist.join(", ")}
允许的target值: ${validTargetIds.join(", ")}（target字段必须是这些值之一，或省略）
禁止的行动: ${input.constraints.blockedActions.join(", ") || "无"}
最多${input.constraints.maxSteps}个候选。

输出严格JSON：{ "candidates": [...], "reasoningPaths": [...] }
candidates: { action(必须在白名单内), target(必须在允许列表内或省略)?, description, rationale, expectedBenefit(定性描述), risk(定性风险描述) }
reasoningPaths: { steps: string[], conclusion: string }
只输出JSON，不要其他文字。${policySuffix}`;

    const prompt = `目标: ${input.goal.description} (进度: ${(input.goal.progress * 100).toFixed(0)}%)
里程碑: ${input.goal.milestones.join("; ") || "无"}

信念状态:
- 社交接受度: ${input.beliefSnapshot.worldState.socialReceptivity.toFixed(2)}
- 话题活力: ${input.beliefSnapshot.worldState.topicViability.toFixed(2)}
- 时间段: ${input.beliefSnapshot.worldState.timeOfDay}
- 能量: ${input.beliefSnapshot.selfState.energy.toFixed(2)}, 社交能量: ${input.beliefSnapshot.selfState.social_energy.toFixed(2)}

近期结果:
${input.beliefSnapshot.recentOutcomes.map(o => `- ${o.action}: ${o.outcome}`).join("\n") || "无"}

生成候选行动：`;

    const startMs = this.clock.nowMs();
    try {
      const raw = await claudeText({ label: "brainstem.proposeConcept", system, prompt, model: "fast", timeoutMs: 15_000 });
      const latencyMs = this.clock.nowMs() - startMs;
      const result = this.validateOutput<CortexProposalOutput>(raw, ["candidates"]);

      if (!result) {
        this.degradationCount++;
        this.logCall({
          cortexId: "c2", timestamp: startMs,
          inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
          latencyMs, outputValid: false, outputUsed: false, degradedTo: "parse_failure",
        });
        return null;
      }

      // Hard validation: discard candidates with actions not in whitelist or unknown targets
      const whitelist = new Set(input.constraints.actionWhitelist);
      const knownTargets = new Set(DEFAULT_ACT_TARGETS.map(t => t.id));
      const validCandidates = result.candidates.filter(c => {
        if (!whitelist.has(c.action)) {
          log.warn(`cortex_violation: c2 proposed action "${c.action}" not in whitelist`);
          return false;
        }
        if (c.target && !knownTargets.has(c.target)) {
          log.warn(`cortex_violation: c2 proposed unknown target "${c.target}"`);
          return false;
        }
        return true;
      });

      if (validCandidates.length === 0) {
        this.degradationCount++;
        this.logCall({
          cortexId: "c2", timestamp: startMs,
          inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
          latencyMs, outputValid: true, outputUsed: false, degradedTo: "all_candidates_invalid",
        });
        return null;
      }

      const tokens = this.estimateTokens(prompt) + this.estimateTokens(raw);
      this.incrementBudget("c2", tokens);
      this.logCall({
        cortexId: "c2", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
        latencyMs, outputValid: true, outputUsed: true, degradedTo: null,
      });
      return { candidates: validCandidates, reasoningPaths: result.reasoningPaths };
    } catch (err) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c2", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: 0,
        latencyMs: this.clock.nowMs() - startMs,
        outputValid: false, outputUsed: false, degradedTo: "call_error",
      });
      log.warn("c2 generateProposals failed", err);
      return null;
    }
  }

  // ── C-3: Outcome Extractor ─────────────────────────────────────

  async extractOutcome(input: CortexOutcomeInput): Promise<CortexOutcomeOutput | null> {
    this.totalCalls++;

    if (!this.canCall("c3")) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c3", timestamp: this.clock.nowMs(),
        inputTokens: 0, outputTokens: 0, latencyMs: 0,
        outputValid: false, outputUsed: false, degradedTo: "budget_exceeded",
      });
      return null;
    }

    const charName = getCharacter().name;
    const system = `你是${charName}的结果提取器。从原始体验中提取结构化结果。
输出严格JSON：{ "outcome", "fields", "confidence", "anomalyTags", "surpriseScore" }
outcome: "positive" | "negative" | "neutral"
fields: { replyReceived(bool), replyLatencyMinutes(number), sentiment(-1|0|1), newInfoDiscovered(bool), goalProgressDelta(number 0-1) }
confidence: 0-1
anomalyTags: 异常标签字符串数组
surpriseScore: 0-1 (预期偏差程度)
只输出JSON，不要其他文字。`;

    const prompt = `行动: ${input.action.type}${input.action.target ? ` → ${input.action.target}` : ""}: ${input.action.description}

原始体验:
${input.rawExperience.transcript ?? input.rawExperience.toolOutput ?? "(无)"}
${input.rawExperience.timingMs ? `耗时: ${input.rawExperience.timingMs}ms` : ""}

预期结果:
- 回复概率: ${input.expectedOutcome.replyReceived?.toFixed(2) ?? "未知"}
- 情感分布: ${input.expectedOutcome.sentiment?.map(s => s.toFixed(2)).join(",") ?? "未知"}
- 目标进展: ${input.expectedOutcome.goalProgressDelta?.toFixed(2) ?? "未知"}

提取结构化结果：`;

    const startMs = this.clock.nowMs();
    try {
      const raw = await claudeText({ label: "brainstem.predict", system, prompt, model: "fast", timeoutMs: 10_000 });
      const latencyMs = this.clock.nowMs() - startMs;
      const result = this.validateOutput<CortexOutcomeOutput>(raw, ["outcome", "fields", "confidence"]);

      if (!result) {
        this.degradationCount++;
        this.logCall({
          cortexId: "c3", timestamp: startMs,
          inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
          latencyMs, outputValid: false, outputUsed: false, degradedTo: "parse_failure",
        });
        return null;
      }

      const tokens = this.estimateTokens(prompt) + this.estimateTokens(raw);
      this.incrementBudget("c3", tokens);
      this.logCall({
        cortexId: "c3", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
        latencyMs, outputValid: true, outputUsed: true, degradedTo: null,
      });
      return result;
    } catch (err) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c3", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: 0,
        latencyMs: this.clock.nowMs() - startMs,
        outputValid: false, outputUsed: false, degradedTo: "call_error",
      });
      log.warn("c3 extractOutcome failed", err);
      return null;
    }
  }

  // ── C-4: Uncertainty Simulator ─────────────────────────────────

  async simulateOutcomes(
    input: CortexSimulationInput,
    cortex4Enabled: boolean,
    worldModelConfidence: number,
  ): Promise<CortexSimulationOutput | null> {
    this.totalCalls++;

    // Extra gate: only callable when cortex4Enabled AND low world model confidence AND not Red
    if (!cortex4Enabled) return null;
    if (worldModelConfidence >= 0.4) return null;
    if (input.belief.internal.csiMode === "red") return null;
    // 30 min cooldown after Red mode exit
    if (this.lastRedModeExitAt > 0 && this.clock.nowMs() - this.lastRedModeExitAt < CORTEX4_COOLDOWN_AFTER_RED_MS) return null;

    this.c4TriggerCount++;

    if (!this.canCall("c4")) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c4", timestamp: this.clock.nowMs(),
        inputTokens: 0, outputTokens: 0, latencyMs: 0,
        outputValid: false, outputUsed: false, degradedTo: "budget_exceeded",
      });
      return null;
    }

    const charName = getCharacter().name;
    const system = `你是${charName}的不确定性模拟器。在低信心情况下想象可能的结果。
输出严格JSON：{ "outcomes", "confidence", "reasoning", "caveats" }
outcomes: 数组，每项 { description, probability(0-1，概率之和=1), latentEffects: { socialReceptivity, topicViability, goalMomentum }, selfEffects: { energyDelta, socialEnergyDelta, safetyMarginDelta } }
confidence: 0-1
reasoning: 模拟推理过程的简要说明
caveats: 注意事项字符串数组
只输出JSON，不要其他文字。`;

    const prompt = `当前信念:
- CSI模式: ${input.belief.internal.csiMode}
- 社交接受度: ${input.belief.latent.socialReceptivity.toFixed(2)}
- 话题活力: ${input.belief.latent.topicViability.toFixed(2)}
- 目标动量: ${input.belief.latent.goalMomentum.toFixed(2)}

自我状态:
- 能量: ${input.selfState.energy.toFixed(2)}, 疲劳: ${input.selfState.fatigue.toFixed(2)}
- 社交能量: ${input.selfState.social_energy.toFixed(2)}
- 安全边际: ${input.selfState.safety_margin.toFixed(2)}

计划行动: ${input.action}${input.target ? ` → ${input.target}` : ""}
背景: ${input.context}

模拟2-4种可能结果：`;

    const startMs = this.clock.nowMs();
    try {
      const raw = await claudeText({ label: "brainstem.simulate", system, prompt, model: "fast", timeoutMs: 12_000, maxOutputChars: 900 });
      const latencyMs = this.clock.nowMs() - startMs;
      const result = this.validateOutput<CortexSimulationOutput>(raw, ["outcomes", "confidence"]);

      if (!result) {
        this.degradationCount++;
        this.logCall({
          cortexId: "c4", timestamp: startMs,
          inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
          latencyMs, outputValid: false, outputUsed: false, degradedTo: "parse_failure",
        });
        return null;
      }

      const tokens = this.estimateTokens(prompt) + this.estimateTokens(raw);
      this.incrementBudget("c4", tokens);
      this.logCall({
        cortexId: "c4", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: this.estimateTokens(raw),
        latencyMs, outputValid: true, outputUsed: true, degradedTo: null,
      });
      return result;
    } catch (err) {
      this.degradationCount++;
      this.logCall({
        cortexId: "c4", timestamp: startMs,
        inputTokens: this.estimateTokens(prompt), outputTokens: 0,
        latencyMs: this.clock.nowMs() - startMs,
        outputValid: false, outputUsed: false, degradedTo: "call_error",
      });
      log.warn("c4 simulateOutcomes failed", err);
      return null;
    }
  }

  // ── Loop B: Prompt Policy ──────────────────────────────────────

  recordProposalFeedback(feedback: ProposalFeedback): void {
    // Track all selected candidates for cortex2AcceptRate metric
    if (feedback.selected) {
      this.c2AcceptCount++;
    }
    this.c2TotalCount++;

    if (feedback.selected && feedback.outcomeIfSelected === "positive") {
      // Good example — FIFO max 5
      this.policy.goodExamples.push({
        goal: feedback.cortexCallId,
        action: `candidate-${feedback.candidateIndex}`,
        rationale: "selected",
        outcome: feedback.outcomeIfSelected,
      });
      if (this.policy.goodExamples.length > 5) this.policy.goodExamples.shift();
    } else if (feedback.rejectionReason) {
      // Avoid pattern — FIFO max 3
      this.policy.avoidPatterns.push(feedback.rejectionReason);
      if (this.policy.avoidPatterns.length > 3) this.policy.avoidPatterns.shift();
    }

    // Update preferredActionDistribution: EWMA of acceptance rate per action type
    if (feedback.actionType) {
      const dist = this.policy.preferredActionDistribution;
      const prev = dist[feedback.actionType] ?? 0.5;
      const lr = 0.1;
      dist[feedback.actionType] = prev + lr * ((feedback.selected ? 1 : 0) - prev);
    }

    this.policy.lastUpdated = this.clock.nowMs();
  }

  private getC2PromptSuffix(): string {
    const parts: string[] = [];
    // Include preferredActionDistribution when available
    const dist = this.policy.preferredActionDistribution;
    const distEntries = Object.entries(dist).filter(([, v]) => Math.abs(v - 0.5) > 0.05);
    if (distEntries.length > 0) {
      parts.push("\n\n偏好的行动分布:");
      for (const [action, rate] of distEntries.sort((a, b) => b[1] - a[1])) {
        parts.push(`- ${action}: 接受率${(rate * 100).toFixed(0)}%`);
      }
    }
    if (this.policy.goodExamples.length > 0) {
      parts.push("\n\n好的例子:");
      for (const ex of this.policy.goodExamples) {
        parts.push(`- 目标「${ex.goal}」→ ${ex.action} → ${ex.outcome}`);
      }
    }
    if (this.policy.avoidPatterns.length > 0) {
      parts.push("\n避免:");
      for (const p of this.policy.avoidPatterns) {
        parts.push(`- ${p}`);
      }
    }
    return parts.join("\n");
  }

  // ── Persistence ────────────────────────────────────────────────

  save(): void {
    try {
      const dir = path.join(this.dataPath, "brainstem");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, "cortex-budget.json"), this.budget);
      writeJsonAtomic(path.join(dir, "cortex-policy.json"), this.policy);
    } catch (err) {
      log.warn("cortex save failed", err);
    }
  }

  // ── Metrics ────────────────────────────────────────────────────

  getCortexMetrics(): {
    cortexCallsPerHour: number;
    cortexTokensToday: number;
    cortex3UsageRate: number;
    cortex2AcceptRate: number;
    cortex4TriggerRate: number;
    cortexDegradationRate: number;
  } {
    return {
      cortexCallsPerHour: Object.values(this.budget.perApi).reduce((s, e) => s + e.usedThisHour, 0),
      cortexTokensToday: this.budget.globalTokensToday,
      cortex3UsageRate: this.c3OutcomesTotal > 0 ? this.c3OutcomesParsed / this.c3OutcomesTotal : 0,
      cortex2AcceptRate: this.c2TotalCount > 0 ? this.c2AcceptCount / this.c2TotalCount : 0,
      cortex4TriggerRate: this.totalCalls > 0 ? this.c4TriggerCount / this.totalCalls : 0,
      cortexDegradationRate: this.totalCalls > 0 ? this.degradationCount / this.totalCalls : 0,
    };
  }
}
