/**
 * Consciousness Stabilizer — single authority closed-loop controller.
 *
 * Observes system state → computes CSI → produces ControlPolicy.
 * All other modules read the policy via getPolicy().
 * Three modes: Green (normal), Yellow (graduated dampening), Red (emergency).
 */

import { BRAINSTEM_CONFIG as C, type Clock, type SelfGatePolicy, DEFAULT_SELF_GATE } from "./config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("brainstem-stabilizer");

// ── Types ────────────────────────────────────────────────────────────

export interface DerivedState {
  winnerGroundingStrength: number;
  clusterGroundingCoverage: number;
  noveltyAvg: number;
  rotationRate: number;
  entropy: number;
  valenceHistory: number[];     // |mean(V)| for last 5 ticks
  avgPredictionError: number;
  energyUtilization: number;
  avgFatigue: number;
  timestamp: number;
}

export interface ControlPolicy {
  mode: "green" | "yellow" | "red";
  csi: number;
  // Slow-loop knobs
  dethroneMarginDelta: number;
  thoughtBudgetScale: number;
  minGroundingWeight: number;
  wVScale: number;
  // Fast-loop knobs
  noiseScale: number;
  spreadScale: number;
  // Injection knobs
  externalAbsorbScale: number;
  // Replay knobs
  replayDistribution: {
    similar: number;
    adjacent: number;
    goal: number;
    grounded: number;
    random: number;
    counterEvidence: number;
  };
  // Hard guards
  freezeVerbalization: boolean;
  externalOnlyDethrone: boolean;
  forceWinnerFatigue: number;
  reflectGateEnabled: boolean;
  // L9: Red-Deep source filtering — only these sources can inject
  externalSourceFilter?: string[];
  // CS5b: Self gate policy
  selfGate: SelfGatePolicy;
  // Cortex: C-4 uncertainty simulator gate
  cortex4Enabled: boolean;
  // CS8: Social gate
  socialGateEnabled: boolean;
}

export interface AffectRegulationState {
  valenceSetpoint: number;       // target valence (0 = neutral)
  arousalSetpoint: number;       // target arousal level (0.4 = moderate)
  regulationStrategy: "none" | "reappraisal" | "distraction" | "suppression";
  regulationIntensity: number;   // 0-1, how strongly regulating
  valenceEma: number;            // exponential moving average of valence
  arousalEma: number;            // EMA of activation energy
  regulationHistory: Array<{
    strategy: string;
    triggerValence: number;
    outcome: "effective" | "partial" | "ineffective";
    timestamp: number;
  }>;
}

export interface PolicyTransition {
  from: string;
  to: string;
  triggeringSubMetrics: Array<{ name: string; value: number; threshold: number }>;
  knobDiffs: Record<string, { from: number; to: number }>;
  timestamp: number;
}

export interface CSISubMetrics {
  G: number;
  Gc: number;
  N: number;
  Rh: number;
  Eh: number;
  Vh: number;
  Pe: number;
}

// ── Default policies ─────────────────────────────────────────────────

const GREEN_POLICY: ControlPolicy = {
  mode: "green",
  csi: 1.0,
  dethroneMarginDelta: 0,
  thoughtBudgetScale: 1.0,
  minGroundingWeight: 0,
  wVScale: 1.0,
  noiseScale: 1.0,
  spreadScale: 1.0,
  externalAbsorbScale: 1.0,
  replayDistribution: { similar: 0.7, adjacent: 0, goal: 0.2, grounded: 0, random: 0.1, counterEvidence: 0 },
  freezeVerbalization: false,
  externalOnlyDethrone: false,
  forceWinnerFatigue: 0,
  reflectGateEnabled: true,
  selfGate: { ...DEFAULT_SELF_GATE },
  cortex4Enabled: true,
  socialGateEnabled: true,
};

// ── Stabilizer ───────────────────────────────────────────────────────

export class ConsciousnessStabilizer {
  private mode: "green" | "yellow" | "red" = "green";
  private csi = 1.0;
  private policy: Readonly<ControlPolicy> = { ...GREEN_POLICY };
  private subMetrics: CSISubMetrics = { G: 1, Gc: 1, N: 1, Rh: 1, Eh: 1, Vh: 1, Pe: 1 };

  // Recovery state
  private lastTransitionAt = 0;
  private csiAtTransition = 1.0;
  private previousMode: "green" | "yellow" | "red" = "green";
  private rampActive = false;
  private rampProgress = 0;
  private csiTrend: number[] = [];   // last 3 CSI values
  private rampFrozen = false;
  private transitions: PolicyTransition[] = [];

  // H1: Extreme valence circuit breaker
  private extremeValenceSince = 0;         // timestamp when |self.V| > 0.9 started
  private extremeValenceOverride = false;  // currently forcing freezeVerbalization

  // Calibration
  private noveltyCenterCalibrated = 0.5;
  private rotationCenterCalibrated: number = C.rotationHealthCenter;
  private entropyCenterCalibrated: number = C.entropyTarget;

  // Policy learning offsets
  private learnedOffsets: Record<string, number> = {};

  // Auto-tune rollback tracking
  private lastAutoTuneAt = 0;
  private lastAutoTuneDeltas: Array<{ knob: string; delta: number }> = [];

  // Affect regulation
  private affect: AffectRegulationState = {
    valenceSetpoint: 0,
    arousalSetpoint: 0.4,
    regulationStrategy: "none",
    regulationIntensity: 0,
    valenceEma: 0,
    arousalEma: 0.4,
    regulationHistory: [],
  };

  constructor(private clock: Clock) {}

  getPolicy(): Readonly<ControlPolicy> {
    return this.policy;
  }

  getCSI(): number {
    return this.csi;
  }

  getMode(): "green" | "yellow" | "red" {
    return this.mode;
  }

  getSubMetrics(): CSISubMetrics {
    return { ...this.subMetrics };
  }

  getTransitions(): PolicyTransition[] {
    return [...this.transitions];
  }

  isRampActive(): boolean {
    return this.rampActive;
  }

  getRampProgress(): number {
    return this.rampProgress;
  }

  /** Apply learned policy adjustments from controller replay analysis. */
  applyLearnedAdjustments(adjustments: Array<{ knob: string; delta: number }>): void {
    for (const adj of adjustments) {
      this.learnedOffsets[adj.knob] = (this.learnedOffsets[adj.knob] ?? 0) + adj.delta;
    }
    log.info(`applied ${adjustments.length} learned adjustments: ${adjustments.map(a => `${a.knob}=${a.delta > 0 ? "+" : ""}${a.delta.toFixed(4)}`).join(", ")}`);
  }

  /** Apply auto-tune parameter adjustments. Stores deltas for potential rollback. */
  applyAutoTune(deltas: Array<{ knob: string; delta: number }>, timestamp: number): void {
    this.lastAutoTuneAt = timestamp;
    this.lastAutoTuneDeltas = deltas;
    this.applyLearnedAdjustments(deltas);
    log.info(`auto-tune applied: ${deltas.length} adjustments at t=${timestamp}`);
  }

  /** Check if auto-tune should be rolled back (CSI < 0.5 within 2h of tune). Returns rollback info if triggered. */
  checkAutoTuneRollback(csi: number, now: number): { rolledBack: true; deltas: Array<{ knob: string; delta: number }>; csi: number } | null {
    if (this.lastAutoTuneDeltas.length === 0) return null;
    if (now - this.lastAutoTuneAt > 2 * 3_600_000) {
      // Past the 2h window — clear rollback data, keep adjustments
      this.lastAutoTuneDeltas = [];
      return null;
    }
    if (csi < 0.5) {
      // Revert: apply inverse deltas
      const reverted = [...this.lastAutoTuneDeltas];
      const inversed = reverted.map(d => ({ knob: d.knob, delta: -d.delta }));
      this.applyLearnedAdjustments(inversed);
      log.warn(`auto-tune ROLLBACK: CSI=${csi.toFixed(2)} within 2h of tune, reverting ${inversed.length} adjustments`);
      this.lastAutoTuneDeltas = [];
      return { rolledBack: true, deltas: reverted, csi };
    }
    return null;
  }

  getCsi(): number {
    return this.csi;
  }

  getAffectState(): AffectRegulationState {
    return { ...this.affect, regulationHistory: [...this.affect.regulationHistory] };
  }

  updateAffectRegulation(valence: number, arousal: number): void {
    const now = this.clock.nowMs();

    // Update EMAs
    this.affect.valenceEma = 0.9 * this.affect.valenceEma + 0.1 * valence;
    this.affect.arousalEma = 0.9 * this.affect.arousalEma + 0.1 * arousal;

    const valenceDeviation = Math.abs(this.affect.valenceEma - this.affect.valenceSetpoint);
    const arousalDeviation = Math.abs(this.affect.arousalEma - this.affect.arousalSetpoint);
    const deviation = Math.max(valenceDeviation, arousalDeviation);

    if (deviation <= 0.3) {
      // Within tolerance — record effectiveness if strategy was active
      if (this.affect.regulationStrategy !== "none") {
        this.affect.regulationHistory.push({
          strategy: this.affect.regulationStrategy,
          triggerValence: this.affect.valenceEma,
          outcome: "effective",
          timestamp: now,
        });
      }
      this.affect.regulationStrategy = "none";
      this.affect.regulationIntensity = 0;
      return;
    }

    // Strategy selection based on valence/arousal quadrant
    const prevStrategy = this.affect.regulationStrategy;
    if (this.affect.valenceEma < -0.3 && this.affect.arousalEma > 0.5) {
      this.affect.regulationStrategy = "reappraisal";
    } else if (this.affect.valenceEma < -0.3 && this.affect.arousalEma <= 0.5) {
      this.affect.regulationStrategy = "distraction";
    } else if (this.affect.arousalEma > 0.7) {
      this.affect.regulationStrategy = "suppression";
    } else if (this.affect.valenceEma > 0.5 && this.affect.arousalEma > 0.6) {
      this.affect.regulationStrategy = "suppression"; // prevent mania-like loops
    } else {
      this.affect.regulationStrategy = "none";
    }

    this.affect.regulationIntensity = Math.max(0, Math.min(1, deviation - 0.3));

    // Log strategy changes
    if (prevStrategy !== this.affect.regulationStrategy && this.affect.regulationStrategy !== "none") {
      this.affect.regulationHistory.push({
        strategy: this.affect.regulationStrategy,
        triggerValence: this.affect.valenceEma,
        outcome: "partial",
        timestamp: now,
      });
      if (this.affect.regulationHistory.length > 20) this.affect.regulationHistory.shift();
      log.info(`affect regulation: ${this.affect.regulationStrategy} (intensity=${this.affect.regulationIntensity.toFixed(2)}, valenceEma=${this.affect.valenceEma.toFixed(2)})`);
    }
  }

  setCalibration(noveltyCenter: number, rotationCenter: number, entropyCenter: number): void {
    this.noveltyCenterCalibrated = noveltyCenter;
    this.rotationCenterCalibrated = rotationCenter;
    this.entropyCenterCalibrated = entropyCenter;
  }

  // ── Main update (called every slow-loop tick) ────────────────────

  update(derived: DerivedState): {
    policy: Readonly<ControlPolicy>;
    csi: number;
    subMetrics: CSISubMetrics;
    transition?: PolicyTransition;
  } {
    const now = this.clock.nowMs();

    // Compute sub-metrics
    this.subMetrics = this.computeSubMetrics(derived);

    // Compute CSI
    const w = C.csiWeights;
    this.csi =
      w.G * this.subMetrics.G +
      w.Gc * this.subMetrics.Gc +
      w.N * this.subMetrics.N +
      w.Rh * this.subMetrics.Rh +
      w.Eh * this.subMetrics.Eh +
      w.Vh * this.subMetrics.Vh +
      w.Pe * this.subMetrics.Pe;

    this.csi = Math.max(0, Math.min(1, this.csi));

    // Track CSI trend
    this.csiTrend.push(this.csi);
    if (this.csiTrend.length > 3) this.csiTrend.shift();

    // Affect regulation: proactive emotion management
    const valenceMean = derived.valenceHistory.length > 0
      ? derived.valenceHistory.reduce((s, v) => s + v, 0) / derived.valenceHistory.length
      : 0;
    this.updateAffectRegulation(valenceMean, derived.energyUtilization);

    // H1: Extreme valence circuit breaker — |self.V| > 0.9 for 5 min → force freeze
    this.updateExtremeValenceOverride(derived, now);

    // Determine mode transition
    let transition: PolicyTransition | undefined;
    const prevMode = this.mode;
    const newMode = this.determineMode();

    if (newMode !== prevMode) {
      transition = {
        from: prevMode,
        to: newMode,
        triggeringSubMetrics: this.findTriggeringMetrics(),
        knobDiffs: {},
        timestamp: now,
      };
      this.previousMode = prevMode;
      this.mode = newMode;
      this.lastTransitionAt = now;
      this.csiAtTransition = this.csi;
      this.rampActive = true;
      this.rampProgress = 0;
      this.rampFrozen = false;
      this.transitions.push(transition);
      if (this.transitions.length > 20) this.transitions.shift();

      log.info(`mode transition: ${prevMode} → ${newMode} (CSI=${this.csi.toFixed(2)})`);
    }

    // Handle recovery ramp
    if (this.rampActive) {
      this.updateRamp(now);
    }

    // Generate policy
    const oldPolicy = this.policy;
    let generated = this.generatePolicy(now);

    // Apply affect regulation modulation to policy knobs
    if (this.affect.regulationStrategy !== "none" && this.affect.regulationIntensity > 0) {
      const intensity = this.affect.regulationIntensity;
      switch (this.affect.regulationStrategy) {
        case "reappraisal":
          generated = {
            ...generated,
            reflectGateEnabled: true,
            wVScale: generated.wVScale * (1 - 0.3 * intensity),
          };
          break;
        case "distraction":
          generated = {
            ...generated,
            noiseScale: generated.noiseScale * (1 + 0.2 * intensity),
            replayDistribution: {
              ...generated.replayDistribution,
              random: generated.replayDistribution.random + 0.1 * intensity,
            },
          };
          break;
        case "suppression":
          generated = {
            ...generated,
            spreadScale: generated.spreadScale * (1 - 0.2 * intensity),
            forceWinnerFatigue: generated.forceWinnerFatigue + 0.1 * intensity,
          };
          break;
      }
    }

    // H1: Override freezeVerbalization if extreme valence circuit breaker is active
    if (this.extremeValenceOverride && !generated.freezeVerbalization) {
      generated = { ...generated, freezeVerbalization: true };
      log.warn("extreme valence circuit breaker: forcing freezeVerbalization");
    }
    this.policy = Object.freeze({ ...generated });

    // Record knob diffs in transition
    if (transition) {
      for (const key of Object.keys(this.policy) as Array<keyof ControlPolicy>) {
        const oldVal = oldPolicy[key];
        const newVal = this.policy[key];
        if (typeof oldVal === "number" && typeof newVal === "number" && oldVal !== newVal) {
          transition.knobDiffs[key] = { from: oldVal, to: newVal };
        }
      }
    }

    return {
      policy: this.policy,
      csi: this.csi,
      subMetrics: this.subMetrics,
      transition,
    };
  }

  // ── Restore state from persistence ───────────────────────────────

  restoreState(csi: number, mode: "green" | "yellow" | "red", lastTransitionAt: number, csiAtTransition: number): void {
    this.csi = csi;
    this.mode = mode;
    this.lastTransitionAt = lastTransitionAt;
    this.csiAtTransition = csiAtTransition;
    this.policy = this.generatePolicy(this.clock.nowMs());
    this.policy = Object.freeze({ ...this.policy });
  }

  // ── Sub-metric computation ───────────────────────────────────────

  private computeSubMetrics(d: DerivedState): CSISubMetrics {
    // G: Grounding Strength
    const G = d.winnerGroundingStrength;

    // Gc: Grounding Coverage
    const Gc = d.clusterGroundingCoverage;

    // N: Novelty Health (bell curve around center)
    const nCenter = this.noveltyCenterCalibrated;
    const N = Math.max(0, 1 - 4 * Math.pow(d.noveltyAvg - nCenter, 2));

    // Rh: Rotation Health (bell curve around center)
    const rCenter = this.rotationCenterCalibrated;
    const Rh = Math.max(0, Math.min(1, 1 - Math.pow((d.rotationRate - rCenter) / rCenter, 2)));

    // Eh: Entropy Health
    const Eh = Math.min(1, d.entropy / this.entropyCenterCalibrated);

    // Vh: Valence Stability
    let Vh = 1.0;
    if (d.valenceHistory.length >= 2) {
      const deltas = [];
      for (let i = 1; i < d.valenceHistory.length; i++) {
        deltas.push(Math.abs(d.valenceHistory[i] - d.valenceHistory[i - 1]));
      }
      const maxDelta = Math.max(...deltas, 0);
      Vh = 1 - maxDelta;
    }
    // Extreme valence penalty
    if (d.valenceHistory.length >= 3) {
      const recent = d.valenceHistory.slice(-3);
      if (recent.every(v => v > C.valenceExtremeThreshold)) {
        Vh *= 0.5;
      }
    }
    Vh = Math.max(0, Math.min(1, Vh));

    // Pe: Prediction Error Trend
    const Pe = 1 - Math.max(0, Math.min(1, d.avgPredictionError));

    return { G, Gc, N, Rh, Eh, Vh, Pe };
  }

  // ── Mode determination with hysteresis ───────────────────────────

  private determineMode(): "green" | "yellow" | "red" {
    const csi = this.csi;

    switch (this.mode) {
      case "green":
        if (csi < C.csiYellowThreshold) return "yellow";
        return "green";

      case "yellow":
        if (csi >= C.yellowToGreenHysteresis) return "green";
        if (csi < C.csiYellowThreshold) {
          // Could go to red
          if (csi < C.csiRedShallowThreshold) return "red";
          return "yellow";
        }
        return "yellow";

      case "red":
        if (csi > C.redToYellowHysteresis) return "yellow";
        return "red";
    }
  }

  // ── Recovery ramp ────────────────────────────────────────────────

  private updateRamp(now: number): void {
    const elapsed = now - this.lastTransitionAt;
    // Red→Yellow uses 60s ramp; other transitions use default rampDurationMs (120s)
    const duration = (this.previousMode === "red" && this.mode === "yellow") ? 60_000 : C.rampDurationMs;

    // Anti-windup: check if CSI is dropping
    if (this.csiTrend.length >= 2) {
      const recent = this.csiTrend[this.csiTrend.length - 1];
      const prev = this.csiTrend[this.csiTrend.length - 2];

      if (recent < this.csiAtTransition) {
        this.rampFrozen = true;
      }

      // Resume if CSI has been stable/rising for 3 ticks
      if (this.rampFrozen && this.csiTrend.length >= 3) {
        const allRising = this.csiTrend.every((v, i) =>
          i === 0 || v >= this.csiTrend[i - 1] - 0.01,
        );
        if (allRising) {
          this.rampFrozen = false;
        }
      }
    }

    if (this.rampFrozen) return; // Hold current values

    this.rampProgress = Math.min(1, elapsed / duration);
    if (this.rampProgress >= 1) {
      this.rampActive = false;
    }
  }

  // ── Policy generation ────────────────────────────────────────────

  private generatePolicy(now: number): ControlPolicy {
    switch (this.mode) {
      case "green":
        return this.greenPolicy();
      case "yellow":
        return this.yellowPolicy();
      case "red":
        return this.redPolicy();
    }
  }

  private greenPolicy(): ControlPolicy {
    if (this.rampActive && this.rampProgress < 1) {
      // Ramping from Yellow → Green
      const t = this.rampProgress;
      return {
        mode: "green",
        csi: this.csi,
        dethroneMarginDelta: (1 - t) * 0.03,
        thoughtBudgetScale: 0.7 + t * 0.3,
        minGroundingWeight: (1 - t) * 0.2,
        wVScale: 0.6 + t * 0.4,
        noiseScale: 0.8 + t * 0.2,
        spreadScale: 0.85 + t * 0.15,
        externalAbsorbScale: 0.8 + t * 0.2,
        replayDistribution: {
          similar: 0.5 + t * 0.2,
          adjacent: (1 - t) * 0.1,
          goal: 0.3 - t * 0.1,
          grounded: (1 - t) * 0.1,
          random: 0.05 + t * 0.05,
          counterEvidence: lerp(0.20, 0, t),  // Yellow→Green: ramp down to 0
        },
        freezeVerbalization: false,
        externalOnlyDethrone: false,
        forceWinnerFatigue: 0,
        reflectGateEnabled: true,
        selfGate: { ...DEFAULT_SELF_GATE },
        cortex4Enabled: true,
        socialGateEnabled: true,
      };
    }

    // Apply learned offsets from policy learning
    const base = { ...GREEN_POLICY, csi: this.csi, replayDistribution: { ...GREEN_POLICY.replayDistribution } };
    if (Object.keys(this.learnedOffsets).length > 0) {
      for (const [knob, offset] of Object.entries(this.learnedOffsets)) {
        // Handle nested replayDistribution keys (e.g. "counterEvidence")
        if (knob in base.replayDistribution && typeof (base.replayDistribution as Record<string, unknown>)[knob] === "number") {
          (base.replayDistribution as unknown as Record<string, number>)[knob] += offset;
        } else if (knob in base && typeof (base as Record<string, unknown>)[knob] === "number") {
          (base as unknown as Record<string, number>)[knob] += offset;
        }
      }
    }
    return base;
  }

  private yellowPolicy(): ControlPolicy {
    // Red→Yellow recovery ramp: gradual restoration over ramp duration
    if (this.rampActive && this.previousMode === "red") {
      const elapsed = this.clock.nowMs() - this.lastTransitionAt;
      const verbFrozen = elapsed < 30_000;
      const t = this.rampProgress;

      return {
        mode: "yellow",
        csi: this.csi,
        dethroneMarginDelta: 0.05 * (1 - t) + 0.03 * t,
        thoughtBudgetScale: t * 0.7,
        minGroundingWeight: 0.3 * (1 - t) + 0.2 * t,
        wVScale: 0.3 + t * 0.3,
        noiseScale: 0.5 + t * 0.3,
        spreadScale: 0.7 + t * 0.15,
        externalAbsorbScale: 0.5 + t * 0.3,
        replayDistribution: {
          similar: t * 0.5,
          adjacent: t * 0.1,
          goal: 0.5 - t * 0.2,
          grounded: 0.5 - t * 0.4,
          random: t * 0.05,
          counterEvidence: lerp(0, 0.20, t),  // Red→Yellow: ramp up to Yellow's 0.20
        },
        freezeVerbalization: verbFrozen,
        externalOnlyDethrone: t < 0.5,
        forceWinnerFatigue: 0.8 * (1 - t),
        reflectGateEnabled: true,
        selfGate: {
          minSocialEnergy: lerp(0.35, 0.25, t),
          maxFatigue: lerp(0.60, 0.75, t),
          minSafetyMargin: lerp(0.40, 0.30, t),
          minCoherence: lerp(0.50, 0.40, t),
        },
        cortex4Enabled: true,
        socialGateEnabled: true,
      };
    }

    // Normal Yellow: t: 0 at CSI=0.7, 1 at CSI=0.45
    const t = Math.max(0, Math.min(1, (C.csiGreenThreshold - this.csi) / (C.csiGreenThreshold - C.csiYellowThreshold)));

    return {
      mode: "yellow",
      csi: this.csi,
      dethroneMarginDelta: 0.03 * t,
      thoughtBudgetScale: 1.0 - 0.3 * t,
      minGroundingWeight: 0.2 * t,
      wVScale: 1.0 - 0.4 * t,
      noiseScale: 1.0 - 0.2 * t,
      spreadScale: 1.0 - 0.15 * t,
      externalAbsorbScale: 1.0 - 0.2 * t,
      replayDistribution: {
        similar: 0.7 - 0.2 * t,
        adjacent: 0.1 * t,
        goal: 0.2 + 0.1 * t,
        grounded: 0.1 * t,
        random: 0.1 - 0.05 * t,
        counterEvidence: lerp(0.20, 0.10, t),   // gradient 0.2 → 0.1 as Yellow deepens
      },
      freezeVerbalization: false,
      externalOnlyDethrone: false,
      forceWinnerFatigue: 0,
      reflectGateEnabled: true,
      selfGate: {
        minSocialEnergy: lerp(0.25, 0.35, t),
        maxFatigue: lerp(0.75, 0.60, t),
        minSafetyMargin: lerp(0.30, 0.40, t),
        minCoherence: lerp(0.40, 0.50, t),
      },
      cortex4Enabled: true,
      socialGateEnabled: true,
    };
  }

  private redPolicy(): ControlPolicy {
    const isDeep = this.csi < C.csiRedShallowThreshold;

    return {
      mode: "red",
      csi: this.csi,
      dethroneMarginDelta: 0.05,
      thoughtBudgetScale: 0,
      minGroundingWeight: 0.3,
      wVScale: 0.3,
      noiseScale: 0.5,
      spreadScale: 0.7,
      externalAbsorbScale: 0.5,
      // L9: Red-Deep dampens all replay; Red-Shallow allows goal/grounded only
      replayDistribution: isDeep
        ? { similar: 0, adjacent: 0, goal: 0, grounded: 0, random: 0, counterEvidence: 0 }
        : { similar: 0, adjacent: 0, goal: 0.5, grounded: 0.5, random: 0, counterEvidence: 0 },
      // L9: Red-Deep limits external absorb to conversation + notification only (blocks curiosity)
      externalSourceFilter: isDeep ? ["conversation", "notification"] : undefined,
      freezeVerbalization: true,
      externalOnlyDethrone: true,
      forceWinnerFatigue: 0.8,
      reflectGateEnabled: !isDeep,
      // Block all outward actions
      selfGate: { minSocialEnergy: 1.0, maxFatigue: 0.0, minSafetyMargin: 1.0, minCoherence: 1.0 },
      cortex4Enabled: false,
      socialGateEnabled: true,
    };
  }

  // ── H1: Extreme valence circuit breaker ─────────────────────────

  private updateExtremeValenceOverride(derived: DerivedState, now: number): void {
    const EXTREME_THRESHOLD = 0.9;
    const SUSTAINED_MS = 5 * 60_000; // 5 minutes

    // Check if recent valence is extreme
    const recentExtreme = derived.valenceHistory.length >= 2 &&
      derived.valenceHistory.slice(-2).every(v => Math.abs(v) > EXTREME_THRESHOLD);

    if (recentExtreme) {
      if (this.extremeValenceSince === 0) {
        this.extremeValenceSince = now;
      } else if (now - this.extremeValenceSince >= SUSTAINED_MS) {
        if (!this.extremeValenceOverride) {
          log.warn(`extreme valence circuit breaker ACTIVATED (sustained ${((now - this.extremeValenceSince) / 1000).toFixed(0)}s)`);
        }
        this.extremeValenceOverride = true;
      }
    } else {
      if (this.extremeValenceOverride) {
        log.info("extreme valence circuit breaker deactivated");
      }
      this.extremeValenceSince = 0;
      this.extremeValenceOverride = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private findTriggeringMetrics(): PolicyTransition["triggeringSubMetrics"] {
    const triggers: PolicyTransition["triggeringSubMetrics"] = [];
    const thresholds = { G: 0.5, Gc: 0.5, N: 0.5, Rh: 0.5, Eh: 0.5, Vh: 0.5, Pe: 0.4 };

    for (const [name, value] of Object.entries(this.subMetrics)) {
      const threshold = thresholds[name as keyof typeof thresholds] ?? 0.5;
      if (value < threshold) {
        triggers.push({ name, value, threshold });
      }
    }

    return triggers.sort((a, b) => a.value - b.value).slice(0, 3);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Anchor tag assignment ────────────────────────────────────────────

export type AnchorTag = "grounded" | "inferred" | "speculative";

export function assignAnchorTag(
  primaryGrounding: { type: string; weight: number } | undefined,
  source: string | undefined,
): AnchorTag {
  if (!primaryGrounding) return "speculative";

  if (source === "simulation") return "speculative";

  if (primaryGrounding.weight > 0.5) return "grounded";
  if (primaryGrounding.weight > 0) return "inferred";

  return "speculative";
}
