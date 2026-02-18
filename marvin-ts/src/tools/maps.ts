import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerMapsTools(registry: ToolRegistry): void {
  registry.registerTool(
    'osm_search',
    'Search OpenStreetMap via Nominatim for locations, addresses, and points of interest.',
    z.object({
      query: z.string().describe('Search query (address, place name, etc.)'),
      max_results: z.number().default(5).describe('Max results (1-20)'),
    }),
    async (args, _ctx) => {
      const params = new URLSearchParams({
        q: args.query,
        format: 'json',
        limit: String(args.max_results),
        addressdetails: '1',
      });

      const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'Marvin-Assistant/1.0' },
      });
      if (!resp.ok) return `Error: Nominatim search failed (${resp.status})`;
      const results = await resp.json() as any[];
      if (!results.length) return 'No results found.';

      return results.map((r: any, i: number) => {
        const parts = [`${i + 1}. ${r.display_name}`];
        parts.push(`   Lat: ${r.lat}, Lon: ${r.lon}`);
        if (r.type) parts.push(`   Type: ${r.type}`);
        if (r.importance) parts.push(`   Importance: ${r.importance.toFixed(2)}`);
        return parts.join('\n');
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'overpass_query',
    'Execute an Overpass API query against OpenStreetMap data. Use Overpass QL syntax.',
    z.object({
      query: z.string().describe('Overpass QL query string'),
    }),
    async (args, _ctx) => {
      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(args.query)}`,
      });
      if (!resp.ok) return `Error: Overpass query failed (${resp.status})`;
      const data = await resp.json() as any;
      if (!data.elements?.length) return 'No results found.';

      return data.elements.slice(0, 20).map((el: any, i: number) => {
        const name = el.tags?.name || `${el.type}/${el.id}`;
        const parts = [`${i + 1}. ${name}`];
        if (el.lat != null) parts.push(`   Lat: ${el.lat}, Lon: ${el.lon}`);
        const tagEntries = Object.entries(el.tags || {}).filter(([k]) => k !== 'name').slice(0, 5);
        if (tagEntries.length) parts.push(`   Tags: ${tagEntries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
        return parts.join('\n');
      }).join('\n\n');
    },
    'always',
  );
}
