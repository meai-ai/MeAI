/**
 * Dynamic context block selection — keyword-scored relevance filtering.
 *
 * Each context source (market, body, schedule, etc.) becomes a typed block
 * with trigger keywords. Only blocks relevant to recent conversation are
 * included in the system prompt, reducing token waste on irrelevant context.
 *
 * Zero LLM calls — pure keyword set intersection using the existing tokenizer.
 */

import { tokenize } from "../memory/search.js";
import type { ContextAdjustments } from "./context-eval.js";

export interface ContextBlock {
  id: string;
  text: string;               // the rendered content
  keywords: string[];          // trigger words (Chinese + English)
  alwaysInclude: boolean;      // skip relevance scoring
  priority: number;            // tiebreaker (lower = higher priority)
}

/**
 * Score blocks against recent conversation and return selected blocks in priority order.
 *
 * Logic:
 * 1. Always include blocks with alwaysInclude=true
 * 2. Score conditional blocks by keyword overlap count
 * 3. Take top maxConditional conditional blocks with score > 0
 * 4. If 0 conditional blocks match, include top 5 by priority as baseline life context
 * 5. Return all selected sorted by priority
 */
export function selectRelevantBlocks(
  blocks: ContextBlock[],
  recentMessages: string[],
  maxConditional = 4,
  adjustments?: ContextAdjustments,
): ContextBlock[] {
  const conversationTokens = new Set(tokenize(recentMessages.join(" ")));

  const alwaysOn: ContextBlock[] = [];
  const conditional: Array<{ block: ContextBlock; score: number; effectivePriority: number }> = [];

  for (const block of blocks) {
    if (!block.text) continue; // skip empty blocks

    if (block.alwaysInclude) {
      alwaysOn.push(block);
      continue;
    }

    // Merge learned keywords from adjustments (don't mutate original block)
    const adj = adjustments?.blocks[block.id];
    const keywords = adj?.addedKeywords?.length
      ? [...block.keywords, ...adj.addedKeywords]
      : block.keywords;
    const effectivePriority = block.priority + (adj?.priorityDelta ?? 0);

    // Score by keyword overlap count
    let score = 0;
    for (const kw of keywords) {
      const kwTokens = tokenize(kw);
      for (const t of kwTokens) {
        if (conversationTokens.has(t)) {
          score++;
          break; // count each keyword at most once
        }
      }
    }

    conditional.push({ block, score, effectivePriority });
  }

  // Select top conditional blocks with score > 0
  const matched = conditional
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.effectivePriority - b.effectivePriority)
    .slice(0, maxConditional)
    .map(c => c.block);

  // Fallback: if no conditional blocks matched, include top 2 by priority
  let selected: ContextBlock[];
  if (matched.length === 0) {
    selected = conditional
      .sort((a, b) => a.effectivePriority - b.effectivePriority)
      .slice(0, 5)
      .map(c => c.block);
  } else {
    selected = matched;
  }

  // Combine always-on + selected conditional, sort by priority
  const all = [...alwaysOn, ...selected];
  all.sort((a, b) => a.priority - b.priority);

  return all;
}
