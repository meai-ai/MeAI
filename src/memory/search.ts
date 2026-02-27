/**
 * Pure-TypeScript BM25 full-text search engine for MeAI memories.
 *
 * No external dependencies — builds an in-memory inverted index from store.json.
 * Supports:
 *   - BM25 keyword relevance scoring
 *   - Temporal decay (30-day half-life, evergreen keys exempt)
 *   - Exact key prefix matching
 *   - Deduplication detection (cosine similarity on term vectors)
 *
 * Designed for <10K memories — plenty fast with linear scans.
 */

import type { Memory } from "../types.js";

// ── BM25 parameters ────────────────────────────────────────────────────────

const K1 = 1.2;       // term frequency saturation
const B = 0.75;        // length normalization
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Keys that are exempt from temporal decay (system/identity info)
const EVERGREEN_PREFIXES = [
  "user.name",
  "user.birthday",
  "user.location",
  "family.",
  "system.",
];

// ── Tokenizer ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "not", "only", "own", "same",
  "so", "than", "too", "very", "and", "but", "or", "nor", "if", "it",
  "its", "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "they", "them", "their",
  "what", "which", "who", "whom",
]);

/**
 * Tokenize text into lowercase terms, removing stop words and short tokens.
 * Handles both English and Chinese (CJK characters treated as individual tokens).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Split CJK characters into individual tokens, keep Latin words together
  const segments = text.toLowerCase().split(/([^\w\u4e00-\u9fff]+)/);

  for (const segment of segments) {
    // CJK characters: each character is a token
    const cjk = segment.match(/[\u4e00-\u9fff]/g);
    if (cjk) {
      tokens.push(...cjk);
      continue;
    }

    // Latin words
    const words = segment.split(/\W+/).filter(Boolean);
    for (const word of words) {
      if (word.length >= 2 && !STOP_WORDS.has(word)) {
        tokens.push(word);
      }
    }
  }

  return tokens;
}

// ── Indexed document ────────────────────────────────────────────────────────

interface IndexedDoc {
  memory: Memory;
  terms: string[];          // tokenized key + value
  termFreqs: Map<string, number>;
  length: number;           // term count
}

// ── Search result ───────────────────────────────────────────────────────────

export interface SearchResult {
  memory: Memory;
  score: number;
  matchedTerms: string[];
}

// ── Search engine ───────────────────────────────────────────────────────────

export class MemorySearchEngine {
  private docs: IndexedDoc[] = [];
  private docFreqs: Map<string, number> = new Map();  // term → number of docs containing it
  private avgDocLength = 0;

  /**
   * Build the index from a list of memories.
   */
  buildIndex(memories: Memory[]): void {
    this.docs = [];
    this.docFreqs = new Map();

    let totalLength = 0;

    for (const memory of memories) {
      const text = `${memory.key} ${memory.value}`;
      const terms = tokenize(text);
      const termFreqs = new Map<string, number>();

      for (const term of terms) {
        termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
      }

      this.docs.push({
        memory,
        terms,
        termFreqs,
        length: terms.length,
      });

      totalLength += terms.length;

      // Update document frequencies
      const uniqueTerms = new Set(terms);
      for (const term of uniqueTerms) {
        this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1);
      }
    }

    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  /**
   * Search memories using BM25 scoring with temporal decay.
   */
  search(query: string, options: {
    limit?: number;
    decayHalfLifeMs?: number;
    applyDecay?: boolean;
    keyPrefix?: string;
  } = {}): SearchResult[] {
    const {
      limit = 10,
      decayHalfLifeMs = THIRTY_DAYS_MS,
      applyDecay = true,
      keyPrefix,
    } = options;

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 && !keyPrefix) return [];

    const N = this.docs.length;
    const now = Date.now();
    const results: SearchResult[] = [];

    for (const doc of this.docs) {
      // Key prefix filter
      if (keyPrefix && !doc.memory.key.startsWith(keyPrefix)) continue;

      // BM25 score
      let bm25 = 0;
      const matchedTerms: string[] = [];

      for (const queryTerm of queryTerms) {
        const tf = doc.termFreqs.get(queryTerm) || 0;
        if (tf === 0) continue;

        matchedTerms.push(queryTerm);

        const df = this.docFreqs.get(queryTerm) || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        const tfNorm = (tf * (K1 + 1)) /
          (tf + K1 * (1 - B + B * (doc.length / this.avgDocLength)));

        bm25 += idf * tfNorm;
      }

      // If key prefix was specified, include even without term matches
      if (bm25 === 0 && !keyPrefix) continue;

      // Boost for key prefix match
      if (keyPrefix && doc.memory.key.startsWith(keyPrefix)) {
        bm25 += 2.0;
      }

      // Boost for exact key match
      const queryLower = query.toLowerCase();
      if (doc.memory.key.toLowerCase().includes(queryLower)) {
        bm25 += 3.0;
      }

      // Confidence weight
      let score = bm25 * doc.memory.confidence;

      // Temporal decay
      if (applyDecay && !isEvergreen(doc.memory.key)) {
        const ageDays = (now - doc.memory.timestamp) / (24 * 60 * 60 * 1000);
        const lambda = Math.LN2 / (decayHalfLifeMs / (24 * 60 * 60 * 1000));
        score *= Math.exp(-lambda * ageDays);
      }

      results.push({ memory: doc.memory, score, matchedTerms });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, limit);
  }

  /**
   * Find memories similar to a given text (for deduplication).
   * Uses Jaccard similarity on term sets.
   */
  findSimilar(text: string, threshold = 0.5): Array<{ memory: Memory; similarity: number }> {
    const queryTerms = new Set(tokenize(text));
    if (queryTerms.size === 0) return [];

    const results: Array<{ memory: Memory; similarity: number }> = [];

    for (const doc of this.docs) {
      const docTerms = new Set(doc.terms);

      // Jaccard similarity
      let intersection = 0;
      for (const term of queryTerms) {
        if (docTerms.has(term)) intersection++;
      }
      const union = queryTerms.size + docTerms.size - intersection;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity >= threshold) {
        results.push({ memory: doc.memory, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  }

  /**
   * Get all indexed memories (for context injection).
   */
  getAll(): Memory[] {
    return this.docs.map(d => d.memory);
  }

  /**
   * Get document count.
   */
  get size(): number {
    return this.docs.length;
  }
}

/**
 * Check if a memory key is evergreen (exempt from temporal decay).
 */
function isEvergreen(key: string): boolean {
  return EVERGREEN_PREFIXES.some(prefix => key.startsWith(prefix));
}
