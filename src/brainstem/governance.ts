/**
 * Data Governance — memory provenance, quarantine/rollback, discovery trust levels,
 * active forgetting, OutcomeTracker, outcome frequency tables.
 */

import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { type Clock, BRAINSTEM_CONFIG as C } from "./config.js";
import type { ConceptGraph, ConceptNode } from "./graph.js";
import type { OutcomeRecord } from "./curiosity-engine.js";
import type { Plan } from "./planner.js";
import path from "node:path";
import fs from "node:fs";
import { createLogger } from "../lib/logger.js";
import { emitState } from "../lib/state-bus.js";

const log = createLogger("brainstem-governance");

// ── Types ────────────────────────────────────────────────────────────

export interface BrainstemMemoryWrite {
  key: string;
  value: unknown;
  origin: "brainstem";
  triggeredBy: {
    type: "reflection" | "consolidation" | "goal_propose" | "insight";
    decisionLogId: string;
    evidencePacketHash: string;
    microThoughtIds: string[];
  };
  supersedes?: string;
  status: "active" | "deprecated" | "quarantined";
  createdAt: number;
}

export interface GoalProgressEvent {
  goalId: string;
  progressBefore: number;
  progressAfter: number;
  source: "micro_thought" | "reflection" | "act_gate" | "conversation" | "notification";
  sourceId: string;
  timestamp: number;
}

export interface Commitment {
  id: string;
  content: string;
  targetEntity: string;
  createdAt: number;
  resolvedAt?: number;
  status: "open" | "fulfilled" | "expired" | "cancelled";
  urgency: number;  // 0-1, increases with age
  sourceDecisionLogId?: string;
}

export interface DiscoveryTrust {
  discoveryId: string;
  tier: "raw" | "verified" | "actionable";
  referenceCount: number;
  firstSeen: number;
  promotedAt?: number;
  hasPositivePrediction?: boolean;  // L10: CS1 positive prediction check
}

export interface SuppressionLabel {
  reason: "act_rejected" | "loop_trigger";
  count: number;
  since: number;
}

export interface GroundingEvidencePacket {
  /** Micro-thought that triggered the action */
  microThoughtId: string;
  microThoughtContent: string;
  /** Trigger type that passed the thought gate */
  triggerType: string;
  /** Anchor tag (grounded, inferred, speculative) */
  anchor: string;
  /** Target of the action */
  targetId: string;
  targetType: string;
  /** All grounding references with full score decomposition */
  groundingRefs: Array<{
    type: "memory" | "goal" | "discovery";
    id: string;
    weight: number;
    sourceNodeIds: string[];
    why: string;
    rawScoreParts: Record<string, number | undefined>;
  }>;
  /** Cluster concepts that contributed */
  clusterConceptIds: string[];
  /** Activation levels at time of decision */
  maxActivation: number;
  meanValence: number;
  /** Gate checks that were passed */
  gatesPassed: string[];
  /** Self-model annex: snapshot + why_now rationale */
  selfAnnex?: {
    snapshot: { energy: number; social_energy: number; safety_margin: number; fatigue: number };
    why_now: string;
  };
  /** Timestamp */
  timestamp: number;
}

export interface AuditRecord {
  type: "brainstem_action" | "exploration_outcome" | "memory_write" | "goal_update";
  action?: string;
  decisionLogId?: string;
  inputsSnapshotHash?: string;
  groundingSummary?: string;
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface GovernanceState {
  memoryWrites: BrainstemMemoryWrite[];
  goalEvents: GoalProgressEvent[];
  discoveryTrust: DiscoveryTrust[];
  suppressions: Record<string, SuppressionLabel>;
  pendingOutcomes: OutcomeRecord[];
  completedOutcomes: OutcomeRecord[];
  lastProcessed: number;
  commitments?: Commitment[];
  version?: number;
}

// ── Brainstem Veto — hard constraints from high-confidence signals ───

export type AuthorityLevel = "advisory" | "directive" | "mandatory";

export interface BrainstemVeto {
  /** Override max output tokens (CSI red → 300) */
  maxTokens?: number;
  /** Force stance override (fatigue/energy thresholds) */
  forceStance?: string;
  /** Block heartbeat actions when depleted */
  blockActions?: string[];
  /** Computed authority level for the TurnDirective */
  authorityLevel: AuthorityLevel;
  /** Human-readable reasons for escalation */
  reasons: string[];
  /** Decomposition of each input signal's contribution to the veto */
  decomposition?: {
    csiContribution: string | null;
    selfStateContribution: string | null;
    commitmentContribution: string | null;
    adherenceContribution: string | null;
  };
}

/**
 * Compute hard-constraint veto from brainstem state.
 *
 * Called by computeTurnDirective to inject mandatory constraints.
 * The veto cannot be overridden by the LLM — it represents
 * physiological and cognitive limits.
 */
export function computeVeto(
  csi: { value: number; mode: "green" | "yellow" | "red" } | null,
  selfState: { energy: number; fatigue: number; social_energy: number; self_efficacy: number } | null,
  commitmentPressure: number,
  previousAdherenceScore: number | null,
  consecutiveLowAdherence: number,
): BrainstemVeto {
  const reasons: string[] = [];
  // Use a mutable variable that TypeScript won't narrow prematurely
  let level: AuthorityLevel = "advisory";
  let maxTokens: number | undefined;
  let forceStance: string | undefined;
  const blockActions: string[] = [];

  /** Upgrade authority level (never downgrade). */
  const escalate = (to: AuthorityLevel): void => {
    const rank: Record<AuthorityLevel, number> = { advisory: 0, directive: 1, mandatory: 2 };
    if (rank[to] > rank[level]) level = to;
  };

  // ── Hard constraints from CSI ──
  if (csi?.mode === "red") {
    maxTokens = 300;
    forceStance = "subdued";
    escalate("mandatory");
    reasons.push("CSI red: forced short replies");
  } else if (csi?.mode === "yellow") {
    escalate("directive");
    reasons.push("CSI yellow: suggest concise replies");
  }

  // ── Hard constraints from self-state ──
  if (selfState) {
    if (selfState.fatigue > 0.7) {
      forceStance = forceStance ?? "subdued";
      escalate("directive");
      reasons.push(`fatigue=${selfState.fatigue.toFixed(2)}: converging due to exhaustion`);
    }
    if (selfState.energy < 0.2) {
      blockActions.push("explore", "post");
      escalate("directive");
      reasons.push(`energy=${selfState.energy.toFixed(2)}: insufficient energy, limiting proactive actions`);
    }
    if (selfState.social_energy < 0.15) {
      forceStance = forceStance ?? "subdued";
      reasons.push(`social_energy=${selfState.social_energy.toFixed(2)}: social energy depleted`);
    }
  }

  // ── Commitment pressure escalation ──
  if (commitmentPressure > 0.7) {
    escalate("directive");
    reasons.push(`commitment_pressure=${commitmentPressure.toFixed(2)}: urgent commitments pending`);
  }

  // ── Adherence feedback escalation ──
  if (consecutiveLowAdherence >= 3) {
    escalate("mandatory");
    reasons.push(`${consecutiveLowAdherence} consecutive low adherence rounds: forced enforcement`);
  } else if (previousAdherenceScore !== null && previousAdherenceScore < 0.5) {
    escalate("directive");
    reasons.push(`previous adherence=${previousAdherenceScore.toFixed(2)}: escalating constraints`);
  }

  const decomposition = {
    csiContribution: csi ? `mode=${csi.mode}, value=${csi.value}` : null,
    selfStateContribution: selfState ? `energy=${selfState.energy.toFixed(2)}, fatigue=${selfState.fatigue.toFixed(2)}, social=${selfState.social_energy.toFixed(2)}` : null,
    commitmentContribution: commitmentPressure > 0 ? `pressure=${commitmentPressure.toFixed(2)}` : null,
    adherenceContribution: previousAdherenceScore !== null ? `score=${previousAdherenceScore.toFixed(2)}, consecutive_low=${consecutiveLowAdherence}` : null,
  };

  return {
    maxTokens,
    forceStance,
    blockActions: blockActions.length > 0 ? blockActions : undefined,
    authorityLevel: level,
    reasons,
    decomposition,
  };
}

// ── OutcomeTracker ───────────────────────────────────────────────────

export class OutcomeTracker {
  private state: GovernanceState;
  private dataPath: string;

  constructor(dataPath: string, private clock: Clock) {
    this.dataPath = dataPath;
    this.state = this.load();
  }

  // ── Outcome recording ────────────────────────────────────────

  recordOutcome(outcome: OutcomeRecord): void {
    if (outcome.outcome === "pending") {
      this.state.pendingOutcomes.push(outcome);
    } else {
      this.state.completedOutcomes.push(outcome);
      // Cap completed outcomes
      if (this.state.completedOutcomes.length > 200) {
        this.state.completedOutcomes = this.state.completedOutcomes.slice(-200);
      }
    }
    this.save();
  }

  resolvePendingOutcome(
    decisionLogId: string,
    result: "positive" | "negative" | "neutral",
    signal: string,
  ): void {
    const idx = this.state.pendingOutcomes.findIndex(
      o => o.triggeredBy.decisionLogId === decisionLogId,
    );
    if (idx === -1) return;

    const outcome = this.state.pendingOutcomes.splice(idx, 1)[0];
    outcome.outcome = result;
    outcome.outcomeSignal = signal;
    outcome.timestamp = this.clock.nowMs();

    this.state.completedOutcomes.push(outcome);
    this.save();
  }

  getCompletedOutcomes(): OutcomeRecord[] {
    return [...this.state.completedOutcomes];
  }

  getPendingOutcomes(): OutcomeRecord[] {
    return [...this.state.pendingOutcomes];
  }

  // ── Credit propagation ───────────────────────────────────────

  propagateCredit(
    outcome: OutcomeRecord,
    graph: ConceptGraph,
  ): void {
    const delta = outcome.outcome === "positive" ? 1
      : outcome.outcome === "negative" ? -1
      : 0;
    if (delta === 0) return;

    // Edge weight update
    for (const edge of graph.edges) {
      const srcInCluster = outcome.triggeredBy.clusterConceptIds.includes(edge.source);
      const tgtInCluster = outcome.triggeredBy.clusterConceptIds.includes(edge.target);
      if (srcInCluster && tgtInCluster) {
        edge.weight = Math.max(0.05, Math.min(1, edge.weight + 0.01 * delta));
      }
    }

    // Grounding weight update
    for (const ref of outcome.triggeredBy.groundingRefs) {
      ref.weight = Math.max(0, Math.min(1, ref.weight + 0.05 * delta));
    }

    // Uncertainty update + cumulative credit on cluster concepts
    for (const conceptId of outcome.triggeredBy.clusterConceptIds) {
      const node = graph.nodes[conceptId];
      if (!node) continue;
      if (outcome.outcome === "positive") {
        node.uncertainty = Math.max(0, node.uncertainty - 0.05);
      }
      // Accumulate credit magnitude
      node.cumulativeCredit = (node.cumulativeCredit ?? 0) + Math.abs(delta * 0.01);
      // Auto-promote discoveries with cumulative credit > 0.5
      if (node.cumulativeCredit > 0.5 && node.source === "curiosity") {
        this.trackDiscovery(conceptId);
        const trust = this.state.discoveryTrust.find(d => d.discoveryId === conceptId);
        if (trust && trust.tier === "raw") {
          trust.tier = "verified";
          trust.promotedAt = this.clock.nowMs();
        }
      }
    }

    // Suppression for repeated failures
    if (outcome.outcome === "negative") {
      for (const conceptId of outcome.triggeredBy.clusterConceptIds) {
        this.incrementSuppression(conceptId, "act_rejected");
      }
    }

    this.save();
  }

  /** Propagate discounted credit through a plan's bestPath. */
  propagatePlanCredit(
    outcome: OutcomeRecord,
    plan: Plan,
    graph: ConceptGraph,
  ): void {
    const delta = outcome.outcome === "positive" ? 1
      : outcome.outcome === "negative" ? -1
      : 0;
    if (delta === 0) return;

    const DISCOUNT = 0.8;
    const completedIdx = Math.min(plan.currentStepIndex, plan.bestPath.length - 1);

    // Walk backwards from completed step
    for (let i = completedIdx; i >= 0; i--) {
      const nodeIdx = plan.bestPath[i];
      const planNode = plan.nodes[nodeIdx];
      if (!planNode) continue;

      const distance = completedIdx - i;
      const credit = delta * Math.pow(DISCOUNT, distance) * 0.05;

      // Find related graph nodes (goal-related)
      const goalNode = graph.nodes[planNode.relatedGoalId];
      if (goalNode) {
        goalNode.cumulativeCredit = (goalNode.cumulativeCredit ?? 0) + Math.abs(credit);
      }

      // Update edges between consecutive plan steps
      if (i < completedIdx) {
        const nextNodeIdx = plan.bestPath[i + 1];
        const nextPlanNode = plan.nodes[nextNodeIdx];
        if (nextPlanNode) {
          // Strengthen/weaken edges between these plan nodes' related concepts
          for (const edge of graph.edges) {
            if ((edge.source === planNode.relatedGoalId && edge.target === nextPlanNode.relatedGoalId) ||
                (edge.target === planNode.relatedGoalId && edge.source === nextPlanNode.relatedGoalId)) {
              edge.weight = Math.max(0.05, Math.min(1, edge.weight + credit * 0.2));
            }
          }
        }
      }
    }

    // Write audit
    this.writeAuditRecord({
      type: "brainstem_action",
      action: "plan_credit_propagation",
      timestamp: this.clock.nowMs(),
      details: {
        planId: plan.id,
        goalId: plan.goalId,
        outcome: outcome.outcome,
        stepsAssigned: completedIdx + 1,
      },
    });
  }

  // ── Suppression labels ───────────────────────────────────────

  incrementSuppression(conceptId: string, reason: SuppressionLabel["reason"]): void {
    const existing = this.state.suppressions[conceptId];
    if (existing) {
      existing.count++;
    } else {
      this.state.suppressions[conceptId] = {
        reason,
        count: 1,
        since: this.clock.nowMs(),
      };
    }
    this.save();
  }

  getSuppression(conceptId: string): SuppressionLabel | null {
    const label = this.state.suppressions[conceptId];
    if (!label) return null;

    // Check decay: 7 days no new events → remove
    if (this.clock.nowMs() - label.since > 7 * 86_400_000) {
      delete this.state.suppressions[conceptId];
      this.save();
      return null;
    }

    return label;
  }

  isActivelySuppressed(conceptId: string): boolean {
    const label = this.getSuppression(conceptId);
    return label !== null && label.count >= 3;
  }

  // ── Memory write provenance ──────────────────────────────────

  recordMemoryWrite(write: BrainstemMemoryWrite): void {
    this.state.memoryWrites.push(write);
    // Cap memory writes log
    if (this.state.memoryWrites.length > 100) {
      this.state.memoryWrites = this.state.memoryWrites.slice(-100);
    }

    // Write audit record
    this.writeAuditRecord({
      type: "memory_write",
      details: {
        key: write.key,
        status: write.status,
        triggeredBy: write.triggeredBy,
      },
      timestamp: write.createdAt,
    });

    this.save();
  }

  deprecateMemory(key: string, graph: ConceptGraph): void {
    const write = this.state.memoryWrites.find(
      w => w.key === key && w.status === "active",
    );
    if (write) {
      write.status = "deprecated";
    }

    // Remove from graph nodes
    for (const node of Object.values(graph.nodes)) {
      const idx = node.memoryKeys.indexOf(key);
      if (idx !== -1) {
        node.memoryKeys.splice(idx, 1);
      }
    }

    this.save();
  }

  quarantineMemory(key: string): void {
    const write = this.state.memoryWrites.find(
      w => w.key === key && w.status === "active",
    );
    if (write) {
      write.status = "quarantined";
    }
    this.save();
  }

  promoteQuarantined(): void {
    const now = this.clock.nowMs();
    for (const write of this.state.memoryWrites) {
      if (write.status === "quarantined" && now - write.createdAt > 24 * 3_600_000) {
        write.status = "active";
      }
    }
    this.save();
  }

  // ── Commitment tracking ─────────────────────────────────────

  addCommitment(content: string, target: string, decisionLogId?: string): Commitment {
    const commitments = this.state.commitments ?? [];
    const commitment: Commitment = {
      id: `commit-${this.clock.nowMs()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      targetEntity: target,
      createdAt: this.clock.nowMs(),
      status: "open",
      urgency: 0,
      sourceDecisionLogId: decisionLogId,
    };
    commitments.push(commitment);
    if (commitments.length > 50) commitments.splice(0, commitments.length - 50);
    this.state.commitments = commitments;
    this.save();
    emitState({ type: "commitment:new", key: commitment.id, what: content });
    return commitment;
  }

  resolveCommitment(id: string, status: "fulfilled" | "expired" | "cancelled"): void {
    const commitments = this.state.commitments ?? [];
    const c = commitments.find(x => x.id === id);
    if (c) {
      c.status = status;
      c.resolvedAt = this.clock.nowMs();
      this.save();
      if (status === "fulfilled") {
        emitState({ type: "commitment:fulfilled", key: id });
      }
    }
  }

  getOpenCommitments(): Commitment[] {
    return (this.state.commitments ?? []).filter(c => c.status === "open");
  }

  updateCommitmentUrgency(clock: Clock): void {
    const now = clock.nowMs();
    for (const c of (this.state.commitments ?? [])) {
      if (c.status !== "open") continue;
      const hoursSinceCreated = (now - c.createdAt) / 3_600_000;
      c.urgency = Math.min(1, hoursSinceCreated / 24);
      // Auto-expire after 48h
      if (hoursSinceCreated > 48) {
        c.status = "expired";
        c.resolvedAt = now;
      }
    }
  }

  getCommitmentPressure(): number {
    const open = this.getOpenCommitments();
    if (open.length === 0) return 0;
    return open.reduce((s, c) => s + c.urgency, 0) / Math.max(1, open.length);
  }

  // ── Goal progress tracking ───────────────────────────────────

  recordGoalProgress(event: GoalProgressEvent): void {
    this.state.goalEvents.push(event);
    if (this.state.goalEvents.length > 500) {
      this.state.goalEvents = this.state.goalEvents.slice(-500);
    }

    this.writeAuditRecord({
      type: "goal_update",
      details: {
        goalId: event.goalId,
        from: event.progressBefore,
        to: event.progressAfter,
        source: event.source,
      },
      timestamp: event.timestamp,
    });

    this.save();
  }

  getGoalEvents(goalId: string): GoalProgressEvent[] {
    return this.state.goalEvents.filter(e => e.goalId === goalId);
  }

  // ── Discovery trust tiers ────────────────────────────────────

  trackDiscovery(discoveryId: string): void {
    const existing = this.state.discoveryTrust.find(d => d.discoveryId === discoveryId);
    if (existing) {
      existing.referenceCount++;
      // Auto-promote T1→T2: referenced in ≥2 micro-thoughts
      // L10: Also require at least one positive prediction for promotion
      if (existing.tier === "raw" && existing.referenceCount >= 2 && existing.hasPositivePrediction !== false) {
        existing.tier = "verified";
        existing.promotedAt = this.clock.nowMs();
      }
    } else {
      this.state.discoveryTrust.push({
        discoveryId,
        tier: "raw",
        referenceCount: 1,
        firstSeen: this.clock.nowMs(),
      });
    }

    // Cap discovery tracking
    if (this.state.discoveryTrust.length > 100) {
      this.state.discoveryTrust = this.state.discoveryTrust.slice(-100);
    }

    this.save();
  }

  markPositivePrediction(discoveryId: string): void {
    const d = this.state.discoveryTrust.find(t => t.discoveryId === discoveryId);
    if (d) d.hasPositivePrediction = true;
  }

  promoteToActionable(discoveryId: string): void {
    const d = this.state.discoveryTrust.find(t => t.discoveryId === discoveryId);
    if (d) {
      d.tier = "actionable";
      d.promotedAt = this.clock.nowMs();
      this.save();
    }
  }

  getDiscoveryTrustWeight(discoveryId: string): number {
    const d = this.state.discoveryTrust.find(t => t.discoveryId === discoveryId);
    if (!d) return 0.3;
    switch (d.tier) {
      case "raw": return 0.3;
      case "verified": return 0.7;
      case "actionable": return 1.0;
    }
  }

  // ── Audit logging ────────────────────────────────────────────

  writeAuditRecord(record: AuditRecord): void {
    const auditPath = path.join(this.dataPath, "brainstem", "audit.jsonl");
    try {
      const dir = path.dirname(auditPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(auditPath, JSON.stringify(record) + "\n");
    } catch (err) {
      log.warn(`audit write failed: ${err}`);
    }
  }

  // ── Persistence ──────────────────────────────────────────────

  save(): void {
    writeJsonAtomic(
      path.join(this.dataPath, "brainstem", "governance.json"),
      { ...this.state, version: this.state.version ?? 1 },
    );
  }

  private load(): GovernanceState {
    return readJsonSafe<GovernanceState>(
      path.join(this.dataPath, "brainstem", "governance.json"),
      {
        memoryWrites: [],
        goalEvents: [],
        discoveryTrust: [],
        suppressions: {},
        pendingOutcomes: [],
        completedOutcomes: [],
        lastProcessed: 0,
        commitments: [],
        version: 1,
      },
    );
  }

  // ── Commitment extraction ───────────────────────────────────

  static extractCommitments(text: string): string[] {
    const patterns = [
      /我会(.{2,30})/g,
      /I'll (.{2,40})/gi,
      /明天(.{2,20})/g,
      /稍后(.{2,20})/g,
      /下次(.{2,20})/g,
      /等一下(.{2,20})/g,
      /回头(.{2,20})/g,
    ];
    const results: string[] = [];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        results.push(match[1].trim());
      }
    }
    return results;
  }

  // ── Portability ──────────────────────────────────────────────

  exportState(): GovernanceState {
    return { ...this.state };
  }

  importState(state: GovernanceState): void {
    this.state = state;
    if (!this.state.commitments) this.state.commitments = [];
    if (!this.state.version) this.state.version = 1;
    this.save();
  }
}
