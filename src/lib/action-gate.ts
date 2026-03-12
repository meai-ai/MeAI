/**
 * Perimeter Action Gate — unified rule evaluation engine for
 * rumination veto, reply-rate check, content filter, contact pacing,
 * emotional state check, and rate limiting for external actions.
 *
 * Gate data comes from observed facts (timestamps, counts),
 * not high-level relationship summaries.
 */

import fs from "node:fs";
import path from "node:path";
import { getRuminationState } from "../emotion.js";
import { getAttachmentState } from "./relationship-model.js";
import { readJsonSafe } from "./atomic-file.js";
import { pstDateStr } from "./pst-date.js";
import { createLogger } from "./logger.js";
import { incrementError } from "./error-metrics.js";

const log = createLogger("action-gate");

// ── Types ────────────────────────────────────────────────────────────

export type ActionLevel = 0 | 1 | 2 | 3 | 4;

export type GateRuleName =
  | "rumination_veto"
  | "unanswered_streak_block"
  | "contact_pacing_block"
  | "sensitive_content_block"
  | "rumination_unanswered_block"
  | "emotional_state_check"
  | "rate_limit_check";

export interface GateResult {
  allowed: boolean;
  reason?: string;
  ruleName?: GateRuleName;
  level?: ActionLevel;
  rulesEvaluated?: number;
  rulesPassed?: number;
  mode?: "enforce" | "audit";
  allRuleResults?: Array<{ name: GateRuleName; passed: boolean; reason?: string }>;
}

interface GateLogEntry {
  ts: number;
  actionType: "proactive" | "social" | "evolution";
  tier?: 1 | 2;
  allowed: boolean;
  ruleName?: GateRuleName;
  reason?: string;
  level?: ActionLevel;
  rulesEvaluated?: number;
  rulesPassed?: number;
  mode?: "enforce" | "audit";
  context?: Record<string, unknown>;
  allRuleResults?: Array<{ name: GateRuleName; passed: boolean; reason?: string }>;
}

// ── State ────────────────────────────────────────────────────────────

let statePath = "";

export function initActionGate(dataPath: string): void {
  statePath = dataPath;
  log.info("initialized");
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_UNANSWERED_STREAK = 3;
const MIN_PROACTIVE_GAP_MS = 20 * 60 * 1000; // 20 minutes
const MAX_DAILY_SOCIAL_POSTS = 5;

/** Sensitive content patterns — self-harm, credentials, personal info */
const SENSITIVE_PATTERNS = [
  // Self-harm
  /(?:自杀|自残|割腕|跳楼|不想活|想死|suicide|self.?harm)/i,
  // Credentials
  /(?:password|密码|api.?key|secret|token|credential)[:\s=]/i,
  // Personal info (SSN, credit card patterns)
  /\b\d{3}-?\d{2}-?\d{4}\b/,             // SSN
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // credit card
];

// ── Unified Rule Engine ─────────────────────────────────────────────

interface RuleContext {
  level: ActionLevel;
  postContent?: string;
  actionType: "proactive" | "social" | "evolution";
}

interface Rule {
  name: GateRuleName;
  minLevel: ActionLevel;
  /** Only run for these action types. undefined = all types. */
  actionTypes?: Array<"proactive" | "social" | "evolution">;
  check: (ctx: RuleContext) => GateResult | null;
}

const RULES: Rule[] = [
  // 1. Rumination veto (L1+)
  {
    name: "rumination_veto",
    minLevel: 1,
    check: () => {
      try {
        const rumination = getRuminationState();
        if (rumination && rumination.spiralDepth >= 2 && !rumination.interrupted) {
          return {
            allowed: false,
            reason: `spiralDepth=${rumination.spiralDepth} interrupted=${rumination.interrupted}`,
            ruleName: "rumination_veto",
          };
        }
      } catch (err) { log.warn("rule rumination_veto error", err); incrementError("gate", "rumination_veto"); }
      return null;
    },
  },

  // 2. Contact pacing (L1+, proactive only)
  {
    name: "contact_pacing_block",
    minLevel: 1,
    actionTypes: ["proactive"],
    check: () => {
      try {
        const proactiveState = loadProactiveState();
        if (proactiveState) {
          const { lastSentAt, lastUserMessageAt } = proactiveState;
          const now = Date.now();
          const timeSinceLastSent = now - (lastSentAt || 0);
          const userRepliedSince = (lastUserMessageAt || 0) > (lastSentAt || 0);

          if (timeSinceLastSent < MIN_PROACTIVE_GAP_MS && !userRepliedSince) {
            return {
              allowed: false,
              reason: `lastSent=${Math.round(timeSinceLastSent / 60000)}min ago, no reply`,
              ruleName: "contact_pacing_block",
            };
          }
        }
      } catch (err) { log.warn("rule contact_pacing error", err); incrementError("gate", "contact_pacing"); }
      return null;
    },
  },

  // 3. Unanswered streak (L1+, proactive only)
  {
    name: "unanswered_streak_block",
    minLevel: 1,
    actionTypes: ["proactive"],
    check: () => {
      try {
        const proactiveState = loadProactiveState();
        if (proactiveState) {
          const { lastSentAt, lastUserMessageAt } = proactiveState;
          if (lastSentAt && (!lastUserMessageAt || lastUserMessageAt < lastSentAt)) {
            const streak = countUnansweredStreak();
            if (streak >= MAX_UNANSWERED_STREAK) {
              return {
                allowed: false,
                reason: `${streak} consecutive unanswered proactive messages`,
                ruleName: "unanswered_streak_block",
              };
            }
          }
        }
      } catch (err) { log.warn("rule unanswered_streak error", err); incrementError("gate", "unanswered_streak"); }
      return null;
    },
  },

  // 4. Rumination + unanswered (L1+, proactive only)
  {
    name: "rumination_unanswered_block",
    minLevel: 1,
    actionTypes: ["proactive"],
    check: () => {
      try {
        const attachment = getAttachmentState();
        if (attachment.stage === "ruminating" && attachment.lastMessageUnanswered
            && attachment.phaseConfidence >= 0.6) {
          return {
            allowed: false,
            reason: "ruminating + unanswered",
            ruleName: "rumination_unanswered_block",
          };
        }
      } catch (err) { log.warn("rule rumination_unanswered error", err); incrementError("gate", "rumination_unanswered"); }
      return null;
    },
  },

  // 5. Emotional state check (L1+) — block when valence < 2 AND energy < 3
  {
    name: "emotional_state_check",
    minLevel: 1,
    check: () => {
      try {
        const emotionState = loadEmotionState();
        if (emotionState && emotionState.valence < 2 && emotionState.energy < 3) {
          return {
            allowed: false,
            reason: `emotional depletion: valence=${emotionState.valence} energy=${emotionState.energy}`,
            ruleName: "emotional_state_check",
          };
        }
      } catch (err) { log.warn("rule emotional_state error", err); incrementError("gate", "emotional_state"); }
      return null;
    },
  },

  // 6. Sensitive content filter (L2+, only when postContent present)
  {
    name: "sensitive_content_block",
    minLevel: 2,
    check: (ctx) => {
      if (!ctx.postContent) return null;
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(ctx.postContent)) {
          return {
            allowed: false,
            reason: `matched sensitive pattern: ${pattern.source.slice(0, 30)}`,
            ruleName: "sensitive_content_block",
          };
        }
      }
      return null;
    },
  },

  // 7. Rate limit check (L2+, social only) — max 5 posts/day
  {
    name: "rate_limit_check",
    minLevel: 2,
    actionTypes: ["social"],
    check: () => {
      try {
        const count = loadSocialDailyCount();
        if (count >= MAX_DAILY_SOCIAL_POSTS) {
          return {
            allowed: false,
            reason: "daily social post limit reached",
            ruleName: "rate_limit_check",
          };
        }
      } catch (err) { log.warn("rule rate_limit error", err); incrementError("gate", "rate_limit"); }
      return null;
    },
  },
];

/**
 * Unified rule evaluation engine.
 * Evaluates rules in order; first block wins.
 *
 * rulesEvaluated = number of rules whose check() was actually called
 * rulesPassed = evaluated rules that returned null or { allowed: true }
 * Once a rule blocks, subsequent rules are NOT evaluated.
 */
function evaluateRules(ctx: RuleContext): GateResult {
  let rulesEvaluated = 0;
  let rulesPassed = 0;
  let firstBlock: GateResult | null = null;
  const allRuleResults: Array<{ name: GateRuleName; passed: boolean; reason?: string }> = [];

  for (const rule of RULES) {
    // Skip if rule requires higher level than current action
    if (ctx.level < rule.minLevel) continue;
    // Skip if rule is for specific action types and this isn't one
    if (rule.actionTypes && !rule.actionTypes.includes(ctx.actionType)) continue;

    rulesEvaluated++;
    const result = rule.check(ctx);

    if (result && !result.allowed) {
      allRuleResults.push({ name: rule.name, passed: false, reason: result.reason });
      if (!firstBlock) {
        firstBlock = result;
      }
      // Continue evaluating remaining rules (don't short-circuit)
    } else {
      allRuleResults.push({ name: rule.name, passed: true });
      rulesPassed++;
    }
  }

  if (firstBlock) {
    return {
      ...firstBlock,
      level: ctx.level,
      rulesEvaluated,
      rulesPassed,
      allRuleResults,
    };
  }

  return {
    allowed: true,
    level: ctx.level,
    rulesEvaluated,
    rulesPassed,
    allRuleResults,
  };
}

// ── Backward-Compatible Wrappers ────────────────────────────────────

export function checkProactiveGate(): GateResult {
  const result = evaluateRules({ level: 1, actionType: "proactive" });
  logGate("proactive", result, {});
  return result;
}

export function checkSocialGate(postContent: string): GateResult {
  const result = evaluateRules({ level: 2, actionType: "social", postContent });
  logGate("social", result, {});
  return result;
}

/**
 * Audit-only gate for evolution tier 1/2 actions.
 * Returns GateResult with mode: "audit" — never blocks, only logs.
 */
export function auditEvolutionAction(tier: 1 | 2): GateResult {
  const result = evaluateRules({ level: tier === 1 ? 0 : 1, actionType: "evolution" });
  const auditResult: GateResult = { ...result, mode: "audit" };
  logGate("evolution", auditResult, {}, tier);
  return auditResult;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface ProactiveStateData {
  lastSentAt: number;
  lastUserMessageAt: number;
  dailyCount: number;
  dailyDate: string;
}

function loadProactiveState(): ProactiveStateData | null {
  if (!statePath) return null;
  const filePath = path.join(statePath, "proactive.json");
  return readJsonSafe<ProactiveStateData | null>(filePath, null);
}

interface EmotionStateData {
  valence: number;
  energy: number;
}

function loadEmotionState(): EmotionStateData | null {
  if (!statePath) return null;
  const filePath = path.join(statePath, "emotion-state.json");
  return readJsonSafe<EmotionStateData | null>(filePath, null);
}

interface SocialStateData {
  dailyCount: number;
  dailyDate: string;
}

function loadSocialDailyCount(): number {
  if (!statePath) return 0;
  const filePath = path.join(statePath, "social.json");
  const state = readJsonSafe<SocialStateData | null>(filePath, null);
  if (!state) return 0;
  // Only count today's posts
  const today = pstDateStr();
  if (state.dailyDate !== today) return 0;
  return state.dailyCount ?? 0;
}

function countUnansweredStreak(): number {
  if (!statePath) return 0;
  try {
    const sessionPath = path.join(statePath, "sessions", "main.jsonl");
    if (!fs.existsSync(sessionPath)) return 0;

    const content = fs.readFileSync(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Walk backwards counting consecutive assistant entries with no user in between
    let streak = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.role === "user") break;
        if (entry.role === "assistant") streak++;
      } catch { continue; }
    }
    return streak;
  } catch {
    return 0;
  }
}

function logGate(
  action: "proactive" | "social" | "evolution",
  result: GateResult,
  context: Record<string, unknown>,
  tier?: 1 | 2,
): void {
  const entry: GateLogEntry = {
    ts: Date.now(),
    actionType: action,
    tier,
    allowed: result.allowed,
    ruleName: result.ruleName,
    reason: result.reason,
    level: result.level,
    rulesEvaluated: result.rulesEvaluated,
    rulesPassed: result.rulesPassed,
    mode: result.mode,
    context: Object.keys(context).length > 0 ? context : undefined,
    allRuleResults: result.allRuleResults,
  };

  if (!result.allowed && result.mode !== "audit") {
    log.info(`BLOCKED ${action}: [${result.ruleName}] ${result.reason}`);
  } else if (!result.allowed && result.mode === "audit") {
    log.info(`AUDIT ${action}: [${result.ruleName}] ${result.reason} (non-blocking)`);
  }

  // Append to gate log
  if (statePath) {
    try {
      if (result.mode === "audit") {
        // Audit entries go to dedicated audit log
        const auditDir = path.join(statePath, "action-audit");
        fs.mkdirSync(auditDir, { recursive: true });
        const logPath = path.join(auditDir, `${pstDateStr()}.jsonl`);
        fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
      } else {
        const logPath = path.join(statePath, "action-gate.jsonl");
        fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
      }
    } catch (err) { incrementError("gate", "log_write"); }
  }
}
