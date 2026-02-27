/**
 * Sense Provider interface — abstraction for information sources.
 *
 * Contributors can swap or add data sources — weather providers, market data,
 * search engines, content feeds, calendar integrations — by creating
 * src/senses/<provider>/index.ts.
 */

import type { AppConfig } from "../types.js";

/** Types of information senses. */
export type SenseType = "search" | "weather" | "market" | "content_feed" | "social_feed" | "calendar" | "location";

/** Standardized weather data. */
export interface WeatherData {
  temp: number;
  feelsLike: number;
  condition: string;
  high: number;
  low: number;
  rainChance: number;
  sunrise: string;
  sunset: string;
}

/** Standardized market data for a single ticker. */
export interface MarketData {
  ticker: string;
  price: number;
  change: number;
  changePct: number;
}

/** Standardized search result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  score?: number;
}

/** Standardized feed item. */
export interface FeedItem {
  title: string;
  url: string;
  summary?: string;
  published?: string;
}

/** Standardized social post. */
export interface SocialPost {
  id: string;
  text: string;
  author: string;
  timestamp: number;
  url?: string;
}

/** Standardized calendar event. */
export interface CalendarEvent {
  title: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

/** Core interface for all sense providers. */
export interface SenseProvider {
  /** Unique provider ID, e.g. "weather-openmeteo", "market-yahoo". */
  readonly id: string;
  /** Sense type this provider handles. */
  readonly type: SenseType;
  /** Display name, e.g. "Open-Meteo Weather". */
  readonly name: string;

  /** Called once at startup with the app config. */
  init?(config: AppConfig): void | Promise<void>;
  /** Whether this provider is currently available (has required API keys). */
  isAvailable(): boolean;

  /** Fetch weather data for coordinates. */
  fetchWeather?(coords: { lat: number; lon: number }): Promise<WeatherData>;
  /** Fetch market data for tickers. */
  fetchMarket?(tickers: string[]): Promise<MarketData[]>;
  /** Search the web. */
  search?(query: string, maxResults?: number): Promise<SearchResult[]>;
  /** Fetch a content feed (RSS, etc.). */
  fetchFeed?(feedUrl: string): Promise<FeedItem[]>;
  /** Fetch social media feed. */
  fetchSocialFeed?(query: string): Promise<SocialPost[]>;
  /** Fetch calendar events for a date. */
  fetchCalendar?(date: string): Promise<CalendarEvent[]>;

  /** Config key — reads from config.json. */
  configKey?: string;
}
