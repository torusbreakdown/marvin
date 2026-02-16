import { z } from "zod";
import type { ToolDef } from "../registry";
import { fetchText } from "../net/http";

export function placesTextSearchTool(): ToolDef<{
  text_query: string;
  latitude?: number;
  longitude?: number;
  radius?: number;
  max_results?: number;
  open_now?: boolean;
}> {
  return {
    name: "places_text_search",
    description: "Search for places using a natural-language query (OSM Nominatim fallback).",
    schema: z.object({
      text_query: z.string(),
      latitude: z.number().optional().default(0),
      longitude: z.number().optional().default(0),
      radius: z.number().optional().default(5000),
      max_results: z.number().int().min(1).max(20).optional().default(5),
      open_now: z.boolean().optional().default(false),
    }),
    write: false,
    async run(_ctx, args) {
      // OSM Nominatim text search.
      const url =
        `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${encodeURIComponent(
          String(args.max_results ?? 5),
        )}&q=${encodeURIComponent(args.text_query)}`;

      const res = await fetchText(url, {
        headers: {
          "User-Agent": "marvin/1.0 (clean-room Node rewrite)",
          "Accept-Language": "en",
        },
        timeoutMs: 20_000,
      });
      if (!res.ok) return `ERROR: places_text_search failed (status ${res.status}): ${res.error}`;

      let j: any;
      try {
        j = JSON.parse(res.text);
      } catch (e) {
        return `ERROR: places_text_search invalid JSON: ${String(e)}`;
      }

      if (!Array.isArray(j)) return [];
      return j.map((p: any) => ({
        name: p?.name ?? p?.display_name?.split(",")[0] ?? "",
        address: p?.display_name ?? "",
        lat: typeof p?.lat === "string" ? Number(p.lat) : p?.lat ?? 0,
        lng: typeof p?.lon === "string" ? Number(p.lon) : p?.lon ?? 0,
        category: p?.type ?? "",
        source: "osm",
      }));
    },
  };
}
