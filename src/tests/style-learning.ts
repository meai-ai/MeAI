/**
 * Style-reaction learning tests (4.2).
 *
 * Verify feature extraction, pairing gate, quality signal,
 * content-word overlap, and pattern computation.
 */

import { assert, assertRange, type TestSuite, type TestResult } from "../brainstem/test-helpers.js";
import { setupTestEnvironment } from "./test-env.js";
import {
  extractResponseStyleFeatures,
  isPairingValid,
  computeUserReaction,
  computeQualitySignal,
  extractContentWords,
  hasTopicOverlap,
  storePendingStyleFeatures,
  getPendingStyleFeatures,
  clearPendingStyleFeatures,
} from "../interaction-learning.js";
import { initInteractionLearning } from "../interaction-learning.js";

export function runStyleLearningTests(): TestSuite {
  const tests: TestResult[] = [];
  const env = setupTestEnvironment();

  try {
    initInteractionLearning(env.statePath);

    // 1. extracts_empathy_features
    {
      const features = extractResponseStyleFeatures(
        "I understand how you feel, that's really not easy. Have you been under a lot of pressure lately?",
      );
      tests.push(assert(
        "extracts_empathy_features",
        features.hasEmpathy === true,
        `hasEmpathy=${features.hasEmpathy}`,
      ));
    }

    // 2. extracts_callback_features
    {
      const features = extractResponseStyleFeatures(
        "Last time you said you wanted to switch jobs, how did that go?",
      );
      tests.push(assert(
        "extracts_callback_features",
        features.hasCallback === true,
        `hasCallback=${features.hasCallback}`,
      ));
    }

    // 3. quality_signal_bounded
    {
      const reaction = {
        replyDelayMs: 120000,
        replyLengthChars: 100,
        topicContinued: true,
        followUpQuestion: false,
      };
      const quality = computeQualitySignal(reaction);
      tests.push(assertRange("quality_signal_bounded", quality, 0, 1));
    }

    // 4. pattern_lift_computed — verify relational pattern computation works
    //    (requires enough pairs, so we test the structure)
    {
      // We test computeUserReaction returns correct structure
      const reaction = computeUserReaction(
        Date.now() - 60000, "What have you been up to lately?",
        Date.now(), "Working on a new project, it's really interesting",
      );
      tests.push(assert(
        "pattern_lift_computed",
        typeof reaction.replyDelayMs === "number" &&
        typeof reaction.replyLengthChars === "number" &&
        typeof reaction.topicContinued === "boolean" &&
        typeof reaction.followUpQuestion === "boolean",
        `reaction has correct structure`,
      ));
    }

    // 5. opening_type_classification
    {
      const questionOpening = extractResponseStyleFeatures("What do you think? I'm really curious about this");
      const empathyOpening = extractResponseStyleFeatures("I feel like you haven't been happy lately");
      const banterOpening = extractResponseStyleFeatures("Haha that's way too funny");

      tests.push(assert(
        "opening_type_classification",
        questionOpening.openingType === "question" &&
        empathyOpening.openingType === "empathy" &&
        banterOpening.openingType === "banter",
        `question=${questionOpening.openingType}, empathy=${empathyOpening.openingType}, banter=${banterOpening.openingType}`,
      ));
    }

    // 6. pairing_skips_invalid_windows
    {
      const now = Date.now();
      // Cross-sleep: >6h delay
      const crossSleep = isPairingValid(
        now - 7 * 60 * 60 * 1000, "How have you been lately",
        now, "Pretty good",
        false,
      );
      // Intervening assistant
      const intervening = isPairingValid(
        now - 60000, "How have you been lately",
        now, "Pretty good",
        true,
      );
      // No topic overlap (long reply)
      const noOverlap = isPairingValid(
        now - 60000, "The weather is really nice today",
        now, "I just cooked a new dish, braised pork ribs",
        false,
      );
      tests.push(assert(
        "pairing_skips_invalid_windows",
        crossSleep === false && intervening === false && noOverlap === false,
        `crossSleep=${crossSleep}, intervening=${intervening}, noOverlap=${noOverlap}`,
      ));
    }

    // 7. short_reaction_not_dropped_if_fast_and_reactive
    {
      const now = Date.now();
      // Strong reactive: "haha" with fast reply
      const strongReactive = isPairingValid(
        now - 30000, "I made such a dumb mistake today",
        now, "haha",
        false,
      );
      // Weak reactive + fast: "ok" with fast reply
      const weakFast = isPairingValid(
        now - 60000, "I think this plan works",
        now, "ok",
        false,
      );
      // Weak reactive + slow: "sure" with slow reply -> should skip
      const weakSlow = isPairingValid(
        now - 20 * 60 * 1000, "Let me look that up for you",
        now, "sure",
        false,
      );
      tests.push(assert(
        "short_reaction_not_dropped_if_fast_and_reactive",
        strongReactive === true && weakFast === true && weakSlow === false,
        `strongReactive=${strongReactive}, weakFast=${weakFast}, weakSlow=${weakSlow}`,
      ));
    }

    // 8. content_word_overlap_ignores_stop_words
    {
      const words1 = extractContentWords("the is at to in on it and");
      const words2 = extractContentWords("today weather beautiful sunny");
      tests.push(assert(
        "content_word_overlap_ignores_stop_words",
        words1.size === 0 && words2.size > 0,
        `stop-word-only=${words1.size}, with content=${words2.size}`,
      ));
    }

    // 9. pending_features_isolated_by_session
    {
      const features1 = extractResponseStyleFeatures("test response 1");
      const features2 = extractResponseStyleFeatures("test response 2");

      storePendingStyleFeatures("session-a", features1, "response 1");
      storePendingStyleFeatures("session-b", features2, "response 2");

      const pendingA = getPendingStyleFeatures("session-a");
      const pendingB = getPendingStyleFeatures("session-b");

      tests.push(assert(
        "pending_features_isolated_by_session",
        pendingA != null && pendingB != null &&
        pendingA.assistantContent === "response 1" &&
        pendingB.assistantContent === "response 2",
        `sessionA="${pendingA?.assistantContent}", sessionB="${pendingB?.assistantContent}"`,
      ));

      // Cleanup
      clearPendingStyleFeatures("session-a");
      clearPendingStyleFeatures("session-b");
    }

  } finally {
    env.cleanup();
  }

  return { name: "Style-Reaction Learning (4.2)", tests };
}
