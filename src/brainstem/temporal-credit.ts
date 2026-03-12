/**
 * Temporal Credit Assignment (CS2) — edge weight learning.
 *
 * Scans activation timestamps for temporal patterns:
 * "A then B" strengthens A→B. Includes negative evidence.
 * Confidence tracking prevents noise reinforcement.
 */

import { type ConceptGraph } from "./graph.js";
import { BRAINSTEM_CONFIG as C, type Clock } from "./config.js";

// ── Edge confidence tracking ─────────────────────────────────────────

const edgeConfidence = new Map<string, { count: number; firstSeen: number }>();

function edgeKey(source: string, target: string): string {
  return `${source}→${target}`;
}

// ── Temporal credit update ───────────────────────────────────────────

export function updateTemporalCredit(
  graph: ConceptGraph,
  activationHistory: Record<string, number[]>,
  clock: Clock,
): void {
  const now = clock.nowMs();

  for (const edge of graph.edges) {
    const aHist = activationHistory[edge.source];
    const bHist = activationHistory[edge.target];
    if (!aHist || !bHist) continue;

    const key = edgeKey(edge.source, edge.target);

    // Count forward: A activated 30-90s before B
    let forward = 0;
    let backward = 0;

    for (const aTime of aHist) {
      for (const bTime of bHist) {
        const dt = bTime - aTime;
        if (dt >= C.temporalCreditMinMs && dt <= C.temporalCreditWindowMs) {
          forward++;
        } else if (-dt >= C.temporalCreditMinMs && -dt <= C.temporalCreditWindowMs) {
          backward++;
        }
      }
    }

    const net = forward - backward;

    // Track confidence
    let conf = edgeConfidence.get(key);
    if (!conf) {
      conf = { count: 0, firstSeen: now };
      edgeConfidence.set(key, conf);
    }

    // L16: Confidence gating threshold 5 (per design doc)
    if (net > 5) {
      edge.weight = Math.min(1, edge.weight + C.temporalCreditEdgeDelta);
      conf.count += forward;
    } else if (net < -5) {
      edge.weight = Math.min(1, edge.weight + C.temporalCreditEdgeDelta);
      conf.count += backward;
    } else if (Math.abs(net) <= 1) {
      edge.weight = Math.max(0.05, edge.weight - C.temporalCreditWeakenDelta);
    }

    // Negative evidence: A activated but B did NOT follow
    const aWithoutB = countAWithoutB(aHist, bHist, C.temporalCreditWindowMs);
    if (aWithoutB > 5 && edge.weight > 0.3) {
      edge.weight = Math.max(0.05, edge.weight - 0.005 * (aWithoutB - 5));
    }
  }

  // Confidence-based reversion: edges with low confidence after 48h → revert
  const revertThresholdMs = 48 * 60 * 60_000;
  for (const [key, conf] of edgeConfidence) {
    if (now - conf.firstSeen > revertThresholdMs && conf.count < C.temporalCreditConfidenceRevertThreshold) {
      // Find edge and soften toward default
      const [src, tgt] = key.split("→");
      const edge = graph.edges.find(e => e.source === src && e.target === tgt);
      if (edge) {
        // Revert toward original weight (approximate: move toward 0.3)
        edge.weight = edge.weight * 0.7 + 0.3 * 0.3;
      }
      edgeConfidence.delete(key);
    }
  }
}

// ── Count A without B ────────────────────────────────────────────────

function countAWithoutB(
  aHist: number[],
  bHist: number[],
  windowMs: number,
): number {
  let count = 0;
  for (const aTime of aHist) {
    const hasFollowUp = bHist.some(
      bTime => bTime > aTime && bTime - aTime <= windowMs,
    );
    if (!hasFollowUp) count++;
  }
  return count;
}

// ── CS6b: Causal edge direction discovery ────────────────────────────

import { CS6_CONFIG } from "./config.js";
import type { EdgeDirectionStat } from "./bootstrap.js";

/**
 * Update edge direction tags using accumulated direction stats.
 * Stats persist across sessions via BrainstemState.edgeDirectionStats.
 */
export function updateEdgeDirections(
  graph: ConceptGraph,
  activationHistory: Record<string, number[]>,
  directionStats?: Record<string, EdgeDirectionStat>,
  now?: number,
): number {
  let updated = 0;
  const stats = directionStats ?? {};
  const timestamp = now ?? Date.now();

  for (const edge of graph.edges) {
    if (edge.type === "causal") continue; // already typed
    const aHist = activationHistory[edge.source];
    const bHist = activationHistory[edge.target];
    if (!aHist || !bHist) continue;

    // Count forward/backward in this scan window
    let scanForward = 0;
    let scanBackward = 0;
    let totalLeadMs = 0;

    for (const aTime of aHist) {
      for (const bTime of bHist) {
        const dt = bTime - aTime;
        if (dt >= C.temporalCreditMinMs && dt <= C.temporalCreditWindowMs) {
          scanForward++;
          totalLeadMs += dt;
        } else if (-dt >= C.temporalCreditMinMs && -dt <= C.temporalCreditWindowMs) {
          scanBackward++;
          totalLeadMs += -dt;
        }
      }
    }

    // Accumulate into persisted stats
    const key = `${edge.source}->${edge.target}`;
    if (!stats[key]) {
      stats[key] = { forwardCount: 0, backwardCount: 0, avgLeadMs: 0, directionConfidence: 0, lastUpdatedAt: 0 };
    }
    const stat = stats[key];
    stat.forwardCount += scanForward;
    stat.backwardCount += scanBackward;
    const totalObservations = scanForward + scanBackward;
    if (totalObservations > 0) {
      // EWMA for avgLeadMs
      const scanAvgLead = totalLeadMs / totalObservations;
      stat.avgLeadMs = stat.avgLeadMs === 0 ? scanAvgLead : 0.8 * stat.avgLeadMs + 0.2 * scanAvgLead;
    }
    stat.lastUpdatedAt = timestamp;

    // Use accumulated totals for direction decisions
    const total = stat.forwardCount + stat.backwardCount;
    if (total < CS6_CONFIG.minDirectionObservations) continue;

    const directionConfidence = Math.abs(stat.forwardCount - stat.backwardCount) / (total + 1);
    stat.directionConfidence = directionConfidence;

    if (directionConfidence > CS6_CONFIG.directionConfidenceThreshold) {
      const newTag = stat.forwardCount > stat.backwardCount ? "A_leads" : "B_leads";
      if (edge.directionTag !== newTag) {
        edge.directionTag = newTag;
        updated++;
      }
    } else if (directionConfidence < 0.3) {
      // Rollback first: previously confident (A_leads/B_leads) but now < 0.3 → reset to null
      if (edge.directionTag && edge.directionTag !== "bidirectional") {
        edge.directionTag = null;
        updated++;
      }
      // Then: truly bidirectional (high observation count, still low confidence, no prior tag)
      if (total > 20 && edge.directionTag === null) {
        edge.directionTag = "bidirectional";
        updated++;
      }
    }
  }

  return updated;
}

// ── Get edge learning rate (for metrics) ─────────────────────────────

export function getEdgeLearningRate(
  graph: ConceptGraph,
  sinceMs: number,
  clock: Clock,
): number {
  const now = clock.nowMs();
  let modified = 0;
  for (const [, conf] of edgeConfidence) {
    if (now - conf.firstSeen <= sinceMs) modified++;
  }
  return modified;
}
