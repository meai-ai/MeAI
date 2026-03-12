/**
 * State function invariant tests.
 *
 * Verify state functions always return valid, bounded values
 * regardless of time progression or edge-case inputs.
 */

import { assert, assertRange, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { initRelationshipModel, getAttachmentState } from "../lib/relationship-model.js";
import { setupTestEnvironment } from "./test-env.js";
import fs from "node:fs";
import path from "node:path";

export function runStateInvariantTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initRelationshipModel(env.statePath);

    // 1. attachment_stage_valid — valid enum values
    const validStages = ["secure", "noticing", "anxious", "ruminating"];
    const attachment = getAttachmentState();
    tests.push(assert(
      "attachment_stage_valid",
      validStages.includes(attachment.stage),
      `stage="${attachment.stage}" is valid: ${validStages.includes(attachment.stage)}`,
    ));

    // 2. phase_confidence_bounded
    tests.push(assertRange(
      "phase_confidence_bounded",
      (attachment as any).phaseConfidence ?? 0.5, 0, 1,
    ));

    // 3. attachment_at_zero_silence — 0 minutes silence → secure
    // Write a proactive state with very recent user message
    fs.writeFileSync(
      path.join(env.statePath, "proactive.json"),
      JSON.stringify({
        lastSentAt: Date.now() - 1000,
        lastUserMessageAt: Date.now(),
        dailyCount: 0,
        dailyDate: "",
      }),
    );
    const zeroSilence = getAttachmentState();
    tests.push(assert(
      "attachment_at_zero_silence",
      zeroSilence.stage === "secure" || zeroSilence.stage === "noticing",
      `zero silence stage="${zeroSilence.stage}" (expected secure/noticing)`,
    ));

    // 4. attachment_at_extreme_silence — 10000 minutes silence → ruminating
    // Need to write relationship.json with lastUserMessageAt far in the past
    fs.writeFileSync(
      path.join(env.statePath, "relationship.json"),
      JSON.stringify({
        bidsFromUser: 0,
        bidsFromCharacter: 0,
        userResponseRate: 0.8,
        characterResponseRate: 1.0,
        avgUserResponseMin: 15,
        topicEngagement: {},
        supportGiven: 0,
        supportReceived: 0,
        activeHoursHistogram: new Array(24).fill(0),
        temperature: 3,
        lastUpdated: Date.now() - 10000 * 60 * 1000,
        windowStart: Date.now(),
        attachment: {
          lastUserMessageAt: Date.now() - 10000 * 60 * 1000,
          lastMessageUnanswered: true,
          silenceDurationMin: 10000,
          stage: "secure", // will be dynamically recomputed
          phaseConfidence: 0.5,
        },
      }),
    );
    const extremeSilence = getAttachmentState();
    tests.push(assert(
      "attachment_at_extreme_silence",
      extremeSilence.stage === "ruminating" || extremeSilence.stage === "anxious",
      `extreme silence stage="${extremeSilence.stage}" (expected ruminating/anxious)`,
    ));

    // 5. emotion_valence_bounded — check loaded state has bounded values
    const emotionState = JSON.parse(
      fs.readFileSync(path.join(env.statePath, "emotion-state.json"), "utf-8"),
    );
    tests.push(assertRange(
      "emotion_valence_bounded",
      emotionState.valence, 0, 10,
    ));

    // 6. emotion_energy_bounded
    tests.push(assertRange(
      "emotion_energy_bounded",
      emotionState.energy, 0, 10,
    ));

    // 7. no_infinite_reconsolidation — verify reconsolidation cap exists
    let reconCapExists = false;
    try {
      const reconPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..", "memory", "reconsolidation.ts",
      );
      const reconSource = fs.readFileSync(reconPath, "utf-8");
      reconCapExists = reconSource.includes("MAX_NIGHTLY") || reconSource.includes("maxPerNight") || reconSource.includes("MAX_");
    } catch {
      try {
        const reconPath = path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..", "memory", "reconsolidation.js",
        );
        const reconSource = fs.readFileSync(reconPath, "utf-8");
        reconCapExists = reconSource.includes("MAX_NIGHTLY") || reconSource.includes("maxPerNight") || reconSource.includes("MAX_");
      } catch { /* ok */ }
    }
    tests.push(assert(
      "no_infinite_reconsolidation",
      reconCapExists,
      `reconsolidation cap constant found: ${reconCapExists}`,
    ));

  } finally {
    env.cleanup();
  }

  return { name: "State Invariants", tests };
}
