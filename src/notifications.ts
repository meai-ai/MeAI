/**
 * Notification Engine — real-time push notifications for the character.
 *
 * No simulated events. All notifications come from real data sources:
 * - RSS/YouTube/Podcast: detect new content in subscriptions
 * - Price alerts: stock prices crossing configured thresholds
 * - Weather changes: significant weather shifts (rain starting, temperature drops)
 * - Schedule reminders: 15 minutes before a schedule block starts
 *
 * The character can manage subscriptions via LLM tool calls:
 * - Curiosity engine found a good blog → subscribe to its RSS
 * - Tracking a stock → set a price alert
 * - No longer interested in a channel → unsubscribe
 *
 * Notifications are not sent directly to the user but injected into the system prompt,
 * allowing the character to bring them up naturally in conversation.
 */

import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { pstDateStr, getUserTZ } from "./lib/pst-date.js";
import { claudeText } from "./claude-runner.js";
import { fetchWeather } from "./world.js";
import { createLogger } from "./lib/logger.js";
import { getCharacter, s, renderTemplate } from "./character.js";

const log = createLogger("notifications");
import {
  fetchYouTubeVideos,
  fetchPodcastEpisodes,
  loadSubscriptions,
  subscribeYouTube,
  subscribePodcast,
  unsubscribeYouTube,
  unsubscribePodcast,
} from "./interests.js";
import type { ToolDefinition, AppConfig } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export type NotificationType =
  | "rss"
  | "youtube"
  | "podcast"
  | "price_alert"
  | "weather"
  | "calendar";

export interface Notification {
  id: string;
  type: NotificationType;
  source: string;        // feed name, channel name, ticker, "weather", "calendar"
  title: string;         // headline / video title / alert message
  body: string;          // short description
  url?: string;          // link to content
  timestamp: number;     // when notification was created
  read: boolean;
  priority: "low" | "normal" | "high";
}

export interface PriceAlertSub {
  id: string;
  ticker: string;         // Yahoo Finance symbol (e.g. "AAPL")
  name: string;           // display name (e.g. "Apple")
  condition: "above" | "below" | "change_pct";
  threshold: number;      // price for above/below, % for change_pct
  createdAt: number;
  /** Once triggered, set to true so it doesn't fire again */
  triggered: boolean;
  /** If true, alert resets daily (re-arm each morning) */
  recurring: boolean;
}

export interface WeatherAlertSub {
  id: string;
  condition: "rain" | "temperature_drop" | "temperature_rise" | "any_change";
  /** For temp alerts: degrees of change that triggers */
  threshold?: number;
  createdAt: number;
}

interface NotificationState {
  /** Notification queue — max 50, auto-prune > 24h */
  queue: Notification[];
  /** Price alert subscriptions */
  priceAlerts: PriceAlertSub[];
  /** Weather alert subscriptions */
  weatherAlerts: WeatherAlertSub[];
  /** RSS feeds to monitor — separate from interests.ts content discovery */
  rssFeeds: Array<{
    id: string;
    name: string;
    url: string;
    category: string;
    addedAt: number;
  }>;
  /** Track last-seen content per source to detect new items */
  lastSeen: Record<string, string>; // source_id → last known item title/id
  /** Last weather state for change detection */
  lastWeather: {
    condition: string;
    temperature: number;
    checkedAt: number;
  } | null;
  /** Last calendar reminder check time */
  lastCalendarCheck: number;
}

// ── NotificationsEngine class ────────────────────────────────────────

export class NotificationsEngine {
  private dataPath: string;
  private stateCache: NotificationState | null = null;

  constructor(statePath: string) {
    this.dataPath = statePath;
  }

  // ── Persistence ────────────────────────────────────────────────────

  private getStatePath(): string {
    return path.join(this.dataPath, "notification-state.json");
  }

  private loadState(): NotificationState {
    if (this.stateCache) return this.stateCache;
    if (!this.dataPath) return this.defaultState();
    const p = this.getStatePath();
    if (!fs.existsSync(p)) {
      const state = this.defaultState();
      this.saveState(state);
      return state;
    }
    this.stateCache = readJsonSafe<NotificationState>(p, this.defaultState());
    return this.stateCache;
  }

  private saveState(state: NotificationState): void {
    if (!this.dataPath) return;
    this.stateCache = state;
    writeJsonAtomic(this.getStatePath(), state);
  }

  private defaultState(): NotificationState {
    return {
      queue: [],
      priceAlerts: [],
      weatherAlerts: [
        // Default: alert when it starts raining (useful for commute)
        { id: "default-rain", condition: "rain", createdAt: Date.now() },
      ],
      rssFeeds: [],
      lastSeen: {},
      lastWeather: null,
      lastCalendarCheck: 0,
    };
  }

  // ── ID generation ──────────────────────────────────────────────────

  private makeId(): string {
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── Queue Management ───────────────────────────────────────────────

  private addNotification(state: NotificationState, notif: Omit<Notification, "id" | "timestamp" | "read">): void {
    // Deduplicate: don't add if same title from same source exists in last 6 hours
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const isDupe = state.queue.some(
      n => n.source === notif.source && n.title === notif.title && n.timestamp > sixHoursAgo,
    );
    if (isDupe) return;

    state.queue.push({
      ...notif,
      id: this.makeId(),
      timestamp: Date.now(),
      read: false,
    });

    // Prune: max 50 items, remove anything > 24h old
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    state.queue = state.queue
      .filter(n => n.timestamp > oneDayAgo)
      .slice(-50);
  }

  // ── Check: YouTube New Videos ──────────────────────────────────────

  private async checkYouTube(state: NotificationState): Promise<number> {
    let count = 0;
    try {
      const videos = await fetchYouTubeVideos();
      const subs = loadSubscriptions();

      for (const ch of subs.youtube) {
        const key = `yt-${ch.channelId}`;
        const lastTitle = state.lastSeen[key];

        // Find newest video from this channel
        const channelVideos = videos.filter(v => v.channel === ch.name);
        if (channelVideos.length === 0) continue;

        const newest = channelVideos[0]; // already sorted by date
        if (newest.title === lastTitle) continue;

        // New video detected
        if (lastTitle) {
          // Only notify if we had a previous marker (skip first run)
          this.addNotification(state, {
            type: "youtube",
            source: ch.name,
            title: newest.title,
            body: newest.description?.slice(0, 100) || "",
            url: newest.url,
            priority: "normal",
          });
          count++;
        }
        state.lastSeen[key] = newest.title;
      }
    } catch (err) {
      console.error("[notifications] YouTube check error:", err);
    }
    return count;
  }

  // ── Check: Podcast New Episodes ────────────────────────────────────

  private async checkPodcasts(state: NotificationState): Promise<number> {
    let count = 0;
    try {
      const episodes = await fetchPodcastEpisodes();
      const subs = loadSubscriptions();

      for (const pod of subs.podcasts) {
        const key = `pod-${pod.name}`;
        const lastTitle = state.lastSeen[key];

        const showEpisodes = episodes.filter(e => e.show === pod.name);
        if (showEpisodes.length === 0) continue;

        const newest = showEpisodes[0];
        if (newest.title === lastTitle) continue;

        if (lastTitle) {
          this.addNotification(state, {
            type: "podcast",
            source: pod.name,
            title: newest.title,
            body: newest.description?.slice(0, 100) || "",
            url: newest.url,
            priority: "normal",
          });
          count++;
        }
        state.lastSeen[key] = newest.title;
      }
    } catch (err) {
      console.error("[notifications] Podcast check error:", err);
    }
    return count;
  }

  // ── Check: Price Alerts ────────────────────────────────────────────

  private async checkPriceAlerts(state: NotificationState): Promise<number> {
    let count = 0;
    const untriggered = state.priceAlerts.filter(a => !a.triggered);
    if (untriggered.length === 0) return 0;

    for (const alert of untriggered) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(alert.ticker)}?range=1d&interval=1d`;
        const res = await fetch(url, {
          headers: { "User-Agent": "MeAI/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) continue;

        const data = (await res.json()) as any;
        const result = data?.chart?.result?.[0];
        if (!result) continue;

        const meta = result.meta;
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose ?? meta.previousClose;
        if (!price) continue;

        let triggered = false;
        let message = "";

        if (alert.condition === "above" && price >= alert.threshold) {
          triggered = true;
          message = s().notifications.price_above.replace("{name}", alert.name).replace("{ticker}", alert.ticker).replace("{price}", price.toFixed(2)).replace("{threshold}", String(alert.threshold));
        } else if (alert.condition === "below" && price <= alert.threshold) {
          triggered = true;
          message = s().notifications.price_below.replace("{name}", alert.name).replace("{ticker}", alert.ticker).replace("{price}", price.toFixed(2)).replace("{threshold}", String(alert.threshold));
        } else if (alert.condition === "change_pct" && prevClose) {
          const changePct = Math.abs(((price - prevClose) / prevClose) * 100);
          if (changePct >= alert.threshold) {
            triggered = true;
            const direction = price > prevClose ? s().notifications.direction_up : s().notifications.direction_down;
            message = s().notifications.price_change.replace("{name}", alert.name).replace("{ticker}", alert.ticker).replace("{direction}", direction).replace("{pct}", changePct.toFixed(1)).replace("{price}", price.toFixed(2));
          }
        }

        if (triggered) {
          alert.triggered = true;
          this.addNotification(state, {
            type: "price_alert",
            source: alert.ticker,
            title: message,
            body: "",
            priority: "high",
          });
          count++;
        }
      } catch (err) {
        log.warn(`failed to check price alert for ${alert.ticker}`, err);
      }
    }
    return count;
  }

  // ── Check: Weather Changes ─────────────────────────────────────────

  private async checkWeather(state: NotificationState): Promise<number> {
    if (state.weatherAlerts.length === 0) return 0;
    let count = 0;

    try {
      const weather = await fetchWeather();
      if (!weather) return 0;

      const prev = state.lastWeather;

      for (const alert of state.weatherAlerts) {
        if (alert.condition === "rain") {
          // Alert if it starts raining (wasn't raining before)
          const rainConditions = s().patterns.rain_conditions;
          const isRainy = rainConditions.includes(weather.condition);
          const wasRainy = prev ? rainConditions.includes(prev.condition) : false;

          if (isRainy && !wasRainy) {
            this.addNotification(state, {
              type: "weather",
              source: "weather",
              title: s().notifications.weather_started.replace("{city}", getCharacter().location.city).replace("{condition}", weather.condition),
              body: s().notifications.weather_reminder.replace("{temp}", String(weather.temperature)),
              priority: "normal",
            });
            count++;
          }
        } else if (alert.condition === "temperature_drop" && prev) {
          const drop = prev.temperature - weather.temperature;
          const threshold = alert.threshold ?? 5;
          if (drop >= threshold) {
            this.addNotification(state, {
              type: "weather",
              source: "weather",
              title: s().notifications.temp_dropped.replace("{delta}", String(drop)),
              body: s().notifications.temp_from_to.replace("{from}", String(prev.temperature)).replace("{to}", String(weather.temperature)),
              priority: "normal",
            });
            count++;
          }
        } else if (alert.condition === "temperature_rise" && prev) {
          const rise = weather.temperature - prev.temperature;
          const threshold = alert.threshold ?? 5;
          if (rise >= threshold) {
            this.addNotification(state, {
              type: "weather",
              source: "weather",
              title: s().notifications.temp_rose.replace("{delta}", String(rise)),
              body: s().notifications.temp_from_to.replace("{from}", String(prev.temperature)).replace("{to}", String(weather.temperature)),
              priority: "low",
            });
            count++;
          }
        }
      }

      // Update last weather
      state.lastWeather = {
        condition: weather.condition,
        temperature: weather.temperature,
        checkedAt: Date.now(),
      };
    } catch (err) {
      console.error("[notifications] Weather check error:", err);
    }
    return count;
  }

  // ── Check: Calendar Reminders ──────────────────────────────────────

  private async checkCalendar(state: NotificationState): Promise<number> {
    let count = 0;

    try {
      // Import dynamically to avoid circular dependency
      const { getWorkContext } = await import("./world.js");
      const work = await getWorkContext();

      const now = new Date();
      const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
      const currentMinutes = userTime.getHours() * 60 + userTime.getMinutes();

      // Check next block — remind 15 minutes before if busy
      if (work.nextBlock && work.nextBlock.busy) {
        const blockStartMinutes = work.nextBlock.start * 60;
        const diff = blockStartMinutes - currentMinutes;

        // Remind if 10-20 minutes away (check range to handle ~5min pulse interval)
        if (diff > 0 && diff <= 20 && diff > 5) {
          const key = `cal-${work.nextBlock.start}-${pstDateStr()}`;
          if (!state.lastSeen[key]) {
            state.lastSeen[key] = "reminded";
            this.addNotification(state, {
              type: "calendar",
              source: "calendar",
              title: `${diff}min: ${work.nextBlock.activity}`,
              body: work.nextBlock.location ? `${work.nextBlock.location}` : "",
              priority: "high",
            });
            count++;
          }
        }
      }
    } catch (err) {
      console.error("[notifications] Calendar check error:", err);
    }
    return count;
  }

  // ── Main Check Function ────────────────────────────────────────────

  /**
   * Check all subscription sources for new items.
   * Called by heartbeat every ~5 minutes. Lightweight -- uses cached data
   * from interests.ts and world.ts wherever possible.
   *
   * Returns the number of new notifications created.
   */
  async checkNotifications(): Promise<number> {
    const state = this.loadState();
    let total = 0;

    // Reset daily recurring price alerts at midnight
    const now = new Date();
    const userTime = new Date(now.toLocaleString("en-US", { timeZone: getUserTZ() }));
    if (userTime.getHours() === 0 && userTime.getMinutes() < 10) {
      for (const alert of state.priceAlerts) {
        if (alert.recurring) alert.triggered = false;
      }
    }

    // Run all checks in parallel (they use cached data, so fast)
    const [yt, pod, price, weather, cal] = await Promise.all([
      this.checkYouTube(state),
      this.checkPodcasts(state),
      this.checkPriceAlerts(state),
      this.checkWeather(state),
      this.checkCalendar(state),
    ]);

    total = yt + pod + price + weather + cal;

    if (total > 0) {
      console.log(`[notifications] ${total} new: youtube=${yt} podcast=${pod} price=${price} weather=${weather} calendar=${cal}`);
    }

    this.saveState(state);
    return total;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Get unread notifications (most recent first) */
  getUnread(): Notification[] {
    const state = this.loadState();
    return state.queue
      .filter(n => !n.read)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Get all recent notifications (last 24h, read and unread) */
  getRecent(): Notification[] {
    const state = this.loadState();
    return state.queue.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Mark a notification as read */
  dismiss(id: string): boolean {
    const state = this.loadState();
    const notif = state.queue.find(n => n.id === id);
    if (!notif) return false;
    notif.read = true;
    this.saveState(state);
    return true;
  }

  /** Mark all notifications as read */
  dismissAll(): void {
    const state = this.loadState();
    for (const n of state.queue) n.read = true;
    this.saveState(state);
  }

  // ── Subscription Management ────────────────────────────────────────

  /** Add a price alert */
  addPriceAlert(
    ticker: string,
    name: string,
    condition: "above" | "below" | "change_pct",
    threshold: number,
    recurring = false,
  ): string {
    const state = this.loadState();
    const id = this.makeId();
    state.priceAlerts.push({
      id,
      ticker,
      name,
      condition,
      threshold,
      createdAt: Date.now(),
      triggered: false,
      recurring,
    });
    this.saveState(state);
    console.log(`[notifications] Price alert added: ${ticker} ${condition} ${threshold}`);
    return id;
  }

  /** Remove a price alert */
  removePriceAlert(id: string): boolean {
    const state = this.loadState();
    const before = state.priceAlerts.length;
    state.priceAlerts = state.priceAlerts.filter(a => a.id !== id);
    if (state.priceAlerts.length < before) {
      this.saveState(state);
      return true;
    }
    return false;
  }

  /** Add a weather alert */
  addWeatherAlert(
    condition: "rain" | "temperature_drop" | "temperature_rise" | "any_change",
    threshold?: number,
  ): string {
    const state = this.loadState();
    const id = this.makeId();
    state.weatherAlerts.push({ id, condition, threshold, createdAt: Date.now() });
    this.saveState(state);
    return id;
  }

  /** Remove a weather alert */
  removeWeatherAlert(id: string): boolean {
    const state = this.loadState();
    const before = state.weatherAlerts.length;
    state.weatherAlerts = state.weatherAlerts.filter(a => a.id !== id);
    if (state.weatherAlerts.length < before) {
      this.saveState(state);
      return true;
    }
    return false;
  }

  /** List all active subscriptions/alerts */
  listSubscriptions(): string {
    const state = this.loadState();
    const subs = loadSubscriptions();
    const lines: string[] = [];

    // YouTube channels
    if (subs.youtube.length > 0) {
      lines.push("📺 " + s().notifications.youtube_label + ":");
      for (const ch of subs.youtube) {
        const tag = ch.source === "discovered" ? " " + s().notifications.discovered_tag : "";
        lines.push(`  - ${ch.name}${tag}`);
      }
    }

    // Podcasts
    if (subs.podcasts.length > 0) {
      lines.push("🎙️ " + s().notifications.podcast_label + ":");
      for (const pod of subs.podcasts) {
        const tag = pod.source === "discovered" ? " " + s().notifications.discovered_tag : "";
        lines.push(`  - ${pod.name}${tag}`);
      }
    }

    // Price alerts
    if (state.priceAlerts.length > 0) {
      lines.push("📈 " + s().notifications.price_alert_label + ":");
      for (const alert of state.priceAlerts) {
        const condText = alert.condition === "above" ? `> $${alert.threshold}`
          : alert.condition === "below" ? `< $${alert.threshold}`
          : `change > ${alert.threshold}%`;
        const status = alert.triggered ? " " + s().notifications.status_triggered : " " + s().notifications.status_monitoring;
        const recur = alert.recurring ? " [daily]" : "";
        lines.push(`  - ${alert.name} (${alert.ticker}): ${condText}${status}${recur}`);
      }
    }

    // Weather alerts
    if (state.weatherAlerts.length > 0) {
      lines.push("🌤️ " + s().notifications.weather_alert_label + ":");
      for (const alert of state.weatherAlerts) {
        const desc = alert.condition === "rain" ? "alert when it starts raining"
          : alert.condition === "temperature_drop" ? `alert when temp drops ${alert.threshold ?? 5}°C`
          : alert.condition === "temperature_rise" ? `alert when temp rises ${alert.threshold ?? 5}°C`
          : "alert on weather changes";
        lines.push(`  - ${desc}`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : s().notifications.no_subscriptions;
  }

  // ── Context Formatting ─────────────────────────────────────────────

  /**
   * Format unread notifications for system prompt injection.
   * Returns empty string if no unread notifications.
   *
   * Surfaced notifications are automatically marked as read --
   * the character "saw" them when they appeared in the system prompt.
   */
  formatNotificationContext(): string {
    const state = this.loadState();
    const unread = state.queue
      .filter(n => !n.read)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (unread.length === 0) return "";

    const lines: string[] = [];

    // Group by type for readability
    const highPriority = unread.filter(n => n.priority === "high");
    const normal = unread.filter(n => n.priority !== "high");

    const surfaced: Notification[] = [];

    if (highPriority.length > 0) {
      for (const n of highPriority.slice(0, 3)) {
        lines.push(`⚡ ${n.title}${n.body ? ` (${n.body})` : ""}`);
        surfaced.push(n);
      }
    }

    for (const n of normal.slice(0, 5)) {
      const icon = n.type === "youtube" ? "📺"
        : n.type === "podcast" ? "🎙️"
        : n.type === "weather" ? "🌧️"
        : n.type === "price_alert" ? "📈"
        : "📱";
      lines.push(`${icon} [${n.source}] ${n.title}`);
      surfaced.push(n);
    }

    const remaining = unread.length - surfaced.length;
    if (remaining > 0) {
      lines.push(s().notifications.remaining_unread.replace("{n}", String(remaining)));
    }

    // Mark surfaced notifications as read — the character "saw" them in the prompt
    if (surfaced.length > 0) {
      for (const n of surfaced) {
        n.read = true;
      }
      this.saveState(state);
    }

    return lines.join("\n");
  }

  // ── LLM Tool Definitions ───────────────────────────────────────────
  //
  // All tool execute functions route through claudeText (-> claude --print CLI)
  // to ensure consistent billing via Max subscription.

  /**
   * Get tool definitions for the character to manage subscriptions.
   * All execute() calls go through claudeText -> Claude Code CLI.
   */
  getNotificationTools(_config: AppConfig): ToolDefinition[] {
    return this._getNotificationTools(_config);
  }

  private _getNotificationTools(_config: AppConfig): ToolDefinition[] {
    // Capture `this` for use in closures
    const engine = this;
    return [
      {
        name: "subscribe",
        description: s().notifications.subscribe_desc,
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["youtube", "podcast", "price_alert", "weather_alert"],
              description: "Subscription type",
            },
            // YouTube
            channel_name: { type: "string", description: "YouTube channel name" },
            channel_id: { type: "string", description: "YouTube channel ID (from URL)" },
            // Podcast
            podcast_name: { type: "string", description: "Podcast name" },
            feed_url: { type: "string", description: "Podcast RSS feed URL" },
            // Price alert
            ticker: { type: "string", description: "Yahoo Finance ticker symbol (e.g. AAPL, NVDA, ^GSPC)" },
            stock_name: { type: "string", description: "Stock display name (e.g. Apple, Nvidia)" },
            condition: {
              type: "string",
              enum: ["above", "below", "change_pct"],
              description: "Trigger condition: above (price rises above), below (price drops below), change_pct (daily change exceeds percentage)",
            },
            threshold: { type: "number", description: "Trigger threshold (price or percentage)" },
            recurring: { type: "boolean", description: "Reset daily (default false, triggers once)" },
            // Weather alert
            weather_condition: {
              type: "string",
              enum: ["rain", "temperature_drop", "temperature_rise"],
              description: "Weather alert type",
            },
            weather_threshold: { type: "number", description: "Temperature change threshold (°C)" },
            // Common
            category: { type: "string", description: "Category (tech, finance, entertainment, etc.)" },
            reason: { type: "string", description: "Reason for subscribing" },
          },
          required: ["type"],
        },
        execute: async (input: Record<string, unknown>): Promise<string> => {
          const type = input.type as string;

          // Direct CRUD for reliability
          let actionResult = "";
          if (type === "youtube") {
            const name = input.channel_name as string;
            const channelId = input.channel_id as string;
            if (!name || !channelId) return "channel_name and channel_id required";
            const ok = subscribeYouTube(name, channelId, (input.category as string) ?? "general", (input.reason as string) ?? "");
            actionResult = ok ? `subscribed_youtube:${name}` : `already_subscribed:${name}`;
          } else if (type === "podcast") {
            const name = input.podcast_name as string;
            const url = input.feed_url as string;
            if (!name || !url) return "podcast_name and feed_url required";
            const ok = subscribePodcast(name, url, (input.category as string) ?? "general", (input.reason as string) ?? "");
            actionResult = ok ? `subscribed_podcast:${name}` : `already_subscribed:${name}`;
          } else if (type === "price_alert") {
            const ticker = input.ticker as string;
            const stockName = input.stock_name as string;
            const condition = input.condition as "above" | "below" | "change_pct";
            const threshold = input.threshold as number;
            if (!ticker || !condition || threshold == null) return "ticker, condition, and threshold required";
            const id = engine.addPriceAlert(ticker, stockName || ticker, condition, threshold, (input.recurring as boolean) ?? false);
            actionResult = `added_price_alert:${id}:${stockName || ticker}:${condition}:${threshold}`;
          } else if (type === "weather_alert") {
            const cond = (input.weather_condition as string) ?? "rain";
            const threshold = input.weather_threshold as number | undefined;
            const id = engine.addWeatherAlert(cond as "rain" | "temperature_drop" | "temperature_rise" | "any_change", threshold);
            actionResult = `added_weather_alert:${id}:${cond}`;
          } else {
            return `unsupported subscription type: ${type}`;
          }

          // Route through claudeText for natural-language confirmation
          const response = await claudeText({
            system: `You are ${getCharacter().name}. Confirm this subscription action in one short sentence. No prefixes or explanations.`,
            prompt: `Action result: ${actionResult}\nOriginal request params: ${JSON.stringify(input)}`,
            model: "fast",
            timeoutMs: 10_000,
          });
          return response || actionResult;
        },
      },
      {
        name: "unsubscribe",
        description: s().notifications.unsubscribe_desc,
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["youtube", "podcast", "price_alert", "weather_alert"],
              description: "Type to unsubscribe",
            },
            id: { type: "string", description: "Subscription ID to remove (from list_subscriptions)" },
            channel_id: { type: "string", description: "YouTube channel ID" },
            feed_url: { type: "string", description: "Podcast RSS feed URL" },
          },
          required: ["type"],
        },
        execute: async (input: Record<string, unknown>): Promise<string> => {
          const type = input.type as string;

          // Direct CRUD
          let ok = false;
          let target = "";
          if (type === "youtube") {
            const channelId = input.channel_id as string;
            if (!channelId) return "channel_id required";
            ok = unsubscribeYouTube(channelId);
            target = `YouTube channel ${channelId}`;
          } else if (type === "podcast") {
            const url = input.feed_url as string;
            if (!url) return "feed_url required";
            ok = unsubscribePodcast(url);
            target = `podcast ${url}`;
          } else if (type === "price_alert") {
            const id = input.id as string;
            if (!id) return "alert id required";
            ok = engine.removePriceAlert(id);
            target = `price_alert ${id}`;
          } else if (type === "weather_alert") {
            const id = input.id as string;
            if (!id) return "alert id required";
            ok = engine.removeWeatherAlert(id);
            target = `weather_alert ${id}`;
          } else {
            return `unsupported type: ${type}`;
          }

          // Route through claudeText
          const response = await claudeText({
            system: `You are ${getCharacter().name}. Confirm this unsubscribe action in one short sentence. No prefixes or explanations.`,
            prompt: `Unsubscribe ${target}: ${ok ? "success" : "not found"}`,
            model: "fast",
            timeoutMs: 10_000,
          });
          return response || (ok ? "unsubscribed" : "subscription not found");
        },
      },
      {
        name: "list_subscriptions",
        description: s().notifications.list_subs_desc,
        inputSchema: {
          type: "object",
          properties: {},
        },
        execute: async (): Promise<string> => {
          const rawList = engine.listSubscriptions();

          // Route through claudeText for natural summary
          const response = await claudeText({
            system: `You are ${getCharacter().name}. Reorganize the subscription list below in your own voice, keep it concise and natural. Include all info but use casual language.`,
            prompt: rawList,
            model: "fast",
            timeoutMs: 10_000,
          });
          return response || rawList;
        },
      },
      {
        name: "check_notifications",
        description: s().notifications.list_notifs_desc,
        inputSchema: {
          type: "object",
          properties: {
            mark_read: { type: "boolean", description: "Mark as read (default false)" },
          },
        },
        execute: async (input: Record<string, unknown>): Promise<string> => {
          const unread = engine.getUnread();
          if (unread.length === 0) return "no unread notifications";

          const rawLines = unread.map(n => {
            const time = new Date(n.timestamp).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: getUserTZ(),
            });
            return `[${time}] [${n.source}] [${n.priority}] ${n.title}${n.body ? ` — ${n.body}` : ""}`;
          });

          if (input.mark_read) {
            engine.dismissAll();
          }

          // Route through claudeText for natural summary
          const response = await claudeText({
            system: `You are ${getCharacter().name}. Summarize these phone notifications in your own voice, like telling a friend 'I just got some notifications.' Highlight high-priority ones.`,
            prompt: `${unread.length} unread notifications:\n${rawLines.join("\n")}`,
            model: "fast",
            timeoutMs: 10_000,
          });
          return response || rawLines.join("\n");
        },
      },
    ];
  }
}

// ── Backward-compat singleton ────────────────────────────────────────

let _singleton: NotificationsEngine | null = null;

export function initNotifications(statePath: string): NotificationsEngine {
  _singleton = new NotificationsEngine(statePath);
  return _singleton;
}

export async function checkNotifications(): Promise<number> {
  return _singleton!.checkNotifications();
}

export function getUnread(): Notification[] {
  return _singleton!.getUnread();
}

export function getRecent(): Notification[] {
  return _singleton!.getRecent();
}

export function dismiss(id: string): boolean {
  return _singleton!.dismiss(id);
}

export function dismissAll(): void {
  _singleton!.dismissAll();
}

export function addPriceAlert(
  ticker: string,
  name: string,
  condition: "above" | "below" | "change_pct",
  threshold: number,
  recurring = false,
): string {
  return _singleton!.addPriceAlert(ticker, name, condition, threshold, recurring);
}

export function removePriceAlert(id: string): boolean {
  return _singleton!.removePriceAlert(id);
}

export function addWeatherAlert(
  condition: "rain" | "temperature_drop" | "temperature_rise" | "any_change",
  threshold?: number,
): string {
  return _singleton!.addWeatherAlert(condition, threshold);
}

export function removeWeatherAlert(id: string): boolean {
  return _singleton!.removeWeatherAlert(id);
}

export function listSubscriptions(): string {
  return _singleton!.listSubscriptions();
}

export function formatNotificationContext(): string {
  return _singleton!.formatNotificationContext();
}

export function getNotificationTools(_config: AppConfig): ToolDefinition[] {
  return _singleton!.getNotificationTools(_config);
}
