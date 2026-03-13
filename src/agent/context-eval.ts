/**
 * Context block self-evaluation — measures selection quality per turn,
 * detects misses retrospectively, and conservatively adjusts keywords
 * + priorities based on accumulated data.
 *
 * Three time scales:
 *   Per-turn   (~5ms, 0 LLM) — record selection, measure utilization
 *   Inter-turn (~2ms, 0 LLM) — detect missed blocks from previous turn
 *   Periodic   (6h, 1 LLM)   — aggregate stats, discover keywords, tune priorities
 */

import fs from "node:fs";
import path from "node:path";
import { tokenize } from "../memory/search.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import { pstDateStr } from "../lib/pst-date.js";
import { claudeText } from "../claude-runner.js";
import { createLogger } from "../lib/logger.js";
import type { ContextBlock } from "./context-blocks.js";

const log = createLogger("context-eval");

// ── Types ────────────────────────────────────────────────────────────

interface ContextEvalEntry {
  timestamp: number;
  turnId: string;
  userMessage: string;
  allBlockIds: string[];
  selectedBlockIds: string[];
  utilization: Record<string, {
    blockTokens: number;
    overlapScore: number;
    wasted: boolean;
  }>;
  keywordHits: Record<string, string[]>;
}

interface MissAmendment {
  timestamp: number;
  type: "miss_amendment";
  turnId: string;
  missedBlockIds: string[];
  missedKeywordCandidates: string[];
}

export interface ContextAdjustments {
  updatedAt: number;
  lastAnalysisAt: number;
  blocks: Record<string, {
    addedKeywords: string[];
    priorityDelta: number;
    pendingKeywords: Record<string, number>;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

// ── ContextEvalEngine class ──────────────────────────────────────────

export class ContextEvalEngine {
  private evalDir: string;
  private adjustmentsPath: string;
  private previousTurnRecord: ContextEvalEntry | null = null;
  private previousAllBlocks: ContextBlock[] | null = null;

  constructor(statePath: string) {
    this.evalDir = path.join(statePath, "context-eval");
    this.adjustmentsPath = path.join(this.evalDir, "adjustments.json");
    fs.mkdirSync(this.evalDir, { recursive: true });
    log.info("initialized");
  }

  // ── Per-turn: Record selection + measure utilization ───────────────

  recordContextTurn(params: {
    userMessage: string;
    responseText: string;
    allBlocks: ContextBlock[];
    selectedBlocks: ContextBlock[];
  }): void {
    if (!this.evalDir) return;

    const { userMessage, responseText, allBlocks, selectedBlocks } = params;
    const turnId = `t_${Date.now()}`;

    // Tokenize response once
    const responseTokens = new Set(tokenize(responseText));

    // Tokenize user message for keyword hit detection
    const userTokens = new Set(tokenize(userMessage));

    // Compute utilization for each selected conditional block
    const utilization: ContextEvalEntry["utilization"] = {};
    const keywordHits: Record<string, string[]> = {};

    for (const block of selectedBlocks) {
      if (block.alwaysInclude) continue;

      // Overlap: how many block tokens appear in the response
      const blockTokens = tokenize(block.text);
      const blockTokenCount = blockTokens.length;
      if (blockTokenCount === 0) continue;

      let overlapCount = 0;
      for (const t of blockTokens) {
        if (responseTokens.has(t)) overlapCount++;
      }
      const overlapScore = overlapCount / blockTokenCount;

      utilization[block.id] = {
        blockTokens: blockTokenCount,
        overlapScore: Math.round(overlapScore * 1000) / 1000,
        wasted: overlapScore < 0.05,
      };

      // Record which keywords triggered this block
      const hits: string[] = [];
      for (const kw of block.keywords) {
        const kwTokens = tokenize(kw);
        for (const t of kwTokens) {
          if (userTokens.has(t)) {
            hits.push(kw);
            break;
          }
        }
      }
      if (hits.length > 0) {
        keywordHits[block.id] = hits;
      }
    }

    const entry: ContextEvalEntry = {
      timestamp: Date.now(),
      turnId,
      userMessage: userMessage.slice(0, 200),
      allBlockIds: allBlocks.map(b => b.id),
      selectedBlockIds: selectedBlocks.map(b => b.id),
      utilization,
      keywordHits,
    };

    // Store for inter-turn miss detection
    this.previousTurnRecord = entry;
    this.previousAllBlocks = allBlocks;

    // Append to today's JSONL
    this.appendJsonl(entry);
  }

  // ── Inter-turn: Detect misses from previous turn ──────────────────

  evaluatePreviousTurn(currentUserMessage: string): void {
    if (!this.evalDir || !this.previousTurnRecord || !this.previousAllBlocks) return;

    const currentTokens = new Set(tokenize(currentUserMessage));
    const selectedSet = new Set(this.previousTurnRecord.selectedBlockIds);

    const missedBlockIds: string[] = [];
    const missedKeywordCandidates: string[] = [];

    for (const block of this.previousAllBlocks) {
      if (block.alwaysInclude) continue;
      if (selectedSet.has(block.id)) continue;

      // Check if current user message mentions this block's keywords
      let matched = false;
      for (const kw of block.keywords) {
        const kwTokens = tokenize(kw);
        for (const t of kwTokens) {
          if (currentTokens.has(t)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }

      if (matched) {
        missedBlockIds.push(block.id);

        // Candidate keywords: tokens from current message that relate to this block
        // (i.e., user words that we should have used to trigger this block last turn)
        const candidates = [...currentTokens].filter(t => t.length >= 2);
        missedKeywordCandidates.push(...candidates);
      }
    }

    if (missedBlockIds.length === 0) return;

    // Increment pending keyword counts in adjustments
    const adj = this.loadAdjustments();
    let promoted = false;

    for (const blockId of missedBlockIds) {
      if (!adj.blocks[blockId]) {
        adj.blocks[blockId] = { addedKeywords: [], priorityDelta: 0, pendingKeywords: {} };
      }
      const blockAdj = adj.blocks[blockId];

      // Dedupe candidates: only add tokens not already in original keywords or addedKeywords
      const originalBlock = this.previousAllBlocks!.find(b => b.id === blockId);
      const existingKeywords = new Set([
        ...(originalBlock?.keywords ?? []).flatMap(kw => tokenize(kw)),
        ...blockAdj.addedKeywords.flatMap(kw => tokenize(kw)),
      ]);

      for (const candidate of missedKeywordCandidates) {
        if (existingKeywords.has(candidate)) continue;

        blockAdj.pendingKeywords[candidate] = (blockAdj.pendingKeywords[candidate] ?? 0) + 1;

        // Immediate promotion: if count reaches >= 3, promote to addedKeywords
        if (blockAdj.pendingKeywords[candidate] >= 3) {
          blockAdj.addedKeywords.push(candidate);
          delete blockAdj.pendingKeywords[candidate];
          promoted = true;
          log.info(`promoted keyword "${candidate}" for block "${blockId}"`);
        }
      }
    }

    // Save adjustments (promotion takes effect this turn)
    adj.updatedAt = Date.now();
    writeJsonAtomic(this.adjustmentsPath, adj);

    if (promoted) {
      log.info("keywords promoted — will affect this turn's block selection");
    }

    // Record miss amendment
    const amendment: MissAmendment = {
      timestamp: Date.now(),
      type: "miss_amendment",
      turnId: this.previousTurnRecord.turnId,
      missedBlockIds,
      missedKeywordCandidates: [...new Set(missedKeywordCandidates)].slice(0, 20),
    };
    this.appendJsonl(amendment);

    log.info(`miss detected: blocks [${missedBlockIds.join(", ")}] were not selected last turn`);
  }

  // ── Load adjustments ──────────────────────────────────────────────

  loadAdjustments(): ContextAdjustments {
    if (!this.adjustmentsPath) return { updatedAt: 0, lastAnalysisAt: 0, blocks: {} };
    return readJsonSafe<ContextAdjustments>(this.adjustmentsPath, {
      updatedAt: 0,
      lastAnalysisAt: 0,
      blocks: {},
    });
  }

  // ── Periodic: Aggregate stats + LLM keyword discovery (6h) ────────

  async runContextAnalysis(): Promise<void> {
    if (!this.evalDir) return;

    const adj = this.loadAdjustments();
    if (Date.now() - adj.lastAnalysisAt < SIX_HOURS_MS) {
      log.info("skipping analysis — last run was < 6h ago");
      return;
    }

    // Read today's JSONL entries
    const today = pstDateStr();
    const logFile = path.join(this.evalDir, `${today}.jsonl`);
    if (!fs.existsSync(logFile)) {
      log.info("no eval data for today, skipping analysis");
      adj.lastAnalysisAt = Date.now();
      writeJsonAtomic(this.adjustmentsPath, adj);
      return;
    }

    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    const entries: ContextEvalEntry[] = [];
    const misses: MissAmendment[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "miss_amendment") {
          misses.push(parsed as MissAmendment);
        } else if (parsed.turnId) {
          entries.push(parsed as ContextEvalEntry);
        }
      } catch { /* skip malformed lines */ }
    }

    if (entries.length < 5) {
      log.info(`only ${entries.length} entries today, need ≥5 for analysis`);
      adj.lastAnalysisAt = Date.now();
      writeJsonAtomic(this.adjustmentsPath, adj);
      return;
    }

    // Aggregate per-block stats
    const stats: Record<string, {
      selections: number;
      totalUtilization: number;
      wasteCount: number;
      missCount: number;
    }> = {};

    // Collect all block IDs seen
    const allBlockIds = new Set<string>();
    for (const entry of entries) {
      for (const id of entry.allBlockIds) allBlockIds.add(id);
    }

    for (const blockId of allBlockIds) {
      stats[blockId] = { selections: 0, totalUtilization: 0, wasteCount: 0, missCount: 0 };
    }

    for (const entry of entries) {
      for (const blockId of entry.selectedBlockIds) {
        if (!stats[blockId]) continue;
        stats[blockId].selections++;
        const util = entry.utilization[blockId];
        if (util) {
          stats[blockId].totalUtilization += util.overlapScore;
          if (util.wasted) stats[blockId].wasteCount++;
        }
      }
    }

    for (const miss of misses) {
      for (const blockId of miss.missedBlockIds) {
        if (!stats[blockId]) stats[blockId] = { selections: 0, totalUtilization: 0, wasteCount: 0, missCount: 0 };
        stats[blockId].missCount++;
      }
    }

    // Priority adjustments based on utilization
    for (const [blockId, s] of Object.entries(stats)) {
      if (!adj.blocks[blockId]) {
        adj.blocks[blockId] = { addedKeywords: [], priorityDelta: 0, pendingKeywords: {} };
      }
      const blockAdj = adj.blocks[blockId];

      if (s.selections >= 5) {
        const avgUtil = s.totalUtilization / s.selections;
        if (avgUtil < 0.1) {
          // Consistently low utilization -> lower priority
          blockAdj.priorityDelta = Math.max(blockAdj.priorityDelta - 1, -2);
        } else if (avgUtil > 0.5) {
          // Consistently high utilization -> raise priority
          blockAdj.priorityDelta = Math.min(blockAdj.priorityDelta + 1, 2);
        }
      }
    }

    // LLM-assisted keyword discovery from miss patterns
    const blockMissCounts: Record<string, number> = {};
    const blockMissKeywords: Record<string, string[]> = {};

    for (const miss of misses) {
      for (const blockId of miss.missedBlockIds) {
        blockMissCounts[blockId] = (blockMissCounts[blockId] ?? 0) + 1;
        if (!blockMissKeywords[blockId]) blockMissKeywords[blockId] = [];
        blockMissKeywords[blockId].push(...miss.missedKeywordCandidates);
      }
    }

    // Only ask LLM for blocks with >= 2 misses
    const blocksNeedingKeywords = Object.entries(blockMissCounts)
      .filter(([, count]) => count >= 2)
      .map(([blockId]) => ({
        blockId,
        missCount: blockMissCounts[blockId],
        candidateWords: [...new Set(blockMissKeywords[blockId])].slice(0, 30),
        existingKeywords: adj.blocks[blockId]?.addedKeywords ?? [],
      }));

    if (blocksNeedingKeywords.length > 0) {
      try {
        const result = await claudeText({
          label: "context-eval.keywordDiscovery",
          system: `You are a keyword discovery system. Given context block miss patterns (user mentioned related topics but the block wasn't selected), suggest new trigger keywords.
Rules:
- Only suggest 2-4 word keywords
- Keywords should be words users would naturally use
- Don't duplicate existing keywords
- Output strict JSON`,
          prompt: `The following context blocks are frequently missed:

${blocksNeedingKeywords.map(b =>
  `Block "${b.blockId}" — missed ${b.missCount} times
  Existing keywords: ${b.existingKeywords.join(", ") || "(none)"}
  Candidate words: ${b.candidateWords.join(", ")}`
).join("\n\n")}

Suggest 1-3 new keywords per block. Output JSON:
[{"blockId": "xxx", "keywords": ["word1", "word2"]}]`,
          model: "fast",
          timeoutMs: 90_000,
        });

        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const suggestions = JSON.parse(jsonMatch[0]) as Array<{ blockId: string; keywords: string[] }>;
          for (const suggestion of suggestions) {
            if (!adj.blocks[suggestion.blockId]) continue;
            const blockAdj = adj.blocks[suggestion.blockId];
            for (const kw of suggestion.keywords) {
              if (!blockAdj.addedKeywords.includes(kw)) {
                blockAdj.addedKeywords.push(kw);
              }
            }
          }
          log.info(`LLM suggested keywords for ${suggestions.length} blocks`);
        }
      } catch (err) {
        log.warn("LLM keyword discovery failed", err);
      }
    }

    // Save updated adjustments
    adj.updatedAt = Date.now();
    adj.lastAnalysisAt = Date.now();
    writeJsonAtomic(this.adjustmentsPath, adj);

    // Log summary
    const summary = Object.entries(stats)
      .filter(([, s]) => s.selections > 0 || s.missCount > 0)
      .map(([id, s]) => {
        const avgUtil = s.selections > 0 ? (s.totalUtilization / s.selections).toFixed(2) : "n/a";
        return `${id}: sel=${s.selections} util=${avgUtil} waste=${s.wasteCount} miss=${s.missCount}`;
      })
      .join(", ");

    log.info(`analysis complete — ${entries.length} turns, ${misses.length} misses. ${summary}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private appendJsonl(data: unknown): void {
    const today = pstDateStr();
    const logFile = path.join(this.evalDir, `${today}.jsonl`);
    try {
      fs.appendFileSync(logFile, JSON.stringify(data) + "\n", "utf-8");
    } catch (err) {
      log.warn("failed to append eval entry", err);
    }
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: ContextEvalEngine | null = null;

export function initContextEval(statePath: string): ContextEvalEngine {
  _singleton = new ContextEvalEngine(statePath);
  return _singleton;
}

export function recordContextTurn(params: {
  userMessage: string;
  responseText: string;
  allBlocks: ContextBlock[];
  selectedBlocks: ContextBlock[];
}): void {
  _singleton?.recordContextTurn(params);
}

export function evaluatePreviousTurn(currentUserMessage: string): void {
  _singleton?.evaluatePreviousTurn(currentUserMessage);
}

export function loadAdjustments(): ContextAdjustments {
  if (!_singleton) return { updatedAt: 0, lastAnalysisAt: 0, blocks: {} };
  return _singleton.loadAdjustments();
}

export async function runContextAnalysis(): Promise<void> {
  await _singleton?.runContextAnalysis();
}
