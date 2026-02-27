/**
 * Body simulation configuration — all magic numbers in one place.
 * Testable, tunable, documented.
 */

export interface BodyConfig {
  // Sleep
  idealSleepHours: number;
  sleepDebtRecoveryRate: number;   // fraction recovered per night (0.7 = 70%)
  sleepDebtFatigueMax: number;     // max fatigue contribution from sleep debt
  sleepInertiaMinutes: number;     // duration of sleep inertia after waking
  sleepInertiaFatigue: number;     // peak fatigue boost from sleep inertia

  // Fatigue (Two-Process Model)
  homeostaticExponent: number;     // processS exponent (>1 = non-linear)
  homeostaticRate: number;         // processS multiplier
  circadianAmplitude: number;      // processC amplitude
  circadianNadirHour: number;      // hour of lowest alertness (typically 4am)

  // Hunger
  hungerHalfLife: number;          // hours for hunger to reach half-max
  hungerMax: number;               // asymptotic max hunger

  // Caffeine (two-phase model)
  caffeinePeakLevel: number;       // peak caffeine effect (0-10 scale)
  caffeineAbsorptionMinutes: number; // time to peak
  caffeineHalfLife: number;        // elimination half-life in hours

  // Exercise intensity profiles
  exerciseProfiles: Record<string, ExerciseProfile>;

  // Weather comfort
  tempComfortMin: number;          // °C
  tempComfortMax: number;          // °C
  humidityComfortMin: number;      // %
  humidityComfortMax: number;      // %

  // Sickness
  sickAcuteDays: number;           // days 1-N: acute phase
  sickPlateauDays: number;         // days N+1 to M: plateau
  sickPlateauRecoveryRate: number; // severity reduction per day during plateau
  sickRecoveryRate: number;        // severity reduction per day during recovery

  // Menstrual cycle
  pmsWindowDays: number;           // days before period for PMS (luteal phase)
  follicularBoostDays: number;     // days of increased energy after period
  cycleVariationDays: number;      // +/- random variation per cycle
}

export interface ExerciseProfile {
  fatigueCost: number;      // immediate fatigue increase during exercise
  recoveryHours: number;    // hours until peak benefit
  peakBenefit: number;      // net fatigue reduction after recovery
  moodBoost: number;        // mood boost value
}

export const DEFAULT_BODY_CONFIG: BodyConfig = {
  // Sleep
  idealSleepHours: 7.5,
  sleepDebtRecoveryRate: 0.7,
  sleepDebtFatigueMax: 3,
  sleepInertiaMinutes: 30,
  sleepInertiaFatigue: 2,

  // Fatigue (Two-Process Model)
  homeostaticExponent: 1.15,
  homeostaticRate: 0.35,
  circadianAmplitude: 2.0,
  circadianNadirHour: 4,

  // Hunger
  hungerHalfLife: 2.5,
  hungerMax: 10,

  // Caffeine
  caffeinePeakLevel: 7,
  caffeineAbsorptionMinutes: 45,
  caffeineHalfLife: 5,

  // Exercise
  exerciseProfiles: {
    "running": { fatigueCost: 2.5, recoveryHours: 1.5, peakBenefit: -2.0, moodBoost: 1.5 },
    "yoga": { fatigueCost: 0.5, recoveryHours: 0.5, peakBenefit: -1.5, moodBoost: 2.0 },
    "tennis": { fatigueCost: 3.0, recoveryHours: 2.0, peakBenefit: -2.5, moodBoost: 2.0 },
    "gym": { fatigueCost: 2.0, recoveryHours: 1.5, peakBenefit: -1.5, moodBoost: 1.0 },
  },

  // Weather comfort
  tempComfortMin: 18,
  tempComfortMax: 24,
  humidityComfortMin: 30,
  humidityComfortMax: 60,

  // Sickness
  sickAcuteDays: 2,
  sickPlateauDays: 4,
  sickPlateauRecoveryRate: 0.8,
  sickRecoveryRate: 2.0,

  // Menstrual cycle
  pmsWindowDays: 5,
  follicularBoostDays: 5,
  cycleVariationDays: 2,
};
