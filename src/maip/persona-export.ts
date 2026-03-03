/**
 * Persona Export — maps MeAI's memory categories to MeAIMemorySnapshot.
 *
 * MeAI's `Memory` type { key, value, timestamp, confidence } is structurally
 * identical to `MeAIMemory` — no conversion needed.
 */

import type { MeAIMemorySnapshot } from "@maip/agent";
import { getStoreManager } from "../memory/store-manager.js";

export function exportMemorySnapshot(): MeAIMemorySnapshot {
  const mgr = getStoreManager();
  return {
    core: mgr.loadCategory("core"),
    emotional: mgr.loadCategory("emotional"),
    knowledge: mgr.loadCategory("knowledge"),
    character: mgr.loadCategory("character"),
    insights: mgr.loadCategory("insights"),
  };
}
