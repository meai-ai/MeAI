/**
 * Pure body simulation calculations — no I/O, no state, easily testable.
 */

import { DEFAULT_BODY_CONFIG, type BodyConfig, type ExerciseProfile } from "./body-config.js";

// ── Fatigue: Two-Process Model ─────────────────────────────────────

/**
 * Non-linear homeostatic sleep pressure (Process S).
 * Fatigue increases faster the longer you're awake.
 */
export function calculateProcessS(
  hoursSinceWake: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  return Math.pow(Math.max(0, hoursSinceWake), cfg.homeostaticExponent) * cfg.homeostaticRate;
}

/**
 * Circadian rhythm (Process C).
 * Cosine wave with nadir at cfg.circadianNadirHour (default 4am).
 * Returns value from -amplitude to +amplitude.
 */
export function calculateProcessC(
  currentHour: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  return -Math.cos(((currentHour - cfg.circadianNadirHour) / 24) * 2 * Math.PI) * cfg.circadianAmplitude;
}

/**
 * Sleep debt contribution to fatigue.
 * @param sleepDebt accumulated sleep debt in hours
 */
export function sleepDebtFatigue(sleepDebt: number, cfg = DEFAULT_BODY_CONFIG): number {
  return Math.min(cfg.sleepDebtFatigueMax, Math.max(0, sleepDebt) * 0.75);
}

/**
 * Sleep inertia — grogginess after waking.
 * Duration and intensity scale with sleep quality and hours:
 * - Poor sleep (<6h or quality<5): extends to 60-90 min with higher peak
 * - Normal sleep: ~30 min linear decay
 */
export function sleepInertiaFatigue(
  minutesSinceWake: number,
  cfg = DEFAULT_BODY_CONFIG,
  sleepHours?: number,
  sleepQuality?: number,
): number {
  if (minutesSinceWake < 0) return 0;

  // Scale inertia duration by sleep quality/hours
  let inertiaDuration = cfg.sleepInertiaMinutes; // default 30
  let peakInertia = cfg.sleepInertiaFatigue;     // default 2

  if (sleepHours !== undefined && sleepHours < 6) {
    // Short sleep: extend to 60-90 min
    inertiaDuration = Math.min(90, inertiaDuration + (6 - sleepHours) * 15);
  }
  if (sleepQuality !== undefined && sleepQuality < 7) {
    // Poor quality: scale peak inertia up and extend duration
    peakInertia *= (1 + (7 - sleepQuality) * 0.2);
    inertiaDuration = Math.max(inertiaDuration, 30 + (7 - sleepQuality) * 8);
  }

  if (minutesSinceWake > inertiaDuration) return 0;
  return peakInertia * (1 - minutesSinceWake / inertiaDuration);
}

/**
 * Calculate sleep debt from last night's sleep.
 * @param currentDebt existing sleep debt
 * @param sleepHours hours slept last night
 * @param sleepQuality quality 1-10
 */
export function updateSleepDebt(
  currentDebt: number,
  sleepHours: number,
  sleepQuality: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  const effectiveSleep = sleepHours * (0.6 + (sleepQuality / 10) * 0.4);
  const newDebt = currentDebt * (1 - cfg.sleepDebtRecoveryRate) + (cfg.idealSleepHours - effectiveSleep);
  return Math.max(0, newDebt);
}

// ── Hunger: Exponential Model ──────────────────────────────────────

/**
 * Exponential hunger model — rises quickly then plateaus.
 * hunger = max * (1 - exp(-ln2/halfLife * hours))
 */
export function calculateHunger(
  hoursSinceLastMeal: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  if (hoursSinceLastMeal <= 0) return 0;
  const lambda = Math.LN2 / cfg.hungerHalfLife;
  return cfg.hungerMax * (1 - Math.exp(-lambda * hoursSinceLastMeal));
}

// ── Caffeine: Two-Phase Model ──────────────────────────────────────

/**
 * Two-phase caffeine model:
 * - Phase 1 (0 to absorptionMinutes): Rising via 1 - exp(-absorption*t)
 * - Phase 2 (absorptionMinutes+): Falling via exp(-elimination*t)
 */
export function calculateCaffeine(
  minutesSinceCoffee: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  if (minutesSinceCoffee < 0) return 0;

  const peakMinutes = cfg.caffeineAbsorptionMinutes;
  const peak = cfg.caffeinePeakLevel;
  const absorptionRate = 3 / peakMinutes; // reaches ~95% at peak time

  if (minutesSinceCoffee <= peakMinutes) {
    // Absorption phase: rising
    return peak * (1 - Math.exp(-absorptionRate * minutesSinceCoffee));
  } else {
    // Elimination phase: falling
    const minutesPastPeak = minutesSinceCoffee - peakMinutes;
    const halfLifeMinutes = cfg.caffeineHalfLife * 60;
    const eliminationRate = Math.LN2 / halfLifeMinutes;
    return peak * Math.exp(-eliminationRate * minutesPastPeak);
  }
}

// ── Exercise: Three-Phase Model ────────────────────────────────────

/**
 * Exercise fatigue effect at a given time after exercise.
 * Three phases:
 * 1. During/just after: +fatigueCost
 * 2. Recovery: linearly improving from fatigueCost to 0
 * 3. Post-recovery: peakBenefit (net negative fatigue = energy boost)
 */
export function exerciseFatigueEffect(
  hoursSinceExercise: number,
  profile: ExerciseProfile,
): number {
  if (hoursSinceExercise < 0) return 0;

  // During exercise / immediately after (first 30 min)
  if (hoursSinceExercise < 0.5) {
    return profile.fatigueCost;
  }

  // Recovery phase: linear from fatigueCost to 0
  if (hoursSinceExercise < profile.recoveryHours) {
    const progress = (hoursSinceExercise - 0.5) / (profile.recoveryHours - 0.5);
    return profile.fatigueCost * (1 - progress);
  }

  // Post-recovery: net benefit (negative = less fatigue)
  return profile.peakBenefit;
}

// ── Weather Comfort ────────────────────────────────────────────────

/**
 * Weather comfort score (0-1, 1 = perfect comfort).
 */
export function weatherComfort(
  tempC: number | undefined,
  humidityPercent: number | undefined,
  isRaining: boolean,
  isCommuteHour: boolean,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  let comfort = 1.0;

  if (tempC !== undefined) {
    if (tempC < cfg.tempComfortMin) {
      comfort -= Math.min(0.3, (cfg.tempComfortMin - tempC) * 0.03);
    } else if (tempC > cfg.tempComfortMax) {
      comfort -= Math.min(0.3, (tempC - cfg.tempComfortMax) * 0.03);
    }
  }

  if (humidityPercent !== undefined) {
    if (humidityPercent < cfg.humidityComfortMin) {
      comfort -= 0.1;
    } else if (humidityPercent > cfg.humidityComfortMax) {
      comfort -= Math.min(0.2, (humidityPercent - cfg.humidityComfortMax) * 0.005);
    }
  }

  if (isRaining && isCommuteHour) {
    comfort -= 0.2;
  } else if (isRaining) {
    comfort -= 0.05;
  }

  return Math.max(0, comfort);
}

// ── Sickness: Biphasic Recovery ────────────────────────────────────

/**
 * Biphasic sickness recovery — severity change per day.
 * Days 1-2: Acute (can worsen slightly)
 * Days 3-4: Plateau (slow improvement)
 * Days 5+: Recovery (faster improvement)
 */
export function sicknessSeverityDelta(
  dayNumber: number,
  cfg = DEFAULT_BODY_CONFIG,
): number {
  if (dayNumber <= cfg.sickAcuteDays) {
    // Acute phase: slight worsening possible (0 to +0.5)
    return 0.3;
  } else if (dayNumber <= cfg.sickPlateauDays) {
    // Plateau phase: slow improvement
    return -cfg.sickPlateauRecoveryRate;
  } else {
    // Recovery phase: faster improvement
    return -cfg.sickRecoveryRate;
  }
}

// ── Menstrual Cycle ────────────────────────────────────────────────

export type ExtendedPeriodPhase =
  | "period_heavy"
  | "period_light"
  | "follicular"    // NEW: post-period, rising energy
  | "ovulation"
  | "pms"
  | "none";

/**
 * Determine menstrual cycle phase from day of cycle.
 */
export function getCyclePhase(
  dayOfCycle: number,
  cycleLength: number,
  periodLength: number,
  cfg = DEFAULT_BODY_CONFIG,
): ExtendedPeriodPhase {
  if (dayOfCycle <= 2) return "period_heavy";
  if (dayOfCycle <= periodLength) return "period_light";
  if (dayOfCycle <= periodLength + cfg.follicularBoostDays) return "follicular";
  if (dayOfCycle >= 12 && dayOfCycle <= 16) return "ovulation";
  if (dayOfCycle >= cycleLength - cfg.pmsWindowDays) return "pms";
  return "none";
}

// ── Utility ────────────────────────────────────────────────────────

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
