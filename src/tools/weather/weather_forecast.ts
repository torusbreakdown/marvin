import { z } from "zod";
import type { ToolDef } from "../registry";
import { fetchText } from "../net/http";

export function weatherForecastTool(): ToolDef<{ latitude: number; longitude: number; days?: number }> {
  return {
    name: "weather_forecast",
    description: "Get current weather and a multi-day forecast using Open-Meteo.",
    schema: z.object({
      latitude: z.number(),
      longitude: z.number(),
      days: z.number().int().min(1).max(7).optional().default(3),
    }),
    write: false,
    async run(_ctx, args) {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(String(args.latitude))}` +
        `&longitude=${encodeURIComponent(String(args.longitude))}` +
        `&current=temperature_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
        `&forecast_days=${encodeURIComponent(String(args.days ?? 3))}` +
        `&timezone=auto`;

      const res = await fetchText(url, { headers: { "User-Agent": "marvin/1.0" }, timeoutMs: 15_000 });
      if (!res.ok) return `ERROR: weather_forecast failed (status ${res.status}): ${res.error}`;

      try {
        return JSON.parse(res.text);
      } catch (e) {
        return `ERROR: weather_forecast invalid JSON: ${String(e)}`;
      }
    },
  };
}
