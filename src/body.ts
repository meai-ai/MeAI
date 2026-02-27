/**
 * Body state engine — gives the character a physical body.
 *
 * Tracks fatigue, hunger, caffeine, physical comfort, exercise,
 * menstrual cycle, and illness/sickness.
 *
 * State is derived from:
 * - Daily schedule (meals, sleep, exercise) — deterministic rules
 * - Persistent health state (period cycle, sick days) — file-based
 *
 * The body state feeds into:
 * 1. emotion.ts — tired/cramping/sick affects mood
 * 2. context.ts — injected into system prompt so she naturally
 *    mentions being tired, hungry, on her period, or feeling sick
 * 3. world.ts — schedule generation adjusts for period/sickness
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { getSleepData, getMealBlocks, getWorkContext, fetchWeather } from "./world.js";
import {
  calculateProcessS, calculateProcessC, sleepDebtFatigue, sleepInertiaFatigue,
  updateSleepDebt, calculateHunger, calculateCaffeine, exerciseFatigueEffect,
  weatherComfort, sicknessSeverityDelta, getCyclePhase,
  clamp, type ExtendedPeriodPhase,
} from "./lib/body-calculations.js";
import { DEFAULT_BODY_CONFIG } from "./lib/body-config.js";
import { createLogger } from "./lib/logger.js";
import { getCharacter, s, renderTemplate } from "./character.js";

const log = createLogger("body");

// ── Types ────────────────────────────────────────────────────────────


export interface BodyState {
  // Sleep & fatigue
  sleepQuality: number;       // 1-10 from last night
  sleepHours: number;         // hours slept
  fatigue: number;            // 1-10 current tiredness (grows through day)

  // Hunger
  hunger: number;             // 1-10 (0 after eating, grows over hours)
  lastMeal: string | null;    // e.g. "12:30 lunch — pho from downstairs"

  // Caffeine
  caffeineLevel: number;      // 0-10 (spikes after coffee, decays)
  lastCoffee: string | null;  // "7:15 oat latte"

  // Physical comfort
  comfort: number;            // 1-10
  physicalNotes: string[];    // e.g. ["legs sore after tennis", "neck stiff from sitting too long"]

  // Exercise
  exercisedToday: boolean;
  exerciseDetail: string | null;  // e.g. "morning 3km run" | "yoga class"

  // Menstrual cycle
  periodStatus: PeriodStatus;

  // Illness
  sickStatus: SickStatus;

  // Meta
  sleepNote: string;          // from schedule, e.g. "pet stepped on face at night"
}

/** Menstrual cycle phases */
export type PeriodPhase =
  | "none"         // not on period, feeling fine
  | "pms"          // PMS: 1-3 days before period (irritable, bloated, cravings)
  | "period_heavy" // day 1-2: heavy flow, cramps, low energy
  | "period_light" // day 3-5: lighter, manageable
  | "follicular"   // post-period, gradually increasing energy
  | "ovulation";   // mid-cycle: higher energy, better mood

export interface PeriodStatus {
  phase: PeriodPhase;
  dayOfCycle: number;        // 1-28 (day 1 = first day of period)
  symptoms: string[];        // e.g. ["stomach ache", "craving sweets"]
  impactOnMood: string;      // e.g. "a bit irritable" | "normal" | "energetic"
}

/** Sickness states */
export type SickType =
  | "none"
  | "cold"          // cold: runny nose, sore throat
  | "headache"      // headache
  | "stomach"       // stomach issues
  | "allergies"     // allergies (common in SF spring)
  | "recovering";   // just recovered, still weak

export interface SickStatus {
  type: SickType;
  severity: number;          // 0-10 (0 = not sick)
  dayNumber: number;         // how many days sick (0 = not sick)
  symptoms: string[];        // e.g. ["stuffy nose", "sore throat"]
  note: string;              // e.g. "probably from getting rained on yesterday"
}

// ── Persistent Health State ──────────────────────────────────────────

let dataPath = "";

export function initBody(statePath: string): void {
  dataPath = statePath;
}

interface HealthState {
  // Menstrual cycle
  cycleStartDate: string;    // ISO date of last period start
  cycleLength: number;       // typical cycle length (25-35 days)
  periodLength: number;      // typical period length (3-7 days)

  // Sickness
  sickType: SickType;
  sickStartDate: string;     // ISO date when got sick
  sickSeverity: number;      // current severity 0-10
  sickNote: string;

  // Sleep debt tracking
  sleepDebt: number;
  sleepHistory: Array<{ date: string; hours: number; quality: number }>;

  lastUpdated: string;
}

function getHealthPath(): string {
  return path.join(dataPath, "health-state.json");
}

function loadHealthState(): HealthState {
  if (!dataPath) return defaultHealthState();
  const p = getHealthPath();
  if (!fs.existsSync(p)) {
    const state = defaultHealthState();
    saveHealthState(state);
    return state;
  }
  const defaults = defaultHealthState();
  const loaded = readJsonSafe<HealthState>(p, defaults);
  // Backfill fields added after initial schema
  if (!loaded.sleepHistory) loaded.sleepHistory = defaults.sleepHistory;
  if (loaded.sleepDebt == null) loaded.sleepDebt = defaults.sleepDebt;
  return loaded;
}

function saveHealthState(state: HealthState): void {
  if (!dataPath) return;
  state.lastUpdated = pstDateStr();
  writeJsonAtomic(getHealthPath(), state);
}

function defaultHealthState(): HealthState {
  // Initialize with a plausible cycle start date
  // Period typically lasts 4-6 days, cycle 26-32 days
  // Set the last start date to be a random point in the current cycle
  const now = new Date();
  const daysIntoCycle = Math.floor(Math.random() * 28);
  const startDate = new Date(now.getTime() - daysIntoCycle * 24 * 60 * 60 * 1000);

  return {
    cycleStartDate: pstDateStr(startDate),
    cycleLength: 28 + Math.floor(Math.random() * 5) - 2, // 26-30
    periodLength: 4 + Math.floor(Math.random() * 2),       // 4-5
    sickType: "none",
    sickStartDate: "",
    sickSeverity: 0,
    sickNote: "",
    sleepDebt: 0,
    sleepHistory: [],
    lastUpdated: pstDateStr(now),
  };
}

// ── Period Cycle Logic ───────────────────────────────────────────────

function calculatePeriodStatus(now: Date): PeriodStatus {
  // Guard: skip menstrual cycle if character config disables it
  if (!getCharacter().body.menstrual_cycle) {
    return { phase: "none", dayOfCycle: 0, symptoms: [], impactOnMood: s().body.normal_mood };
  }

  const health = loadHealthState();
  const cycleStart = new Date(health.cycleStartDate);
  const daysSinceStart = Math.floor((now.getTime() - cycleStart.getTime()) / (24 * 60 * 60 * 1000));

  // Calculate day within current cycle (wraps around)
  let dayOfCycle = (daysSinceStart % health.cycleLength) + 1;
  if (dayOfCycle <= 0) dayOfCycle += health.cycleLength;

  // Auto-advance cycle start date if we've passed a full cycle
  if (daysSinceStart >= health.cycleLength) {
    const cyclesElapsed = Math.floor(daysSinceStart / health.cycleLength);
    const variation = Math.floor(Math.random() * (DEFAULT_BODY_CONFIG.cycleVariationDays * 2 + 1)) - DEFAULT_BODY_CONFIG.cycleVariationDays;
    const newStart = new Date(cycleStart.getTime() + cyclesElapsed * health.cycleLength * 24 * 60 * 60 * 1000);
    health.cycleStartDate = pstDateStr(newStart);
    health.cycleLength = 28 + variation; // vary cycle length
    saveHealthState(health);
  }

  // Determine phase based on day of cycle using pure calculation
  const symptoms: string[] = [];
  const extPhase = getCyclePhase(dayOfCycle, health.cycleLength, health.periodLength);
  const phase: PeriodPhase = extPhase as PeriodPhase;  // ExtendedPeriodPhase is superset
  let impactOnMood: string;

  switch (extPhase) {
    case "period_heavy":
      symptoms.push(s().body.cramps);
      symptoms.push(s().body.tired);
      if (dayOfCycle === 1) symptoms.push(s().body.backache);
      impactOnMood = s().body.period_heavy_mood;
      break;
    case "period_light":
      if (dayOfCycle <= health.periodLength - 1) symptoms.push(s().body.still_uncomfortable);
      impactOnMood = s().body.period_light_mood;
      break;
    case "follicular":
      impactOnMood = s().body.follicular_mood;
      break;
    case "ovulation":
      impactOnMood = s().body.ovulation_mood;
      break;
    case "pms":
      symptoms.push(s().body.irritable);
      if (dayOfCycle >= health.cycleLength - 2) symptoms.push(s().body.cravings);
      if (dayOfCycle >= health.cycleLength - 1) symptoms.push(s().body.bloated);
      impactOnMood = s().body.pms_mood;
      break;
    default:
      impactOnMood = s().body.normal_mood;
  }

  return { phase, dayOfCycle, symptoms, impactOnMood };
}

// ── Sickness Logic ───────────────────────────────────────────────────

/**
 * Daily sickness roll — small chance of getting sick each day.
 * Called once per day during schedule generation.
 *
 * Factors that increase chance:
 * - Bad sleep (< 6 hours or quality < 5)
 * - Rainy/cold weather
 * - Spring (allergy season in SF: Feb-May)
 * - Period (immune system slightly weakened)
 */
export function rollDailySickness(context: {
  sleepQuality: number;
  isRaining: boolean;
  month: number;
  periodPhase: PeriodPhase;
}): void {
  const health = loadHealthState();
  const today = pstDateStr();

  // If already sick, progress the illness (biphasic model)
  if (health.sickType !== "none") {
    const startDate = new Date(health.sickStartDate);
    const dayNumber = Math.floor((new Date().getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const delta = sicknessSeverityDelta(dayNumber);
    health.sickSeverity = Math.max(0, health.sickSeverity + delta);
    if (health.sickSeverity <= 1) {
      // Transition to recovering
      if (health.sickType !== "recovering") {
        health.sickType = "recovering";
        health.sickSeverity = 2;
        health.sickNote = s().body.sick_recovering_note;
      } else {
        // Fully recovered
        health.sickType = "none";
        health.sickSeverity = 0;
        health.sickNote = "";
        health.sickStartDate = "";
      }
    }
    saveHealthState(health);
    return;
  }

  // Base chance of getting sick: ~3% per day
  let sickChance = 0.03;

  // Bad sleep increases chance
  if (context.sleepQuality < 5) sickChance += 0.02;

  // Rain/cold
  if (context.isRaining) sickChance += 0.01;

  // Allergy season (configurable months from character.yaml)
  const allergyMonths = getCharacter().body.allergy_months;
  if (allergyMonths.includes(context.month)) sickChance += 0.015;

  // PMS/period slightly weakened immune
  if (context.periodPhase === "pms" || context.periodPhase === "period_heavy") {
    sickChance += 0.01;
  }

  // Roll the dice
  if (Math.random() < sickChance) {
    // Got sick! Determine type
    const types: Array<{ type: SickType; weight: number; note: string }> = [
      { type: "cold", weight: 40, note: s().body.sick_note_cold },
      { type: "headache", weight: 20, note: s().body.sick_note_headache },
      { type: "stomach", weight: 15, note: s().body.sick_note_stomach },
    ];

    // Allergies more likely during configured allergy months
    if (allergyMonths.includes(context.month)) {
      const allergyNote = getCharacter().body.allergy_note ?? s().body.allergy_default;
      types.push({ type: "allergies", weight: 25, note: allergyNote });
    }

    // Weighted random selection
    const totalWeight = types.reduce((sum, t) => sum + t.weight, 0);
    let roll = Math.random() * totalWeight;
    let selected = types[0];
    for (const t of types) {
      roll -= t.weight;
      if (roll <= 0) { selected = t; break; }
    }

    health.sickType = selected.type;
    health.sickStartDate = today;
    health.sickSeverity = 4 + Math.floor(Math.random() * 4); // 4-7
    health.sickNote = selected.note;
    saveHealthState(health);

    log.info(`${getCharacter().name} got sick: ${selected.type} (severity ${health.sickSeverity}) — ${selected.note}`);
  }
}

function calculateSickStatus(): SickStatus {
  const health = loadHealthState();

  if (health.sickType === "none") {
    return { type: "none", severity: 0, dayNumber: 0, symptoms: [], note: "" };
  }

  const startDate = new Date(health.sickStartDate);
  const now = new Date();
  const dayNumber = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

  const symptoms: string[] = [];

  switch (health.sickType) {
    case "cold":
      if (health.sickSeverity >= 5) {
        symptoms.push(s().body.stuffy_nose);
        symptoms.push(s().body.sore_throat);
        if (Math.random() < 0.4) symptoms.push(s().body.mild_fever);
      } else {
        symptoms.push(s().body.still_stuffy);
        if (Math.random() < 0.3) symptoms.push(s().body.occasional_cough);
      }
      break;
    case "headache":
      symptoms.push(health.sickSeverity >= 5 ? s().body.bad_headache : s().body.dull_headache);
      break;
    case "stomach":
      if (health.sickSeverity >= 5) {
        symptoms.push(s().body.stomach_upset);
        symptoms.push(s().body.no_appetite);
      } else {
        symptoms.push(s().body.stomach_lingering);
      }
      break;
    case "allergies":
      symptoms.push(s().body.sneezing);
      if (health.sickSeverity >= 5) symptoms.push(s().body.itchy_eyes);
      symptoms.push(s().body.stuffy_nose);
      break;
    case "recovering":
      symptoms.push(s().body.mostly_better);
      break;
  }

  return {
    type: health.sickType,
    severity: health.sickSeverity,
    dayNumber,
    symptoms,
    note: health.sickNote,
  };
}

// ── Core Logic ───────────────────────────────────────────────────────

/**
 * Calculate current body state from schedule data + persistent health state.
 * Rule-based derivation — fast and deterministic.
 */
export async function getBodyState(now: Date = new Date()): Promise<BodyState> {
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const currentHour = userTime.getHours() + userTime.getMinutes() / 60;

  // ── Sleep data ──
  const sleep = await getSleepData();
  const sleepQuality = sleep.quality;

  // Parse wake/bed times to calculate hours
  const wakeHour = parseTimeToHour(sleep.wakeTime);
  const bedHour = parseTimeToHour(sleep.bedtime);
  // Sleep hours: bedtime is previous night, so 23:30→7:15 = 7.75h
  const sleepHours = bedHour > wakeHour
    ? (24 - bedHour + wakeHour) // crossed midnight
    : (wakeHour - bedHour); // weird but handle it

  // ── Period status ──
  const periodStatus = calculatePeriodStatus(userTime);

  // ── Sick status ──
  const sickStatus = calculateSickStatus();

  // ── Health state (loaded once for sleep debt + later use) ──
  const health = loadHealthState();

  // ── Sleep debt tracking ──
  const todayStr = pstDateStr();
  const lastHistoryDate = health.sleepHistory.length > 0
    ? health.sleepHistory[health.sleepHistory.length - 1].date : "";
  if (lastHistoryDate !== todayStr) {
    health.sleepDebt = updateSleepDebt(health.sleepDebt, sleepHours, sleepQuality);
    health.sleepHistory.push({ date: todayStr, hours: sleepHours, quality: sleepQuality });
    // Keep last 7 days
    if (health.sleepHistory.length > 7) health.sleepHistory = health.sleepHistory.slice(-7);
    saveHealthState(health);
  }

  // ── Fatigue (Two-Process Model) ──
  const hoursSinceWake = Math.max(0, currentHour - wakeHour);
  const minutesSinceWake = hoursSinceWake * 60;
  const baseFatigue = Math.max(1, 10 - sleepQuality);

  // Process S: homeostatic pressure (non-linear)
  const processS = calculateProcessS(hoursSinceWake);
  // Process C: circadian rhythm
  const processC = calculateProcessC(currentHour);
  // Sleep debt effect
  const debtEffect = sleepDebtFatigue(health.sleepDebt);
  // Sleep inertia (duration scales with sleep quality/hours)
  const inertiaEffect = sleepInertiaFatigue(minutesSinceWake, DEFAULT_BODY_CONFIG, sleepHours, sleepQuality);

  let fatigue = baseFatigue + processS + processC + debtEffect + inertiaEffect;
  // Post-lunch dip (13:00-15:00)
  if (currentHour >= 13 && currentHour <= 15) fatigue += 1.5;
  // Late night penalty
  if (currentHour >= 22) fatigue += 2;
  // Period fatigue boost
  if (periodStatus.phase === "period_heavy") fatigue += 2;
  else if (periodStatus.phase === "period_light") fatigue += 0.5;
  else if (periodStatus.phase === "pms") fatigue += 1;
  else if (periodStatus.phase === "follicular") fatigue -= 0.5; // rising energy
  // Ovulation energy boost
  if (periodStatus.phase === "ovulation") fatigue -= 1;
  // Sickness fatigue
  if (sickStatus.severity > 0) fatigue += sickStatus.severity * 0.5;
  fatigue = clamp(Math.round(fatigue), 1, 10);

  // ── Meals & Hunger ──
  const meals = await getMealBlocks();
  let lastMeal: string | null = null;
  let hoursSinceLastMeal = 999;

  for (const meal of meals) {
    if (meal.start <= currentHour) {
      lastMeal = `${meal.start}:00 ${meal.activity}`;
      hoursSinceLastMeal = currentHour - meal.end;
    }
  }

  // Hunger: exponential model (rises quickly then plateaus)
  let hunger = calculateHunger(hoursSinceLastMeal);
  // Morning hunger if haven't eaten
  if (!lastMeal && currentHour >= wakeHour + 1) {
    hunger = Math.min(10, (currentHour - wakeHour) * 1.5);
  }
  // PMS cravings increase hunger perception
  if (periodStatus.phase === "pms") hunger += 1.5;
  // Stomach sickness reduces hunger
  if (sickStatus.type === "stomach") hunger = Math.max(1, hunger - 3);
  hunger = clamp(Math.round(hunger), 1, 10);

  // ── Caffeine (Two-Phase Model) ──
  const coffeeHour = Math.max(wakeHour, getCharacter().body.caffeine_default_hour);
  const minutesSinceCoffee = (currentHour - coffeeHour) * 60;
  let caffeineLevel = calculateCaffeine(minutesSinceCoffee);
  if (currentHour < coffeeHour) caffeineLevel = 0;
  if (sickStatus.type === "stomach" && sickStatus.severity >= 5) caffeineLevel = 0;
  caffeineLevel = clamp(Math.round(caffeineLevel), 0, 10);

  // Caffeine reduces fatigue
  fatigue = clamp(fatigue - Math.floor(caffeineLevel / 2), 1, 10);

  const lastCoffee = (currentHour >= coffeeHour && !(sickStatus.type === "stomach" && sickStatus.severity >= 5))
    ? `${Math.floor(coffeeHour)}:00 oat latte`
    : null;

  // ── Exercise ──
  const work = await getWorkContext(now);
  let exercisedToday = false;
  let exerciseDetail: string | null = null;

  if (work.currentBlock?.category === "exercise" || work.fullSchedule.includes("exercise")) {
    exercisedToday = true;
    exerciseDetail = work.currentBlock?.category === "exercise"
      ? work.currentBlock.activity
      : s().body.exercise_label;
  }

  // Look through the schedule text for exercise indicators
  const scheduleText = work.fullSchedule;
  const exerciseKeywords = s().patterns.exercise_keywords;
  const exerciseRegex = new RegExp(exerciseKeywords.join("|"), "i");
  if (exerciseRegex.test(scheduleText)) {
    const exerciseMatch = scheduleText.match(new RegExp(`(\\d+):00.*(?:${exerciseKeywords.join("|")})`, "i"));
    if (exerciseMatch) {
      const exerciseHour = parseInt(exerciseMatch[1]);
      if (currentHour > exerciseHour) {
        exercisedToday = true;
        for (const kw of exerciseKeywords) {
          if (scheduleText.toLowerCase().includes(kw.toLowerCase())) { exerciseDetail = kw; break; }
        }
      }
    }
  }

  // Exercise: three-phase intensity model
  if (exercisedToday && exerciseDetail) {
    const profile = DEFAULT_BODY_CONFIG.exerciseProfiles[exerciseDetail]
      ?? DEFAULT_BODY_CONFIG.exerciseProfiles[exerciseKeywords[exerciseKeywords.length - 1]] // fallback to last keyword
      ?? Object.values(DEFAULT_BODY_CONFIG.exerciseProfiles)[0]; // fallback to any profile
    if (profile) {
      const exerciseMatch2 = scheduleText.match(new RegExp(`(\\d+):00.*(?:${exerciseKeywords.join("|")})`, "i"));
      const exerciseHour2 = exerciseMatch2 ? parseInt(exerciseMatch2[1]) : currentHour - 1;
      const hoursSinceExercise = currentHour - exerciseHour2;
      fatigue += exerciseFatigueEffect(hoursSinceExercise, profile);
    }
  }

  // ── Weather comfort ──
  const weather = await fetchWeather();
  const isCommuteHour = (currentHour >= 8 && currentHour <= 9) || (currentHour >= 17 && currentHour <= 18.5);
  const rainConditions = s().patterns.rain_conditions;
  const isRaining = weather ? rainConditions.some(c => weather.condition.toLowerCase().includes(c.toLowerCase())) : false;
  const weatherComfortScore = weatherComfort(
    weather?.temperature, undefined, isRaining, isCommuteHour,
  );
  // Weather discomfort adds fatigue (too hot, too cold, rain during commute)
  if (weatherComfortScore < 0.7) {
    fatigue = clamp(fatigue + Math.round((1 - weatherComfortScore) * 2), 1, 10);
  }

  // ── Physical notes ──
  const physicalNotes: string[] = [];
  if (sleepQuality <= 4) physicalNotes.push(s().body.bad_sleep_eyes);
  if (fatigue >= 7) physicalNotes.push(s().body.feeling_tired);
  if (hunger >= 7) physicalNotes.push(s().body.feeling_hungry);
  if (exercisedToday && exerciseDetail) {
    const ek = exerciseDetail.toLowerCase();
    if (ek.includes("run") || ek.includes("jog")) physicalNotes.push(s().body.ran_legs_sore);
    else if (ek.includes("tennis")) physicalNotes.push(s().body.tennis_arms_sore);
    else if (ek.includes("yoga")) physicalNotes.push(s().body.yoga_stretched);
  }
  // Weather discomfort
  if (weather && weatherComfortScore < 0.6) {
    if (weather.temperature < 10) physicalNotes.push(s().body.cold_outside);
    else if (weather.temperature > 30) physicalNotes.push(s().body.hot_outside);
    if (isRaining && isCommuteHour) physicalNotes.push(s().body.rain_commute);
    else if (isRaining) physicalNotes.push(s().body.raining);
  }
  // Sitting too long
  if (work.isWorkDay && currentHour >= 15 && currentHour < 18) {
    physicalNotes.push(s().body.sat_too_long);
  }
  // Period symptoms
  if (periodStatus.symptoms.length > 0) {
    physicalNotes.push(...periodStatus.symptoms);
  }
  // Sick symptoms
  if (sickStatus.symptoms.length > 0) {
    physicalNotes.push(...sickStatus.symptoms);
  }

  // ── Social battery depletion (2.5) ──
  // Count completed social blocks today — social events drain energy
  const socialKeywords = s().patterns.social_keywords;
  const pastBlocks = scheduleText.split("\n").filter(line => {
    const match = line.match(/(\d+):00/);
    return match && parseInt(match[1]) < currentHour;
  });
  let socialBlockCount = 0;
  for (const block of pastBlocks) {
    if (block.includes("[social]") || socialKeywords.some(kw => block.includes(kw))) {
      socialBlockCount++;
    }
  }
  // Each social block adds fatigue: 1-on-1 = low, group = higher
  if (socialBlockCount >= 3) {
    fatigue = clamp(fatigue + 2, 1, 10);
    physicalNotes.push(s().body.too_much_social);
  } else if (socialBlockCount >= 2) {
    fatigue = clamp(fatigue + 1, 1, 10);
  }

  // ── Comfort ──
  let comfort = 7;
  if (sleepQuality <= 4) comfort -= 2;
  if (hunger >= 7) comfort -= 1;
  if (fatigue >= 8) comfort -= 2;
  if (exercisedToday) comfort += 1; // exercise boost
  // Weather comfort penalty
  if (weatherComfortScore < 0.7) comfort -= Math.round((1 - weatherComfortScore) * 3);
  // Social battery depletion comfort penalty
  if (socialBlockCount >= 3) comfort -= 1;
  // Period discomfort
  if (periodStatus.phase === "period_heavy") comfort -= 3;
  else if (periodStatus.phase === "period_light") comfort -= 1;
  else if (periodStatus.phase === "pms") comfort -= 2;
  // Sickness discomfort
  if (sickStatus.severity > 0) comfort -= Math.ceil(sickStatus.severity / 2);
  comfort = clamp(comfort, 1, 10);

  return {
    sleepQuality,
    sleepHours: Math.round(sleepHours * 10) / 10,
    fatigue,
    hunger,
    lastMeal,
    caffeineLevel,
    lastCoffee,
    comfort,
    physicalNotes,
    exercisedToday,
    exerciseDetail,
    periodStatus,
    sickStatus,
    sleepNote: sleep.note,
  };
}

/**
 * Format body state as context for system prompt.
 */
export function formatBodyContext(body: BodyState): string {
  const lines: string[] = [];

  // Fatigue
  if (body.fatigue >= 7) {
    lines.push(`${s().body.energy}: ${body.fatigue}/10 — ${s().body.energy_tired}${body.sleepQuality <= 5 ? ` (${body.sleepNote})` : ""}`);
  } else if (body.fatigue <= 3) {
    lines.push(`${s().body.energy}: ${body.fatigue}/10 — ${s().body.energy_good}${body.caffeineLevel >= 5 ? ` ${s().body.coffee_helping}` : ""}`);
  } else {
    lines.push(`${s().body.energy}: ${body.fatigue}/10`);
  }

  // Hunger
  if (body.hunger >= 6) {
    lines.push(`${s().body.hunger}: ${body.hunger}/10 — ${body.hunger >= 8 ? s().body.hungry_starving : s().body.hungry_bit}`);
  } else if (body.lastMeal) {
    lines.push(`${s().body.last_meal}: ${body.lastMeal}`);
  }

  // Caffeine
  if (body.caffeineLevel >= 5) {
    lines.push(`${s().body.caffeine}: ${s().body.caffeine_online}${body.lastCoffee ? ` (${body.lastCoffee})` : ""}`);
  } else if (body.caffeineLevel > 0 && body.caffeineLevel < 3) {
    lines.push(`${s().body.caffeine}: ${s().body.caffeine_fading}`);
  }

  // Exercise
  if (body.exercisedToday && body.exerciseDetail) {
    lines.push(`${s().body.exercised_today}: ${body.exerciseDetail}`);
  }

  // Period status — only show when actively relevant
  const p = body.periodStatus;
  if (p.phase === "period_heavy") {
    lines.push(s().body.period_day_heavy.replace("{day}", String(p.dayOfCycle)).replace("{symptoms}", p.symptoms.join(", ")));
    lines.push(renderTemplate(s().body.period_privacy_note));
  } else if (p.phase === "period_light") {
    lines.push(s().body.period_ending.replace("{symptoms}", p.symptoms.length > 0 ? p.symptoms.join(", ") : s().body.period_light_mood));
  } else if (p.phase === "pms") {
    lines.push(s().body.pms_note.replace("{symptoms}", p.symptoms.join(", ")));
    lines.push(s().body.pms_behavior);
  } else if (p.phase === "follicular") {
    // Don't explicitly mention, just reflected in improving energy
  } else if (p.phase === "ovulation") {
    // Don't explicitly mention ovulation, just reflected in higher energy
  }

  // Sickness
  const sick = body.sickStatus;
  if (sick.type !== "none" && sick.severity > 0) {
    const sickLabel: Record<string, string> = {
      cold: s().body.sick_cold,
      headache: s().body.sick_headache,
      stomach: s().body.sick_stomach,
      allergies: s().body.sick_allergies,
      recovering: s().body.sick_recovering,
    };
    const label = sickLabel[sick.type] ?? s().body.sick_general;
    lines.push(`${s().body.body_status}: ${label} (${s().body.sick_day_label.replace("{day}", String(sick.dayNumber))}, ${sick.symptoms.join(", ")})`);
    if (sick.note) lines.push(`${s().body.sick_cause}: ${sick.note}`);
    if (sick.severity >= 6) {
      lines.push(s().body.sick_severe);
    } else if (sick.severity >= 3) {
      lines.push(s().body.sick_moderate);
    }
  }

  // Physical notes (deduplicated — period/sick symptoms already in notes)
  const existingNotes = new Set(lines.join(""));
  const extraNotes = body.physicalNotes.filter(n =>
    !existingNotes.has(n) &&
    !body.periodStatus.symptoms.includes(n) &&
    !body.sickStatus.symptoms.includes(n)
  );
  if (extraNotes.length > 0) {
    lines.push(`${s().body.physical_notes}: ${extraNotes.join("; ")}`);
  }

  return lines.join("\n");
}

// ── Public Helpers ───────────────────────────────────────────────────

/** Get current period phase — used by world.ts for schedule adjustments */
export function getCurrentPeriodPhase(): PeriodPhase {
  const now = new Date();
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  return calculatePeriodStatus(userTime).phase;
}

/** Get current sick status — used by world.ts for schedule adjustments */
export function getCurrentSickStatus(): SickStatus {
  return calculateSickStatus();
}

// ── Cycle Mood Modifiers (Phase 5.5) ────────────────────────────────

export interface CycleMoodModifiers {
  valenceShift: number;          // added to emotion valence
  irritabilityMultiplier: number; // 1.0 = normal, 1.3 = PMS irritable
  rejectionSensitivity: number;  // 1.0 = normal, 2.0 = PMS hypersensitive
  hint: string;                  // behaviorHints append
}

/** Return mood modifiers based on current menstrual cycle phase. */
export function getCycleMoodModifiers(): CycleMoodModifiers {
  if (!getCharacter().body.menstrual_cycle) {
    return { valenceShift: 0, irritabilityMultiplier: 1.0, rejectionSensitivity: 1.0, hint: "" };
  }

  const now = new Date();
  const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
  const status = calculatePeriodStatus(userTime);

  switch (status.phase) {
    case "pms":
      return {
        valenceShift: -0.5,
        irritabilityMultiplier: 1.3,
        rejectionSensitivity: 2.0,
        hint: s().body.pms_hint,
      };
    case "period_heavy":
      return {
        valenceShift: -1.0,
        irritabilityMultiplier: 1.2,
        rejectionSensitivity: 1.5,
        hint: s().body.period_heavy_hint,
      };
    case "period_light":
      return {
        valenceShift: -0.3,
        irritabilityMultiplier: 1.0,
        rejectionSensitivity: 1.2,
        hint: "",
      };
    case "follicular":
      return {
        valenceShift: 0.3,
        irritabilityMultiplier: 0.9,
        rejectionSensitivity: 0.8,
        hint: "",
      };
    case "ovulation":
      return {
        valenceShift: 0.5,
        irritabilityMultiplier: 0.8,
        rejectionSensitivity: 0.7,
        hint: "",
      };
    default:
      return {
        valenceShift: 0,
        irritabilityMultiplier: 1.0,
        rejectionSensitivity: 1.0,
        hint: "",
      };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Parse "7:15" or "23:30" to decimal hours */
function parseTimeToHour(timeStr: string): number {
  const parts = timeStr.split(":");
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h + m / 60;
}

