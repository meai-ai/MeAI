/**
 * Token estimation and budget enforcement.
 *
 * Uses character-based heuristics:
 * - English/ASCII: ~4 chars per token
 * - CJK characters: ~2 chars per token
 */

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u3000-\u303f\uff00-\uffef]/gu;

/**
 * Estimate token count from text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK characters
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches?.length ?? 0;

  // Non-CJK character count
  const nonCjkLength = text.length - cjkCount;

  // CJK: ~2 chars per token, non-CJK: ~4 chars per token
  return Math.ceil(cjkCount / 2 + nonCjkLength / 4);
}

/**
 * Truncate text to fit within a token budget.
 * Returns the truncated text and metadata.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; tokens: number; truncated: boolean } {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) {
    return { text, tokens, truncated: false };
  }

  // Binary search for the right truncation point
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // Back up to last newline for clean truncation
  const truncPoint = text.lastIndexOf("\n", lo);
  const finalPoint = truncPoint > lo * 0.5 ? truncPoint : lo;
  const truncated = text.slice(0, finalPoint) + "\n…(truncated)";

  return {
    text: truncated,
    tokens: estimateTokens(truncated),
    truncated: true,
  };
}
