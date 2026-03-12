/**
 * Concept Graph — types and pure math functions for brainstem activation dynamics.
 *
 * Core operations: tickGraph (spread/decay/energy), boostNode (injection),
 * findClusters (seed-based expansion), scoreClusters, computeGrounding.
 * All functions are pure (no I/O, no LLM calls). ~0.1ms for 100 nodes.
 */

import { tokenize } from "../memory/search.js";
import {
  BRAINSTEM_CONFIG as C,
  DERIVED,
  type Clock,
  type ConceptACL,
  ACL_DEFAULTS,
  mulberry32,
} from "./config.js";

// ── Types ────────────────────────────────────────────────────────────

export type ConceptSource =
  | "memory" | "curiosity" | "conversation" | "emotion"
  | "goal" | "reflection" | "replay" | "notification" | "simulation"
  | "cortex" | "structure_learning";

export type KnowledgeTier = "stm" | "mtm" | "ltm";

const EXTERNAL_SOURCES: Set<ConceptSource> = new Set(["conversation", "curiosity", "notification"]);

export type ConceptDomain = "quant" | "creative" | "social" | "physical" | "meta" | "general";

export interface ConceptNode {
  id: string;
  label: string;
  // ── 6 core state variables + IS ──
  activation: number;           // A: 0-1
  fatigue: number;              // F: 0-1
  salience: number;             // S: 0-1
  uncertainty: number;          // U: 0-1
  valence: number;              // V: -1 to +1
  drive: number;                // D: 0-1
  inputSatiation: number;       // IS: 0-1
  // ── Metadata ──
  lastExternalBoostAt: number;
  lastActivated: number;
  source: ConceptSource;
  termVector: string[];
  memoryKeys: string[];         // max 5
  stableSince: number;
  anchorText: string;
  // ── Hierarchy (CS3) ──
  parentId: string | null;
  depth: number;                // 0=root, 1=mid, 2=specific. Max 3.
  // ── ACL ──
  acl: ConceptACL;
  // ── Knowledge tier ──
  knowledgeTier: KnowledgeTier;
  // ── Credit ──
  cumulativeCredit: number;
  // ── Domain (cross-domain transfer) ──
  domain: ConceptDomain;
  // ── Suppression ──
  suppressionLabel?: {
    reason: "act_rejected" | "loop_trigger";
    count: number;
    since: number;
  };
}

export interface ConceptEdge {
  source: string;
  target: string;
  type: "co_occurrence" | "semantic" | "causal" | "goal_related" | "cross_domain";
  weight: number;               // 0-1
  directionTag?: "A_leads" | "B_leads" | "bidirectional" | null;
}

export interface ConceptGraph {
  nodes: Record<string, ConceptNode>;
  edges: ConceptEdge[];
  lastRebuilt: number;
}

export interface GroundingRef {
  type: "memory" | "goal" | "discovery";
  id: string;
  weight: number;
  evidence: {
    sourceNodeIds: string[];
    why: "memoryKeys" | "goalMatch" | "discoveryMatch";
    rawScoreParts: {
      recency?: number;
      linkage?: number;
      priority?: number;
      matchScore?: number;
    };
  };
}

export interface ClusterInfo {
  nodes: string[];
  avgA: number;
  avgS: number;
  avgU: number;
  avgD: number;
  avgF: number;
  avgV: number;
  size: number;
}

export interface ScoredCluster extends ClusterInfo {
  score: number;
  labels: string[];
  grounding: GroundingRef[];
  groundingStrength: number;
}

export interface GroundingResult {
  grounding: GroundingRef[];
  groundingStrength: number;
}

// ── Alias Table (entity resolution) ──────────────────────────────────

export interface AliasTable {
  canonical: Record<string, string>;   // alias → canonical nodeId
  aliases: Record<string, string[]>;   // nodeId → all known aliases
  mergeHistory: Array<{
    from: string;
    to: string;
    reason: string;
    timestamp: number;
  }>;
}

export function createAliasTable(): AliasTable {
  return { canonical: {}, aliases: {}, mergeHistory: [] };
}

export function registerAlias(table: AliasTable, alias: string, canonicalId: string): void {
  const key = normalizeId(alias);
  if (key === canonicalId) return;
  table.canonical[key] = canonicalId;
  if (!table.aliases[canonicalId]) table.aliases[canonicalId] = [];
  const arr = table.aliases[canonicalId];
  if (!arr.includes(key)) arr.push(key);
}

export function resolveAlias(table: AliasTable, label: string): string | null {
  return table.canonical[normalizeId(label)] ?? null;
}

export function getAliases(table: AliasTable, nodeId: string): string[] {
  return table.aliases[nodeId] ?? [];
}

// ── Domain inference (cross-domain transfer) ─────────────────────────

const QUANT_KEYWORDS = ["market", "quant", "code", "trading", "stock", "finance", "algorithm", "data", "model", "math"];
const CREATIVE_KEYWORDS = ["art", "music", "design", "writing", "photo", "draw", "creative", "aesthetic"];
const PHYSICAL_KEYWORDS = ["health", "exercise", "body", "sleep", "food", "run", "walk", "yoga"];

export function inferDomain(label: string, source: ConceptSource, memoryKeys: string[]): ConceptDomain {
  if (source === "emotion") return "social";
  const lower = label.toLowerCase();
  if (memoryKeys.some(k => k.startsWith("user.") || k.startsWith("family."))) return "social";
  if (source === "goal") {
    if (QUANT_KEYWORDS.some(kw => lower.includes(kw))) return "quant";
    if (CREATIVE_KEYWORDS.some(kw => lower.includes(kw))) return "creative";
    if (PHYSICAL_KEYWORDS.some(kw => lower.includes(kw))) return "physical";
  }
  if (QUANT_KEYWORDS.some(kw => lower.includes(kw))) return "quant";
  if (CREATIVE_KEYWORDS.some(kw => lower.includes(kw))) return "creative";
  if (PHYSICAL_KEYWORDS.some(kw => lower.includes(kw))) return "physical";
  if (source === "reflection") return "meta";
  return "general";
}

export function detectCrossDomainBridges(graph: ConceptGraph, clusters: ClusterInfo[]): ConceptEdge[] {
  const newEdges: ConceptEdge[] = [];

  for (const cluster of clusters) {
    // Compute domain distribution
    const domainCounts = new Map<ConceptDomain, string[]>();
    for (const nodeId of cluster.nodes) {
      const node = graph.nodes[nodeId];
      if (!node) continue;
      const domain = node.domain ?? "general";
      if (!domainCounts.has(domain)) domainCounts.set(domain, []);
      domainCounts.get(domain)!.push(nodeId);
    }

    // Need 2+ domains with >20% representation each
    const significantDomains: Array<{ domain: ConceptDomain; nodeIds: string[] }> = [];
    for (const [domain, nodeIds] of domainCounts) {
      if (nodeIds.length / cluster.nodes.length > 0.2) {
        significantDomains.push({ domain, nodeIds });
      }
    }
    if (significantDomains.length < 2) continue;

    // Create cross-domain edges between pairs from different domains
    for (let i = 0; i < significantDomains.length; i++) {
      for (let j = i + 1; j < significantDomains.length; j++) {
        const aDomain = significantDomains[i];
        const bDomain = significantDomains[j];
        // Connect top node from each domain
        const aNode = graph.nodes[aDomain.nodeIds[0]];
        const bNode = graph.nodes[bDomain.nodeIds[0]];
        if (!aNode || !bNode) continue;
        const weight = Math.min(aNode.activation, bNode.activation) * 0.8;
        if (weight > 0.05) {
          const exists = graph.edges.some(
            e => (e.source === aNode.id && e.target === bNode.id) ||
                 (e.source === bNode.id && e.target === aNode.id),
          );
          if (!exists) {
            newEdges.push({ source: aNode.id, target: bNode.id, type: "cross_domain", weight });
          }
        }
      }
    }
  }

  // Merge structural analogy edges
  const analogyEdges = detectStructuralAnalogies(graph, clusters);
  newEdges.push(...analogyEdges);

  return newEdges;
}

// ── Structural analogy detection ──────────────────────────────────────

/**
 * Detect structural analogies between clusters in different domains.
 * Computes structural signatures (avgDegree, avgDepth, edgeDensity, nodeCount)
 * and finds cross-domain pairs with high cosine similarity.
 */
export function detectStructuralAnalogies(
  graph: ConceptGraph,
  clusters: ClusterInfo[],
): ConceptEdge[] {
  if (clusters.length < 2) return [];

  // Compute structural signature per cluster
  interface ClusterSig {
    cluster: ClusterInfo;
    domain: ConceptDomain;
    sig: [number, number, number, number]; // avgDegree, avgDepth, edgeDensity, nodeCount
    topNodeId: string;
  }

  const sigs: ClusterSig[] = [];

  for (const cluster of clusters) {
    if (cluster.nodes.length < 2) continue;

    // Determine dominant domain
    const domainCounts: Record<string, number> = {};
    let totalDepth = 0;
    let topNodeId = cluster.nodes[0];
    let topActivation = 0;

    for (const nid of cluster.nodes) {
      const node = graph.nodes[nid];
      if (!node) continue;
      const d = node.domain ?? "general";
      domainCounts[d] = (domainCounts[d] ?? 0) + 1;
      totalDepth += node.depth;
      if (node.activation > topActivation) {
        topActivation = node.activation;
        topNodeId = nid;
      }
    }

    const domain = Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] as ConceptDomain ?? "general";

    // Compute avg degree (edges per node within cluster)
    const nodeSet = new Set(cluster.nodes);
    let edgesWithin = 0;
    for (const edge of graph.edges) {
      if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) edgesWithin++;
    }
    const n = cluster.nodes.length;
    const avgDegree = n > 0 ? (edgesWithin * 2) / n : 0;
    const avgDepth = n > 0 ? totalDepth / n : 0;
    const maxEdges = n * (n - 1) / 2;
    const edgeDensity = maxEdges > 0 ? edgesWithin / maxEdges : 0;

    sigs.push({ cluster, domain, sig: [avgDegree, avgDepth, edgeDensity, n], topNodeId });
  }

  // Cosine similarity between two 4-element vectors
  const cosine = (a: number[], b: number[]): number => {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  };

  const newEdges: ConceptEdge[] = [];
  const COSINE_THRESHOLD = 0.7;
  const MAX_ANALOGY_EDGES = 3;

  for (let i = 0; i < sigs.length && newEdges.length < MAX_ANALOGY_EDGES; i++) {
    for (let j = i + 1; j < sigs.length && newEdges.length < MAX_ANALOGY_EDGES; j++) {
      if (sigs[i].domain === sigs[j].domain) continue; // must differ
      const sim = cosine(sigs[i].sig, sigs[j].sig);
      if (sim < COSINE_THRESHOLD) continue;

      // Check no existing edge between these top nodes
      const exists = graph.edges.some(
        e => (e.source === sigs[i].topNodeId && e.target === sigs[j].topNodeId) ||
             (e.source === sigs[j].topNodeId && e.target === sigs[i].topNodeId),
      );
      if (exists) continue;

      newEdges.push({
        source: sigs[i].topNodeId,
        target: sigs[j].topNodeId,
        type: "cross_domain",
        weight: sim * 0.5,
      });
    }
  }

  return newEdges;
}

// ── External absorb budget state ─────────────────────────────────────

interface BudgetEntry {
  bucket: number;
  remaining: number;
}

const budgetMap = new Map<string, BudgetEntry>();
let clusterOfNode = new Map<string, string>();
let clusterFamilyKeyOfNode = new Map<string, string>();
let clusterBudgetAvailable = false;

export function enableClusterBudget(
  nodeToCluster: Map<string, string>,
  nodeFamilyKey: Map<string, string>,
): void {
  clusterOfNode = nodeToCluster;
  clusterFamilyKeyOfNode = nodeFamilyKey;
  clusterBudgetAvailable = true;
  budgetMap.clear();
}

// ── Node creation & canonicalization ─────────────────────────────────

export function createNode(
  id: string,
  label: string,
  source: ConceptSource,
  opts?: Partial<Pick<ConceptNode, "parentId" | "depth" | "anchorText" | "memoryKeys" | "acl">>,
): ConceptNode {
  const memoryKeys = opts?.memoryKeys ?? [];
  return {
    id,
    label,
    activation: 0,
    fatigue: 0,
    salience: 0,
    uncertainty: 0,
    valence: 0,
    drive: 0,
    inputSatiation: 0,
    lastExternalBoostAt: 0,
    lastActivated: 0,
    source,
    termVector: tokenize(`${id} ${label}`),
    memoryKeys,
    stableSince: 0,
    anchorText: opts?.anchorText ?? label,
    parentId: opts?.parentId ?? null,
    depth: opts?.depth ?? 1,
    acl: opts?.acl ?? ACL_DEFAULTS.topic,
    knowledgeTier: "stm",
    cumulativeCredit: 0,
    domain: inferDomain(label, source, memoryKeys),
  };
}

export function normalizeId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
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

export function findOrCreateNode(
  graph: ConceptGraph,
  label: string,
  source: ConceptSource,
  opts?: Partial<Pick<ConceptNode, "parentId" | "depth" | "anchorText" | "memoryKeys" | "acl">>,
  aliasTable?: AliasTable,
): ConceptNode {
  const id = normalizeId(label);

  // Alias resolution: redirect to canonical node if known
  if (aliasTable) {
    const resolved = resolveAlias(aliasTable, label);
    if (resolved && graph.nodes[resolved]) {
      const existing = graph.nodes[resolved];
      if (source === "conversation") existing.label = label;
      existing.source = source;
      // Never merge memoryKeys into the self node — it's an identity anchor, not a memory bucket
      if (opts?.memoryKeys && existing.id !== "self") {
        const merged = new Set([...existing.memoryKeys, ...opts.memoryKeys]);
        existing.memoryKeys = [...merged].slice(0, 5);
      }
      return existing;
    }
  }

  // Exact match
  if (graph.nodes[id]) {
    const existing = graph.nodes[id];
    if (source === "conversation") existing.label = label;
    existing.source = source;
    if (opts?.memoryKeys && existing.id !== "self") {
      const merged = new Set([...existing.memoryKeys, ...opts.memoryKeys]);
      existing.memoryKeys = [...merged].slice(0, 5);
    }
    return existing;
  }

  // Jaccard match against existing nodes
  const newTerms = tokenize(`${id} ${label}`);
  for (const existing of Object.values(graph.nodes)) {
    // Never Jaccard-match into the self node — it should not absorb other concepts
    if (existing.id === "self") continue;
    const sim = jaccardSimilarity(newTerms, existing.termVector);
    if (sim > 0.7) {
      if (source === "conversation") existing.label = label;
      existing.termVector = [...new Set([...existing.termVector, ...newTerms])].slice(0, 20);
      existing.source = source;
      if (opts?.memoryKeys) {
        const merged = new Set([...existing.memoryKeys, ...opts.memoryKeys]);
        existing.memoryKeys = [...merged].slice(0, 5);
      }
      return existing;
    }
  }

  // Create new
  const node = createNode(id, label, source, { ...opts, memoryKeys: opts?.memoryKeys ?? [] });
  node.termVector = newTerms;

  // Enforce MAX_NODES
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length >= C.maxNodes) {
    // Evict lowest priority node (lowest activation + degree)
    let worstId = "";
    let worstScore = Infinity;
    for (const nid of nodeIds) {
      if (nid === "self") continue;
      const n = graph.nodes[nid];
      const degree = graph.edges.filter(e => e.source === nid || e.target === nid).length;
      const score = Math.max(n.activation, degree / 10);
      if (score < worstScore) {
        worstScore = score;
        worstId = nid;
      }
    }
    if (worstId) {
      delete graph.nodes[worstId];
      graph.edges = graph.edges.filter(e => e.source !== worstId && e.target !== worstId);
    }
  }

  graph.nodes[node.id] = node;
  return node;
}

// ── Clamping ─────────────────────────────────────────────────────────

export function clampNode(node: ConceptNode, clock: Clock): void {
  node.activation = Math.max(0, Math.min(1, node.activation));
  node.salience = Math.max(0, Math.min(1, node.salience));
  node.uncertainty = Math.max(0, Math.min(1, node.uncertainty));
  node.valence = Math.max(-1, Math.min(1, node.valence));
  node.drive = Math.max(0, Math.min(1, node.drive));
  node.inputSatiation = Math.max(0, Math.min(1, node.inputSatiation));

  // stableSince hysteresis
  if (node.activation > 0.5 && node.stableSince === 0) {
    node.stableSince = clock.nowMs();
  } else if (node.activation < 0.3) {
    node.stableSince = 0;
  }

  // lastActivated: only for meaningful post-energy-scaling activation
  if (node.activation > 0.15) {
    node.lastActivated = clock.nowMs();
  }
}

export function clampFatigue(node: ConceptNode): void {
  node.fatigue = Math.max(0, Math.min(1, node.fatigue));
}

// ── Forces interface ─────────────────────────────────────────────────

export interface TickForces {
  emotionValence?: Record<string, number>;  // nodeId → valence delta
  salienceBoosts?: Record<string, number>;  // nodeId → salience boost
  uncertaintyBoosts?: Record<string, number>; // nodeId → uncertainty boost
}

// ── Core: tickGraph ──────────────────────────────────────────────────

export function tickGraph(
  graph: ConceptGraph,
  forces: TickForces,
  clock: Clock,
  rng: () => number,
  policyScales?: { noiseScale: number; spreadScale: number },
  energyClippingTracker?: { clippedCount: number; totalCount: number },
): void {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return;

  const noiseScale = policyScales?.noiseScale ?? 1.0;
  const spreadScale = policyScales?.spreadScale ?? 1.0;

  // Step 1: Inject forces
  if (forces.emotionValence) {
    for (const [id, dv] of Object.entries(forces.emotionValence)) {
      if (graph.nodes[id]) graph.nodes[id].valence += dv;
    }
  }
  if (forces.salienceBoosts) {
    for (const [id, ds] of Object.entries(forces.salienceBoosts)) {
      if (graph.nodes[id]) graph.nodes[id].salience += ds;
    }
  }
  if (forces.uncertaintyBoosts) {
    for (const [id, du] of Object.entries(forces.uncertaintyBoosts)) {
      if (graph.nodes[id]) graph.nodes[id].uncertainty += du;
    }
  }

  // Step 2: Spread (row-normalized + damped)
  const alpha = C.spreadFactor * spreadScale;
  // Build adjacency: skip self-loops and edges involving "self" node
  const outgoing = new Map<string, Array<{ target: string; weight: number }>>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    if (edge.source === "self" || edge.target === "self") continue;
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source)!.push({ target: edge.target, weight: edge.weight });
  }

  // Row-normalize and spread
  const spreadDelta = new Map<string, number>();
  for (const [srcId, neighbors] of outgoing) {
    const srcNode = graph.nodes[srcId];
    if (!srcNode) continue;
    const totalWeight = neighbors.reduce((s, n) => s + n.weight, 0);
    if (totalWeight === 0) continue;
    for (const { target, weight } of neighbors) {
      const contribution = alpha * srcNode.activation * (weight / totalWeight);
      spreadDelta.set(target, (spreadDelta.get(target) ?? 0) + contribution);
    }
  }

  for (const [id, delta] of spreadDelta) {
    if (graph.nodes[id] && id !== "self") {
      graph.nodes[id].activation =
        (1 - alpha) * graph.nodes[id].activation + delta;
    }
  }
  // Nodes that received no spread: dampen slightly
  for (const node of nodes) {
    if (node.id === "self") continue;
    if (!spreadDelta.has(node.id)) {
      // Dangling nodes: just receive + decay, no damping
    }
  }

  // Step 2.5: Hierarchical propagation (CS3)
  for (const node of nodes) {
    if (node.id === "self") continue;
    // Bottom-up: specific → abstract
    if (node.parentId && graph.nodes[node.parentId]) {
      const parent = graph.nodes[node.parentId];
      parent.activation += C.hierarchyBottomUpFactor * node.activation / Math.max(1, getChildCount(graph, node.parentId));
    }
    // Top-down: abstract → specific (only from parents)
    if (node.parentId && graph.nodes[node.parentId]) {
      const parent = graph.nodes[node.parentId];
      node.activation += C.hierarchyTopDownFactor * parent.activation;
    }
  }

  // Step 3: Decay
  for (const node of nodes) {
    if (node.id === "self") continue; // self has floor rule later
    node.activation *= (1 - DERIVED.activationDecay);
    node.salience *= (1 - DERIVED.salienceDecay);
    // D is NOT decayed — recomputed from goals
  }

  // Step 4: Fatigue inhibition
  for (const node of nodes) {
    if (node.id === "self") continue;
    node.activation -= DERIVED.fatigueInhibitionK * node.fatigue;
  }

  // Step 5: Input satiation decay
  for (const node of nodes) {
    node.inputSatiation *= DERIVED.isFactor;
  }

  // Step 6: Noise
  for (const node of nodes) {
    if (node.id === "self") continue;
    node.activation += DERIVED.noiseAmplitude * noiseScale * (rng() - 0.5) * (1 - node.fatigue);
  }

  // Step 7: Clamp A/S/U/V/D/IS (but NOT F yet)
  for (const node of nodes) {
    clampNode(node, clock);
  }

  // Self node floor + special rules
  const self = graph.nodes["self"];
  if (self) {
    self.activation = Math.max(C.selfActivationFloor, self.activation);
    self.fatigue = 0; // self never fatigues
  }

  // Step 8: Energy conservation (winner-protect scaling)
  if (energyClippingTracker) energyClippingTracker.totalCount++;

  const sumA = nodes.reduce((s, n) => s + n.activation, 0);
  if (sumA > C.energyMax) {
    if (energyClippingTracker) energyClippingTracker.clippedCount++;

    // Determine N for protection
    const clippingRate = energyClippingTracker
      ? energyClippingTracker.clippedCount / Math.max(1, energyClippingTracker.totalCount)
      : 0;
    const protectedN = clippingRate > C.energyClippingRateExpansionThreshold
      ? C.energyProtectedExpandedN
      : C.energyProtectedN;

    // Find top-N non-self nodes by activation + self
    const nonSelf = nodes.filter(n => n.id !== "self");
    nonSelf.sort((a, b) => b.activation - a.activation);
    const protectedSet = new Set<string>();
    if (self) protectedSet.add("self");
    for (let i = 0; i < protectedN && i < nonSelf.length; i++) {
      protectedSet.add(nonSelf[i].id);
    }

    const sumProtected = nodes.filter(n => protectedSet.has(n.id)).reduce((s, n) => s + n.activation, 0);
    const sumRest = nodes.filter(n => !protectedSet.has(n.id)).reduce((s, n) => s + n.activation, 0);

    const eFloor = C.bgFloorFrac * C.energyMax;
    const eLeft = Math.max(0, C.energyMax - sumProtected);
    const eBg = Math.min(eFloor, eLeft);
    const eProtect = C.energyMax - eBg;

    // Scale protected proportionally to eProtect
    if (sumProtected > eProtect && sumProtected > 0) {
      const scale = eProtect / sumProtected;
      for (const node of nodes) {
        if (protectedSet.has(node.id)) node.activation *= scale;
      }
    }

    // Scale non-protected proportionally to eBg
    if (sumRest > 0 && eBg < sumRest) {
      const scale = eBg / sumRest;
      for (const node of nodes) {
        if (!protectedSet.has(node.id)) node.activation *= scale;
      }
    }
  }

  // Re-clamp after energy scaling
  for (const node of nodes) {
    clampNode(node, clock);
  }

  // Step 9: Fatigue update (AFTER energy scaling)
  for (const node of nodes) {
    if (node.id === "self") continue;
    node.fatigue +=
      DERIVED.fatigueGainPerTick * Math.max(0, node.activation - 0.25) -
      DERIVED.fatigueRecovery * node.fatigue;
  }

  // Step 10: Clamp F
  for (const node of nodes) {
    clampFatigue(node);
  }
}

function getChildCount(graph: ConceptGraph, parentId: string): number {
  let count = 0;
  for (const n of Object.values(graph.nodes)) {
    if (n.parentId === parentId) count++;
  }
  return count;
}

// ── boostNode ────────────────────────────────────────────────────────

export function boostNode(
  graph: ConceptGraph,
  id: string,
  boost: number,
  source: ConceptSource,
  clock: Clock,
  policyExternalAbsorbScale?: number,
): void {
  const node = graph.nodes[id];
  if (!node) return;

  const isExternal = EXTERNAL_SOURCES.has(source);
  const now = clock.nowMs();

  // Step 1: Salience always boosted (IS/budget don't suppress awareness)
  node.salience += C.salienceBoostK * boost;

  // Step 2: External absorb budget
  if (isExternal) {
    const scaledBudget = C.externalAbsorbBudgetPerMin * (policyExternalAbsorbScale ?? 1.0);
    const familyKey = clusterBudgetAvailable
      ? (clusterFamilyKeyOfNode.get(id) ?? id)
      : id;
    const bucket = Math.floor(now / 60_000);
    let entry = budgetMap.get(familyKey);
    if (!entry || entry.bucket !== bucket) {
      entry = { bucket, remaining: scaledBudget };
      budgetMap.set(familyKey, entry);
    }
    if (entry.remaining < boost) {
      // Budget exceeded: S already boosted, skip A/IS/lastExternalBoostAt
      return;
    }
    entry.remaining = Math.max(0, entry.remaining - boost);
  }

  // Step 3: Compute effective boost
  const floorBoost = boost * 0.15 * (1 - node.fatigue);
  const isGatedBoost = boost * (1 - node.fatigue) * (1 - node.inputSatiation);
  const effectiveBoost = Math.max(floorBoost, isGatedBoost);
  node.activation += effectiveBoost;

  // Step 4: IS accumulation (external only)
  if (isExternal) {
    const dt = (now - node.lastExternalBoostAt) / 1000;
    node.inputSatiation += C.inputSatiationGain * boost * Math.exp(-dt / 20);
    node.lastExternalBoostAt = now;
  }

  // Step 5: Replay-specific cap
  if (source === "replay") {
    node.activation = Math.min(node.activation, 0.45);
  }

  // Clamp
  node.activation = Math.max(0, Math.min(1, node.activation));
  node.salience = Math.max(0, Math.min(1, node.salience));
  node.inputSatiation = Math.max(0, Math.min(1, node.inputSatiation));
}

// ── recomputeDrive ───────────────────────────────────────────────────

export interface GoalInfo {
  id: string;
  priority: number;
  progress: number;
  relatedTopics: string[];
  deadlineDays?: number;
}

export function recomputeDrive(graph: ConceptGraph, activeGoals: GoalInfo[]): void {
  // Reset all drive to 0
  for (const node of Object.values(graph.nodes)) {
    node.drive = 0;
  }

  const allNodes = Object.values(graph.nodes);

  for (const goal of activeGoals) {
    const deadlineUrgency = goal.deadlineDays !== undefined && goal.deadlineDays < 7 ? 2.0 : 1.0;
    const d = Math.min(1, goal.priority * (1 - goal.progress) * deadlineUrgency);

    for (const topic of goal.relatedTopics) {
      const id = normalizeId(topic);

      // Exact match
      if (graph.nodes[id]) {
        graph.nodes[id].drive = Math.max(graph.nodes[id].drive, d);
        continue;
      }

      // Fuzzy match: tokenize topic and Jaccard-match against node termVectors
      const topicTerms = tokenize(topic);
      let bestNode: ConceptNode | null = null;
      let bestSim = 0;
      for (const node of allNodes) {
        if (node.id === "self") continue;
        const sim = jaccardSimilarity(topicTerms, node.termVector);
        if (sim > bestSim) {
          bestSim = sim;
          bestNode = node;
        }
      }
      if (bestNode && bestSim > 0.3) {
        bestNode.drive = Math.max(bestNode.drive, d);
      }
    }
  }
}

// ── Queries ──────────────────────────────────────────────────────────

export function getTopK(graph: ConceptGraph, k: number): Array<{ id: string; activation: number; label: string }> {
  return Object.values(graph.nodes)
    .sort((a, b) => b.activation - a.activation)
    .slice(0, k)
    .map(n => ({ id: n.id, activation: n.activation, label: n.label }));
}

export function computeEntropy(graph: ConceptGraph): number {
  const nodes = Object.values(graph.nodes);
  const sum = nodes.reduce((s, n) => s + n.activation, 0);
  if (sum <= 0) return 0;
  let entropy = 0;
  for (const n of nodes) {
    const p = n.activation / sum;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function getStableAttractors(
  graph: ConceptGraph,
  threshold: number,
  minDurationMs: number,
  clock: Clock,
): ConceptNode[] {
  const now = clock.nowMs();
  return Object.values(graph.nodes).filter(
    n => n.activation >= threshold && n.stableSince > 0 && (now - n.stableSince) >= minDurationMs,
  );
}

export function getActivationSpike(
  graph: ConceptGraph,
  prevSnapshot: Record<string, number>,
): { id: string; delta: number } | null {
  let best: { id: string; delta: number } | null = null;
  for (const [id, node] of Object.entries(graph.nodes)) {
    const prev = prevSnapshot[id] ?? 0;
    const delta = node.activation - prev;
    if (delta > 0.3 && (!best || delta > best.delta)) {
      best = { id, delta };
    }
  }
  return best;
}

// ── findClusters (seed-based local expansion) ────────────────────────

export function findClusters(graph: ConceptGraph): ClusterInfo[] {
  const nodes = Object.values(graph.nodes);
  if (nodes.length === 0) return [];

  // Adaptive thresholds: soften when graph energy is low
  const totalEnergy = nodes.reduce((s, n) => s + n.activation, 0);
  const lowEnergy = totalEnergy < C.energyMax * 0.6;
  const aThresh = lowEnergy ? 0.05 : 0.15;
  const sdThresh = lowEnergy ? 0.03 : 0.1;
  const uThresh = lowEnergy ? 0.05 : 0.2;

  // Prune edges: keep weight >= 0.35 OR top-5 per node
  const edgeCounts = new Map<string, number>();
  const sortedEdges = [...graph.edges].sort((a, b) => b.weight - a.weight);
  const prunedEdges: ConceptEdge[] = [];

  for (const edge of sortedEdges) {
    const sCount = edgeCounts.get(edge.source) ?? 0;
    const tCount = edgeCounts.get(edge.target) ?? 0;
    if (edge.weight >= C.clusterEdgeThreshold || sCount < 5 || tCount < 5) {
      prunedEdges.push(edge);
      edgeCounts.set(edge.source, sCount + 1);
      edgeCounts.set(edge.target, tCount + 1);
    }
  }

  // Build adjacency from pruned edges
  const adj = new Map<string, Set<string>>();
  for (const e of prunedEdges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  // Multi-channel seeding
  const seeds = new Set<string>();
  const byA = [...nodes].sort((a, b) => b.activation - a.activation);
  const byS = [...nodes].sort((a, b) => b.salience - a.salience);
  const byD = [...nodes].sort((a, b) => b.drive - a.drive);
  const byU = [...nodes].sort((a, b) => b.uncertainty - a.uncertainty);

  for (let i = 0; i < 3 && i < byA.length; i++) seeds.add(byA[i].id);
  for (let i = 0; i < 3 && i < byS.length; i++) seeds.add(byS[i].id);
  for (let i = 0; i < 3 && i < byD.length; i++) seeds.add(byD[i].id);
  for (let i = 0; i < 2 && i < byU.length; i++) seeds.add(byU[i].id);

  // Expand each seed via BFS
  const clusters: ClusterInfo[] = [];

  for (const seed of seeds) {
    const cluster = new Set<string>();
    const queue = [seed];
    cluster.add(seed);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adj.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (cluster.has(neighbor)) continue;
        const n = graph.nodes[neighbor];
        if (!n) continue;
        // In low-energy mode, allow expansion on A alone (cold-start: S/D/U all zero)
        const sduOk = n.salience > sdThresh || n.drive > sdThresh || n.uncertainty > uThresh;
        if (n.activation > aThresh && (sduOk || lowEnergy)) {
          cluster.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (cluster.size >= 2) {
      const clusterNodes = [...cluster].map(id => graph.nodes[id]).filter(Boolean);
      clusters.push({
        nodes: [...cluster],
        avgA: mean(clusterNodes.map(n => n.activation)),
        avgS: mean(clusterNodes.map(n => n.salience)),
        avgU: mean(clusterNodes.map(n => n.uncertainty)),
        avgD: mean(clusterNodes.map(n => n.drive)),
        avgF: mean(clusterNodes.map(n => n.fatigue)),
        avgV: mean(clusterNodes.map(n => n.valence)),
        size: cluster.size,
      });
    }
  }

  // Merge overlapping clusters (>50% node overlap)
  const merged: ClusterInfo[] = [];
  const used = new Set<number>();

  for (let i = 0; i < clusters.length; i++) {
    if (used.has(i)) continue;
    let current = clusters[i];
    const currentSet = new Set(current.nodes);

    for (let j = i + 1; j < clusters.length; j++) {
      if (used.has(j)) continue;
      const other = clusters[j];
      const otherSet = new Set(other.nodes);
      let overlap = 0;
      for (const id of currentSet) if (otherSet.has(id)) overlap++;
      const smaller = Math.min(currentSet.size, otherSet.size);
      if (smaller > 0 && overlap / smaller > 0.5) {
        // Merge
        for (const id of otherSet) currentSet.add(id);
        used.add(j);
      }
    }

    // Recompute stats after merge
    const clusterNodes = [...currentSet].map(id => graph.nodes[id]).filter(Boolean);
    if (clusterNodes.length >= 2) {
      merged.push({
        nodes: [...currentSet],
        avgA: mean(clusterNodes.map(n => n.activation)),
        avgS: mean(clusterNodes.map(n => n.salience)),
        avgU: mean(clusterNodes.map(n => n.uncertainty)),
        avgD: mean(clusterNodes.map(n => n.drive)),
        avgF: mean(clusterNodes.map(n => n.fatigue)),
        avgV: mean(clusterNodes.map(n => n.valence)),
        size: clusterNodes.length,
      });
    }
  }

  return merged;
}

// ── scoreClusters ────────────────────────────────────────────────────

export function scoreClusters(
  clusters: ClusterInfo[],
  graph: ConceptGraph,
  wV?: number,
  valenceRising?: boolean,
): ScoredCluster[] {
  const wA = 0.3, wS = 0.25, wU = 0.15, wD = 0.15;
  const effectiveWV = (wV ?? 0.1);
  const wF = 0.2, wSize = 0.05;

  return clusters.map(c => {
    let valTerm = Math.tanh(C.valTanhK * Math.abs(c.avgV));
    // L1: Valence trend penalty — dampen if valence has been rising 3+ ticks
    if (valenceRising) valTerm *= 0.7;
    const sizeTerm = Math.log1p(c.size) / Math.log1p(10);

    let score =
      wA * c.avgA +
      wS * c.avgS +
      wU * c.avgU +
      wD * c.avgD +
      effectiveWV * valTerm -
      wF * c.avgF +
      wSize * sizeTerm;

    // Self node discount: if cluster has self, reduce self's contribution
    if (c.nodes.includes("self")) {
      const selfNode = graph.nodes["self"];
      if (selfNode) {
        // Check cluster has at least 2 non-self nodes
        const nonSelfCount = c.nodes.filter(id => id !== "self").length;
        if (nonSelfCount < 2) {
          score = 0; // self alone or with 1 node is not valid
        }
      }
    }

    const labels = c.nodes
      .map(id => graph.nodes[id]?.label ?? id)
      .slice(0, 6);

    return {
      ...c,
      score: Math.max(0, score),
      labels,
      grounding: [],
      groundingStrength: 0,
    };
  }).sort((a, b) => b.score - a.score);
}

// ── computeGroundingForCluster ────────────────────────────────────────

interface MemoryRef {
  key: string;
  timestamp: number;
}

interface GoalRef {
  id: string;
  priority: number;
  progress: number;
  relatedTopics: string[];
}

interface DiscoveryRef {
  query: string;
  timestamp: number;
  category: string;
}

export function computeGroundingForCluster(
  cluster: ClusterInfo,
  graph: ConceptGraph,
  memories: MemoryRef[],
  goals: GoalRef[],
  discoveries: DiscoveryRef[],
  clock: Clock,
  recentGroundedMemories?: Map<string, number>,
): GroundingResult {
  const now = clock.nowMs();
  const candidates: Array<{ type: "memory" | "goal" | "discovery"; id: string; weight: number; sourceNodeIds: string[]; why: GroundingRef["evidence"]["why"]; rawParts: GroundingRef["evidence"]["rawScoreParts"] }> = [];

  // Build memory lookup
  const memoryByKey = new Map<string, MemoryRef>();
  for (const m of memories) memoryByKey.set(m.key, m);

  for (const nodeId of cluster.nodes) {
    const node = graph.nodes[nodeId];
    if (!node) continue;

    // Memory grounding
    for (const key of node.memoryKeys) {
      const mem = memoryByKey.get(key);
      if (!mem) continue;
      const recency = Math.exp(-(now - mem.timestamp) / (14 * 86_400_000));
      const linkage = 1.0;
      const w = 0.6 * recency + 0.4 * linkage;
      candidates.push({
        type: "memory", id: key, weight: w, sourceNodeIds: [nodeId],
        why: "memoryKeys", rawParts: { recency, linkage },
      });
    }

    // Goal grounding
    for (const goal of goals) {
      if (goal.relatedTopics.some(t => normalizeId(t) === nodeId)) {
        const deadlineUrgency = 1.0; // simplified
        const w = Math.min(1, goal.priority * (1 - goal.progress) * deadlineUrgency);
        candidates.push({
          type: "goal", id: goal.id, weight: w, sourceNodeIds: [nodeId],
          why: "goalMatch", rawParts: { priority: goal.priority },
        });
      }
    }

    // Discovery grounding
    for (const disc of discoveries) {
      const matchScore = jaccardSimilarity(node.termVector, tokenize(disc.query + " " + disc.category));
      if (matchScore > 0.2) {
        const recency = Math.exp(-(now - disc.timestamp) / (3 * 86_400_000));
        const w = 0.5 * recency + 0.5 * matchScore;
        candidates.push({
          type: "discovery", id: disc.query, weight: w, sourceNodeIds: [nodeId],
          why: "discoveryMatch", rawParts: { recency, matchScore },
        });
      }
    }
  }

  // Dedup by (type, id): merge weights using 1 - Π(1 - w_i)
  const dedupMap = new Map<string, typeof candidates[0]>();
  for (const c of candidates) {
    const key = `${c.type}:${c.id}`;
    const existing = dedupMap.get(key);
    if (existing) {
      existing.weight = 1 - (1 - existing.weight) * (1 - c.weight);
      existing.sourceNodeIds = [...new Set([...existing.sourceNodeIds, ...c.sourceNodeIds])];
    } else {
      dedupMap.set(key, { ...c, sourceNodeIds: [...c.sourceNodeIds] });
    }
  }

  // Diversity: penalize memories already used in recent thoughts
  if (recentGroundedMemories) {
    for (const [, c] of dedupMap) {
      if (c.type === "memory") {
        const recentUseCount = recentGroundedMemories.get(c.id) ?? 0;
        if (recentUseCount > 0) {
          c.weight *= Math.pow(0.7, recentUseCount); // 30% discount per recent use
        }
      }
    }
  }

  // Sort by weight desc, take top 3
  const sorted = [...dedupMap.values()].sort((a, b) => b.weight - a.weight).slice(0, 3);

  const grounding: GroundingRef[] = sorted.map(c => ({
    type: c.type,
    id: c.id,
    weight: c.weight,
    evidence: {
      sourceNodeIds: c.sourceNodeIds,
      why: c.why,
      rawScoreParts: c.rawParts,
    },
  }));

  const groundingStrength = grounding.length > 0
    ? mean(grounding.map(g => g.weight))
    : 0;

  return { grounding, groundingStrength };
}

// ── groundingAgePenaltyFactor ────────────────────────────────────────

export function groundingAgePenaltyFactor(
  grounding: GroundingRef[],
  nodesDrive: number[],
  nodesSalience: number[],
  clock: Clock,
  memoryTimestamps: Map<string, number>,
  graph?: ConceptGraph,
  clusterNodeIds?: string[],
): number {
  if (grounding.length === 0) return 1.0;

  const now = clock.nowMs();
  let penalty = 1.0;

  // ── Check 1: Temporal relevance (graduated age decay) ──
  for (const ref of grounding) {
    if (ref.type === "goal") continue; // goals never age out

    if (ref.type === "memory") {
      const memTs = memoryTimestamps.get(ref.id);
      if (!memTs) continue;
      const ageDays = (now - memTs) / 86_400_000;

      if (ageDays > 90) {
        penalty *= 0.5;  // very stale: 50% reduction
      } else if (ageDays > 60) {
        penalty *= 0.6;  // stale: 40% reduction
      } else if (ageDays > 30) {
        penalty *= 0.8;  // aging: 20% reduction
      }
      // ≤30 days: no penalty
    }

    if (ref.type === "discovery") {
      const ageDays = ref.evidence.rawScoreParts.recency
        ? -Math.log(ref.evidence.rawScoreParts.recency) * (3 * 86_400_000 / 86_400_000)
        : 30;
      if (ageDays > 14) {
        penalty *= 0.7; // discoveries go stale faster
      }
    }
  }

  // ── Check 2: Entity state contradiction ──
  // If cluster nodes have opposing valence signs, grounding may be contradictory
  if (graph && clusterNodeIds && clusterNodeIds.length >= 2) {
    const valences = clusterNodeIds
      .map(id => graph.nodes[id]?.valence ?? 0)
      .filter(v => Math.abs(v) > 0.2);
    if (valences.length >= 2) {
      const hasPositive = valences.some(v => v > 0.2);
      const hasNegative = valences.some(v => v < -0.2);
      if (hasPositive && hasNegative) {
        // Contradictory valence in cluster → reduce confidence
        penalty *= 0.85;
      }
    }
  }

  // ── Check 3: Cross-grounding consistency ──
  // Multiple groundings should not mix very fresh and very stale sources
  if (grounding.length >= 2) {
    const ages = grounding
      .filter(g => g.type === "memory")
      .map(g => {
        const ts = memoryTimestamps.get(g.id);
        return ts ? (now - ts) / 86_400_000 : 60;
      });
    if (ages.length >= 2) {
      const minAge = Math.min(...ages);
      const maxAge = Math.max(...ages);
      if (maxAge > 60 && minAge < 7) {
        // Mixing very fresh and very stale groundings → temporal inconsistency
        penalty *= 0.9;
      }
    }
  }

  // ── Immunity overrides ──
  // Active commitment bypasses age penalty
  if (Math.max(...nodesDrive, 0) > 0.25) return Math.max(penalty, 0.9);
  // Fresh external salience bypasses age penalty
  if (mean(nodesSalience) > 0.6) return Math.max(penalty, 0.9);

  return penalty;
}

// ── Edge building utilities ──────────────────────────────────────────

export function buildSemanticEdges(graph: ConceptGraph): void {
  const nodeList = Object.values(graph.nodes);

  // Track best neighbor per node for fallback bridging
  const bestNeighbor = new Map<string, { id: string; sim: number }>();

  for (let i = 0; i < nodeList.length; i++) {
    const a = nodeList[i];
    const similarities: Array<{ id: string; sim: number }> = [];

    for (let j = 0; j < nodeList.length; j++) {
      if (i === j) continue;
      const b = nodeList[j];
      const sim = jaccardSimilarity(a.termVector, b.termVector);

      // Track best neighbor regardless of threshold
      const current = bestNeighbor.get(a.id);
      if (!current || sim > current.sim) {
        bestNeighbor.set(a.id, { id: b.id, sim });
      }

      if (sim > C.jaccardEdgeThreshold) {
        similarities.push({ id: b.id, sim });
      }
    }

    // Keep top-8 most similar
    similarities.sort((x, y) => y.sim - x.sim);
    for (const { id: targetId, sim } of similarities.slice(0, 8)) {
      // Check if edge already exists
      const exists = graph.edges.some(
        e => (e.source === a.id && e.target === targetId) ||
             (e.source === targetId && e.target === a.id),
      );
      if (!exists && graph.edges.length < C.maxEdges) {
        graph.edges.push({
          source: a.id,
          target: targetId,
          type: "semantic",
          weight: sim,
        });
      }
    }
  }

  // Bridge disconnected nodes: connect any node with zero edges to its nearest neighbor
  const connectedNodes = new Set<string>();
  for (const e of graph.edges) {
    connectedNodes.add(e.source);
    connectedNodes.add(e.target);
  }

  for (const node of nodeList) {
    if (connectedNodes.has(node.id)) continue;
    const best = bestNeighbor.get(node.id);
    if (best && graph.edges.length < C.maxEdges) {
      graph.edges.push({
        source: node.id,
        target: best.id,
        type: "semantic",
        weight: Math.max(0.15, best.sim),
      });
      connectedNodes.add(node.id);
    }
  }
}

export function addEdge(
  graph: ConceptGraph,
  source: string,
  target: string,
  type: ConceptEdge["type"],
  weight: number,
): void {
  if (source === target) return;
  const existing = graph.edges.find(
    e => (e.source === source && e.target === target) ||
         (e.source === target && e.target === source),
  );
  if (existing) {
    existing.weight = Math.max(existing.weight, weight);
    existing.type = type;
    return;
  }
  if (graph.edges.length < C.maxEdges) {
    graph.edges.push({ source, target, type, weight: Math.min(1, weight) });
  }
}

// ── Graph merge scan (drift + fragmentation) ─────────────────────────

export function runMergeScan(graph: ConceptGraph, clock: Clock, aliasTable?: AliasTable): string[] {
  const mergeLog: string[] = [];
  const nodeList = Object.values(graph.nodes);

  for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
      const a = nodeList[i];
      const b = nodeList[j];
      const combined = [...new Set([...a.termVector, ...a.memoryKeys, ...b.termVector, ...b.memoryKeys])];
      const aCombined = [...new Set([...a.termVector, ...a.memoryKeys])];
      const bCombined = [...new Set([...b.termVector, ...b.memoryKeys])];
      const sim = jaccardSimilarity(aCombined, bCombined);

      if (sim > 0.85 && (a.parentId === b.parentId || !a.parentId || !b.parentId)) {
        // Auto-merge: keep a, absorb b
        a.termVector = [...new Set([...a.termVector, ...b.termVector])].slice(0, 20);
        a.memoryKeys = [...new Set([...a.memoryKeys, ...b.memoryKeys])].slice(0, 5);
        a.activation = Math.max(a.activation, b.activation);
        if (b.source === "conversation") a.label = b.label;

        // Redirect edges from b to a
        for (const edge of graph.edges) {
          if (edge.source === b.id) edge.source = a.id;
          if (edge.target === b.id) edge.target = a.id;
        }
        // Remove self-loops
        graph.edges = graph.edges.filter(e => e.source !== e.target);
        delete graph.nodes[b.id];

        // Register aliases so future references to b get redirected to a
        if (aliasTable) {
          registerAlias(aliasTable, b.id, a.id);
          registerAlias(aliasTable, b.label, a.id);
          aliasTable.mergeHistory.push({
            from: b.id, to: a.id,
            reason: "auto-merge",
            timestamp: clock.nowMs(),
          });
          if (aliasTable.mergeHistory.length > 100) aliasTable.mergeHistory.shift();
        }

        mergeLog.push(`merged: ${a.label} ← ${b.label} (sim=${sim.toFixed(2)})`);
      } else if (sim > 0.7) {
        mergeLog.push(`merge candidate: ${a.label} ↔ ${b.label} (sim=${sim.toFixed(2)})`);
      }
    }
  }

  return mergeLog;
}

export function checkFragmentation(graph: ConceptGraph): {
  fragmented: boolean;
  largestComponentFrac: number;
  bridgesCreated: number;
} {
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length === 0) return { fragmented: false, largestComponentFrac: 1, bridgesCreated: 0 };

  // Build adjacency (weight > 0.1)
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of graph.edges) {
    if (e.weight > 0.1) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }
  }

  // Find connected components
  const visited = new Set<string>();
  const components: Set<string>[] = [];

  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    const component = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);
      for (const neighbor of (adj.get(current) ?? [])) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  const largest = components.reduce((a, b) => a.size > b.size ? a : b, new Set<string>());
  const largestFrac = largest.size / nodeIds.length;
  let bridgesCreated = 0;

  if (largestFrac < 0.6) {
    // Auto-repair: connect fragments to largest component
    for (const fragment of components) {
      if (fragment === largest) continue;
      let bestSim = 0;
      let bestPair: [string, string] | null = null;

      for (const fId of fragment) {
        const fNode = graph.nodes[fId];
        if (!fNode) continue;
        for (const lId of largest) {
          const lNode = graph.nodes[lId];
          if (!lNode) continue;
          const sim = jaccardSimilarity(fNode.termVector, lNode.termVector);
          if (sim > bestSim) {
            bestSim = sim;
            bestPair = [fId, lId];
          }
        }
      }

      if (bestPair) {
        addEdge(graph, bestPair[0], bestPair[1], "semantic", Math.max(0.2, bestSim));
        bridgesCreated++;
      }
    }
  }

  return { fragmented: largestFrac < 0.6, largestComponentFrac: largestFrac, bridgesCreated };
}

// ── Utility ──────────────────────────────────────────────────────────

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function snapshotActivations(graph: ConceptGraph): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    snap[id] = node.activation;
  }
  return snap;
}
