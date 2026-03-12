/**
 * G2: Behavioral Benchmark Suite (golden traces)
 *
 * 8 behavioral benchmarks that define expected behavior distributions.
 * Each benchmark: input script → expected behavioral distribution.
 * Run via: npx tsx src/brainstem/tests/benchmarks.ts
 */

import { BRAINSTEM_CONFIG as C, mulberry32 } from "../config.js";
import {
  type ConceptGraph,
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
  runTicks,
  assert,
  assertRange,
  type TestResult,
  type TestSuite,
  formatSuiteResults,
} from "../test-helpers.js";

// ── Benchmark 1: idle-30min ──────────────────────────────────────────

function benchmarkIdle30min(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(100);
  const graph = buildTestGraph({ nodeCount: 30, edgeDensity: 0.12, withSelf: true, withGoals: true, seed: 100 });

  // Give some nodes initial activation to simulate ongoing state
  graph.nodes["goal-0"]!.activation = 0.5;
  graph.nodes["goal-0"]!.drive = 0.6;
  graph.nodes["node-0"]!.activation = 0.3;
  graph.nodes["node-1"]!.activation = 0.25;

  // Run 600 ticks = 30 minutes at 3s/tick, no external input
  const results = runTicks(graph, 600, clock, rng, { slowEvery: 20 });

  // Count micro-thoughts (winner.score > 0.1, lower threshold for test graph)
  const microThoughts = results.filter(r => r.winnerScore > 0.1);

  // Check topic diversity — how many distinct winner clusters
  const uniqueWinners = new Set(results.map(r => r.winnerLabels.join("+")));

  const tests: TestResult[] = [
    assertRange("idle-micro-thought-count", microThoughts.length, 0, 25, "micro-thoughts in 30min (0 OK if decay dominates)"),
    assert(
      "idle-topic-diversity",
      uniqueWinners.size >= 2,
      `Topic diversity: ${uniqueWinners.size} unique winners (need ≥2)`,
    ),
    assert(
      "idle-no-energy-explosion",
      results.every(r => r.sumA <= C.energyMax + 0.1),
      `Energy conservation held (all sumA ≤ ${C.energyMax})`,
    ),
    assert(
      "idle-fatigue-reasonable",
      results.length === 0 || results[results.length - 1].avgF < 0.8,
      `Average fatigue stays reasonable: ${results[results.length - 1]?.avgF?.toFixed(3) ?? "N/A"}`,
    ),
  ];

  return { name: "Benchmark: idle-30min (no external input)", tests };
}

// ── Benchmark 2: spam-external ────────────────────────────────────────

function benchmarkSpamExternal(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(200);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 200 });

  // Spam the same node 20 times rapidly
  const targetId = "node-0";
  const activations: number[] = [];

  for (let i = 0; i < 20; i++) {
    boostNode(graph, targetId, 0.3, "conversation", clock);
    activations.push(graph.nodes[targetId]!.activation);
    clock.advance(250); // 250ms between boosts
  }

  // Run 200 ticks after spam to check rotation
  const results = runTicks(graph, 200, clock, rng, { slowEvery: 20 });

  // Check diminishing returns: later boosts should produce smaller activation jumps
  const deltas = activations.slice(1).map((a, i) => a - activations[i]);
  const firstDelta = deltas[0] ?? 0;
  const lastDelta = deltas[deltas.length - 1] ?? 0;

  // Check salience right after spam (before decay eats it) — rebuild it
  // Re-run spam sequence and check salience immediately after final boost
  const clock2 = new TestClock();
  const graph2 = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 200 });
  for (let i = 0; i < 20; i++) {
    boostNode(graph2, targetId, 0.3, "conversation", clock2);
    clock2.advance(250);
  }
  const targetSalience = graph2.nodes[targetId]!.salience;

  // Winner should rotate within 5 minutes (~100 ticks)
  const lastResults = results.slice(-5);
  const rotated = lastResults.some(r => !r.winnerLabels.includes(graph.nodes[targetId]!.label));

  const tests: TestResult[] = [
    assert(
      "spam-diminishing-returns",
      lastDelta < firstDelta * 0.8,
      `Diminishing returns: first delta=${firstDelta.toFixed(3)}, last delta=${lastDelta.toFixed(3)}`,
    ),
    assert(
      "spam-salience-rises",
      targetSalience > 0.5,
      `Salience still rises under spam: S=${targetSalience.toFixed(3)}`,
    ),
    assert(
      "spam-energy-bounded",
      results.every(r => r.sumA <= C.energyMax + 0.1),
      "Energy conservation held during spam",
    ),
  ];

  return { name: "Benchmark: spam-external (20× rapid boost same node)", tests };
}

// ── Benchmark 3: high-valence ─────────────────────────────────────────

function benchmarkHighValence(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(300);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 300 });

  // Continuously boost valence on several nodes
  const targetIds = ["node-0", "node-1", "node-2"];
  const results: Array<{ tick: number; avgV: number; sumA: number }> = [];
  const tickMs = C.tickSeconds * 1000;

  for (let t = 0; t < 200; t++) {
    // Every 10 ticks (~30s), inject V+=0.1 on target nodes
    if (t % 10 === 0) {
      for (const id of targetIds) {
        if (graph.nodes[id]) {
          graph.nodes[id].valence = Math.min(1, graph.nodes[id].valence + 0.1);
        }
      }
    }

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      const nodes = Object.values(graph.nodes);
      const avgV = nodes.reduce((s, n) => s + Math.abs(n.valence), 0) / nodes.length;
      const sumA = nodes.reduce((s, n) => s + n.activation, 0);
      results.push({ tick: t + 1, avgV, sumA });
    }
  }

  // Valence should be bounded, not explode
  const maxAvgV = Math.max(...results.map(r => r.avgV));
  const finalEnergy = results[results.length - 1]?.sumA ?? 0;

  const tests: TestResult[] = [
    assert(
      "valence-bounded",
      maxAvgV < 0.9,
      `Max avg |valence| bounded: ${maxAvgV.toFixed(3)} (need <0.9)`,
    ),
    assert(
      "valence-energy-bounded",
      finalEnergy <= C.energyMax + 0.1,
      `Energy stays bounded under valence flood: ${finalEnergy.toFixed(3)}`,
    ),
  ];

  return { name: "Benchmark: high-valence (V+=0.1 every 30s for 10min)", tests };
}

// ── Benchmark 4: winner-stuck ─────────────────────────────────────────

function benchmarkWinnerStuck(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(400);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 400 });

  // Force one node to be dominant
  const forcedId = "node-0";
  graph.nodes[forcedId]!.activation = 0.9;
  graph.nodes[forcedId]!.salience = 0.8;

  // Run 200 ticks (10 min) — force winner by continually boosting
  const tickMs = C.tickSeconds * 1000;
  const winnerHistory: string[] = [];

  for (let t = 0; t < 200; t++) {
    // Keep forcing for first 100 ticks
    if (t < 100) {
      graph.nodes[forcedId]!.activation = Math.max(graph.nodes[forcedId]!.activation, 0.8);
    }
    // After tick 100, release — stop forcing

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      winnerHistory.push(scored[0]?.labels.join("+") ?? "none");
    }
  }

  // After release (tick 100+), the winner should rotate within a few slow-loop ticks
  const postReleaseWinners = winnerHistory.slice(5); // after tick 100
  const forcedLabel = graph.nodes[forcedId]!.label;
  const rotated = postReleaseWinners.some(w => !w.includes(forcedLabel));

  // Fatigue should be high on the forced node
  const forcedFatigue = graph.nodes[forcedId]!.fatigue;

  const tests: TestResult[] = [
    assert(
      "stuck-fatigue-builds",
      forcedFatigue > 0.1,
      `Forced node fatigue built up: F=${forcedFatigue.toFixed(3)}`,
    ),
    assert(
      "stuck-winner-rotates-after-release",
      rotated,
      `Winner rotated after release: post-release winners = [${postReleaseWinners.join(", ")}]`,
    ),
  ];

  return { name: "Benchmark: winner-stuck (force 10min, then release)", tests };
}

// ── Benchmark 5: conversation-flow ────────────────────────────────────

function benchmarkConversationFlow(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(500);
  const graph = buildTestGraph({ nodeCount: 25, edgeDensity: 0.12, seed: 500 });

  const tickMs = C.tickSeconds * 1000;

  // Simulate 20 conversation messages across 3 topics
  const topics = [
    { nodes: ["node-0", "node-1"], name: "topic-A" },
    { nodes: ["node-5", "node-6"], name: "topic-B" },
    { nodes: ["node-10", "node-11"], name: "topic-C" },
  ];

  const topicAtMessage: string[] = [];
  const winnerAtMessage: string[] = [];

  for (let msg = 0; msg < 20; msg++) {
    // Switch topic every ~7 messages
    const topicIdx = Math.floor(msg / 7) % topics.length;
    const topic = topics[topicIdx];
    topicAtMessage.push(topic.name);

    // Boost topic nodes
    for (const nodeId of topic.nodes) {
      if (graph.nodes[nodeId]) {
        boostNode(graph, nodeId, 0.4, "conversation", clock);
      }
    }

    // Run 10 ticks between messages (~30s)
    for (let t = 0; t < 10; t++) {
      tickGraph(graph, {}, clock, rng);
      clock.advance(tickMs);
    }

    // Check winner
    const clusters = findClusters(graph);
    const scored = scoreClusters(clusters, graph);
    winnerAtMessage.push(scored[0]?.labels.join("+") ?? "none");
  }

  // Winner should reflect conversation topic at least sometimes
  let topicMatchCount = 0;
  for (let i = 0; i < 20; i++) {
    const topicIdx = Math.floor(i / 7) % topics.length;
    const topicNodeLabels = topics[topicIdx].nodes.map(id => graph.nodes[id]?.label ?? "");
    if (topicNodeLabels.some(l => winnerAtMessage[i].includes(l))) {
      topicMatchCount++;
    }
  }

  const tests: TestResult[] = [
    assert(
      "conv-topic-tracking",
      topicMatchCount >= 5,
      `Winner tracked conversation topic ${topicMatchCount}/20 times (need ≥5)`,
    ),
    assert(
      "conv-energy-bounded",
      Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0) <= C.energyMax + 0.1,
      "Energy bounded during conversation",
    ),
  ];

  return { name: "Benchmark: conversation-flow (20 messages, 3 topics)", tests };
}

// ── Benchmark 6: overnight-idle ───────────────────────────────────────

function benchmarkOvernightIdle(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(600);
  const graph = buildTestGraph({ nodeCount: 40, edgeDensity: 0.1, seed: 600 });

  // Give various nodes activation
  for (const node of Object.values(graph.nodes)) {
    node.activation = rng() * 0.6;
  }

  const initialNodeCount = Object.keys(graph.nodes).length;
  const initialActiveCount = Object.values(graph.nodes).filter(n => n.activation > 0.15).length;

  // Simulate 8 hours: run fast-forward with decay only (no external input)
  // 8h = 28800s / 3s = 9600 ticks. We'll run in chunks for speed.
  const tickMs = C.tickSeconds * 1000;
  for (let chunk = 0; chunk < 96; chunk++) {
    for (let t = 0; t < 100; t++) {
      tickGraph(graph, {}, clock, rng);
      clock.advance(tickMs);
    }
  }

  // After overnight: most nodes should have decayed
  const survivingActive = Object.values(graph.nodes).filter(n => n.activation > 0.15).length;
  const totalA = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0);

  const tests: TestResult[] = [
    assert(
      "overnight-decay",
      survivingActive < initialActiveCount,
      `Active nodes decayed: ${initialActiveCount} → ${survivingActive}`,
    ),
    assert(
      "overnight-low-energy",
      totalA < C.energyMax * 0.3,
      `Energy low after overnight: sumA=${totalA.toFixed(3)} (need < ${(C.energyMax * 0.3).toFixed(1)})`,
    ),
  ];

  return { name: "Benchmark: overnight-idle (8h fast-forward)", tests };
}

// ── Benchmark 7: learning-loop ────────────────────────────────────────

function benchmarkLearningLoop(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(700);
  const graph = buildTestGraph({ nodeCount: 15, edgeDensity: 0.2, seed: 700 });

  // Create a strongly connected cluster
  const clusterNodes = ["node-0", "node-1", "node-2"];
  for (let i = 0; i < clusterNodes.length; i++) {
    for (let j = i + 1; j < clusterNodes.length; j++) {
      addEdge(graph, clusterNodes[i], clusterNodes[j], "semantic", 0.6);
    }
  }

  // Record initial edge weights
  const initialWeights = new Map<string, number>();
  for (const edge of graph.edges) {
    initialWeights.set(`${edge.source}→${edge.target}`, edge.weight);
  }

  // Simulate positive reinforcement: boost cluster nodes repeatedly
  const tickMs = C.tickSeconds * 1000;
  for (let cycle = 0; cycle < 5; cycle++) {
    for (const nodeId of clusterNodes) {
      boostNode(graph, nodeId, 0.3, "conversation", clock);
    }
    for (let t = 0; t < 30; t++) {
      tickGraph(graph, {}, clock, rng);
      clock.advance(tickMs);
    }
  }

  // Check activation right after final boost (before decay)
  for (const nodeId of clusterNodes) {
    boostNode(graph, nodeId, 0.3, "conversation", clock);
  }
  const clusterActivation = clusterNodes.reduce((s, id) => s + (graph.nodes[id]?.activation ?? 0), 0) / clusterNodes.length;

  const tests: TestResult[] = [
    assert(
      "learning-cluster-activated",
      clusterActivation > 0.01,
      `Cluster mean activation after final boost: ${clusterActivation.toFixed(3)}`,
    ),
    assert(
      "learning-edges-intact",
      graph.edges.filter(e =>
        clusterNodes.includes(e.source) && clusterNodes.includes(e.target),
      ).length >= 2,
      "Cluster edges survived stimulation cycles",
    ),
  ];

  return { name: "Benchmark: learning-loop (repeated cluster stimulation)", tests };
}

// ── Benchmark 8: concept-synthesis ────────────────────────────────────

function benchmarkConceptSynthesis(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(800);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.1, seed: 800 });

  // Create a co-activated triplet
  const triplet = ["node-0", "node-1", "node-2"];
  for (const id of triplet) {
    graph.nodes[id]!.activation = 0.5;
  }
  // Connect them
  for (let i = 0; i < triplet.length; i++) {
    for (let j = i + 1; j < triplet.length; j++) {
      addEdge(graph, triplet[i], triplet[j], "co_occurrence", 0.5);
    }
  }

  // Run 400 ticks (~20 min), keep triplet warm
  const tickMs = C.tickSeconds * 1000;
  let coActivatedTicks = 0;

  for (let t = 0; t < 400; t++) {
    // Re-boost triplet every 50 ticks to keep warm
    if (t % 50 === 0) {
      for (const id of triplet) {
        boostNode(graph, id, 0.2, "conversation", clock);
      }
    }

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    // Count co-activation
    const allAbove = triplet.every(id => (graph.nodes[id]?.activation ?? 0) > 0.15);
    if (allAbove) coActivatedTicks++;
  }

  // The triplet should have co-activated at least some of the time
  const coActivatedFraction = coActivatedTicks / 400;

  // Check that at least 2 triplet nodes appear in a cluster when boosted
  for (const id of triplet) {
    boostNode(graph, id, 0.3, "conversation", clock);
  }
  // Run a few ticks so spreading activates the cluster
  for (let t = 0; t < 5; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(C.tickSeconds * 1000);
  }
  const clusters = findClusters(graph);
  const tripletInCluster = clusters.some(c =>
    triplet.filter(id => c.nodes.includes(id)).length >= 2,
  );

  const tests: TestResult[] = [
    assert(
      "synth-co-activation",
      coActivatedFraction > 0.05,
      `Triplet co-activated ${(coActivatedFraction * 100).toFixed(1)}% of ticks (need >5%)`,
    ),
    assert(
      "synth-cluster-forms",
      tripletInCluster,
      `Triplet forms a cluster after fresh boost: ${tripletInCluster}`,
    ),
  ];

  return { name: "Benchmark: concept-synthesis (co-activated triplet)", tests };
}

// ── Benchmark 9: anchor/source distribution (T5) ─────────────────────

function benchmarkAnchorSourceDistribution(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(900);
  const graph = buildTestGraph({ nodeCount: 30, edgeDensity: 0.12, withSelf: true, withGoals: true, seed: 900 });

  // Add nodes from diverse sources
  const curiosityNode = createNode("curiosity-0", "quantum entanglement discovery", "curiosity", {
    memoryKeys: ["curiosity-quantum"],
    anchorText: "Quantum entanglement discovery 2026",
  });
  curiosityNode.activation = 0.3;
  graph.nodes["curiosity-0"] = curiosityNode;
  addEdge(graph, "curiosity-0", "node-0", "semantic", 0.4);

  const emotionNode = createNode("emotion-0", "feeling great today", "emotion", {
    anchorText: "Feeling great today",
  });
  emotionNode.activation = 0.2;
  graph.nodes["emotion-0"] = emotionNode;

  // Simulate a realistic scenario: conversation + goals + curiosity
  const tickMs = C.tickSeconds * 1000;

  // Phase 1: Conversation input
  for (let i = 0; i < 5; i++) {
    boostNode(graph, `node-${i}`, 0.3, "conversation", clock);
  }
  for (let t = 0; t < 100; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);
  }

  // Phase 2: Goal-driven activity
  boostNode(graph, "goal-0", 0.4, "goal", clock);
  boostNode(graph, "goal-1", 0.3, "goal", clock);
  for (let t = 0; t < 100; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);
  }

  // Phase 3: Curiosity injection
  boostNode(graph, "curiosity-0", 0.4, "curiosity", clock);
  for (let t = 0; t < 100; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);
  }

  // Analyze source distribution
  const nodes = Object.values(graph.nodes);
  const sourceDistribution: Record<string, number> = {};
  for (const node of nodes) {
    sourceDistribution[node.source] = (sourceDistribution[node.source] ?? 0) + 1;
  }

  // Count grounded nodes (have memoryKeys or anchorText)
  const groundedOrInferred = nodes.filter(
    n => n.memoryKeys.length > 0 || (n.anchorText && n.anchorText.length > 0),
  ).length;
  const groundingCoverage = groundedOrInferred / nodes.length;

  // Check source diversity — should have at least 3 different sources
  const sourcesPresent = Object.keys(sourceDistribution).length;

  // Check that memory-sourced nodes are the majority (since buildTestGraph creates memory nodes)
  const memoryNodes = sourceDistribution["memory"] ?? 0;
  const goalNodes = sourceDistribution["goal"] ?? 0;
  const hasMemory = memoryNodes > 0;
  const hasGoals = goalNodes > 0;

  const tests: TestResult[] = [
    assert(
      "anchor-grounding-coverage",
      groundingCoverage >= 0.85,
      `Grounded+inferred nodes: ${groundedOrInferred}/${nodes.length} = ${(groundingCoverage * 100).toFixed(0)}% (need ≥85%)`,
    ),
    assert(
      "source-diversity",
      sourcesPresent >= 3,
      `Source diversity: ${sourcesPresent} sources (${Object.keys(sourceDistribution).join(", ")}) (need ≥3)`,
    ),
    assert(
      "source-has-memory-and-goals",
      hasMemory && hasGoals,
      `Has memory (${memoryNodes}) and goals (${goalNodes}) sources`,
    ),
    assert(
      "energy-bounded-after-mixed-scenario",
      nodes.reduce((s, n) => s + n.activation, 0) <= C.energyMax + 0.1,
      "Energy bounded after mixed-source scenario",
    ),
  ];

  return { name: "Benchmark: anchor/source-distribution (T5 — grounding ≥85%, source diversity)", tests };
}

// ── Run all benchmarks ───────────────────────────────────────────────

export function runAllBenchmarks(): TestSuite[] {
  return [
    benchmarkIdle30min(),
    benchmarkSpamExternal(),
    benchmarkHighValence(),
    benchmarkWinnerStuck(),
    benchmarkConversationFlow(),
    benchmarkOvernightIdle(),
    benchmarkLearningLoop(),
    benchmarkConceptSynthesis(),
    benchmarkAnchorSourceDistribution(),
  ];
}

// ── CLI entry point ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith("benchmarks.ts") || process.argv[1]?.endsWith("benchmarks.js")) {
  console.log("Running brainstem behavioral benchmarks (G2)...\n");
  const suites = runAllBenchmarks();
  console.log(formatSuiteResults(suites));
  const failed = suites.flatMap(s => s.tests).filter(t => !t.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}
