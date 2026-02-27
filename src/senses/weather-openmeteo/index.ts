/**
 * Open-Meteo weather sense provider.
 *
 * Extracted from src/world.ts. Uses Open-Meteo's free API (no key needed)
 * for real-time weather data.
 */

import * as https from "https";
import type { AppConfig } from "../../types.js";
import type { SenseProvider, SenseType, WeatherData } from "../types.js";

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

const provider: SenseProvider = {
  id: "weather-openmeteo",
  type: "weather" as SenseType,
  name: "Open-Meteo Weather (free)",

  isAvailable(): boolean {
    return true; // No API key needed
  },

  async fetchWeather(coords: { lat: number; lon: number }): Promise<WeatherData> {
    const { lat, lon } = coords;
    const url =
      `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
      `&timezone=auto`;

    const raw = await httpGet(url);
    const data = JSON.parse(raw);

    const current = data.current ?? {};
    const daily = data.daily ?? {};

    // Map weather code to condition
    const weatherCodeMap: Record<number, string> = {
      0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
      45: "fog", 48: "rime fog",
      51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
      61: "light rain", 63: "moderate rain", 65: "heavy rain",
      71: "light snow", 73: "moderate snow", 75: "heavy snow",
      80: "rain showers", 81: "moderate showers", 82: "heavy showers",
      95: "thunderstorm",
    };

    const code = current.weather_code ?? 0;
    const condition = weatherCodeMap[code] ?? "unknown";

    // Parse sunrise/sunset times (ISO 8601 → HH:MM)
    const sunrise = daily.sunrise?.[0]?.split("T")[1]?.slice(0, 5) ?? "";
    const sunset = daily.sunset?.[0]?.split("T")[1]?.slice(0, 5) ?? "";

    return {
      temp: current.temperature_2m ?? 0,
      feelsLike: current.apparent_temperature ?? 0,
      condition,
      high: daily.temperature_2m_max?.[0] ?? 0,
      low: daily.temperature_2m_min?.[0] ?? 0,
      rainChance: daily.precipitation_probability_max?.[0] ?? 0,
      sunrise,
      sunset,
    };
  },
};

export default provider;
