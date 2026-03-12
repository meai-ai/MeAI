/**
 * Social Model (CS8) — per-target relationship state that gates externalization.
 *
 * Tracks closeness, trust, responsiveness per target.
 * Provides a social gate that can block/delay proactive actions.
 */

import { CS8_CONFIG, type Clock } from "./config.js";
import { readJsonSafe, writeJsonAtomic } from "../lib/atomic-file.js";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-social-model");

// ── Types ────────────────────────────────────────────────────────────

export interface SocialTargetState {
  targetId: string;
  closeness: number;              // 0-1
  trust: number;                  // 0-1
  responsivenessEwma: number;     // 0-1
  lastOutboundAt: number;
  lastInboundAt: number;
  pendingType: "waiting_reply" | "scheduled_plan" | null;
  outboundCount7d: number;
  inboundCount7d: number;
  lastOutboundTopics: string[];   // CS8: topic IDs for follow-up detection
}

interface SocialModelPersisted {
  version: number;
  targets: SocialTargetState[];
  gateBlockCount: number;
  lastUpdated: number;
}

export interface SocialGateResult {
  passed: boolean;
  reason?: string;
  cooldownMultiplier: number;
}

// ── Social Model ─────────────────────────────────────────────────────

export class SocialModel {
  private targets: Map<string, SocialTargetState> = new Map();
  private gateBlockCount = 0;

  constructor(
    private dataPath: string,
    private clock: Clock,
  ) {
    this.load();
  }

  private coldStart(targetId: string): SocialTargetState {
    return {
      targetId,
      closeness: 0.3,
      trust: 0.3,
      responsivenessEwma: 0.5,
      lastOutboundAt: 0,
      lastInboundAt: 0,
      pendingType: null,
      outboundCount7d: 0,
      inboundCount7d: 0,
      lastOutboundTopics: [],
    };
  }

  private getOrCreate(targetId: string): SocialTargetState {
    let state = this.targets.get(targetId);
    if (!state) {
      state = this.coldStart(targetId);
      this.targets.set(targetId, state);
    }
    return state;
  }

  // ── Event hooks ──────────────────────────────────────────────────

  onOutbound(targetId: string, topics?: string[]): void {
    const s = this.getOrCreate(targetId);
    s.lastOutboundAt = this.clock.nowMs();
    s.outboundCount7d++;
    s.pendingType = "waiting_reply";
    if (topics) s.lastOutboundTopics = topics;
  }

  onInbound(targetId: string, sentiment: number): void {
    const s = this.getOrCreate(targetId);
    const now = this.clock.nowMs();
    // EWMA responsiveness up
    s.responsivenessEwma = CS8_CONFIG.ewmaAlpha * 1.0 + (1 - CS8_CONFIG.ewmaAlpha) * s.responsivenessEwma;
    s.closeness = clamp01(s.closeness + 0.02);
    // Trust adjust by sentiment: positive +0.01, negative -0.005
    s.trust = clamp01(s.trust + (sentiment > 0 ? 0.01 : sentiment < 0 ? -0.005 : 0));
    s.lastInboundAt = now;
    s.inboundCount7d++;
    s.pendingType = null;
  }

  onNoReply(targetId: string): void {
    const s = this.getOrCreate(targetId);
    // EWMA responsiveness down: α × 0.0
    s.responsivenessEwma = CS8_CONFIG.ewmaAlpha * 0.0 + (1 - CS8_CONFIG.ewmaAlpha) * s.responsivenessEwma;
    s.trust = clamp01(s.trust - 0.002);
  }

  // ── Daily decay ──────────────────────────────────────────────────

  dailyDecay(): void {
    const now = this.clock.nowMs();
    const sevenDaysAgo = now - 7 * 86_400_000;

    for (const s of this.targets.values()) {
      s.closeness *= CS8_CONFIG.closenessDecayPerDay;
      s.trust *= CS8_CONFIG.trustDecayPerDay;

      // Recount 7d windows: decay by removing stale counts
      // Approximate: reduce by 1/7 daily
      s.outboundCount7d = Math.max(0, Math.round(s.outboundCount7d * 6 / 7));
      s.inboundCount7d = Math.max(0, Math.round(s.inboundCount7d * 6 / 7));

      // Timeout pending replies after 48h
      if (s.pendingType === "waiting_reply" && s.lastOutboundAt > 0 &&
          now - s.lastOutboundAt > CS8_CONFIG.pendingReplyTimeoutMs) {
        s.pendingType = null;
        s.responsivenessEwma = CS8_CONFIG.ewmaAlpha * 0.0 + (1 - CS8_CONFIG.ewmaAlpha) * s.responsivenessEwma;
      }
    }
  }

  // ── Social gate ──────────────────────────────────────────────────

  evaluateSocialGate(targetId: string, actionType: string, isFollowUp?: boolean): SocialGateResult {
    const s = this.getOrCreate(targetId);

    // Rule 1: Low responsiveness + outbound >> inbound → cooldown multiplier
    if (s.responsivenessEwma < CS8_CONFIG.lowResponsivenessThreshold &&
        s.outboundCount7d > s.inboundCount7d * 2) {
      this.gateBlockCount++;
      return {
        passed: true,  // not blocked, but slowed
        reason: "low_responsiveness",
        cooldownMultiplier: CS8_CONFIG.cooldownMultiplier,
      };
    }

    // Rule 2: Pending reply → block new-topic reach_out (follow-ups allowed per design doc)
    if (s.pendingType === "waiting_reply" && actionType === "reach_out" && !isFollowUp) {
      this.gateBlockCount++;
      return {
        passed: false,
        reason: "pending_reply",
        cooldownMultiplier: 1.0,
      };
    }

    return { passed: true, cooldownMultiplier: 1.0 };
  }

  // ── Accessors ────────────────────────────────────────────────────

  getTargetState(targetId: string): SocialTargetState | undefined {
    return this.targets.get(targetId);
  }

  getTargetCount(): number {
    return this.targets.size;
  }

  getGateBlockCount(): number {
    return this.gateBlockCount;
  }

  // ── Persistence ──────────────────────────────────────────────────

  save(): void {
    const data: SocialModelPersisted = {
      version: 1,
      targets: [...this.targets.values()],
      gateBlockCount: this.gateBlockCount,
      lastUpdated: this.clock.nowMs(),
    };
    writeJsonAtomic(path.join(this.dataPath, "brainstem", "social-model.json"), data);
  }

  private load(): void {
    const data = readJsonSafe<SocialModelPersisted>(
      path.join(this.dataPath, "brainstem", "social-model.json"),
      { version: 1, targets: [], gateBlockCount: 0, lastUpdated: 0 },
    );
    this.gateBlockCount = data.gateBlockCount ?? 0;
    for (const t of data.targets ?? []) {
      this.targets.set(t.targetId, t);
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
