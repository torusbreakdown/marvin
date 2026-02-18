import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
  55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Freezing rain (light)', 67: 'Freezing rain (heavy)',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
};

export function registerWeatherTools(registry: ToolRegistry): void {
  registry.registerTool(
    'weather_forecast',
    'Get current weather and a multi-day forecast using the free Open-Meteo API.',
    z.object({
      latitude: z.number().describe('Latitude of the location'),
      longitude: z.number().describe('Longitude of the location'),
      days: z.number().default(3).describe('Number of forecast days (1-7)'),
    }),
    async (args, _ctx) => {
      const params = new URLSearchParams({
        latitude: String(args.latitude),
        longitude: String(args.longitude),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,wind_speed_10m_max',
        forecast_days: String(Math.min(args.days, 7)),
        timezone: 'auto',
      });

      const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!resp.ok) return `Error: Open-Meteo request failed (${resp.status})`;
      const data = await resp.json() as any;

      const parts: string[] = [];
      const c = data.current;
      if (c) {
        const condition = WMO_CODES[c.weather_code] || `Code ${c.weather_code}`;
        parts.push('Current Conditions:');
        parts.push(`  ${condition}`);
        parts.push(`  Temperature: ${c.temperature_2m}°C (feels like ${c.apparent_temperature}°C)`);
        parts.push(`  Humidity: ${c.relative_humidity_2m}%`);
        parts.push(`  Wind: ${c.wind_speed_10m} km/h`);
        if (c.precipitation > 0) parts.push(`  Precipitation: ${c.precipitation} mm`);
      }

      const d = data.daily;
      if (d?.time?.length) {
        parts.push('\nForecast:');
        for (let i = 0; i < d.time.length; i++) {
          const condition = WMO_CODES[d.weather_code[i]] || `Code ${d.weather_code[i]}`;
          parts.push(`  ${d.time[i]}: ${condition}`);
          parts.push(`    High: ${d.temperature_2m_max[i]}°C / Low: ${d.temperature_2m_min[i]}°C`);
          if (d.precipitation_sum[i] > 0) parts.push(`    Precipitation: ${d.precipitation_sum[i]} mm`);
          parts.push(`    Wind: up to ${d.wind_speed_10m_max[i]} km/h`);
          parts.push(`    Sunrise: ${d.sunrise[i]?.split('T')[1] || 'N/A'} / Sunset: ${d.sunset[i]?.split('T')[1] || 'N/A'}`);
        }
      }

      return parts.join('\n') || 'No weather data available.';
    },
    'always',
  );
}
