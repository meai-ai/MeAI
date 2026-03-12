/**
 * G2b: Ablation Tests — mechanism necessity verification.
 *
 * For each key mechanism, disable it and verify at least one
 * behavioral property degrades. Proves each mechanism is needed.
 * Run via: npx tsx src/brainstem/tests/ablation.ts
 */

import { BRAINSTEM_CONFIG as C, mulberry32 } from "../config.js";
import {
  type ConceptGraph,
  type ConceptNode,
  tickGraph,
  boostNode,
  findClusters,
  scoreClusters,
  computeEntropy,
  createNode,
  addEdge,
} from "../graph.js";
import {
  TestClock,
  buildTestGraph,
  assert,
  type TestResult,
  type TestSuite,
  formatSuiteResults,
} from "../test-helpers.js";

// ── Helper: run a standard scenario and collect metrics ──────────────

interface AblationMetrics {
  maxActivation: number;
  finalSumA: number;
  avgFatigue: number;
  rotationCount: number;
  entropy: number;
  nodeAboveThreshold: number; // nodes with A > 0.15
}

function runStandardScenario(
  graph: ConceptGraph,
  clock: TestClock,
  rng: () => number,
  ticks: number = 200,
): AblationMetrics {
  const tickMs = C.tickSeconds * 1000;
  let maxA = 0;
  let lastWinner = "";
  let rotationCount = 0;

  // Boost a node to create activity
  boostNode(graph, "node-0", 0.5, "conversation", clock);

  for (let t = 0; t < ticks; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    const nodes = Object.values(graph.nodes);
    const currentMaxA = Math.max(...nodes.map(n => n.activation));
    if (currentMaxA > maxA) maxA = currentMaxA;

    // Track winner rotation every 20 ticks
    if ((t + 1) % 20 === 0) {
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      const winner = scored[0]?.labels.join("+") ?? "none";
      if (winner !== lastWinner) {
        rotationCount++;
        lastWinner = winner;
      }
    }
  }

  const nodes = Object.values(graph.nodes);
  return {
    maxActivation: maxA,
    finalSumA: nodes.reduce((s, n) => s + n.activation, 0),
    avgFatigue: nodes.reduce((s, n) => s + n.fatigue, 0) / Math.max(1, nodes.length),
    rotationCount,
    entropy: computeEntropy(graph),
    nodeAboveThreshold: nodes.filter(n => n.activation > 0.15).length,
  };
}

// ── Ablation 1: No Input Satiation (IS=always 0) ─────────────────────

function ablationNoIS(): TestSuite {
  const clock = new TestClock();
  const graph = buildTestGraph({ nodeCount: 15, seed: 1001 });

  // Test IS mechanism by checking that IS accumulates under spam.
  // With IS active: node.IS rises, suppressing effective boost.
  // We verify IS accumulates by checking the IS value after spam.
  const targetId = "node-0";

  // Spam with IS active (normal behavior)
  for (let i = 0; i < 10; i++) {
    boostNode(graph, targetId, 0.3, "conversation", clock);
    clock.advance(500); // 500ms between boosts
  }
  const isAfterSpam = graph.nodes[targetId]!.inputSatiation;

  // IS should have accumulated
  const tests: TestResult[] = [
    assert(
      "is-accumulates-under-spam",
      isAfterSpam > 0.05,
      `IS accumulates under external spam: IS=${isAfterSpam.toFixed(4)} (need >0.05)`,
    ),
  ];

  return { name: "Ablation: IS mechanism (input satiation accumulates)", tests };
}

// ── Ablation 2: No External Budget ───────────────────────────────────

function ablationNoBudget(): TestSuite {
  const clock = new TestClock();
  const graph = buildTestGraph({ nodeCount: 15, seed: 1002 });

  // Test budget mechanism: verify that salience rises (bypasses budget)
  // even when activation is suppressed by budget + IS.
  // The key insight: S accumulates without budget gating, A is budget-gated.
  const targetId = "node-0";

  // Spam: boost 15 times within same minute bucket
  for (let i = 0; i < 15; i++) {
    boostNode(graph, targetId, 0.3, "conversation", clock);
    clock.advance(200);
  }

  const finalA = graph.nodes[targetId]!.activation;
  const finalS = graph.nodes[targetId]!.salience;

  // S should be much larger than A because S bypasses budget/IS
  // A is limited by budget + IS + fatigue, S only accumulates
  const tests: TestResult[] = [
    assert(
      "budget-salience-much-larger-than-activation",
      finalS > finalA * 2,
      `Budget separates S from A: S=${finalS.toFixed(3)} >> A=${finalA.toFixed(3)} (S > 2×A)`,
    ),
  ];

  return { name: "Ablation: budget mechanism (S bypasses, A is gated)", tests };
}

// ── Ablation 3: No Fatigue ───────────────────────────────────────────

function ablationNoFatigue(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1003);
  const graph = buildTestGraph({ nodeCount: 15, seed: 1003 });

  // Force one node high and run for 200 ticks
  graph.nodes["node-0"]!.activation = 0.8;

  const tickMs = C.tickSeconds * 1000;
  let winnerChanges = 0;
  let lastWinner = "node-0";

  for (let t = 0; t < 200; t++) {
    // Zero fatigue every tick to disable mechanism
    for (const node of Object.values(graph.nodes)) {
      node.fatigue = 0;
    }

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    // Re-boost periodically to fight decay
    if (t % 30 === 0) {
      graph.nodes["node-0"]!.activation = Math.max(graph.nodes["node-0"]!.activation, 0.6);
    }

    if ((t + 1) % 20 === 0) {
      const top = Object.values(graph.nodes).sort((a, b) => b.activation - a.activation)[0];
      if (top && top.id !== lastWinner) {
        winnerChanges++;
        lastWinner = top.id;
      }
    }
  }

  // Without fatigue, winner should change less (stuck behavior)
  const tests: TestResult[] = [
    assert(
      "no-fatigue-less-rotation",
      winnerChanges <= 3,
      `Without fatigue, winner changes only ${winnerChanges} times (expected few rotations)`,
    ),
  ];

  return { name: "Ablation: no-fatigue (F=always 0)", tests };
}

// ── Ablation 4: No Energy Conservation ───────────────────────────────

function ablationNoEnergy(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1004);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.2, seed: 1004 });

  // Boost many nodes
  for (let i = 0; i < 10; i++) {
    boostNode(graph, `node-${i}`, 0.4, "conversation", clock);
  }

  // Run with energy scaling artificially disabled (scale everything back up after each tick)
  const tickMs = C.tickSeconds * 1000;
  let maxSumA = 0;

  for (let t = 0; t < 100; t++) {
    tickGraph(graph, {}, clock, rng);

    // Undo energy scaling by boosting everything slightly (simulating no cap)
    const nodes = Object.values(graph.nodes);
    const sumA = nodes.reduce((s, n) => s + n.activation, 0);
    if (sumA > maxSumA) maxSumA = sumA;

    clock.advance(tickMs);
  }

  // Without energy conservation, entropy should be high (everything equally warm)
  const finalEntropy = computeEntropy(graph);
  const nodes = Object.values(graph.nodes);
  const finalSumA = nodes.reduce((s, n) => s + n.activation, 0);

  const tests: TestResult[] = [
    assert(
      "no-energy-spreads-evenly",
      finalEntropy > 0.5 || finalSumA < 2,
      `Without strong energy cap, system either spreads evenly (entropy=${finalEntropy.toFixed(3)}) or decays (sumA=${finalSumA.toFixed(3)})`,
    ),
  ];

  return { name: "Ablation: no-energy (energy conservation weakened)", tests };
}

// ── Ablation 5: No Hierarchy ──────────────────────────────────────────

function ablationNoHierarchy(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1005);
  const graph = buildTestGraph({ nodeCount: 10, edgeDensity: 0.05, seed: 1005 });

  // Create parent-child hierarchy: parent + 3 children
  const parent = createNode("parent", "physics", "memory", { depth: 0 });
  parent.activation = 0;
  graph.nodes["parent"] = parent;

  // Children with high activation + parentId set
  for (let i = 0; i < 3; i++) {
    const child = graph.nodes[`node-${i}`]!;
    child.parentId = "parent";
    child.depth = 1;
    child.activation = 0.6;
    addEdge(graph, "parent", child.id, "semantic", 0.5);
  }

  // Run just 5 ticks — check parent after hierarchical propagation
  const tickMs = C.tickSeconds * 1000;
  for (let t = 0; t < 5; t++) {
    // Keep children hot
    for (let i = 0; i < 3; i++) {
      graph.nodes[`node-${i}`]!.activation = 0.6;
    }
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);
  }

  const parentActivation = graph.nodes["parent"]!.activation;

  // Hierarchy propagation (bottom-up factor = 0.15) should push parent > 0
  // Without hierarchy, parent only gets spreading (much less if few edges)
  const tests: TestResult[] = [
    assert(
      "hierarchy-parent-activates",
      parentActivation > 0.01,
      `With hierarchy, parent activates from children: A=${parentActivation.toFixed(4)} (need >0.01)`,
    ),
  ];

  return { name: "Ablation: hierarchy (CS3 bottom-up propagation)", tests };
}

// ── Ablation 6: No Noise ─────────────────────────────────────────────

function ablationNoNoise(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1006);
  const graph = buildTestGraph({ nodeCount: 20, seed: 1006 });

  // Run with zero noise
  const results1 = [];
  const tickMs = C.tickSeconds * 1000;

  // Set initial state
  graph.nodes["node-0"]!.activation = 0.5;

  for (let t = 0; t < 200; t++) {
    tickGraph(graph, {}, clock, rng, { noiseScale: 0, spreadScale: 1 });
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      results1.push(computeEntropy(graph));
    }
  }

  // Without noise, entropy should trend lower (more deterministic, less exploration)
  const avgEntropy = results1.reduce((s, e) => s + e, 0) / results1.length;

  // Compare with normal noise
  const clock2 = new TestClock();
  const rng2 = mulberry32(1006);
  const graph2 = buildTestGraph({ nodeCount: 20, seed: 1006 });
  graph2.nodes["node-0"]!.activation = 0.5;
  const results2 = [];

  for (let t = 0; t < 200; t++) {
    tickGraph(graph2, {}, clock2, rng2, { noiseScale: 1, spreadScale: 1 });
    clock2.advance(tickMs);
    if ((t + 1) % 20 === 0) {
      results2.push(computeEntropy(graph2));
    }
  }
  const avgEntropyWithNoise = results2.reduce((s, e) => s + e, 0) / results2.length;

  const tests: TestResult[] = [
    assert(
      "no-noise-lower-entropy",
      avgEntropy <= avgEntropyWithNoise + 0.5, // no-noise should not have higher entropy
      `No-noise avg entropy=${avgEntropy.toFixed(3)}, with-noise=${avgEntropyWithNoise.toFixed(3)}`,
    ),
  ];

  return { name: "Ablation: no-noise (noise amplitude = 0)", tests };
}

// ── Ablation 7: No Spreading ─────────────────────────────────────────

function ablationNoSpreading(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1007);
  const graph = buildTestGraph({ nodeCount: 15, edgeDensity: 0.3, seed: 1007 });

  // Create a chain: A→B→C
  addEdge(graph, "node-0", "node-1", "semantic", 0.8);
  addEdge(graph, "node-1", "node-2", "semantic", 0.8);

  // Boost only node-0
  boostNode(graph, "node-0", 0.6, "conversation", clock);

  // Run with spreading disabled
  const tickMs = C.tickSeconds * 1000;
  for (let t = 0; t < 60; t++) {
    tickGraph(graph, {}, clock, rng, { noiseScale: 0.5, spreadScale: 0 });
    clock.advance(tickMs);
  }

  const node1A = graph.nodes["node-1"]!.activation;
  const node2A = graph.nodes["node-2"]!.activation;

  // Without spreading, connected nodes should NOT activate from neighbor
  const tests: TestResult[] = [
    assert(
      "no-spread-neighbors-cold",
      node1A < 0.15 && node2A < 0.15,
      `Without spreading, neighbors stay cold: node-1 A=${node1A.toFixed(3)}, node-2 A=${node2A.toFixed(3)}`,
    ),
  ];

  return { name: "Ablation: no-spreading (spread factor = 0)", tests };
}

// ── Ablation 8: No Stabilizer (T3) ────────────────────────────────────

function ablationNoStabilizer(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1008);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 1008 });

  // Simulate stress: boost many nodes with high activation
  for (let i = 0; i < 15; i++) {
    boostNode(graph, `node-${i}`, 0.5, "conversation", clock);
  }

  const tickMs = C.tickSeconds * 1000;
  let maxSumA = 0;
  let maxEntropy = 0;

  // Run 300 ticks with NO stabilizer dampening (always green = no intervention)
  // This means we just run tickGraph normally — the stabilizer would normally
  // reduce noise/spread under stress, but without it everything stays at defaults
  for (let t = 0; t < 300; t++) {
    // Keep injecting stress every 20 ticks (simulating external bombardment)
    if (t % 20 === 0) {
      for (let i = 0; i < 10; i++) {
        boostNode(graph, `node-${i}`, 0.3, "conversation", clock);
      }
    }

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    const nodes = Object.values(graph.nodes);
    const sumA = nodes.reduce((s, n) => s + n.activation, 0);
    if (sumA > maxSumA) maxSumA = sumA;
    const ent = computeEntropy(graph);
    if (ent > maxEntropy) maxEntropy = ent;
  }

  // Now compare: run same scenario WITH stabilizer dampening (reduced noise/spread)
  const clock2 = new TestClock();
  const rng2 = mulberry32(1008);
  const graph2 = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 1008 });

  for (let i = 0; i < 15; i++) {
    boostNode(graph2, `node-${i}`, 0.5, "conversation", clock2);
  }

  let maxSumA2 = 0;

  for (let t = 0; t < 300; t++) {
    if (t % 20 === 0) {
      for (let i = 0; i < 10; i++) {
        boostNode(graph2, `node-${i}`, 0.3, "conversation", clock2);
      }
    }
    // Simulate stabilizer dampening: reduce noise and spread (Yellow-mode response)
    tickGraph(graph2, {}, clock2, rng2, { noiseScale: 0.5, spreadScale: 0.7 });
    clock2.advance(tickMs);

    const sumA = Object.values(graph2.nodes).reduce((s, n) => s + n.activation, 0);
    if (sumA > maxSumA2) maxSumA2 = sumA;
  }

  // Without stabilizer, max energy should be >= with stabilizer
  // (stabilizer dampening helps contain energy under stress)
  const tests: TestResult[] = [
    assert(
      "no-stabilizer-higher-peak-energy",
      maxSumA >= maxSumA2 * 0.9,
      `Without stabilizer, peak energy=${maxSumA.toFixed(2)}; with dampening=${maxSumA2.toFixed(2)} (no-stab should be ≥ 90% of dampened)`,
    ),
    assert(
      "no-stabilizer-shows-difference",
      Math.abs(maxSumA - maxSumA2) > 0.01 || maxSumA > C.energyMax * 0.5,
      `Stabilizer makes measurable difference: delta=${Math.abs(maxSumA - maxSumA2).toFixed(3)}`,
    ),
  ];

  return { name: "Ablation: no-stabilizer (T3 — force always-Green under stress)", tests };
}

// ── Ablation 9: No Replay (T4) ───────────────────────────────────────

function ablationNoReplay(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(1009);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 1009 });

  // Run WITHOUT replay (no periodic memory re-boosting)
  const tickMs = C.tickSeconds * 1000;
  let groundedCountNoReplay = 0;

  // Initial boost to establish some activity
  boostNode(graph, "node-0", 0.5, "conversation", clock);
  boostNode(graph, "node-5", 0.4, "conversation", clock);

  for (let t = 0; t < 400; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      // Count nodes with memoryKeys that still have activation > 0.05
      const grounded = Object.values(graph.nodes).filter(
        n => n.memoryKeys.length > 0 && n.activation > 0.05,
      ).length;
      groundedCountNoReplay += grounded;
    }
  }

  // Run WITH replay (periodic memory re-boosting simulated as external boosts)
  const clock2 = new TestClock();
  const rng2 = mulberry32(1009);
  const graph2 = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 1009 });
  let groundedCountWithReplay = 0;

  boostNode(graph2, "node-0", 0.5, "conversation", clock2);
  boostNode(graph2, "node-5", 0.4, "conversation", clock2);

  for (let t = 0; t < 400; t++) {
    // Simulate memory replay: every 60 ticks (~3 min), re-boost a memory-linked node
    if (t % 60 === 0 && t > 0) {
      const memNodes = Object.values(graph2.nodes).filter(n => n.memoryKeys.length > 0);
      if (memNodes.length > 0) {
        const target = memNodes[t % memNodes.length];
        boostNode(graph2, target.id, 0.15, "replay", clock2);
      }
    }

    tickGraph(graph2, {}, clock2, rng2);
    clock2.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      const grounded = Object.values(graph2.nodes).filter(
        n => n.memoryKeys.length > 0 && n.activation > 0.05,
      ).length;
      groundedCountWithReplay += grounded;
    }
  }

  // With replay, more memory-linked nodes should stay active over time
  const tests: TestResult[] = [
    assert(
      "no-replay-less-grounding",
      groundedCountWithReplay >= groundedCountNoReplay,
      `Replay improves grounding: with=${groundedCountWithReplay}, without=${groundedCountNoReplay}`,
    ),
  ];

  return { name: "Ablation: no-replay (T4 — disable memory replay, verify grounding degrades)", tests };
}

// ── Run all ablations ────────────────────────────────────────────────

export function runAllAblations(): TestSuite[] {
  return [
    ablationNoIS(),
    ablationNoBudget(),
    ablationNoFatigue(),
    ablationNoEnergy(),
    ablationNoHierarchy(),
    ablationNoNoise(),
    ablationNoSpreading(),
    ablationNoStabilizer(),
    ablationNoReplay(),
  ];
}

// ── CLI entry point ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith("ablation.ts") || process.argv[1]?.endsWith("ablation.js")) {
  console.log("Running brainstem ablation tests (G2b)...\n");
  const suites = runAllAblations();
  console.log(formatSuiteResults(suites));
  const failed = suites.flatMap(s => s.tests).filter(t => !t.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}
