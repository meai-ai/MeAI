/**
 * Prediction Layer (CS1) — generate and validate predictions.
 *
 * Generation: pure heuristic after micro-thought (no LLM).
 * Validation: compare predicted vs actual activation/valence.
 * Feeds prediction error → uncertainty → curiosity.
 */

import { type ConceptGraph, normalizeId, mean } from "./graph.js";
import { BRAINSTEM_CONFIG as C, type Clock } from "./config.js";
import type { PredictionRecord, MicroThoughtRecord } from "./bootstrap.js";
import { getCharacter } from "../character.js";

// ── Generate predictions from micro-thought ──────────────────────────

export function generatePredictions(
  thought: MicroThoughtRecord,
  graph: ConceptGraph,
  clock: Clock,
): PredictionRecord[] {
  const predictions: PredictionRecord[] = [];
  const now = clock.nowMs();
  const userName = (getCharacter().user?.name ?? "user").toLowerCase();

  // Check if any concept involves the user → predict user-related nodes will activate
  const userConcepts = thought.concepts.filter(
    id => id.includes(userName) || (graph.nodes[id]?.label ?? "").toLowerCase().includes(userName),
  );
  if (userConcepts.length > 0) {
    // Find other user-related nodes not in current cluster
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (thought.concepts.includes(id)) continue;
      if (id.includes(userName) || node.label.toLowerCase().includes(userName)) {
        predictions.push({
          id: `pred-${now}-${id}`,
          concept: id,
          expectedActivation: Math.min(1, node.activation + 0.15),
          expectedValence: node.valence,
          generatedAt: now,
          source: "micro_thought",
          resolved: false,
        });
        break; // 1 prediction per thought for user
      }
    }
  }

  // Check if thought involves a goal → predict goal-related nodes will increase S
  const goalGrounding = thought.grounding.find(g => g.type === "goal");
  if (goalGrounding) {
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (thought.concepts.includes(id)) continue;
      if (node.drive > 0.3) {
        predictions.push({
          id: `pred-${now}-${id}`,
          concept: id,
          expectedActivation: Math.min(1, node.activation + 0.1),
          expectedValence: node.valence,
          generatedAt: now,
          source: "goal",
          resolved: false,
        });
        break;
      }
    }
  }

  // Semantic adjacency: predict spreading activation to neighbors
  if (thought.concepts.length > 0) {
    const mainConcept = thought.concepts[0];
    const edges = graph.edges.filter(
      e => (e.source === mainConcept || e.target === mainConcept) && e.weight > 0.3,
    );
    for (const edge of edges.slice(0, 1)) {
      const neighborId = edge.source === mainConcept ? edge.target : edge.source;
      if (thought.concepts.includes(neighborId)) continue;
      const neighbor = graph.nodes[neighborId];
      if (neighbor) {
        predictions.push({
          id: `pred-${now}-${neighborId}`,
          concept: neighborId,
          expectedActivation: Math.min(1, neighbor.activation + 0.08),
          expectedValence: neighbor.valence,
          generatedAt: now,
          source: "memory_pattern",
          resolved: false,
        });
      }
    }
  }

  return predictions.slice(0, 2); // max 2 predictions per thought
}

// ── Validate predictions ─────────────────────────────────────────────

export interface ValidationResult {
  errors: number[];
  epistemicErrors: number[];  // activation prediction errors (learnable)
  pragmaticErrors: number[];  // valence prediction errors (harder to reduce)
  surprises: Array<{ concept: string; error: number }>;
  confirmed: Array<{ concept: string }>;
}

export function validatePredictions(
  predictions: PredictionRecord[],
  graph: ConceptGraph,
  clock: Clock,
): ValidationResult {
  const now = clock.nowMs();
  const errors: number[] = [];
  const epistemicErrors: number[] = [];
  const pragmaticErrors: number[] = [];
  const surprises: Array<{ concept: string; error: number }> = [];
  const confirmed: Array<{ concept: string }> = [];

  for (const pred of predictions) {
    if (pred.resolved) continue;
    // Only validate predictions older than 45s
    if (now - pred.generatedAt < 45_000) continue;

    const node = graph.nodes[pred.concept];
    if (!node) {
      pred.resolved = true;
      continue;
    }

    const epiError = Math.abs(pred.expectedActivation - node.activation);
    const pragError = Math.abs(pred.expectedValence - node.valence);
    const error = epiError + 0.5 * pragError;

    errors.push(error);
    epistemicErrors.push(epiError);
    pragmaticErrors.push(pragError);
    pred.resolved = true;

    if (error > C.predictionSurpriseThreshold) {
      surprises.push({ concept: pred.concept, error });
    } else if (error < C.predictionConfirmThreshold) {
      confirmed.push({ concept: pred.concept });
    }
  }

  return { errors, epistemicErrors, pragmaticErrors, surprises, confirmed };
}

// ── Per-concept prediction error tracking ────────────────────────────

const predictionErrorByNode = new Map<string, number>();

export function updatePredictionErrorForNode(concept: string, error: number): void {
  const current = predictionErrorByNode.get(concept) ?? 0.5;
  predictionErrorByNode.set(concept, current * 0.8 + error * 0.2);
}

export function getPredictionErrorForNode(concept: string): number {
  return predictionErrorByNode.get(concept) ?? 0.5;
}
