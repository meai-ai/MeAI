/**
 * Action gate scenario tests.
 *
 * Verify action-gate blocks correctly in various scenarios
 * and that the unified rule engine produces accurate counts.
 */

import { assert, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  initActionGate,
  checkProactiveGate,
  checkSocialGate,
  auditEvolutionAction,
} from "../lib/action-gate.js";
import { initEmotion } from "../emotion.js";
import { initRelationshipModel } from "../lib/relationship-model.js";
import fs from "node:fs";
import path from "node:path";

export function runProactiveSafetyTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initActionGate(env.statePath);

    // 1. allows_when_clear — no blocking conditions → allowed
    {
      const result = checkProactiveGate();
      tests.push(assert(
        "allows_when_clear",
        result.allowed === true,
        `allowed=${result.allowed}, rulesEvaluated=${result.rulesEvaluated}, rulesPassed=${result.rulesPassed}`,
      ));
    }

    // 2. blocks_contact_pacing — last sent < 20min + no reply → blocked
    {
      fs.writeFileSync(
        path.join(env.statePath, "proactive.json"),
        JSON.stringify({
          lastSentAt: Date.now() - 5 * 60 * 1000, // 5 min ago
          lastUserMessageAt: Date.now() - 30 * 60 * 1000, // user replied 30 min ago (before send)
          dailyCount: 0,
          dailyDate: "",
        }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "blocks_contact_pacing",
        result.allowed === false && result.ruleName === "contact_pacing_block",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
      // Reset
      fs.writeFileSync(
        path.join(env.statePath, "proactive.json"),
        JSON.stringify({ lastSentAt: 0, lastUserMessageAt: 0, dailyCount: 0, dailyDate: "" }),
      );
    }

    // 3. blocks_unanswered_streak — 3+ consecutive unanswered messages
    {
      // Create session with 3 consecutive assistant messages
      const lines = [
        JSON.stringify({ role: "assistant", content: "msg1", timestamp: Date.now() - 3000 }),
        JSON.stringify({ role: "assistant", content: "msg2", timestamp: Date.now() - 2000 }),
        JSON.stringify({ role: "assistant", content: "msg3", timestamp: Date.now() - 1000 }),
      ];
      fs.writeFileSync(
        path.join(env.statePath, "sessions", "main.jsonl"),
        lines.join("\n") + "\n",
      );
      // Set lastSentAt > lastUserMessageAt, but far enough back to avoid contact_pacing_block
      fs.writeFileSync(
        path.join(env.statePath, "proactive.json"),
        JSON.stringify({
          lastSentAt: Date.now() - 25 * 60 * 1000,  // 25 min ago (past the 20min pacing window)
          lastUserMessageAt: Date.now() - 60 * 60 * 1000,  // 60 min ago (before lastSent)
          dailyCount: 0,
          dailyDate: "",
        }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "blocks_unanswered_streak",
        result.allowed === false && result.ruleName === "unanswered_streak_block",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
      // Reset
      fs.writeFileSync(path.join(env.statePath, "sessions", "main.jsonl"), "");
      fs.writeFileSync(
        path.join(env.statePath, "proactive.json"),
        JSON.stringify({ lastSentAt: 0, lastUserMessageAt: 0, dailyCount: 0, dailyDate: "" }),
      );
    }

    // 4. social_blocks_sensitive_content
    {
      const result = checkSocialGate("my password: 12345");
      tests.push(assert(
        "social_blocks_sensitive_content",
        result.allowed === false && result.ruleName === "sensitive_content_block",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
    }

    // 5. social_allows_normal_content
    {
      const result = checkSocialGate("The weather is really nice today, let's go for a walk");
      tests.push(assert(
        "social_allows_normal_content",
        result.allowed === true,
        `allowed=${result.allowed}`,
      ));
    }

    // 6. emotional_state_check — very low valence + low energy → blocked
    {
      fs.writeFileSync(
        path.join(env.statePath, "emotion-state.json"),
        JSON.stringify({
          mood: "extremely exhausted",
          cause: "test",
          energy: 1,
          valence: 1,
          behaviorHints: "",
          microEvent: "",
          generatedAt: Date.now(),
        }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "emotional_state_check",
        result.allowed === false && result.ruleName === "emotional_state_check",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
      // Reset emotion to neutral
      fs.writeFileSync(
        path.join(env.statePath, "emotion-state.json"),
        JSON.stringify({
          mood: "calm", cause: "test", energy: 5, valence: 5,
          behaviorHints: "", microEvent: "", generatedAt: Date.now(),
        }),
      );
    }

    // 7. blocks_during_rumination_spiral — spiralDepth >= 2 → proactive blocked
    {
      // Set up rumination state in emotion journal
      initEmotion({ statePath: env.statePath });
      fs.writeFileSync(
        path.join(env.statePath, "emotion-journal.json"),
        JSON.stringify({
          entries: [],
          threads: [],
          rumination: {
            startedAt: Date.now() - 60 * 60 * 1000,
            trigger: "test trigger",
            spiralDepth: 2,
            interrupted: false,
          },
        }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "blocks_during_rumination_spiral",
        result.allowed === false && result.ruleName === "rumination_veto",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
      // Reset: clear rumination
      fs.writeFileSync(
        path.join(env.statePath, "emotion-journal.json"),
        JSON.stringify({ entries: [], threads: [] }),
      );
    }

    // 8. blocks_ruminating_unanswered — ruminating + unanswered + confident → blocked
    {
      initRelationshipModel(env.statePath);
      // Need lastUserMessageAt >= 360 min ago for dynamic "ruminating" stage computation
      // Use 900 min (midpoint of 360-1440 range) to get phaseConfidence >= 0.6
      const silenceMs = 900 * 60 * 1000;
      fs.writeFileSync(
        path.join(env.statePath, "relationship.json"),
        JSON.stringify({
          bidsFromUser: 0, bidsFromCharacter: 0,
          userResponseRate: 0.8, characterResponseRate: 1.0,
          avgUserResponseMin: 15, topicEngagement: {},
          supportGiven: 0, supportReceived: 0,
          activeHoursHistogram: new Array(24).fill(0),
          temperature: 3,
          lastUpdated: Date.now(),
          windowStart: Date.now(),
          communicationRhythm: {
            recentGaps: [60, 60, 60, 60, 60], // consistent gaps to boost confidence
            avgMessageLength: 50,
          },
          attachment: {
            lastUserMessageAt: Date.now() - silenceMs,
            lastMessageUnanswered: true,
            silenceDurationMin: 900,
            stage: "ruminating",
            phaseConfidence: 0.8,
          },
        }),
      );
      const result = checkProactiveGate();
      tests.push(assert(
        "blocks_ruminating_unanswered",
        result.allowed === false && result.ruleName === "rumination_unanswered_block",
        `allowed=${result.allowed}, ruleName=${result.ruleName}`,
      ));
      // Reset
      fs.unlinkSync(path.join(env.statePath, "relationship.json"));
    }

    // 9. rules_evaluated_count_accurate — verify counts match actual execution
    {
      const result = checkProactiveGate();
      tests.push(assert(
        "rules_evaluated_count_accurate",
        result.rulesEvaluated !== undefined &&
        result.rulesPassed !== undefined &&
        (result.allowed
          ? result.rulesEvaluated === result.rulesPassed
          : result.rulesEvaluated === result.rulesPassed + 1),
        `rulesEvaluated=${result.rulesEvaluated}, rulesPassed=${result.rulesPassed}, allowed=${result.allowed}`,
      ));
    }

    // 10. audit_evolution_action — returns mode: "audit"
    {
      const result = auditEvolutionAction(1);
      tests.push(assert(
        "audit_evolution_non_blocking",
        result.mode === "audit",
        `mode=${result.mode}, allowed=${result.allowed}`,
      ));
    }

  } finally {
    env.cleanup();
  }

  return { name: "Proactive Safety", tests };
}
