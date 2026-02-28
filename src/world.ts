/**
 * Real-world context — grounds the character in physical reality.
 *
 * Everything is LLM-generated, nothing hard-coded:
 * 1. Full-day schedule: 6:00-24:00 covering sleep, meals, commute, work, hobbies, socializing
 * 2. Daily watchlist: which stocks/indices to track today (LLM decides)
 * 3. Market data: live prices from Yahoo Finance for the watchlist
 * 4. Weather: real-time SF weather from Open-Meteo (free, no API key)
 * 5. Life context: body state, location, what she's doing NOW
 *
 * Both the schedule and watchlist are generated ONCE per day (first call),
 * cached, and used throughout the day.
 */

import fs from "node:fs";
import path from "node:path";
import { claudeText } from "./claude-runner.js";
import { fetchLocalEvents } from "./interests.js";
import { rollDailySickness, getCurrentPeriodPhase, getCurrentSickStatus } from "./body.js";
import { getStoreManager } from "./memory/store-manager.js";
import { getUserTZ } from "./lib/pst-date.js";
import { getCharacter, s, renderTemplate } from "./character.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TimeBlock {
  start: number;        // hour (e.g. 7)
  end: number;          // hour (e.g. 8)
  activity: string;     // e.g. "Getting oat latte at the cafe downstairs, browsing news on phone"
  busy: boolean;        // true = don't interrupt (meetings, focused work)
  location: string;     // e.g. "home" | "nearby cafe" | "office" | "commuting"
  category: string;     // sleep | morning | commute | work | meal | exercise | hobby | social | entertainment | pet | chores | rest
  details?: string;     // optional color: e.g. "pet sitting on pillow staring at me"
  withPeople?: string[];// who the character is with
}

interface WatchlistItem {
  ticker: string;   // Yahoo Finance symbol (e.g. "AAPL", "^GSPC")
  name: string;     // Display name (e.g. "Apple", "S&P 500")
}

/** Sleep log — generated with the daily schedule */
interface SleepLog {
  bedtime: string;      // "23:30"
  wakeTime: string;     // "7:15"
  quality: number;      // 1-10
  note: string;         // e.g. "pet stepped on my face at 3am" | "slept well"
}

/** Weather snapshot — fetched from Open-Meteo */
interface WeatherSnapshot {
  temperature: number;     // current °C
  feelsLike: number;       // apparent °C
  condition: string;       // e.g. "sunny" | "cloudy" | "foggy" | "light rain"
  high: number;            // today's high °C
  low: number;             // today's low °C
  rainChance: number;      // 0-100 %
  sunrise: string;         // "HH:MM" local time (from Open-Meteo)
  sunset: string;          // "HH:MM" local time (from Open-Meteo)
  fetchedAt: number;       // timestamp
}

interface DailySchedule {
  date: string;
  isWorkDay: boolean;
  blocks: TimeBlock[];       // FULL DAY: 6:00-24:00 time blocks
  dayOff: string;            // weekend/day-off: summary (kept for backward compat)
  watchlist: WatchlistItem[];
  sleep: SleepLog;           // last night's sleep
  outfit: string;            // what she's wearing today
  petMoments: string[];    // Pet moments throughout the day
}

// ── Constants ─────────────────────────────────────────────────────────

const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MARKET_CACHE_TTL = 30 * 60 * 1000;  // 30 minutes

// ── WorldEngine class ────────────────────────────────────────────────

export class WorldEngine {
  private dataPath: string;
  private weatherCache: WeatherSnapshot | null = null;
  private marketCache: { text: string; fetchedAt: number } | null = null;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Private helpers ──

  /** Get location detail from character.yaml places map */
  private getLocationDetail(location: string): string {
    const places = getCharacter().location.places;
    // Try exact match first
    if (places[location]) return places[location];
    // Try partial match
    for (const [key, detail] of Object.entries(places)) {
      if (location.includes(key) || key.includes(location)) return detail;
    }
    return location;
  }

  private getWmoDescription(code: number): string {
    const codes = s().weather_codes;
    return codes[String(code)] ?? s().schedule.unknown_weather;
  }

  /** Default schedule blocks so meal/commute blocks always exist even when LLM generation fails. */
  private defaultBlocks(isWorkDay: boolean): TimeBlock[] {
    if (isWorkDay) return [
      { start: 7, end: 8, activity: "wake up, morning routine", busy: false, location: "home", category: "morning" },
      { start: 8, end: 9, activity: "commute", busy: false, location: "commuting", category: "commute" },
      { start: 9, end: 12, activity: "morning work", busy: true, location: "office", category: "work" },
      { start: 12, end: 13, activity: "lunch", busy: false, location: "near office", category: "meal" },
      { start: 13, end: 18, activity: "afternoon work", busy: true, location: "office", category: "work" },
      { start: 18, end: 19, activity: "commute home", busy: false, location: "commuting home", category: "commute" },
      { start: 19, end: 20, activity: "cook dinner", busy: false, location: "home", category: "meal" },
      { start: 20, end: 22, activity: "relax", busy: false, location: "home", category: "entertainment" },
      { start: 22, end: 23, activity: "bedtime routine", busy: false, location: "home", category: "rest" },
    ];
    return [
      { start: 8, end: 9, activity: "sleep in, breakfast", busy: false, location: "home", category: "morning" },
      { start: 9, end: 12, activity: "free morning", busy: false, location: "home", category: "rest" },
      { start: 12, end: 13, activity: "lunch", busy: false, location: "home", category: "meal" },
      { start: 13, end: 17, activity: "afternoon activity", busy: false, location: "out", category: "hobby" },
      { start: 17, end: 18, activity: "rest at home", busy: false, location: "home", category: "rest" },
      { start: 18, end: 19, activity: "cook dinner", busy: false, location: "home", category: "meal" },
      { start: 19, end: 22, activity: "evening relaxation", busy: false, location: "home", category: "entertainment" },
      { start: 22, end: 23, activity: "bedtime routine", busy: false, location: "home", category: "rest" },
    ];
  }

  // ── Schedule cache (file-based) ──

  private getScheduleCachePath(): string {
    return path.join(this.dataPath, "daily-schedule.json");
  }

  private loadCachedSchedule(): DailySchedule | null {
    if (!this.dataPath) return null;
    const p = this.getScheduleCachePath();
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as DailySchedule;
    } catch {
      return null;
    }
  }

  private saveCachedSchedule(schedule: DailySchedule): void {
    if (!this.dataPath) return;
    fs.writeFileSync(this.getScheduleCachePath(), JSON.stringify(schedule, null, 2) + "\n");
  }

  /** Read watchlist from cached schedule without triggering generation. */
  loadCachedWatchlist(): WatchlistItem[] {
    const cached = this.loadCachedSchedule();
    if (!cached) return [];
    // Only use if it's today's schedule
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const todayStr = `${userTime.getFullYear()}-${String(userTime.getMonth() + 1).padStart(2, "0")}-${String(userTime.getDate()).padStart(2, "0")}`;
    if (cached.date !== todayStr) return [];
    return cached.watchlist ?? [];
  }

  private loadFile(...segments: string[]): string {
    if (!this.dataPath) return "";
    const p = path.join(this.dataPath, ...segments);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf-8").trim();
  }

  private loadRecentMemories(): string {
    try {
      const memories = getStoreManager().loadCategories("core", "emotional");
      return memories
        .slice(-8)
        .map(m => `${m.key}: ${m.value}`)
        .join("\n");
    } catch {
      return "";
    }
  }

  /** Summarize previous day's schedule for continuity context. */
  private formatPreviousDay(prev: DailySchedule): string {
    const parts: string[] = [];
    if (prev.blocks.length > 0) {
      // Summarize key activities (skip sleep/morning/rest categories)
      const notable = prev.blocks
        .filter(b => !["sleep", "morning", "rest"].includes(b.category))
        .map(b => {
          const people = Array.isArray(b.withPeople) && b.withPeople.length ? ` (${s().schedule.with_people.replace("{people}", b.withPeople.join(", "))})` : "";
          return `${b.activity}${people}`;
        });
      if (notable.length > 0) {
        parts.push(s().schedule.schedule_label + ": " + notable.join(", "));
      }
    }
    if (prev.dayOff) {
      parts.push(s().schedule.plan_label + ": " + prev.dayOff);
    }
    if (prev.watchlist?.length > 0) {
      parts.push(s().schedule.watchlist_label + ": " + prev.watchlist.map(w => `${w.name}(${w.ticker})`).join(", "));
    }
    if (prev.sleep) {
      parts.push(`${s().schedule.yesterday_sleep}: ${prev.sleep.quality}/10 — ${prev.sleep.note}`);
    }
    return parts.join("\n");
  }

  /** Format the full day schedule with current time marker */
  private formatFullDaySchedule(schedule: DailySchedule, currentHour?: number): string {
    if (schedule.blocks.length === 0) {
      return schedule.dayOff || "";
    }

    const lines: string[] = [];

    for (const b of schedule.blocks) {
      const isCurrent = currentHour !== undefined && currentHour >= b.start && currentHour < b.end;
      const marker = isCurrent ? ` ${s().time.now_marker}` : "";
      const location = b.location ? ` [${b.location}]` : "";
      const people = Array.isArray(b.withPeople) && b.withPeople.length ? ` ${s().schedule.with_people.replace("{people}", b.withPeople.join(", "))}` : "";
      const detail = b.details ? ` — ${b.details}` : "";

      lines.push(`${b.start}:00-${b.end}:00 ${b.activity}${location}${people}${detail}${marker}`);
    }

    return lines.join("\n");
  }

  /**
   * Get or generate today's schedule + watchlist.
   * First call of the day triggers LLM generation; subsequent calls use cache.
   */
  private async ensureDailySchedule(): Promise<DailySchedule> {
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const todayStr = `${userTime.getFullYear()}-${String(userTime.getMonth() + 1).padStart(2, "0")}-${String(userTime.getDate()).padStart(2, "0")}`;

    // Check cache
    const cached = this.loadCachedSchedule();
    if (cached?.date === todayStr && cached.blocks.length > 0) return cached;

    // Generate new schedule + watchlist
    const dayOfWeek = userTime.getDay();
    const isWorkDay = dayOfWeek >= 1 && dayOfWeek <= 5;
    const dayName = s().time.day_names[dayOfWeek];

    // Gather context for generation
    const identity = this.loadFile("memory", "IDENTITY.md");
    const recentMemories = this.loadRecentMemories();
    // Feed in previous day's schedule for continuity
    const previousSchedule = cached ? this.formatPreviousDay(cached) : "";
    // Local SF events
    const localEvents = await fetchLocalEvents();
    // Weather — affects outdoor plans
    const weather = await this.fetchWeather();
    // Hobby + friend state for richer context
    const hobbyState = this.loadFile("hobby-progress.json");
    const friendState = this.loadFile("friend-state.json");

    // Daily health roll — sickness chance + period progression
    const periodPhase = getCurrentPeriodPhase();
    const isRaining = weather ? weather.rainChance > 50 : false;
    rollDailySickness({
      sleepQuality: cached?.sleep?.quality ?? 7,
      isRaining,
      month: userTime.getMonth() + 1,
      periodPhase,
    });

    // Get current health status for schedule adjustments
    const sickStatus = getCurrentSickStatus();

    const schedule = await this.generateSchedule({
      todayStr,
      dayName,
      isWorkDay,
      identity,
      recentMemories,
      previousSchedule,
      localEvents,
      weather,
      hobbyState,
      friendState,
      periodPhase,
      sickType: sickStatus.type,
      sickSeverity: sickStatus.severity,
    });

    this.saveCachedSchedule(schedule);

    // Now that we have a watchlist, invalidate market cache so next fetch uses it
    this.marketCache = null;

    console.log(`[world] Generated full-day plan for ${todayStr} (${isWorkDay ? "workday" : "weekend"}) — ${schedule.blocks.length} blocks, watching: ${schedule.watchlist.map(w => w.ticker).join(", ")}`);

    return schedule;
  }

  /**
   * Generate today's FULL DAY schedule — from wake to sleep.
   * Covers all aspects of the character's day: morning routine, commute, work, meals,
   * hobbies, cat interactions, social events, entertainment, and bedtime.
   */
  private async generateSchedule(ctx: {
    todayStr: string;
    dayName: string;
    isWorkDay: boolean;
    identity: string;
    recentMemories: string;
    previousSchedule: string;
    localEvents: string;
    weather: WeatherSnapshot | null;
    hobbyState: string;
    friendState: string;
    periodPhase: string;
    sickType: string;
    sickSeverity: number;
  }): Promise<DailySchedule> {
    const prevContext = ctx.previousSchedule
      ? `\nPrevious day (for continuity):\n${ctx.previousSchedule}\n`
      : "";

    const weatherContext = ctx.weather
      ? `\nToday's weather: ${this.formatWeather(ctx.weather)}\n`
      : "";

    const hobbyContext = ctx.hobbyState
      ? `\nHobby progress: ${ctx.hobbyState.slice(0, 300)}\n`
      : "";

    // Health context for schedule adjustments
    let healthContext = "";
    if (ctx.periodPhase === "period_heavy") {
      healthContext += `\n${s().body.body_status}: ${s().body.period_heavy_hint}\n`;
    } else if (ctx.periodPhase === "period_light") {
      healthContext += `\n${s().body.body_status}: ${s().body.period_ending.replace(", {symptoms}", "")}\n`;
    } else if (ctx.periodPhase === "pms") {
      healthContext += `\n${s().body.body_status}: ${s().body.pms_hint}\n`;
    }
    if (ctx.sickType !== "none" && ctx.sickSeverity > 0) {
      const bs = s().body;
      const sickLabels: Record<string, string> = {
        cold: bs.sick_cold, headache: bs.sick_headache, stomach: bs.sick_stomach,
        allergies: bs.sick_allergies, recovering: bs.sick_recovering,
      };
      const label = sickLabels[ctx.sickType] ?? bs.sick_general;
      if (ctx.sickSeverity >= 6) {
        healthContext += `\n${bs.body_status}: ${label} (${ctx.sickSeverity}/10) ${bs.sick_severe}\n`;
      } else if (ctx.sickSeverity >= 3) {
        healthContext += `\n${bs.body_status}: ${label} (${ctx.sickSeverity}/10) ${bs.sick_moderate}\n`;
      } else {
        healthContext += `\n${bs.body_status}: ${label}, ${bs.sick_recovering_note}\n`;
      }
    }

    const friendContext = ctx.friendState
      ? `\nFriend interactions: ${ctx.friendState.slice(0, 300)}\n`
      : "";

    const schedulePrompt = getCharacter().persona.schedule_generator;
    if (!schedulePrompt) {
      // No schedule generation prompt — use defaults
      return {
        date: ctx.todayStr, isWorkDay: ctx.isWorkDay,
        blocks: this.defaultBlocks(ctx.isWorkDay), dayOff: "",
        watchlist: [],
        sleep: { bedtime: "23:00", wakeTime: "7:00", quality: 7, note: "normal" },
        outfit: "", petMoments: [],
      };
    }
    const systemPrompt = renderTemplate(schedulePrompt, undefined, {
      identity: ctx.identity ? ctx.identity.slice(0, 600) : "",
      prevContext, weatherContext, hobbyContext, friendContext, healthContext,
      recentMemories: ctx.recentMemories || "",
      localEvents: ctx.localEvents || "",
      dayName: ctx.dayName, todayStr: ctx.todayStr,
      wakeTime: ctx.isWorkDay ? "~7:00" : "~8:00-9:00",
      city: getCharacter().location.city,
    });

    const callLLM = async () => {
      const text = await claudeText({
        system: systemPrompt,
        prompt: `Generate full day for ${ctx.dayName} ${ctx.todayStr}`,
        model: "smart",
        timeoutMs: 120_000,
      });
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    };

    try {
      let parsed = await callLLM();

      // Retry once if blocks came back empty
      if (parsed && ((parsed.blocks ?? []) as any[]).length === 0) {
        console.warn("[world] Schedule generation returned empty blocks, retrying once...");
        parsed = await callLLM();
      }

      if (parsed) {
        const blocks = (parsed.blocks ?? []) as TimeBlock[];
        const watchlist = (parsed.watchlist ?? []) as WatchlistItem[];

        const sleep: SleepLog = {
          bedtime: parsed.sleep?.bedtime ?? "23:00",
          wakeTime: parsed.sleep?.wakeTime ?? "7:00",
          quality: parsed.sleep?.quality ?? 7,
          note: parsed.sleep?.note ?? "normal",
        };

        const validBlocks = blocks.filter(b => typeof b.start === "number" && typeof b.end === "number");

        return {
          date: ctx.todayStr,
          isWorkDay: ctx.isWorkDay,
          blocks: validBlocks.length > 0 ? validBlocks : this.defaultBlocks(ctx.isWorkDay),
          dayOff: parsed.dayOff ?? "",
          watchlist: watchlist.filter(w => w.ticker && w.name),
          sleep,
          outfit: parsed.outfit ?? "",
          petMoments: parsed.petMoments ?? [],
        };
      }
    } catch (err) {
      console.error("[world] Schedule generation error:", err);
    }

    // Fallback — use default blocks so meals exist and hunger can reset
    console.warn("[world] Schedule generation failed, using fallback with default blocks");
    return {
      date: ctx.todayStr,
      isWorkDay: ctx.isWorkDay,
      blocks: this.defaultBlocks(ctx.isWorkDay),
      dayOff: "",
      watchlist: [],
      sleep: { bedtime: "23:00", wakeTime: "7:00", quality: 7, note: "normal" },
      outfit: "",
      petMoments: [],
    };
  }

  // ── Weather ──

  async fetchWeather(): Promise<WeatherSnapshot | null> {
    if (this.weatherCache && Date.now() - this.weatherCache.fetchedAt < WEATHER_CACHE_TTL) {
      return this.weatherCache;
    }

    try {
      const { latitude, longitude } = getCharacter().location.coordinates;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        "&current=temperature_2m,apparent_temperature,weather_code" +
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
        `&timezone=${encodeURIComponent(getUserTZ())}&forecast_days=1`;

      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const current = data?.current;
      const daily = data?.daily;

      if (!current || !daily) return null;

      const weatherCode = current.weather_code ?? 0;
      // Open-Meteo returns sunrise/sunset as ISO strings like "2026-02-25T06:52"
      const rawSunrise = daily.sunrise?.[0] ?? "";
      const rawSunset = daily.sunset?.[0] ?? "";
      const sunrise = rawSunrise ? rawSunrise.split("T")[1]?.slice(0, 5) ?? "" : "";
      const sunset = rawSunset ? rawSunset.split("T")[1]?.slice(0, 5) ?? "" : "";

      const snapshot: WeatherSnapshot = {
        temperature: Math.round(current.temperature_2m),
        feelsLike: Math.round(current.apparent_temperature),
        condition: this.getWmoDescription(weatherCode),
        high: Math.round(daily.temperature_2m_max?.[0] ?? current.temperature_2m),
        low: Math.round(daily.temperature_2m_min?.[0] ?? current.temperature_2m),
        rainChance: daily.precipitation_probability_max?.[0] ?? 0,
        sunrise,
        sunset,
        fetchedAt: Date.now(),
      };

      this.weatherCache = snapshot;
      console.log(`[world] Weather: ${snapshot.condition} ${snapshot.temperature}°C (${snapshot.low}-${snapshot.high}°C), rain ${snapshot.rainChance}%`);
      return snapshot;
    } catch {
      return null;
    }
  }

  getDaylightStatus(): string | null {
    if (!this.weatherCache?.sunrise || !this.weatherCache?.sunset) return null;

    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const nowMinutes = userTime.getHours() * 60 + userTime.getMinutes();

    const [sunriseH, sunriseM] = this.weatherCache.sunrise.split(":").map(Number);
    const [sunsetH, sunsetM] = this.weatherCache.sunset.split(":").map(Number);
    const sunriseMinutes = sunriseH * 60 + sunriseM;
    const sunsetMinutes = sunsetH * 60 + sunsetM;

    if (nowMinutes < sunriseMinutes) return s().daylight.dark.replace("{time}", this.weatherCache.sunrise);
    if (nowMinutes >= sunsetMinutes) return s().daylight.night.replace("{time}", this.weatherCache.sunset);
    // Within 30 min of sunset
    if (sunsetMinutes - nowMinutes <= 30) return s().daylight.dusk.replace("{time}", this.weatherCache.sunset);
    return s().daylight.dawn.replace("{time}", this.weatherCache.sunset);
  }

  /** Format weather for system prompt */
  formatWeather(w: WeatherSnapshot | null): string {
    if (!w) return "";
    const rain = w.rainChance > 30 ? s().schedule.rain_chance.replace("{pct}", String(w.rainChance)) : "";
    const city = getCharacter().location.city;
    return s().schedule.weather_format
      .replace("{city}", city)
      .replace("{condition}", w.condition)
      .replace("{temp}", String(w.temperature))
      .replace("{feels}", String(w.feelsLike))
      .replace("{low}", String(w.low))
      .replace("{high}", String(w.high))
      .replace("{rain}", rain);
  }

  // ── Market Data ──

  async fetchMarketSnapshot(): Promise<string> {
    if (this.marketCache && Date.now() - this.marketCache.fetchedAt < MARKET_CACHE_TTL) {
      return this.marketCache.text;
    }

    // Get today's watchlist from cached schedule (don't trigger generation here)
    // Fall back to default watchlist so market data is always available
    const DEFAULT_WATCHLIST: WatchlistItem[] = [
      { ticker: "^GSPC", name: "S&P 500" },
      { ticker: "^IXIC", name: "Nasdaq" },
      { ticker: "NVDA", name: "Nvidia" },
      { ticker: "AAPL", name: "Apple" },
    ];
    const watchlist = this.loadCachedWatchlist();
    const effectiveWatchlist = watchlist.length > 0 ? watchlist : DEFAULT_WATCHLIST;

    try {
      const fetches = effectiveWatchlist.map(async (item) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.ticker)}?range=1d&interval=1d`;
          const res = await fetch(url, {
            headers: { "User-Agent": "MeAI/1.0" },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return null;

          const data = (await res.json()) as any;
          const result = data?.chart?.result?.[0];
          if (!result) return null;

          const meta = result.meta;
          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose ?? meta.previousClose;
          if (!price || !prevClose) return null;

          const change = (((price - prevClose) / prevClose) * 100).toFixed(2);
          const direction = Number(change) >= 0 ? "+" : "";

          return `${item.name}: $${price.toFixed(2)} (${direction}${change}%)`;
        } catch {
          return null;
        }
      });

      const quotes = (await Promise.all(fetches)).filter(Boolean) as string[];
      const text = quotes.length > 0 ? quotes.join("  |  ") : "";
      this.marketCache = { text, fetchedAt: Date.now() };
      return text;
    } catch {
      return "";
    }
  }

  // ── Public API methods ──

  async getWorkContext(now: Date = new Date()): Promise<{
    currentActivity: string;
    busy: boolean;
    fullSchedule: string;
    isWorkDay: boolean;
    currentBlock: TimeBlock | null;
    nextBlock: TimeBlock | null;
    location: string;
  }> {
    const schedule = await this.ensureDailySchedule();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const hour = userTime.getHours();

    // Find current and next block from the full-day schedule
    const currentBlock = schedule.blocks.find(b => hour >= b.start && hour < b.end) ?? null;
    const nextBlock = schedule.blocks.find(b => b.start > hour) ?? null;

    if (!schedule.isWorkDay && !currentBlock) {
      return {
        currentActivity: schedule.dayOff || "",
        busy: false,
        fullSchedule: this.formatFullDaySchedule(schedule, hour),
        isWorkDay: false,
        currentBlock: null,
        nextBlock,
        location: "home",
      };
    }

    return {
      currentActivity: currentBlock?.activity ?? "",
      busy: currentBlock?.busy ?? false,
      fullSchedule: this.formatFullDaySchedule(schedule, hour),
      isWorkDay: schedule.isWorkDay,
      currentBlock,
      nextBlock,
      location: currentBlock?.location ?? "home",
    };
  }

  async getSleepData(): Promise<SleepLog> {
    const schedule = await this.ensureDailySchedule();
    return schedule.sleep;
  }

  async getPetMoments(): Promise<string[]> {
    const schedule = await this.ensureDailySchedule();
    return schedule.petMoments;
  }

  async getOutfit(): Promise<string> {
    const schedule = await this.ensureDailySchedule();
    return schedule.outfit;
  }

  async getMealBlocks(): Promise<TimeBlock[]> {
    const schedule = await this.ensureDailySchedule();
    return schedule.blocks.filter(b => b.category === "meal");
  }

  async getTimeSpaceContext(now: Date = new Date()): Promise<string> {
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const hour = userTime.getHours();
    const minute = userTime.getMinutes();
    const dayOfWeek = s().time.day_names[userTime.getDay()];
    const month = userTime.getMonth() + 1;
    const day = userTime.getDate();
    const timeStr = `${hour}:${String(minute).padStart(2, "0")}`;

    // Season
    let season: string;
    if (month >= 3 && month <= 5) season = s().time.seasons.spring;
    else if (month >= 6 && month <= 8) season = s().time.seasons.summer;
    else if (month >= 9 && month <= 11) season = s().time.seasons.fall;
    else season = s().time.seasons.winter;

    // Get actual location from schedule
    const work = await this.getWorkContext(now);
    const locationDetail = this.getLocationDetail(work.location);

    // Weather
    const weather = await this.fetchWeather();
    const weatherStr = weather ? this.formatWeather(weather) : "";

    const char = getCharacter();
    const parts = [
      s().time.now_time
        .replace("{city}", char.location.city)
        .replace("{month}", String(month))
        .replace("{day}", String(day))
        .replace("{dow}", dayOfWeek)
        .replace("{time}", timeStr)
        .replace("{season}", season),
      s().time.you_are_at.replace("{location}", locationDetail),
      renderTemplate(s().time.user_is_at),
    ];

    if (weatherStr) parts.push(weatherStr);

    return parts.join("\n");
  }

  async calculateReplyDelay(now: Date = new Date()): Promise<{
    delayMs: number;
    reason: string;
  }> {
    const { currentBlock } = await this.getWorkContext(now);
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    const hour = userTime.getHours();
    const category = currentBlock?.category ?? "";

    // ── Sleeping: delay until she wakes up (~7:00-7:30 AM) ──
    if (category === "sleep" || (hour >= 0 && hour < 7 && !currentBlock)) {
      const wakeHour = 7;
      const wakeMinute = Math.floor(Math.random() * 30); // 7:00-7:29
      const wakeTime = new Date(userTime);
      wakeTime.setHours(wakeHour, wakeMinute, 0, 0);
      if (wakeTime <= userTime) wakeTime.setDate(wakeTime.getDate() + 1);
      const delayMs = wakeTime.getTime() - userTime.getTime();
      return { delayMs, reason: s().schedule.sleeping };
    }

    // ── Morning routine (shower, getting ready) ──
    if (category === "morning") {
      if (Math.random() < 0.7) {
        const delayMs = (1.5 + Math.random() * 1.5) * 60 * 1000; // 1.5-3 min
        return { delayMs, reason: currentBlock?.activity ?? s().schedule.morning_routine };
      }
      return { delayMs: 0, reason: "" };
    }

    // ── Exercise ──
    if (category === "exercise") {
      if (Math.random() < 0.8) {
        const delayMs = (1.5 + Math.random() * 1.5) * 60 * 1000; // 1.5-3 min
        return { delayMs, reason: currentBlock?.activity ?? s().schedule.exercising };
      }
      return { delayMs: 0, reason: "" };
    }

    // ── Social (out with friends) ──
    if (category === "social") {
      if (Math.random() < 0.6) {
        const delayMs = (1 + Math.random() * 2) * 60 * 1000; // 1-3 min
        return { delayMs, reason: currentBlock?.activity ?? s().schedule.with_friends };
      }
      return { delayMs: 0, reason: "" };
    }

    // ── Focused work (busy flag) ──
    if (currentBlock?.busy) {
      if (Math.random() < 0.5) {
        const delayMs = (1 + Math.random() * 2) * 60 * 1000; // 1-3 min
        return { delayMs, reason: currentBlock.activity };
      }
      return { delayMs: 0, reason: "" };
    }

    // ── Hobby / entertainment / chores / commute ──
    if (["hobby", "entertainment", "chores", "commute"].includes(category)) {
      if (Math.random() < 0.3) {
        const delayMs = (0.5 + Math.random() * 1.5) * 60 * 1000; // 0.5-2 min
        return { delayMs, reason: currentBlock?.activity ?? s().schedule.busy };
      }
      return { delayMs: 0, reason: "" };
    }

    // ── Default: available, no delay ──
    return { delayMs: 0, reason: "" };
  }
}

// ── Singleton & backward-compat wrappers ─────────────────────────────

let _singleton: WorldEngine | null = null;

/** Must be called once at startup with config. */
export function initWorld(config: { statePath: string }): WorldEngine {
  _singleton = new WorldEngine(config.statePath);
  return _singleton;
}

// Backward-compatible module-level exports that delegate to the singleton.
// Every function that was previously exported at module level is preserved here.

export function fetchWeather() { return _singleton!.fetchWeather(); }
export function getDaylightStatus() { return _singleton!.getDaylightStatus(); }
export function formatWeather(w: any) { return _singleton!.formatWeather(w); }
export function fetchMarketSnapshot() { return _singleton!.fetchMarketSnapshot(); }
export function getWorkContext(now?: Date) { return _singleton!.getWorkContext(now); }
export function getSleepData() { return _singleton!.getSleepData(); }
export function getPetMoments() { return _singleton!.getPetMoments(); }
export function getOutfit() { return _singleton!.getOutfit(); }
export function getMealBlocks() { return _singleton!.getMealBlocks(); }
export function getTimeSpaceContext(now?: Date) { return _singleton!.getTimeSpaceContext(now); }
export function calculateReplyDelay(now?: Date) { return _singleton!.calculateReplyDelay(now); }
