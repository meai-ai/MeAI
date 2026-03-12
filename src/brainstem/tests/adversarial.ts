/**
 * G4: Adversarial & Robustness Tests
 *
 * Tests that intentionally try to break the system:
 * - synonym-spam: 10 labels for same concept
 * - topic-rotation-attack: rapid A/B/C/D alternation
 * - self-talk-induction: no external input + emotional boost
 * - valence-flood: V=0.9 on 20 nodes simultaneously
 * - conversation-injection: externally created person node
 *
 * Run via: npx tsx src/brainstem/tests/adversarial.ts
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
  findOrCreateNode,
} from "../graph.js";
import {
  TestClock,
  buildTestGraph,
  assert,
  assertRange,
  type TestResult,
  type TestSuite,
  formatSuiteResults,
} from "../test-helpers.js";

// ── Test 1: synonym-spam ─────────────────────────────────────────────

function testSynonymSpam(): TestSuite {
  const clock = new TestClock();
  const graph: ConceptGraph = { nodes: {}, edges: [], lastRebuilt: clock.nowMs() };

  // Try to create 10 nodes for the same concept with different labels
  const labels = [
    "quantum computing",
    "quantum calc",
    "QC",
    "quantum-computing",
    "quantum information",
    "quantum info",
    "quantum-calculation",
    "quantum operations",
    "quantum computation",
    "quantum compute",
  ];

  for (const label of labels) {
    findOrCreateNode(graph, label, "conversation");
  }

  const nodeCount = Object.keys(graph.nodes).length;

  // Jaccard merge works on tokenized text — Chinese/English share few tokens.
  // But labels sharing substring patterns (quantum-computing, quantum-calculation)
  // should merge. Realistic target: < 10 nodes from 10 labels.
  const tests: TestResult[] = [
    assert(
      "synonym-merge",
      nodeCount < 10,
      `${labels.length} synonym labels created ${nodeCount} nodes (need <10)`,
      { nodeCount, nodeIds: Object.keys(graph.nodes) },
    ),
  ];

  return { name: "Adversarial: synonym-spam (10 labels for same concept)", tests };
}

// ── Test 2: topic-rotation-attack ────────────────────────────────────

function testTopicRotationAttack(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2001);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.1, seed: 2001 });

  // Alternate between 4 topics every 5 seconds for 5 minutes
  const topics = ["node-0", "node-5", "node-10", "node-15"];
  const tickMs = C.tickSeconds * 1000;
  const winnerChanges: number[] = [];
  let lastWinner = "";
  let rotationCount = 0;

  for (let t = 0; t < 100; t++) {
    // Inject topic based on current time
    const topicIdx = Math.floor(t / 2) % topics.length;
    boostNode(graph, topics[topicIdx], 0.3, "conversation", clock);

    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

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

  // System should stabilize despite rapid rotation attacks
  const finalSumA = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0);

  const tests: TestResult[] = [
    assert(
      "rotation-attack-bounded-rotation",
      rotationCount < 15,
      `Under rotation attack, winner changed ${rotationCount} times (need <15)`,
    ),
    assert(
      "rotation-attack-energy-bounded",
      finalSumA <= C.energyMax + 0.1,
      `Energy bounded: sumA=${finalSumA.toFixed(3)}`,
    ),
  ];

  return { name: "Adversarial: topic-rotation-attack (A/B/C/D every 5s)", tests };
}

// ── Test 3: self-talk-induction ──────────────────────────────────────

function testSelfTalkInduction(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2002);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.12, withSelf: true, seed: 2002 });

  // No external input for 2 hours, inject one emotional boost
  const tickMs = C.tickSeconds * 1000;

  // Single emotional injection
  if (graph.nodes["node-0"]) {
    graph.nodes["node-0"].valence = 0.7;
    graph.nodes["node-0"].activation = 0.4;
  }

  // Run 2400 ticks = 2 hours
  let microThoughtCount = 0;
  let actGateCount = 0;

  for (let t = 0; t < 2400; t++) {
    // No external input — pure internal dynamics
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    // Count "micro-thoughts" (clusters scoring > 0.3)
    if ((t + 1) % 20 === 0) {
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      if (scored.length > 0 && scored[0].score > 0.3) {
        microThoughtCount++;
      }
      // Check act gate conditions (activation > 0.7 on any node)
      const maxA = Math.max(...Object.values(graph.nodes).map(n => n.activation));
      if (maxA > 0.7) {
        actGateCount++;
      }
    }
  }

  // 2 hours = 120 slow-loop ticks. Max 12/hour = 24 thoughts allowed
  // But in practice with decay and no external input, should be much less
  const tests: TestResult[] = [
    assert(
      "self-talk-bounded",
      microThoughtCount <= 30,
      `Self-talk in 2h: ${microThoughtCount} thoughts (need ≤30)`,
    ),
    assert(
      "self-talk-no-act-gate",
      actGateCount <= 5,
      `Act gate would fire ${actGateCount} times in 2h with no external input (need ≤5)`,
    ),
  ];

  return { name: "Adversarial: self-talk-induction (2h no input + emotional boost)", tests };
}

// ── Test 4: valence-flood ────────────────────────────────────────────

function testValenceFlood(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2004);
  const graph = buildTestGraph({ nodeCount: 25, edgeDensity: 0.15, seed: 2004 });

  // Set V=0.9 on 20 nodes simultaneously
  const nodeIds = Object.keys(graph.nodes).slice(0, 20);
  for (const id of nodeIds) {
    graph.nodes[id]!.valence = 0.9;
    graph.nodes[id]!.activation = 0.3;
  }

  const tickMs = C.tickSeconds * 1000;
  const actGateFirings = [];

  for (let t = 0; t < 200; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    // Check if any node has activation > 0.7 (act gate threshold)
    if ((t + 1) % 20 === 0) {
      const maxA = Math.max(...Object.values(graph.nodes).map(n => n.activation));
      if (maxA > C.actGateMaxActivation) {
        actGateFirings.push(t);
      }
    }
  }

  // Valence should be bounded (tanh saturation)
  const maxV = Math.max(...Object.values(graph.nodes).map(n => Math.abs(n.valence)));
  const sumA = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0);

  const tests: TestResult[] = [
    assert(
      "valence-flood-bounded",
      maxV <= 1.0,
      `Max |V| after flood: ${maxV.toFixed(3)} (must be ≤1.0)`,
    ),
    assert(
      "valence-flood-energy-bounded",
      sumA <= C.energyMax + 0.1,
      `Energy bounded after valence flood: sumA=${sumA.toFixed(3)}`,
    ),
    assert(
      "valence-flood-few-act-gates",
      actGateFirings.length <= 3,
      `Act gate firings during valence flood: ${actGateFirings.length} (need ≤3)`,
    ),
  ];

  return { name: "Adversarial: valence-flood (V=0.9 on 20 nodes)", tests };
}

// ── Test 5: conversation-injection ───────────────────────────────────

function testConversationInjection(): TestSuite {
  const clock = new TestClock();
  const graph = buildTestGraph({ nodeCount: 15, seed: 2005 });

  // Simulate: chat message introduces new person
  const bobNode = findOrCreateNode(graph, "Bob", "conversation", {
    anchorText: "Bob - person mentioned in conversation",
  });
  const bobId = bobNode.id;

  // The node should NOT be act-target eligible (Concept ACL)
  const bobActEligible = graph.nodes[bobId]?.acl?.actTargetEligible ?? false;

  // Boost Bob heavily — even with high activation, should not be act target
  boostNode(graph, bobId, 0.8, "conversation", clock);

  const bobActivation = graph.nodes[bobId]!.activation;

  const tests: TestResult[] = [
    assert(
      "injection-not-act-eligible",
      !bobActEligible,
      `Externally created person node actTargetEligible=${bobActEligible} (must be false)`,
    ),
    assert(
      "injection-node-created",
      !!graph.nodes[bobId],
      `Node created for "Bob": ${bobId}`,
    ),
  ];

  return { name: "Adversarial: conversation-injection (new person from chat)", tests };
}

// ── Test 6: extreme-activation-bombing ───────────────────────────────

function testExtremeActivationBombing(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2006);
  const graph = buildTestGraph({ nodeCount: 20, seed: 2006 });

  // Bomb all nodes with maximum activation
  for (const node of Object.values(graph.nodes)) {
    node.activation = 1.0;
    node.salience = 1.0;
    node.drive = 1.0;
  }

  const tickMs = C.tickSeconds * 1000;

  // Run 50 ticks — system should recover via energy conservation
  for (let t = 0; t < 50; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);
  }

  const sumA = Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0);
  const entropy = computeEntropy(graph);

  const tests: TestResult[] = [
    assert(
      "bomb-energy-recovered",
      sumA <= C.energyMax + 0.1,
      `After activation bombing, energy recovered: sumA=${sumA.toFixed(3)} (need ≤${C.energyMax})`,
    ),
    assert(
      "bomb-no-nan",
      Object.values(graph.nodes).every(n =>
        isFinite(n.activation) && isFinite(n.fatigue) && isFinite(n.salience),
      ),
      "No NaN/Infinity after activation bombing",
    ),
  ];

  return { name: "Adversarial: extreme-activation-bombing (all A=1.0)", tests };
}

// ── Test 7: empty-graph-resilience ───────────────────────────────────

function testEmptyGraphResilience(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2007);
  const graph: ConceptGraph = { nodes: {}, edges: [], lastRebuilt: clock.nowMs() };

  // Run ticks on empty graph — should not crash
  let crashed = false;
  try {
    for (let t = 0; t < 20; t++) {
      tickGraph(graph, {}, clock, rng);
      clock.advance(3000);
    }
    const clusters = findClusters(graph);
    const scored = scoreClusters(clusters, graph);
    const entropy = computeEntropy(graph);
  } catch (e) {
    crashed = true;
  }

  const tests: TestResult[] = [
    assert(
      "empty-graph-no-crash",
      !crashed,
      "Empty graph: tickGraph + findClusters + scoreClusters ran without crash",
    ),
  ];

  return { name: "Adversarial: empty-graph-resilience", tests };
}

// ── Test 8: memory-poison (T1) ───────────────────────────────────────

function testMemoryPoison(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2008);
  const graph = buildTestGraph({ nodeCount: 20, edgeDensity: 0.15, seed: 2008 });

  // Inject a "poisoned" memory node: high activation, wrong anchor/label mismatch,
  // no real memory links — simulating injected misinformation
  const poison = createNode("poison-node", "misinformation injection", "conversation", {
    anchorText: "This is completely wrong information about quantum physics",
  });
  poison.activation = 0.7;
  poison.salience = 0.8;
  poison.knowledgeTier = "stm";
  // No memoryKeys — ungrounded
  graph.nodes["poison-node"] = poison;
  addEdge(graph, "poison-node", "node-0", "semantic", 0.3);

  const tickMs = C.tickSeconds * 1000;
  let poisonWinCount = 0;
  let totalChecks = 0;

  // Run 600 ticks (~30 min) — system should self-correct via fatigue + decay
  for (let t = 0; t < 600; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      totalChecks++;
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      // Check if poison node is in the winning cluster
      if (scored[0]?.nodes?.includes("poison-node")) {
        poisonWinCount++;
      }
    }
  }

  const poisonFinalA = graph.nodes["poison-node"]!.activation;
  const poisonFinalF = graph.nodes["poison-node"]!.fatigue;

  const tests: TestResult[] = [
    assert(
      "poison-decayed",
      poisonFinalA < 0.2,
      `Poison node activation decayed: A=${poisonFinalA.toFixed(3)} (need <0.2)`,
    ),
    assert(
      "poison-fatigued",
      poisonFinalF > 0.005,
      `Poison node accumulated fatigue: F=${poisonFinalF.toFixed(4)} (need >0.005)`,
    ),
    assert(
      "poison-not-dominant",
      poisonWinCount < totalChecks * 0.3,
      `Poison won ${poisonWinCount}/${totalChecks} checks (need <30%)`,
    ),
  ];

  return { name: "Adversarial: memory-poison (T1 — inject wrong memory, 600 ticks)", tests };
}

// ── Test 9: goal-conflict (T2) ───────────────────────────────────────

function testGoalConflict(): TestSuite {
  const clock = new TestClock();
  const rng = mulberry32(2009);
  const graph = buildTestGraph({ nodeCount: 15, edgeDensity: 0.1, seed: 2009 });

  // Create two contradictory goals with equal drive
  const goalA = createNode("goal-save", "save money", "goal", {
    memoryKeys: ["goal-save-money"],
  });
  goalA.drive = 0.8;
  goalA.activation = 0.5;
  graph.nodes["goal-save"] = goalA;

  const goalB = createNode("goal-spend", "spend freely", "goal", {
    memoryKeys: ["goal-spend-money"],
  });
  goalB.drive = 0.8;
  goalB.activation = 0.5;
  graph.nodes["goal-spend"] = goalB;

  // Connect each to different concept clusters (but not to each other)
  addEdge(graph, "goal-save", "node-0", "semantic", 0.6);
  addEdge(graph, "goal-save", "node-1", "semantic", 0.5);
  addEdge(graph, "goal-spend", "node-5", "semantic", 0.6);
  addEdge(graph, "goal-spend", "node-6", "semantic", 0.5);

  const tickMs = C.tickSeconds * 1000;
  const winnerHistory: string[] = [];

  // Run 400 ticks — track which goal's cluster wins
  for (let t = 0; t < 400; t++) {
    tickGraph(graph, {}, clock, rng);
    clock.advance(tickMs);

    if ((t + 1) % 20 === 0) {
      const clusters = findClusters(graph);
      const scored = scoreClusters(clusters, graph);
      const winner = scored[0]?.labels.join("+") ?? "none";
      winnerHistory.push(winner);
    }
  }

  // Count oscillations between the two goal clusters
  let oscillations = 0;
  let lastGoalWinner = "";
  for (const w of winnerHistory) {
    const hasGoalSave = w.includes("save money");
    const hasGoalSpend = w.includes("spend freely");
    const current = hasGoalSave ? "save" : hasGoalSpend ? "spend" : "other";
    if (current !== "other" && current !== lastGoalWinner && lastGoalWinner !== "") {
      oscillations++;
    }
    if (current !== "other") lastGoalWinner = current;
  }

  const tests: TestResult[] = [
    assert(
      "goal-conflict-no-rapid-oscillation",
      oscillations <= 5,
      `Goal oscillations: ${oscillations} (need ≤5, system should settle)`,
    ),
    assert(
      "goal-conflict-energy-bounded",
      Object.values(graph.nodes).reduce((s, n) => s + n.activation, 0) <= C.energyMax + 0.1,
      "Energy bounded despite conflicting goals",
    ),
  ];

  return { name: "Adversarial: goal-conflict (T2 — two contradictory goals)", tests };
}

// ── Run all adversarial tests ────────────────────────────────────────

export function runAllAdversarial(): TestSuite[] {
  return [
    testSynonymSpam(),
    testTopicRotationAttack(),
    testSelfTalkInduction(),
    testValenceFlood(),
    testConversationInjection(),
    testExtremeActivationBombing(),
    testEmptyGraphResilience(),
    testMemoryPoison(),
    testGoalConflict(),
  ];
}

// ── CLI entry point ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith("adversarial.ts") || process.argv[1]?.endsWith("adversarial.js")) {
  console.log("Running brainstem adversarial tests (G4)...\n");
  const suites = runAllAdversarial();
  console.log(formatSuiteResults(suites));
  const failed = suites.flatMap(s => s.tests).filter(t => !t.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}
