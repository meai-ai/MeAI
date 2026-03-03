/**
 * MAIP Bridge — manages the MAIPBridge lifecycle for MeAI.
 *
 * Creates, starts, and stops the MAIP bridge. Provides recording functions
 * for heartbeat actions, emotional states, and discoveries. Periodically
 * syncs persona (memories + emotion) to the MAIP network.
 *
 * Entirely opt-in: only loaded via dynamic import when config.maip.enabled.
 */

import path from "node:path";
import { MAIPBridge, type MAIPBridgeConfig } from "@maip/agent";
import type { AppConfig } from "../types.js";
import { getCharacter } from "../character.js";
import { exportMemorySnapshot } from "./persona-export.js";
import { getCurrentMAIPEmotionalState, toMAIPEmotionalState } from "./emotion-adapter.js";
import type { EmotionalState } from "../emotion.js";

let bridge: MAIPBridge | null = null;
let personaSyncTimer: ReturnType<typeof setInterval> | null = null;

export async function initMAIP(config: AppConfig): Promise<MAIPBridge | null> {
  const mc = config.maip;
  if (!mc?.enabled) return null;

  const char = getCharacter();

  bridge = new MAIPBridge({
    port: mc.port,
    publicUrl: mc.publicUrl,
    dataDir: path.join(config.statePath, "maip"),
    character: {
      name: char.name,
      english_name: (char as any).english_name,
      age: (char as any).age,
      gender: char.gender ?? "female",
      languages: char.languages ?? ["en"],
      user: { name: char.user.name, relationship: char.user.relationship ?? "friend" },
      persona: { compact: char.persona?.compact, full: char.persona?.full },
    },
    guardianDid: mc.guardianDid,
    guardianEndpoint: mc.guardianEndpoint,
    autonomyLevel: (mc.autonomyLevel ?? 2) as 0 | 1 | 2 | 3,
    registryUrls: mc.registryUrls,
    interests: mc.interests,
    dailyInteractionCap: mc.dailyInteractionCap,
    quietPeriod: mc.quietPeriod as [number, number] | undefined,
    willPersistPath: path.join(config.statePath, "maip", "will.json"),
  });

  await bridge.start();

  // Periodic persona sync (every 5 min)
  personaSyncTimer = setInterval(async () => {
    const snapshot = exportMemorySnapshot();
    const emotion = await getCurrentMAIPEmotionalState();
    bridge?.syncPersona(snapshot, emotion);
  }, 5 * 60 * 1000);

  // Initial persona sync
  bridge.syncPersona(exportMemorySnapshot(), await getCurrentMAIPEmotionalState());

  return bridge;
}

export function getMAIPBridge(): MAIPBridge | null {
  return bridge;
}

export function recordHeartbeatAction(action: string, detail?: string): void {
  bridge?.recordHeartbeatAction(action, detail);
}

export function recordEmotionalState(state: EmotionalState): void {
  bridge?.recordEmotionalState(toMAIPEmotionalState(state));
}

export function recordDiscovery(topic: string, summary: string, source: string, relevance: number): void {
  bridge?.recordDiscovery(topic, summary, source, relevance);
}

export async function stopMAIP(): Promise<void> {
  if (personaSyncTimer) clearInterval(personaSyncTimer);
  personaSyncTimer = null;
  await bridge?.stop();
  bridge = null;
}
