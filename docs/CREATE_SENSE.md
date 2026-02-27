# Creating a Sense Provider

Sense Providers are information sources — weather, market data, web search, content feeds, calendars, etc.

## Quick Start

1. Create `src/senses/<your-provider>/index.ts`
2. Export a default `SenseProvider` instance
3. Restart MeAI — your provider is auto-discovered

## SenseProvider Interface

```typescript
interface SenseProvider {
  readonly id: string;       // "weather-openmeteo", "market-yahoo"
  readonly type: SenseType;  // "search" | "weather" | "market" | "content_feed" | etc.
  readonly name: string;

  init?(config: AppConfig): void | Promise<void>;
  isAvailable(): boolean;

  fetchWeather?(coords: { lat: number; lon: number }): Promise<WeatherData>;
  fetchMarket?(tickers: string[]): Promise<MarketData[]>;
  search?(query: string, maxResults?: number): Promise<SearchResult[]>;
  fetchFeed?(feedUrl: string): Promise<FeedItem[]>;
  fetchSocialFeed?(query: string): Promise<SocialPost[]>;
  fetchCalendar?(date: string): Promise<CalendarEvent[]>;
}
```

## Sense Types

| Type | Default Provider | What It Does |
|------|-----------------|-------------|
| `search` | `search-tavily` / `search-duckduckgo` | Web search |
| `weather` | `weather-openmeteo` | Weather data |
| `market` | `market-yahoo` | Stock/index prices |
| `content_feed` | (none yet) | RSS/content feeds |
| `calendar` | (none yet) | Calendar events |

## Usage

```typescript
import { senseRegistry } from "./senses/registry.js";

const weather = senseRegistry.getSense("weather");
if (weather) {
  const data = await weather.fetchWeather!({ lat: 37.7749, lon: -122.4194 });
  console.log(`${data.temp}°C, ${data.condition}`);
}

// Fallback chain: get all providers for a type
const searchProviders = senseRegistry.getAllSenses("search");
```

## Existing Providers

- `weather-openmeteo` — Open-Meteo (free, no API key)
- `market-yahoo` — Yahoo Finance (free, no API key)
- `search-duckduckgo` — DuckDuckGo HTML scraping (free)
- `search-tavily` — Tavily AI search (requires `tavilyApiKey`)

## Adding a New Provider

Example: Google Calendar sense provider

```typescript
import type { SenseProvider, SenseType, CalendarEvent } from "../types.js";

const provider: SenseProvider = {
  id: "calendar-google",
  type: "calendar" as SenseType,
  name: "Google Calendar",
  isAvailable: () => !!process.env.GOOGLE_CALENDAR_KEY,
  async fetchCalendar(date: string): Promise<CalendarEvent[]> {
    // ... fetch events from Google Calendar API
  },
};

export default provider;
```
