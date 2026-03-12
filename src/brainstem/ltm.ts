/**
 * Long-Term Memory (CS7) — dual-layer WM/LTM graph.
 *
 * Persistent cold storage for evicted concepts.
 * Provides eviction, loading, working-set selection, and nightly consolidation.
 */

import { type ConceptGraph, type ConceptNode, type ConceptSource, createNode, normalizeId, addEdge } from "./graph.js";
import { CS7_CONFIG, type Clock } from "./config.js";
import { tokenize } from "../memory/search.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-ltm");

// ── Types ────────────────────────────────────────────────────────────

export interface LTMNode {
  id: string;
  label: string;
  anchorText: string;
  termVector: string[];
  parentId: string | null;
  depth: number;
  source: string;
  memoryKeys: string[];
  tags: string[];
  // LTM-specific stats
  lastActiveAt: number;
  totalActiveTime: number;
  avgActivationWhenActive: number;
  peakActivation: number;
  winnerCount: number;
  coActivationStats: Record<string, number>;
  edgeWeights: Record<string, number>;
  importanceScore: number;
  accessCount: number;
}

export interface LTMGraph {
  nodes: Record<string, LTMNode>;
  version: number;
  lastConsolidation: number;
  lastLoadAt: number;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createLTMGraph(): LTMGraph {
  return {
    nodes: {},
    version: 1,
    lastConsolidation: 0,
    lastLoadAt: 0,
  };
}

// ── Eviction: WM → LTM ──────────────────────────────────────────────

export function evictToLTM(
  graph: ConceptGraph,
  ltm: LTMGraph,
  nodeId: string,
  totalTicks: number,
  coActivationCounts?: Map<string, number>,
): void {
  const node = graph.nodes[nodeId];
  if (!node || nodeId === "self") return;

  // Compute importance score
  const winnerCount = node.cumulativeCredit;
  const avgA = node.activation; // approximate: current activation
  const edgeCount = graph.edges.filter(e => e.source === nodeId || e.target === nodeId).length;
  const recency = node.lastActivated > 0
    ? Math.exp(-(Date.now() - node.lastActivated) / (7 * 86_400_000))
    : 0;
  const importance = 0.3 * (totalTicks > 0 ? winnerCount / totalTicks : 0) +
    0.3 * avgA +
    0.2 * Math.min(1, edgeCount / 10) +
    0.2 * recency;

  // Capture edge weights
  const edgeWeights: Record<string, number> = {};
  for (const edge of graph.edges) {
    if (edge.source === nodeId) edgeWeights[edge.target] = edge.weight;
    else if (edge.target === nodeId) edgeWeights[edge.source] = edge.weight;
  }

  // Create LTM node
  const ltmNode: LTMNode = {
    id: nodeId,
    label: node.label,
    anchorText: node.anchorText,
    termVector: node.termVector,
    parentId: node.parentId,
    depth: node.depth,
    source: node.source,
    memoryKeys: node.memoryKeys,
    tags: [],
    lastActiveAt: node.lastActivated,
    totalActiveTime: 0,
    avgActivationWhenActive: avgA,
    peakActivation: avgA,
    winnerCount,
    coActivationStats: buildCoActivationStats(nodeId, coActivationCounts),
    edgeWeights,
    importanceScore: Math.max(0, Math.min(1, importance)),
    accessCount: 0,
  };

  // Merge with existing LTM node if present
  const existing = ltm.nodes[nodeId];
  if (existing) {
    ltmNode.accessCount = existing.accessCount;
    ltmNode.importanceScore = Math.max(existing.importanceScore, ltmNode.importanceScore);
    ltmNode.peakActivation = Math.max(existing.peakActivation, ltmNode.peakActivation);
    ltmNode.winnerCount += existing.winnerCount;
    // Merge edge weights
    for (const [k, v] of Object.entries(existing.edgeWeights)) {
      ltmNode.edgeWeights[k] = Math.max(v, ltmNode.edgeWeights[k] ?? 0);
    }
  }

  ltm.nodes[nodeId] = ltmNode;

  // Remove from WM graph
  delete graph.nodes[nodeId];
  graph.edges = graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
}

// ── Working set selection ────────────────────────────────────────────

export function selectWorkingSet(
  ltm: LTMGraph,
  state: { graph: ConceptGraph; activationHistory: Record<string, number[]> },
  maxToLoad: number,
): string[] {
  if (maxToLoad <= 0) return [];
  const now = Date.now();
  const graph = state.graph;

  // Active goal nodes in WM
  const goalNodes = Object.values(graph.nodes).filter(n => n.drive > 0.3);
  const goalTerms = new Set(goalNodes.flatMap(n => n.termVector));

  // High-U nodes in WM
  const highUTerms = new Set(
    Object.values(graph.nodes)
      .filter(n => n.uncertainty > 0.5)
      .flatMap(n => n.termVector),
  );

  // Recent conversation terms (from activation history)
  const recentTerms = new Set<string>();
  for (const [nodeId, timestamps] of Object.entries(state.activationHistory)) {
    const recent = timestamps.some(t => now - t < 300_000); // last 5 min
    if (recent && graph.nodes[nodeId]) {
      for (const t of graph.nodes[nodeId].termVector) recentTerms.add(t);
    }
  }

  // Score LTM nodes
  const scored: Array<{ id: string; score: number; group: string | null }> = [];
  for (const node of Object.values(ltm.nodes)) {
    // Skip if already in WM
    if (graph.nodes[node.id]) continue;

    const recency = 0.25 * Math.exp(-(now - node.lastActiveAt) / (7 * 86_400_000));
    const importance = 0.25 * node.importanceScore;
    const driveMatch = 0.20 * termOverlap(node.termVector, goalTerms);
    const uncertainty = 0.15 * termOverlap(node.termVector, highUTerms);
    const priming = 0.15 * termOverlap(node.termVector, recentTerms);

    const score = recency + importance + driveMatch + uncertainty + priming;
    scored.push({ id: node.id, score, group: node.parentId });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Diverse top-K: max 2 per parent group, min 3 distinct groups
  const result: string[] = [];
  const groupCounts = new Map<string, number>();

  for (const item of scored) {
    if (result.length >= maxToLoad) break;
    const group = item.group ?? item.id;
    const count = groupCounts.get(group) ?? 0;
    if (count >= CS7_CONFIG.loadDiversityMaxPerGroup) continue;
    groupCounts.set(group, count + 1);
    result.push(item.id);
  }

  // Enforce min 3 distinct parent groups: backfill from underrepresented groups
  if (groupCounts.size < 3 && result.length < maxToLoad) {
    const usedIds = new Set(result);
    for (const item of scored) {
      if (result.length >= maxToLoad || groupCounts.size >= 3) break;
      if (usedIds.has(item.id)) continue;
      const group = item.group ?? item.id;
      if (groupCounts.has(group)) continue; // already represented
      groupCounts.set(group, 1);
      result.push(item.id);
      usedIds.add(item.id);
    }
  }

  return result;
}

// ── Load: LTM → WM ──────────────────────────────────────────────────

export function loadFromLTM(
  ltm: LTMGraph,
  graph: ConceptGraph,
  nodeId: string,
): void {
  const ltmNode = ltm.nodes[nodeId];
  if (!ltmNode) return;
  if (graph.nodes[nodeId]) return; // already in WM

  // Reconstruct ConceptNode
  const conceptNode = createNode(
    ltmNode.id,
    ltmNode.label,
    ltmNode.source as ConceptSource,
    {
      parentId: ltmNode.parentId ?? undefined,
      depth: ltmNode.depth,
      anchorText: ltmNode.anchorText,
    },
  );
  conceptNode.activation = 0;
  conceptNode.fatigue = 0;
  conceptNode.termVector = ltmNode.termVector;
  conceptNode.memoryKeys = ltmNode.memoryKeys;

  graph.nodes[nodeId] = conceptNode;

  // Restore edges to nodes that exist in WM
  for (const [targetId, weight] of Object.entries(ltmNode.edgeWeights)) {
    if (graph.nodes[targetId]) {
      addEdge(graph, nodeId, targetId, "semantic", weight);
    }
  }

  ltmNode.accessCount++;
  ltmNode.lastActiveAt = Date.now();
}

// ── Nightly consolidation ────────────────────────────────────────────

export function nightlyConsolidation(
  ltm: LTMGraph,
  clock: Clock,
): { pruned: number; merged: number; total: number } {
  const now = clock.nowMs();
  let pruned = 0;
  let merged = 0;

  // 1. Prune: 90d inactive + importanceScore < 0.1 + accessCount < 3
  const pruneThresholdMs = CS7_CONFIG.pruneAgeDays * 86_400_000;
  const toDelete: string[] = [];
  for (const node of Object.values(ltm.nodes)) {
    if (now - node.lastActiveAt > pruneThresholdMs &&
        node.importanceScore < CS7_CONFIG.pruneSalienceThreshold &&
        node.accessCount < CS7_CONFIG.pruneMinAccessCount) {
      toDelete.push(node.id);
    }
  }
  for (const id of toDelete) {
    delete ltm.nodes[id];
    pruned++;
  }

  // 2. Merge: Jaccard > 0.7, keep higher importance
  const nodeList = Object.values(ltm.nodes);
  const mergedIds = new Set<string>();
  for (let i = 0; i < nodeList.length; i++) {
    if (mergedIds.has(nodeList[i].id)) continue;
    for (let j = i + 1; j < nodeList.length; j++) {
      if (mergedIds.has(nodeList[j].id)) continue;
      const sim = jaccardSimilarity(nodeList[i].termVector, nodeList[j].termVector);
      if (sim > CS7_CONFIG.mergeJaccardThreshold) {
        // Keep higher importance, merge memoryKeys
        const [keep, remove] = nodeList[i].importanceScore >= nodeList[j].importanceScore
          ? [nodeList[i], nodeList[j]]
          : [nodeList[j], nodeList[i]];
        for (const key of remove.memoryKeys) {
          if (!keep.memoryKeys.includes(key)) {
            keep.memoryKeys.push(key);
          }
        }
        keep.winnerCount += remove.winnerCount;
        keep.accessCount += remove.accessCount;
        keep.importanceScore = Math.max(keep.importanceScore, remove.importanceScore);
        // Merge edge weights
        for (const [k, v] of Object.entries(remove.edgeWeights)) {
          keep.edgeWeights[k] = Math.max(v, keep.edgeWeights[k] ?? 0);
        }
        delete ltm.nodes[remove.id];
        mergedIds.add(remove.id);
        merged++;
      }
    }
  }

  // 3. Decay: importanceScore *= 0.99^daysSinceLastConsolidation
  // Use delta from last consolidation (not from lastActiveAt) to avoid compounding double-decay
  const daysSinceLastConsolidation = ltm.lastConsolidation > 0
    ? Math.max(0, (now - ltm.lastConsolidation) / 86_400_000)
    : 1; // first consolidation: decay by 1 day
  const decayFactor = Math.pow(CS7_CONFIG.importanceDecayPerDay, daysSinceLastConsolidation);
  for (const node of Object.values(ltm.nodes)) {
    node.importanceScore *= decayFactor;
  }

  // 4. Hard cap
  const allNodes = Object.values(ltm.nodes);
  if (allNodes.length > CS7_CONFIG.ltmMaxNodes) {
    allNodes.sort((a, b) => a.importanceScore - b.importanceScore);
    const excess = allNodes.length - CS7_CONFIG.ltmMaxNodes;
    for (let i = 0; i < excess; i++) {
      delete ltm.nodes[allNodes[i].id];
      pruned++;
    }
  }

  ltm.lastConsolidation = now;
  const total = Object.keys(ltm.nodes).length;
  log.info(`LTM consolidation: pruned=${pruned}, merged=${merged}, total=${total}`);
  return { pruned, merged, total };
}

// ── Persistence ──────────────────────────────────────────────────────

export function saveLTM(ltm: LTMGraph, dataPath: string): void {
  writeJsonAtomic(path.join(dataPath, "brainstem", "ltm.json"), ltm);
}

export function loadLTM(dataPath: string): LTMGraph {
  return readJsonSafe<LTMGraph>(
    path.join(dataPath, "brainstem", "ltm.json"),
    createLTMGraph(),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function termOverlap(terms: string[], targetSet: Set<string>): number {
  if (terms.length === 0 || targetSet.size === 0) return 0;
  let count = 0;
  for (const t of terms) {
    if (targetSet.has(t)) count++;
  }
  return count / terms.length;
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function buildCoActivationStats(
  nodeId: string,
  coActivationCounts?: Map<string, number>,
): Record<string, number> {
  if (!coActivationCounts) return {};
  const stats: Record<string, number> = {};
  for (const [pairKey, count] of coActivationCounts) {
    const [a, b] = pairKey.split("|");
    if (a === nodeId) stats[b] = count;
    else if (b === nodeId) stats[a] = count;
  }
  return stats;
}
