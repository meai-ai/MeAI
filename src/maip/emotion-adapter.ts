/**
 * Emotion Adapter — maps MeAI's EmotionalState to MeAIEmotionalState.
 *
 * MeAI's EmotionalState is a superset (has optional defenseMechanism).
 * We pass through the shared fields only.
 */

import type { MeAIEmotionalState } from "@maip/agent";
import { getEmotionalState, type EmotionalState } from "../emotion.js";

export function toMAIPEmotionalState(state: EmotionalState): MeAIEmotionalState {
  return {
    mood: state.mood,
    cause: state.cause,
    energy: state.energy,
    valence: state.valence,
    behaviorHints: state.behaviorHints,
    microEvent: state.microEvent,
    generatedAt: state.generatedAt,
  };
}

export async function getCurrentMAIPEmotionalState(): Promise<MeAIEmotionalState | null> {
  try {
    return toMAIPEmotionalState(await getEmotionalState());
  } catch {
    return null;
  }
}
