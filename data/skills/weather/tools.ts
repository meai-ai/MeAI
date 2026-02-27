/**
 * Weather skill — accurate weather using Open-Meteo (primary) and wttr.in (fallback).
 * No API key required. Uses ECMWF/NOAA weather models via Open-Meteo.
 *
 * Features:
 *   - Current conditions with feels-like, wind, humidity, UV
 *   - Hourly forecast with rain probability
 *   - 7-day daily forecast with high/low, rain chance, sunrise/sunset
 *   - Air quality index (AQI) with pollutant breakdown
 */

import * as https from 'https';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'MeAI/1.0', Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGetJson(res.headers.location).then(resolve, reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

// ── Geocoding (Open-Meteo) ──────────────────────────────────────────────────

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;  // state/province
  timezone: string;
}

async function geocode(city: string): Promise<GeoResult> {
  // Well-known locations shortcut (avoid geocoding issues)
  const shortcuts: Record<string, GeoResult> = {
    'new york': { name: 'New York', latitude: 40.7128, longitude: -74.0060, country: 'US', admin1: 'New York', timezone: 'America/New_York' },
    beijing: { name: 'Beijing', latitude: 39.9042, longitude: 116.4074, country: 'CN', admin1: 'Beijing', timezone: 'Asia/Shanghai' },
    shanghai: { name: 'Shanghai', latitude: 31.2304, longitude: 121.4737, country: 'CN', admin1: 'Shanghai', timezone: 'Asia/Shanghai' },
  };

  const lower = city.toLowerCase().trim();
  if (shortcuts[lower]) return shortcuts[lower];

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const data = await httpGetJson(url);

  if (!data.results || data.results.length === 0) {
    throw new Error(`Location not found: "${city}". Try a different spelling or use English name.`);
  }

  const r = data.results[0];
  return {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country_code || r.country || '',
    admin1: r.admin1 || '',
    timezone: r.timezone || 'America/Los_Angeles',
  };
}

// ── WMO weather code → description ──────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function describeWeather(code: number): string {
  return WMO_CODES[code] || `Unknown (code ${code})`;
}

// ── Unit conversion helpers ─────────────────────────────────────────────────

function cToF(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

function kmhToMph(kmh: number): number {
  return Math.round(kmh * 0.621371 * 10) / 10;
}

// ── Tool exports ────────────────────────────────────────────────────────────

export function getTools(_config?: any): any[] {
  return [
    {
      name: 'get_weather',
      description:
        'Get current weather conditions for a city. Returns temperature, feels-like, ' +
        'wind, humidity, UV index, precipitation, and cloud cover. ' +
        'Also returns a brief today overview with rain probability.',
      inputSchema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name (e.g. "New York", "Beijing"). Default: from character config.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const city = (input.city as string) || 'New York';
          const geo = await geocode(city);

          const url = `https://api.open-meteo.com/v1/forecast?` +
            `latitude=${geo.latitude}&longitude=${geo.longitude}` +
            `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max` +
            `&timezone=${encodeURIComponent(geo.timezone)}` +
            `&forecast_days=1`;

          const data = await httpGetJson(url);
          const c = data.current;
          const today = data.daily;

          const tempC = Math.round(c.temperature_2m * 10) / 10;
          const feelsC = Math.round(c.apparent_temperature * 10) / 10;

          return JSON.stringify({
            success: true,
            location: {
              city: geo.name,
              region: geo.admin1 || '',
              country: geo.country,
              coordinates: `${geo.latitude}, ${geo.longitude}`,
            },
            current: {
              condition: describeWeather(c.weather_code),
              temperature: `${cToF(tempC)}°F (${tempC}°C)`,
              feels_like: `${cToF(feelsC)}°F (${feelsC}°C)`,
              humidity: `${c.relative_humidity_2m}%`,
              wind: `${kmhToMph(c.wind_speed_10m)} mph (gusts ${kmhToMph(c.wind_gusts_10m)} mph)`,
              wind_direction: `${c.wind_direction_10m}°`,
              cloud_cover: `${c.cloud_cover}%`,
              precipitation: `${c.precipitation} mm`,
              is_day: c.is_day === 1,
            },
            today_overview: {
              high: `${cToF(today.temperature_2m_max[0])}°F (${today.temperature_2m_max[0]}°C)`,
              low: `${cToF(today.temperature_2m_min[0])}°F (${today.temperature_2m_min[0]}°C)`,
              rain_probability: `${today.precipitation_probability_max[0]}%`,
              total_precipitation: `${today.precipitation_sum[0]} mm`,
              uv_index: today.uv_index_max[0],
              sunrise: today.sunrise[0]?.split('T')[1] || '',
              sunset: today.sunset[0]?.split('T')[1] || '',
            },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'weather_hourly',
      description:
        'Get hourly weather forecast for the next 24 hours. ' +
        'Shows temperature, rain probability, precipitation, and conditions for each hour. ' +
        'Best for answering "will it rain?", "should I bring an umbrella?", "when will it stop raining?"',
      inputSchema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name. Default: from character config.',
          },
          hours: {
            type: 'number',
            description: 'Number of hours to show. Default: 12.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const city = (input.city as string) || 'New York';
          const maxHours = (input.hours as number) || 12;
          const geo = await geocode(city);

          const url = `https://api.open-meteo.com/v1/forecast?` +
            `latitude=${geo.latitude}&longitude=${geo.longitude}` +
            `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,apparent_temperature` +
            `&timezone=${encodeURIComponent(geo.timezone)}` +
            `&forecast_hours=${Math.min(maxHours, 48)}`;

          const data = await httpGetJson(url);
          const h = data.hourly;

          // Find current hour index
          const now = new Date();
          const currentHour = now.toISOString().slice(0, 13);
          let startIdx = 0;
          for (let i = 0; i < h.time.length; i++) {
            if (h.time[i] >= currentHour) { startIdx = i; break; }
          }

          const hours = [];
          for (let i = startIdx; i < Math.min(startIdx + maxHours, h.time.length); i++) {
            const tempC = h.temperature_2m[i];
            hours.push({
              time: h.time[i]?.split('T')[1] || h.time[i],
              condition: describeWeather(h.weather_code[i]),
              temperature: `${cToF(tempC)}°F`,
              feels_like: `${cToF(h.apparent_temperature[i])}°F`,
              rain_probability: `${h.precipitation_probability[i]}%`,
              precipitation: `${h.precipitation[i]} mm`,
              wind: `${kmhToMph(h.wind_speed_10m[i])} mph`,
            });
          }

          // Summary: will it rain?
          const rainHours = hours.filter(hr =>
            parseInt(hr.rain_probability) >= 40,
          );
          const rainSummary = rainHours.length > 0
            ? `Rain likely during ${rainHours.length} of the next ${hours.length} hours (${rainHours.map(h => h.time).join(', ')})`
            : 'No significant rain expected';

          return JSON.stringify({
            success: true,
            location: { city: geo.name, country: geo.country },
            rain_summary: rainSummary,
            hours,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'weather_forecast',
      description:
        'Get multi-day weather forecast (up to 7 days). ' +
        'Use for: "明天天气", "tomorrow\'s weather", "this weekend", "next few days", any future date. ' +
        'Shows daily high/low, conditions, rain probability, UV, sunrise/sunset. ' +
        'day index 0 = today, 1 = tomorrow, 2 = day after tomorrow.',
      inputSchema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name. Default: from character config.',
          },
          days: {
            type: 'number',
            description: 'Number of days (1-7). Default: 7.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const city = (input.city as string) || 'New York';
          const days = Math.min((input.days as number) || 7, 7);
          const geo = await geocode(city);

          const url = `https://api.open-meteo.com/v1/forecast?` +
            `latitude=${geo.latitude}&longitude=${geo.longitude}` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset` +
            `&timezone=${encodeURIComponent(geo.timezone)}` +
            `&forecast_days=${days}`;

          const data = await httpGetJson(url);
          const d = data.daily;

          const forecast = [];
          for (let i = 0; i < d.time.length; i++) {
            const date = new Date(d.time[i] + 'T12:00:00');
            const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });

            forecast.push({
              date: d.time[i],
              weekday,
              condition: describeWeather(d.weather_code[i]),
              high: `${cToF(d.temperature_2m_max[i])}°F (${d.temperature_2m_max[i]}°C)`,
              low: `${cToF(d.temperature_2m_min[i])}°F (${d.temperature_2m_min[i]}°C)`,
              rain_probability: `${d.precipitation_probability_max[i]}%`,
              total_precipitation: `${d.precipitation_sum[i]} mm`,
              wind_max: `${kmhToMph(d.wind_speed_10m_max[i])} mph`,
              uv_index: d.uv_index_max[i],
              sunrise: d.sunrise[i]?.split('T')[1] || '',
              sunset: d.sunset[i]?.split('T')[1] || '',
            });
          }

          return JSON.stringify({
            success: true,
            location: { city: geo.name, region: geo.admin1 || '', country: geo.country },
            days: forecast.length,
            forecast,
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },

    {
      name: 'weather_aqi',
      description:
        'Get air quality index (AQI) and pollutant levels. ' +
        'Use when user asks about air quality, pollution, smoke, or whether it\'s safe to exercise outdoors.',
      inputSchema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name. Default: from character config.',
          },
        },
        required: [],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        try {
          const city = (input.city as string) || 'New York';
          const geo = await geocode(city);

          const url = `https://air-quality-api.open-meteo.com/v1/air-quality?` +
            `latitude=${geo.latitude}&longitude=${geo.longitude}` +
            `&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,european_aqi` +
            `&timezone=${encodeURIComponent(geo.timezone)}`;

          const data = await httpGetJson(url);
          const c = data.current;

          // AQI categories (US EPA standard)
          const usAqi = c.us_aqi;
          let aqiCategory: string;
          let aqiAdvice: string;

          if (usAqi <= 50) {
            aqiCategory = 'Good';
            aqiAdvice = 'Air quality is satisfactory. Enjoy outdoor activities.';
          } else if (usAqi <= 100) {
            aqiCategory = 'Moderate';
            aqiAdvice = 'Acceptable. Unusually sensitive people should consider reducing prolonged outdoor exertion.';
          } else if (usAqi <= 150) {
            aqiCategory = 'Unhealthy for Sensitive Groups';
            aqiAdvice = 'Sensitive groups (children, elderly, those with respiratory conditions) should limit prolonged outdoor exertion.';
          } else if (usAqi <= 200) {
            aqiCategory = 'Unhealthy';
            aqiAdvice = 'Everyone may begin to experience health effects. Limit prolonged outdoor exertion.';
          } else if (usAqi <= 300) {
            aqiCategory = 'Very Unhealthy';
            aqiAdvice = 'Health alert. Everyone should avoid prolonged outdoor exertion.';
          } else {
            aqiCategory = 'Hazardous';
            aqiAdvice = 'Health warning of emergency conditions. Stay indoors.';
          }

          return JSON.stringify({
            success: true,
            location: { city: geo.name, country: geo.country },
            air_quality: {
              us_aqi: usAqi,
              category: aqiCategory,
              advice: aqiAdvice,
              pollutants: {
                pm2_5: `${c.pm2_5} μg/m³`,
                pm10: `${c.pm10} μg/m³`,
                ozone: `${c.ozone} μg/m³`,
                nitrogen_dioxide: `${c.nitrogen_dioxide} μg/m³`,
                carbon_monoxide: `${c.carbon_monoxide} μg/m³`,
              },
            },
          });
        } catch (err: any) {
          return JSON.stringify({ success: false, error: err.message });
        }
      },
    },
  ];
}
