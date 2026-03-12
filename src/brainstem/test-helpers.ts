/**
 * Shared test infrastructure for brainstem behavioral, ablation,
 * property-based, and adversarial tests.
 *
 * Provides: deterministic clock, test graph builder, sim runner wrappers,
 * assertion helpers, and result formatting.
 */

import { type Clock, BRAINSTEM_CONFIG as C, mulberry32 } from "./config.js";
import {
  type ConceptGraph,
  type ConceptNode,
  type ConceptEdge,
  type TickForces,
  createNode,
  addEdge,
  tickGraph,
  boostNode,
  findClusters,
  scoreClusters,
  computeEntropy,
  recomputeDrive,
  clampNode,
  type GoalInfo,
} from "./graph.js";

// ── Deterministic Clock ──────────────────────────────────────────────

export class TestClock implements Clock {
  private time: number;
  constructor(startMs: number = Date.now()) {
    this.time = startMs;
  }
  nowMs(): number { return this.time; }
  advance(ms: number): void { this.time += ms; }
  set(ms: number): void { this.time = ms; }
}

// ── Test Graph Builder ───────────────────────────────────────────────

export interface TestGraphOpts {
  nodeCount?: number;
  edgeDensity?: number; // 0-1, fraction of possible edges to create
  withSelf?: boolean;
  withGoals?: boolean;
  seed?: number;
}

export function buildTestGraph(opts: TestGraphOpts = {}): ConceptGraph {
  const {
    nodeCount = 20,
    edgeDensity = 0.15,
    withSelf = true,
    withGoals = false,
    seed = 42,
  } = opts;

  const rng = mulberry32(seed);
  const graph: ConceptGraph = { nodes: {}, edges: [], lastRebuilt: Date.now() };

  // Create nodes
  const nodeIds: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const id = `node-${i}`;
    const label = `concept-${i}`;
    const node = createNode(id, label, "memory", {
      memoryKeys: [`mem-${i}`],
      anchorText: `Concept ${i} anchor text`,
    });
    node.knowledgeTier = "stm";
    // Small initial activation spread
    node.activation = rng() * 0.2;
    graph.nodes[id] = node;
    nodeIds.push(id);
  }

  // Self node
  if (withSelf) {
    const self = createNode("self", "self", "reflection");
    self.activation = 0.5;
    self.fatigue = 0; // self never fatigues
    graph.nodes["self"] = self;
  }

  // Goal-related nodes
  if (withGoals) {
    for (let i = 0; i < 3; i++) {
      const id = `goal-${i}`;
      const node = createNode(id, `goal-${i}`, "goal", {
        memoryKeys: [`goal-mem-${i}`],
      });
      node.drive = 0.3 + rng() * 0.4;
      graph.nodes[id] = node;
      nodeIds.push(id);
    }
  }

  // Create edges
  const allIds = Object.keys(graph.nodes).filter(id => id !== "self");
  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      if (rng() < edgeDensity) {
        addEdge(graph, allIds[i], allIds[j], "semantic", 0.3 + rng() * 0.5);
      }
    }
  }

  return graph;
}

// ── Sim Helpers ──────────────────────────────────────────────────────

export interface TickResult {
  tick: number;
  topNodes: Array<{ id: string; activation: number }>;
  entropy: number;
  sumA: number;
  avgF: number;
  winnerLabels: string[];
  winnerScore: number;
}

/** Run N fast-loop ticks, optionally running slow-loop scoring every slowEvery ticks. */
export function runTicks(
  graph: ConceptGraph,
  ticks: number,
  clock: TestClock,
  rng: () => number,
  opts?: {
    forces?: TickForces;
    slowEvery?: number;
    policyScales?: { noiseScale: number; spreadScale: number };
  },
): TickResult[] {
  const results: TickResult[] = [];
  const tickMs = C.tickSeconds * 1000;
  const slowEvery = opts?.slowEvery ?? 20;
  const forces = opts?.forces ?? {};

  for (let t = 0; t < ticks; t++) {
    tickGraph(graph, forces, clock, rng, opts?.policyScales);
    clock.advance(tickMs);

    if ((t + 1) % slowEvery === 0) {
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      const nodes = Object.values(graph.nodes);
      const sumA = nodes.reduce((s, n) => s + n.activation, 0);
      const avgF = nodes.reduce((s, n) => s + n.fatigue, 0) / Math.max(1, nodes.length);

      results.push({
        tick: t + 1,
        topNodes: nodes
          .sort((a, b) => b.activation - a.activation)
          .slice(0, 5)
          .map(n => ({ id: n.id, activation: n.activation })),
        entropy: computeEntropy(graph),
        sumA,
        avgF,
        winnerLabels: scored[0]?.labels ?? [],
        winnerScore: scored[0]?.score ?? 0,
      });
    }
  }
  return results;
}

// ── Assertion Helpers ────────────────────────────────────────────────

export interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export function assert(
  name: string,
  condition: boolean,
  message: string,
  details?: Record<string, unknown>,
): TestResult {
  return { name, passed: condition, message, details };
}

export function assertRange(
  name: string,
  value: number,
  min: number,
  max: number,
  label?: string,
): TestResult {
  const passed = value >= min && value <= max;
  return {
    name,
    passed,
    message: passed
      ? `${label ?? name}: ${value.toFixed(3)} in [${min}, ${max}]`
      : `${label ?? name}: ${value.toFixed(3)} NOT in [${min}, ${max}]`,
    details: { value, min, max },
  };
}

// ── Suite Runner ─────────────────────────────────────────────────────

export interface TestSuite {
  name: string;
  tests: TestResult[];
}

export function formatSuiteResults(suites: TestSuite[]): string {
  const lines: string[] = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const suite of suites) {
    const passed = suite.tests.filter(t => t.passed).length;
    const failed = suite.tests.filter(t => !t.passed).length;
    totalPassed += passed;
    totalFailed += failed;

    const icon = failed === 0 ? "PASS" : "FAIL";
    lines.push(`\n${icon} ${suite.name} (${passed}/${suite.tests.length})`);
    for (const t of suite.tests) {
      const tIcon = t.passed ? "  [ok]" : "  [FAIL]";
      lines.push(`${tIcon} ${t.message}`);
    }
  }

  lines.push(`\n${"=".repeat(50)}`);
  lines.push(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  return lines.join("\n");
}
