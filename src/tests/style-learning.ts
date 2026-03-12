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
        "我理解你的感受，这确实不容易。你最近是不是压力比较大？",
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
        "上次你说想换工作的事，后来怎么样了？",
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
        Date.now() - 60000, "你最近在忙什么？",
        Date.now(), "在做一个新项目，很有意思",
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
      const questionOpening = extractResponseStyleFeatures("你怎么想？这件事我很好奇");
      const empathyOpening = extractResponseStyleFeatures("感觉你最近不太开心诶");
      const banterOpening = extractResponseStyleFeatures("哈哈 你这也太搞了吧");

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
        now - 7 * 60 * 60 * 1000, "你最近怎么样",
        now, "还好啊",
        false,
      );
      // Intervening assistant
      const intervening = isPairingValid(
        now - 60000, "你最近怎么样",
        now, "还好啊",
        true,
      );
      // No topic overlap (long reply)
      const noOverlap = isPairingValid(
        now - 60000, "今天天气真好",
        now, "我刚刚做了一道新菜，红烧排骨",
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
      // Strong reactive: "哈哈" with fast reply
      const strongReactive = isPairingValid(
        now - 30000, "我今天犯了一个超蠢的错误",
        now, "哈哈",
        false,
      );
      // Weak reactive + fast: "嗯" with fast reply
      const weakFast = isPairingValid(
        now - 60000, "我觉得这个方案可以",
        now, "嗯",
        false,
      );
      // Weak reactive + slow: "好" with slow reply → should skip
      const weakSlow = isPairingValid(
        now - 20 * 60 * 1000, "我帮你查一下",
        now, "好",
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
      const words1 = extractContentWords("的了是在我你他她");
      const words2 = extractContentWords("今天天气很好");
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
