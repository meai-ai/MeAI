/**
 * Bootstrap — builds initial concept graph from existing state.
 *
 * Creates nodes from memories, goals, discoveries, opinions.
 * Creates self node (CS5). Assigns parent-child. Builds edges.
 * Migrates legacy activation state from heartbeat.
 */

import { tokenize } from "../memory/search.js";
import { getActiveGoals, type Goal } from "../goals.js";
import type { Memory } from "../types.js";
import type { Clock, ConceptACL } from "./config.js";
import type { CortexManager } from "./cortex.js";
import { ACL_DEFAULTS, BRAINSTEM_CONFIG as C, CS6_CONFIG, DEFAULT_TTL_DAYS_BY_SOURCE, MS_PER_DAY, MS_PER_HOUR } from "./config.js";
import {
  type ConceptGraph,
  type ConceptNode,
  type ConceptSource,
  type ConceptDomain,
  type AliasTable,
  createNode,
  normalizeId,
  findOrCreateNode,
  addEdge,
  boostNode,
  buildSemanticEdges,
  checkFragmentation,
  registerAlias,
  runMergeScan,
  findClusters,
  detectCrossDomainBridges,
} from "./graph.js";
import { readJsonSafe } from "../lib/atomic-file.js";
import { claudeText } from "../claude-runner.js";
import { getCharacter } from "../character.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-bootstrap");

// ── State types ──────────────────────────────────────────────────────

/** CS6b: Persisted edge direction statistics for causal direction discovery. */
export interface EdgeDirectionStat {
  forwardCount: number;
  backwardCount: number;
  avgLeadMs: number;
  directionConfidence: number;
  lastUpdatedAt: number;
}

export interface BrainstemState {
  version: number;
  graph: ConceptGraph;
  tickCount: number;
  memoryReplayIndex: number;
  avgPredictionError: number;
  avgEpistemicError: number;
  avgPragmaticError: number;
  predictionErrors: number[];
  thoughtHistory: MicroThoughtRecord[];
  topHistory: Array<{ ids: string[]; timestamp: number }>;
  predictions: PredictionRecord[];
  activationHistory: Record<string, number[]>;
  hypotheticalNodes: string[];
  selfValence: number;
  csi: number;
  csiMode: "green" | "yellow" | "red";
  valenceHistory: number[];
  lastModeTransitionAt: number;
  csiAtTransition: number;
  seeds?: { noise: number; replay: number; sampling: number };
  // CS6: Structure learning
  conceptBirthsToday?: number;
  conceptDeathsToday?: number;
  causalEdgesFormed?: number;
  lastConceptBirthDay?: number;
  conceptBirthDates?: number[];    // timestamps of recent births for 7d rolling count
  // CS6b: Edge direction stats (persisted across sessions)
  edgeDirectionStats?: Record<string, EdgeDirectionStat>;
  configHash?: string;
  contractVersion?: string;
  // Persisted co-activation counts (Map<string,number> serialized as Record)
  coActivationCountsPersisted?: Record<string, number>;
  lastConfigSnapshot?: string;
  learnedSkillMappings?: LearnedSkillMapping[];
  // Working memory slots (persisted across restarts)
  workingMemorySlots?: Record<string, unknown>;
}

export interface LearnedSkillMapping {
  pattern: string;
  skillName: string;
  actionType: string;
  minActivation: number;
  successCount: number;
  failCount: number;
  lastUsed: number;
  createdAt: number;
}

export interface MicroThoughtRecord {
  id: string;
  content: string;
  structSig: string[];
  semSigText: string;
  timestamp: number;
  trigger: "stable_attractor" | "activation_spike" | "high_uncertainty" | "high_valence" | "prediction_error";
  grounding: Array<{ type: string; id: string; weight: number }>;
  concepts: string[];
  anchor: "grounded" | "inferred" | "speculative";
}

export interface PredictionRecord {
  id: string;
  concept: string;
  expectedActivation: number;
  expectedValence: number;
  generatedAt: number;
  source: "micro_thought" | "goal" | "memory_pattern";
  resolved: boolean;
}

// ── Default empty state ──────────────────────────────────────────────

export function createDefaultState(): BrainstemState {
  return {
    version: 2,
    graph: { nodes: {}, edges: [], lastRebuilt: 0 },
    tickCount: 0,
    memoryReplayIndex: 0,
    avgPredictionError: 0,
    avgEpistemicError: 0,
    avgPragmaticError: 0,
    predictionErrors: [],
    thoughtHistory: [],
    topHistory: [],
    predictions: [],
    activationHistory: {},
    hypotheticalNodes: [],
    selfValence: 0,
    csi: 1.0,
    csiMode: "green",
    valenceHistory: [],
    lastModeTransitionAt: 0,
    csiAtTransition: 1.0,
  };
}

// ── State migration ──────────────────────────────────────────────────

export function migrateState(state: Record<string, unknown>): BrainstemState {
  const defaults = createDefaultState();
  const v = (state.version as number) ?? 1;

  if (v < 2) {
    // v1 → v2: add missing fields
    return {
      ...defaults,
      ...(state as Partial<BrainstemState>),
      version: 2,
      predictions: (state.predictions as PredictionRecord[]) ?? [],
      activationHistory: (state.activationHistory as Record<string, number[]>) ?? {},
      hypotheticalNodes: (state.hypotheticalNodes as string[]) ?? [],
      selfValence: (state.selfValence as number) ?? 0,
      csi: (state.csi as number) ?? 1.0,
      csiMode: (state.csiMode as "green" | "yellow" | "red") ?? "green",
      valenceHistory: (state.valenceHistory as number[]) ?? [],
      lastModeTransitionAt: (state.lastModeTransitionAt as number) ?? 0,
      csiAtTransition: (state.csiAtTransition as number) ?? 1.0,
      graph: (state.graph as ConceptGraph) ?? defaults.graph,
    };
  }

  const merged = { ...defaults, ...(state as Partial<BrainstemState>) };
  // Ensure contractVersion exists for older installs
  if (!merged.contractVersion) merged.contractVersion = "2.0.0";
  return merged;
}

// ── Bootstrap graph from existing state ──────────────────────────────

export function bootstrapGraph(
  memories: Memory[],
  goals: Goal[],
  discoveries: Array<{ query: string; category: string; timestamp: number }>,
  opinions: Array<{ topic: string; stance?: string; position?: string }>,
  legacyActivations: Record<string, { weight: number }>,
  clock: Clock,
): ConceptGraph {
  const graph: ConceptGraph = { nodes: {}, edges: [], lastRebuilt: clock.nowMs() };
  const char = getCharacter();
  const charName = char.name;
  const userName = char.user.name;
  const userNameLower = userName.toLowerCase();

  log.info("bootstrapping concept graph...");

  // 1. Self node (CS5) — must be created first
  const self = createNode("self", `self (${charName})`, "reflection", {
    depth: 0,
    anchorText: `${charName} — the character`,
    acl: ACL_DEFAULTS.meta,
  });
  self.activation = 0.5;
  self.salience = 0.2;
  graph.nodes["self"] = self;

  // 2. Nodes from memories
  let memCount = 0;
  for (const mem of memories) {
    // Extract key prefix as concept label
    const parts = mem.key.split(".");
    if (parts.length < 2) continue;
    const prefix = parts.slice(0, 2).join(".");

    // Determine ACL from key
    let acl: ConceptACL = ACL_DEFAULTS.topic;
    if (prefix.startsWith("user.") || prefix.startsWith("family.")) {
      acl = ACL_DEFAULTS.person;
    } else if (prefix.startsWith("health.")) {
      acl = ACL_DEFAULTS.sensitive;
    }

    const label = extractLabel(mem.key, mem.value);
    const node = findOrCreateNode(graph, label, "memory", {
      memoryKeys: [mem.key],
      anchorText: mem.value.slice(0, 100),
      acl,
    });

    memCount++;
    if (memCount >= C.maxNodes - 10) break; // leave room for goals/discoveries
  }

  // 3. Nodes from goals
  const activeGoals = goals.filter(g => g.status === "active");
  for (const goal of activeGoals) {
    const node = findOrCreateNode(graph, goal.description, "goal", {
      depth: 1,
      anchorText: goal.description,
    });

    // Create nodes for relatedTopics as children
    if (goal.relatedTopics) {
      for (const topic of goal.relatedTopics) {
        const child = findOrCreateNode(graph, topic, "goal", {
          parentId: node.id,
          depth: 2,
          anchorText: topic,
        });
        addEdge(graph, node.id, child.id, "goal_related", 0.6);
      }
    }
  }

  // 4. Nodes from discoveries (recent ones)
  const recentDiscoveries = discoveries
    .filter(d => clock.nowMs() - d.timestamp < 3 * (MS_PER_DAY as number)) // last 3 days
    .slice(0, 10);

  for (const disc of recentDiscoveries) {
    findOrCreateNode(graph, disc.query, "curiosity", {
      anchorText: disc.query,
    });
  }

  // 5. Nodes from opinions
  for (const op of opinions.slice(0, 10)) {
    findOrCreateNode(graph, op.topic, "reflection", {
      anchorText: (op.stance ?? op.position ?? op.topic).slice(0, 100),
    });
  }

  // 6. Warm-start activations and salience by source type
  for (const node of Object.values(graph.nodes)) {
    if (node.id === "self") continue; // self already set to 0.5
    switch (node.source) {
      case "memory":
        node.activation = Math.max(node.activation, 0.1);
        node.salience = Math.max(node.salience, 0.05);
        break;
      case "goal":
        node.activation = Math.max(node.activation, 0.2);
        node.salience = Math.max(node.salience, 0.1);
        break;
      case "curiosity":
        node.activation = Math.max(node.activation, 0.15);
        node.salience = Math.max(node.salience, 0.08);
        break;
      case "reflection":
        node.activation = Math.max(node.activation, 0.1);
        node.salience = Math.max(node.salience, 0.05);
        break;
    }
  }

  // 6b. Migrate legacy activations from heartbeat (overrides warm-start if higher)
  for (const [topic, act] of Object.entries(legacyActivations)) {
    const id = normalizeId(topic);
    if (graph.nodes[id]) {
      graph.nodes[id].activation = Math.max(graph.nodes[id].activation, Math.min(1, act.weight));
    }
  }

  // 7. Build edges
  buildSemanticEdges(graph);

  // Memory-key prefix edges: group nodes by top-level prefix and connect within groups
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
    // Connect each node to up to 4 others in the same prefix group
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length && j < i + 5; j++) {
        addEdge(graph, unique[i], unique[j], "semantic", 0.25);
      }
    }
  }

  // Goal-related edges
  for (const goal of activeGoals) {
    if (!goal.relatedTopics || goal.relatedTopics.length < 2) continue;
    for (let i = 0; i < goal.relatedTopics.length; i++) {
      for (let j = i + 1; j < goal.relatedTopics.length; j++) {
        const a = normalizeId(goal.relatedTopics[i]);
        const b = normalizeId(goal.relatedTopics[j]);
        if (graph.nodes[a] && graph.nodes[b]) {
          addEdge(graph, a, b, "goal_related", 0.4);
        }
      }
    }
  }

  // Self edges: connect to goals, emotion-related, and user
  for (const node of Object.values(graph.nodes)) {
    if (node.id === "self") continue;
    if (node.source === "goal") {
      addEdge(graph, "self", node.id, "goal_related", 0.5);
    }
    if (node.source === "emotion") {
      addEdge(graph, "self", node.id, "semantic", 0.3);
    }
    if (node.id.includes(userNameLower) || node.label.toLowerCase().includes(userNameLower)) {
      addEdge(graph, "self", node.id, "semantic", 0.4);
    }
  }

  // 8. Prune to limits
  pruneGraph(graph);

  log.info(`bootstrapped: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`);

  return graph;
}

// ── Wake-up consolidation ────────────────────────────────────────────

export interface ConsolidationResult {
  edgesPruned: number;
  nodesEvicted: number;
  edgesStrengthened: number;
  conceptsSynthesized: number;
  overnightInsight: string | null;
}

export async function wakeUpConsolidation(
  graph: ConceptGraph,
  coActivationCounts: Map<string, number>, // "nodeA|nodeB" → count
  clock: Clock,
  activationHistory?: Record<string, number[]>,
  aliasTable?: AliasTable,
  cortexManager?: CortexManager,
): Promise<ConsolidationResult> {
  const now = clock.nowMs();
  let edgesPruned = 0;
  let nodesEvicted = 0;
  let edgesStrengthened = 0;
  let conceptsSynthesized = 0;

  // 1. Edge pruning: remove weight < 0.1 (L8: protect learned edges)
  const before = graph.edges.length;
  graph.edges = graph.edges.filter(e => {
    if (e.weight >= 0.1) return true;
    // L8: Protect edges with high confidence (learned through temporal credit)
    if (e.weight >= 0.05 && e.type === "causal") return true;
    return false;
  });
  edgesPruned = before - graph.edges.length;

  // 1.5. Tier promotion/demotion (STM → MTM → LTM)
  if (activationHistory) {
    const _48h = 48 * (MS_PER_HOUR as number);
    const _7d = 7 * (MS_PER_DAY as number);
    const _30d = 30 * (MS_PER_DAY as number);

    for (const node of Object.values(graph.nodes)) {
      if (node.id === "self") continue;
      const history = activationHistory[node.id] ?? [];

      if (node.knowledgeTier === "stm") {
        // STM → MTM: 3+ activations in last 48h
        const recent = history.filter(ts => now - ts < _48h);
        if (recent.length >= 3) {
          node.knowledgeTier = "mtm";
        }
      } else if (node.knowledgeTier === "mtm") {
        // MTM → LTM: activation history spans 7+ days AND 2+ memory links
        if (history.length >= 2) {
          const oldest = Math.min(...history);
          const newest = Math.max(...history);
          const memoryEdges = graph.edges.filter(
            e => (e.source === node.id || e.target === node.id) && e.type === "semantic",
          ).length;
          if (newest - oldest >= _7d && memoryEdges >= 2) {
            node.knowledgeTier = "ltm";
          }
        }
      } else if (node.knowledgeTier === "ltm") {
        // LTM → MTM demotion: not activated in 30 days
        const lastActivation = history.length > 0 ? Math.max(...history) : 0;
        if (lastActivation > 0 && now - lastActivation > _30d) {
          node.knowledgeTier = "mtm";
        }
      }
    }
  }

  // 2. Node eviction: per-source TTL
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (id === "self") continue;
    const ttlDays = DEFAULT_TTL_DAYS_BY_SOURCE[node.source] ?? 14;
    if (ttlDays === Infinity) continue; // goals never auto-evict
    if (ttlDays === 0) continue; // simulation nodes handled by hypotheticalTTLMs

    // Tier-aware eviction: LTM never auto-evicted, MTM has 7-day floor
    const tier = node.knowledgeTier;
    if (tier === "ltm") continue;
    const effectiveTtlMs = tier === "mtm"
      ? Math.max(7 * (MS_PER_DAY as number), ttlDays * (MS_PER_DAY as number))
      : ttlDays * (MS_PER_DAY as number);

    if (now - node.lastActivated > effectiveTtlMs) {
      delete graph.nodes[id];
      graph.edges = graph.edges.filter(e => e.source !== id && e.target !== id);
      nodesEvicted++;
    }
  }

  // 3. Data-driven edge strengthening (top 20%)
  if (coActivationCounts.size > 0) {
    const sorted = [...coActivationCounts.entries()].sort((a, b) => b[1] - a[1]);
    const threshold = Math.ceil(sorted.length * 0.2);
    const topPairs = sorted.slice(0, threshold);

    for (const [pairKey] of topPairs) {
      const [a, b] = pairKey.split("|");
      const edge = graph.edges.find(
        e => (e.source === a && e.target === b) || (e.source === b && e.target === a),
      );
      if (edge) {
        edge.weight = Math.min(1, edge.weight * 1.07); // 7% increase
        edgesStrengthened++;
      }
    }

    // 3b. C-1: Cortex-assisted concept extraction (non-fatal, supplements synthesis)
    if (cortexManager) {
      try {
        const thoughtNodes = Object.values(graph.nodes)
          .filter(n => n.source === "reflection")
          .sort((a, b) => b.lastActivated - a.lastActivated)
          .slice(0, 20);
        if (thoughtNodes.length > 0) {
          const fragments = thoughtNodes.map(n => ({
            text: n.label,
            source: "reflection" as const,
            timestamp: n.lastActivated,
          }));
          const existingConcepts = Object.values(graph.nodes).map(n => n.label);
          const c1Result = await cortexManager.compressSemantics({ fragments, existingConcepts });
          for (const concept of c1Result.concepts) {
            if (concept.confidence > 0.6) {
              const parentId = concept.parentCandidate
                ? normalizeId(concept.parentCandidate)
                : undefined;
              const parentExists = parentId && graph.nodes[parentId];
              const opts: Partial<Pick<ConceptNode, "parentId" | "depth" | "anchorText">> = {};
              if (concept.definition) opts.anchorText = concept.definition;
              if (parentExists) {
                opts.parentId = parentId;
                opts.depth = (graph.nodes[parentId!].depth ?? 0) + 1;
              }
              findOrCreateNode(graph, concept.label, "cortex",
                Object.keys(opts).length > 0 ? opts : undefined, aliasTable);
            }
          }
          const VALID_C1_REL_TYPES = new Set(["semantic", "causal", "co_occurrence"]);
          for (const rel of c1Result.relations) {
            if (rel.confidence > 0.6 && VALID_C1_REL_TYPES.has(rel.type)) {
              const srcId = normalizeId(rel.source);
              const tgtId = normalizeId(rel.target);
              if (graph.nodes[srcId] && graph.nodes[tgtId]) {
                addEdge(graph, srcId, tgtId, rel.type as "semantic" | "causal" | "co_occurrence", rel.weight);
              }
            }
          }
          for (const hint of c1Result.salienceHints) {
            const nodeId = normalizeId(hint.concept);
            if (graph.nodes[nodeId]) {
              // Use boostNode for proper IS/budget gating (treated as external injection)
              boostNode(graph, nodeId, hint.salience * 0.3, "cortex", clock);
            }
          }
        }
      } catch {
        // C-1 failure is non-fatal — existing synthesis continues
      }
    }

    // 3c. Concept synthesis: find co-activated triplets, create synthetic parent
    conceptsSynthesized = await synthesizeConcepts(graph, sorted, now, aliasTable);
  }

  // 4. Overnight insight: most persistent node (L5: use stableSince, not highest activation)
  let mostPersistent: ConceptNode | null = null;
  let longestStable = 0;
  for (const node of Object.values(graph.nodes)) {
    if (node.id === "self") continue;
    if (node.activation < 0.1) continue;
    const stableDuration = node.stableSince > 0 ? now - node.stableSince : 0;
    if (stableDuration > longestStable) {
      longestStable = stableDuration;
      mostPersistent = node;
    }
  }

  const overnightInsight = mostPersistent && longestStable > 60_000
    ? `Still thinking about: ${mostPersistent.label}`
    : null;

  // 5. L6: Fragmentation check during consolidation (not just on restart)
  const fragResult = checkFragmentation(graph);
  if (fragResult.fragmented) {
    log.info(`consolidation: fragmentation detected, largest=${(fragResult.largestComponentFrac * 100).toFixed(0)}%, bridges=${fragResult.bridgesCreated}`);
  }

  // 5b. Merge scan with alias registration
  const mergeLog = runMergeScan(graph, clock, aliasTable);
  if (mergeLog.length > 0) {
    log.info(`consolidation merge scan: ${mergeLog.length} actions`);
  }

  // 5c. Cross-domain bridge detection
  const clusters = findClusters(graph);
  const crossDomainEdges = detectCrossDomainBridges(graph, clusters);
  for (const edge of crossDomainEdges) {
    addEdge(graph, edge.source, edge.target, edge.type, edge.weight);
  }
  if (crossDomainEdges.length > 0) {
    log.info(`consolidation: ${crossDomainEdges.length} cross-domain bridges created`);
  }

  // 6. M3: Semantic anchor drift detection
  detectAnchorDrift(graph);

  return { edgesPruned, nodesEvicted, edgesStrengthened, conceptsSynthesized, overnightInsight };
}

// ── CS6: Concept birth/death ──────────────────────────────────────────

/**
 * Propose concept births from co-activation patterns.
 * Returns birth count + details for audit logging.
 */
export async function proposeConceptBirth(
  graph: ConceptGraph,
  coActivationCounts: Map<string, number>,
  activationHistory: Record<string, number[]>,
  clock: Clock,
  cortexManager?: CortexManager,
  state?: BrainstemState,
): Promise<{ count: number; births: Array<{ id: string; label: string; members: string[] }> }> {
  const now = clock.nowMs();

  // Check daily limit
  const today = Math.floor(now / 86_400_000);
  if (state) {
    if (state.lastConceptBirthDay === today && (state.conceptBirthsToday ?? 0) >= CS6_CONFIG.maxBirthsPerDay) {
      return { count: 0, births: [] };
    }
    if (state.lastConceptBirthDay !== today) {
      state.conceptBirthsToday = 0;
      state.conceptDeathsToday = 0;
      state.lastConceptBirthDay = today;
    }
  }

  // Check synthetic node cap
  const syntheticCount = Object.values(graph.nodes).filter(n => n.source === "structure_learning").length;
  if (syntheticCount >= CS6_CONFIG.maxSyntheticNodes) return { count: 0, births: [] };

  // Total ticks for support calculation
  const totalTicks = Math.max(1, coActivationCounts.size > 0
    ? Math.max(...coActivationCounts.values()) / CS6_CONFIG.coActivationThreshold
    : 100);

  // Find frequent pairs
  const candidates: Array<{ members: string[]; support: number }> = [];
  for (const [pairKey, count] of coActivationCounts) {
    const support = count / totalTicks;
    if (support < CS6_CONFIG.coActivationThreshold) continue;
    const [a, b] = pairKey.split("|");
    if (!graph.nodes[a] || !graph.nodes[b]) continue;
    if (graph.nodes[a].id === "self" || graph.nodes[b].id === "self") continue;

    // Check no existing shared parent
    const aParent = graph.nodes[a].parentId;
    const bParent = graph.nodes[b].parentId;
    if (aParent && aParent === bParent) continue;

    // CS6: avgEdgeWeightTrend > 0 — only birth if edge weight is strengthening
    const existingEdge = graph.edges.find(
      e => (e.source === a && e.target === b) || (e.source === b && e.target === a),
    );
    if (existingEdge && existingEdge.weight < 0.15) continue; // edge too weak / declining

    // Dedup: skip if any existing node has high Jaccard with combined termVectors
    const combined = [...new Set([...graph.nodes[a].termVector, ...graph.nodes[b].termVector])];
    let isDuplicate = false;
    for (const node of Object.values(graph.nodes)) {
      const setA = new Set(combined);
      const setB = new Set(node.termVector);
      let intersection = 0;
      for (const x of setA) if (setB.has(x)) intersection++;
      const union = setA.size + setB.size - intersection;
      if (union > 0 && intersection / union > 0.6) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    candidates.push({ members: [a, b], support });
  }

  if (candidates.length === 0) return { count: 0, births: [] };

  // Sort by support descending, take top 1
  candidates.sort((a, b) => b.support - a.support);
  const best = candidates[0];

  // Create synthetic node
  const sortedMembers = [...best.members].sort();
  const synthId = normalizeId(`synth-${sortedMembers.join("-")}`);
  if (graph.nodes[synthId]) return { count: 0, births: [] };

  const memberLabels = sortedMembers.map(id => graph.nodes[id]?.label ?? id);
  // CS6: Cortex-1 naming via LLM or fallback to concatenation
  let label = memberLabels.join("+");
  try {
    const nameResult = await claudeText({
      label: "brainstem.nameCortex",
      system: "Name the following co-activated concept group with a concise superordinate concept (2-5 words). Output only the name, no explanation.",
      prompt: memberLabels.join(", "),
      model: "fast",
      timeoutMs: 10_000,
    });
    const trimmed = nameResult.trim().slice(0, 30);
    if (trimmed.length > 0) label = trimmed;
  } catch { /* fallback to concatenation */ }

  const node = findOrCreateNode(graph, label, "structure_learning", {
    depth: Math.min(...sortedMembers.map(id => graph.nodes[id]?.depth ?? 2)) - 1,
  });
  if (!node) return { count: 0, births: [] };

  // Add parent-child edges
  for (const memberId of sortedMembers) {
    if (graph.nodes[memberId]) {
      graph.nodes[memberId].parentId = node.id;
      addEdge(graph, node.id, memberId, "semantic", 0.4);
    }
  }

  if (state) {
    state.conceptBirthsToday = (state.conceptBirthsToday ?? 0) + 1;
    // Track birth timestamps for 7d rolling count
    if (!state.conceptBirthDates) state.conceptBirthDates = [];
    state.conceptBirthDates.push(now);
    // Prune entries older than 7 days
    const cutoff7d = now - 7 * 86_400_000;
    state.conceptBirthDates = state.conceptBirthDates.filter(t => t > cutoff7d);
  }

  log.info(`concept birth: "${label}" from co-activation of [${sortedMembers.join(", ")}]`);
  return { count: 1, births: [{ id: synthId, label, members: sortedMembers }] };
}

/**
 * Prune dead synthetic concepts — inactive for > conceptDeathDays with low co-activation.
 * Returns death count + details for audit logging.
 */
export function pruneDeadConcepts(
  graph: ConceptGraph,
  coActivationCounts: Map<string, number>,
  clock: Clock,
  state?: BrainstemState,
): { count: number; deaths: Array<{ id: string; label: string }> } {
  const now = clock.nowMs();
  const deathThresholdMs = 7 * 86_400_000; // CS6_CONFIG.conceptDeathDays
  let deathCount = 0;
  const deathDetails: Array<{ id: string; label: string }> = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.source !== "structure_learning") continue;
    if (now - node.lastActivated < deathThresholdMs) continue;

    // Check member co-activation support fraction is below threshold
    const children = Object.values(graph.nodes).filter(n => n.parentId === node.id);
    let totalCoAct = 0;
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const key = children[i].id < children[j].id
          ? `${children[i].id}|${children[j].id}`
          : `${children[j].id}|${children[i].id}`;
        totalCoAct += coActivationCounts.get(key) ?? 0;
      }
    }
    // Convert to support fraction: co-act count relative to total tracked ticks
    const totalTicks = Math.max(1, [...coActivationCounts.values()].reduce((s, v) => s + v, 0) / Math.max(1, coActivationCounts.size));
    const supportFraction = totalTicks > 0 ? totalCoAct / totalTicks : 0;

    if (supportFraction < 0.05) {
      // Prune
      deathDetails.push({ id: node.id, label: node.label });
      for (const child of children) {
        child.parentId = null;
      }
      delete graph.nodes[node.id];
      graph.edges = graph.edges.filter(e => e.source !== node.id && e.target !== node.id);
      deathCount++;
      log.info(`concept death: "${node.label}"`);
    }
  }

  if (state) {
    state.conceptDeathsToday = (state.conceptDeathsToday ?? 0) + deathCount;
  }
  return { count: deathCount, deaths: deathDetails };
}

/** Find co-activated triplets and create synthetic parent nodes with LLM labels. */
async function synthesizeConcepts(
  graph: ConceptGraph,
  sortedPairs: Array<[string, number]>,
  now: number,
  aliasTable?: AliasTable,
): Promise<number> {
  // Build adjacency from top pairs
  const topN = sortedPairs.slice(0, 30);
  const adj = new Map<string, Set<string>>();
  for (const [pairKey] of topN) {
    const [a, b] = pairKey.split("|");
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  // Find triplets: A-B, A-C, B-C all in top pairs (max 3)
  const groups: Array<string[]> = [];
  const nodes = [...adj.keys()].filter(id => id !== "self" && graph.nodes[id]);
  for (let i = 0; i < nodes.length && groups.length < 3; i++) {
    const neighborsI = adj.get(nodes[i])!;
    for (let j = i + 1; j < nodes.length && groups.length < 3; j++) {
      if (!neighborsI.has(nodes[j])) continue;
      const neighborsJ = adj.get(nodes[j])!;
      for (let k = j + 1; k < nodes.length && groups.length < 3; k++) {
        if (neighborsI.has(nodes[k]) && neighborsJ.has(nodes[k])) {
          groups.push([nodes[i], nodes[j], nodes[k]]);
        }
      }
    }
  }

  // Fallback: if no triplets, use the top pair with count >= 5 (pair-based synthesis)
  if (groups.length === 0 && topN.length > 0) {
    for (const [pairKey, count] of topN) {
      if (count < 5) continue; // need meaningful co-activation
      const [a, b] = pairKey.split("|");
      if (!graph.nodes[a] || !graph.nodes[b]) continue;
      if (a === "self" || b === "self") continue;
      // Skip if already have a shared parent
      const aParent = graph.nodes[a].parentId;
      const bParent = graph.nodes[b].parentId;
      if (aParent && aParent === bParent) continue;
      groups.push([a, b]);
      if (groups.length >= 2) break; // max 2 pair syntheses
    }
  }

  let synthesized = 0;

  for (const members of groups) {
    const parentId = normalizeId(`${members.join("-")}-synth`);
    if (graph.nodes[parentId]) continue; // already synthesized

    const labels = members.map(id => graph.nodes[id]?.label ?? id);

    // LLM-generated label for the synthetic concept
    let label: string;
    try {
      const result = await claudeText({
        label: "brainstem.syntheticLabel",
        system: "Summarize these concepts with a short noun phrase (3-8 words) capturing their shared theme. Output only the phrase.",
        prompt: `Concepts: ${labels.join(", ")}`,
        model: "fast",
        timeoutMs: 8_000,
      });
      const trimmed = result.trim();
      label = (trimmed.length >= 2 && trimmed.length <= 20) ? trimmed : labels.join("·");
    } catch {
      label = labels.join("·");
    }

    // Determine majority domain
    const domainCounts = new Map<ConceptDomain, number>();
    for (const childId of members) {
      const d = graph.nodes[childId]?.domain ?? "general";
      domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
    }
    let synthDomain: ConceptDomain = "meta";
    let maxCount = 0;
    for (const [d, count] of domainCounts) {
      if (count > maxCount) { maxCount = count; synthDomain = d; }
    }
    if (maxCount < 2) synthDomain = "meta"; // no majority → meta

    // Create synthetic parent node
    const parentNode: ConceptNode = {
      id: parentId,
      label,
      activation: 0.1,
      fatigue: 0,
      salience: 0.2,
      uncertainty: 0.1,
      valence: members.reduce((s, id) => s + (graph.nodes[id]?.valence ?? 0), 0) / members.length,
      drive: Math.max(...members.map(id => graph.nodes[id]?.drive ?? 0)),
      inputSatiation: 0,
      lastExternalBoostAt: 0,
      lastActivated: now,
      source: "reflection" as ConceptSource,
      termVector: tokenize(label),
      memoryKeys: [...new Set(members.flatMap(id => graph.nodes[id]?.memoryKeys ?? []))],
      stableSince: 0,
      anchorText: label,
      parentId: null,
      depth: 1, // parent level
      acl: ACL_DEFAULTS.topic,
      knowledgeTier: "stm",
      cumulativeCredit: 0,
      domain: synthDomain,
    };

    graph.nodes[parentId] = parentNode;

    // Set children's parentId and add hierarchy edges
    for (const childId of members) {
      const child = graph.nodes[childId];
      if (child && !child.parentId) {
        child.parentId = parentId;
        addEdge(graph, parentId, childId, "semantic", 0.5);
        // Register parent-child alias: child labels point to parent for broad queries
        if (aliasTable) {
          registerAlias(aliasTable, childId, parentId);
        }
      }
    }

    synthesized++;
    log.info(`concept synthesized: "${label}" from [${labels.join(", ")}]`);
  }

  return synthesized;
}

// ── M3: Anchor drift detection ──────────────────────────────────────

function detectAnchorDrift(graph: ConceptGraph): void {
  for (const node of Object.values(graph.nodes)) {
    if (node.id === "self" || !node.anchorText) continue;

    // Compare termVector against its original source (label), not anchorText.
    // For memory nodes, anchorText is the memory value (e.g., "1993-03-01")
    // while termVector comes from tokenize(id + label) — they're intentionally different.
    const expectedTokens = new Set(tokenize(`${node.id} ${node.label}`));
    const termTokens = new Set(node.termVector);
    if (expectedTokens.size === 0 || termTokens.size === 0) continue;

    // Jaccard similarity
    let intersection = 0;
    for (const t of expectedTokens) {
      if (termTokens.has(t)) intersection++;
    }
    const union = new Set([...expectedTokens, ...termTokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard < 0.3) {
      log.warn(`anchor drift: "${node.label}" (id=${node.id}) Jaccard=${jaccard.toFixed(2)} — termVector diverged from label`);
      // Auto-repair: reset termVector to match current label
      node.termVector = tokenize(`${node.id} ${node.label}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractLabel(key: string, value: string): string {
  // Extract a readable label from a memory key/value
  const parts = key.split(".");
  const lastPart = parts[parts.length - 1] ?? key;

  // Use the key as the label, converted to readable form
  return lastPart
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, c => c);
}

function pruneGraph(graph: ConceptGraph): void {
  // Prune nodes to MAX_NODES
  const nodeIds = Object.keys(graph.nodes);
  if (nodeIds.length > C.maxNodes) {
    const sorted = nodeIds
      .filter(id => id !== "self")
      .map(id => {
        const node = graph.nodes[id];
        const degree = graph.edges.filter(e => e.source === id || e.target === id).length;
        return { id, score: Math.max(node.activation, degree / 10) };
      })
      .sort((a, b) => a.score - b.score);

    const toRemove = sorted.slice(0, nodeIds.length - C.maxNodes);
    for (const { id } of toRemove) {
      delete graph.nodes[id];
      graph.edges = graph.edges.filter(e => e.source !== id && e.target !== id);
    }
  }

  // Prune edges to MAX_EDGES
  if (graph.edges.length > C.maxEdges) {
    graph.edges.sort((a, b) => b.weight - a.weight);
    graph.edges = graph.edges.slice(0, C.maxEdges);
  }
}

// ── State persistence path ───────────────────────────────────────────

export function getStatePath(dataPath: string): string {
  return path.join(dataPath, "brainstem", "state.json");
}

export function getMetricsPath(dataPath: string): string {
  return path.join(dataPath, "brainstem", "metrics.jsonl");
}

export function getAuditPath(dataPath: string): string {
  return path.join(dataPath, "brainstem", "audit.jsonl");
}

export function getReplayLogPath(dataPath: string): string {
  return path.join(dataPath, "brainstem", "controller-replay.jsonl");
}
