import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { ToolRegistry } from './registry.js';

function getGoogleAuthHeaders(): Record<string, string> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (apiKey) {
    return { 'X-Goog-Api-Key': apiKey };
  }
  // Fall back to gcloud ADC bearer token
  try {
    const token = execSync('gcloud auth application-default print-access-token 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (token) return { Authorization: `Bearer ${token}` };
  } catch { /* ignore */ }
  try {
    const token = execSync('gcloud auth print-access-token 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (token) return { Authorization: `Bearer ${token}` };
  } catch { /* ignore */ }
  return {};
}

function hasGoogleAuth(): boolean {
  return !!(process.env.GOOGLE_PLACES_API_KEY || Object.keys(getGoogleAuthHeaders()).length);
}

async function googleTextSearch(query: string, lat?: number, lng?: number, radius?: number, maxResults?: number, openNow?: boolean): Promise<string> {
  const authHeaders = getGoogleAuthHeaders();
  if (!Object.keys(authHeaders).length) throw new Error('No Google auth available');

  const body: any = { textQuery: query, maxResultCount: maxResults || 5 };
  if (lat && lng) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: radius || 5000 } };
  }
  if (openNow) body.openNow = true;

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.location,places.types',
      ...authHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Google Places API error: ${resp.status}`);
  const data = await resp.json() as any;
  if (!data.places?.length) return '';
  return data.places.map((p: any, i: number) => {
    const parts = [`${i + 1}. ${p.displayName?.text || 'Unknown'}`];
    if (p.formattedAddress) parts.push(`   Address: ${p.formattedAddress}`);
    if (p.rating) parts.push(`   Rating: ${p.rating}/5 (${p.userRatingCount || 0} reviews)`);
    if (p.location) parts.push(`   Location: ${p.location.latitude}, ${p.location.longitude}`);
    return parts.join('\n');
  }).join('\n\n');
}

async function osmTextSearch(query: string, lat?: number, lng?: number, maxResults?: number): Promise<string> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: String(maxResults || 5),
    addressdetails: '1',
  });
  if (lat && lng) {
    params.set('viewbox', `${lng - 0.1},${lat + 0.1},${lng + 0.1},${lat - 0.1}`);
    params.set('bounded', '0');
  }

  const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': 'Marvin-Assistant/1.0' },
  });
  if (!resp.ok) throw new Error(`OSM search failed: ${resp.status}`);
  const results = await resp.json() as any[];
  if (!results.length) return '';
  return results.map((r: any, i: number) => {
    const parts = [`${i + 1}. ${r.display_name}`];
    parts.push(`   Location: ${r.lat}, ${r.lon}`);
    if (r.type) parts.push(`   Type: ${r.type}`);
    return parts.join('\n');
  }).join('\n\n');
}

async function osmNearbySearch(lat: number, lng: number, types: string[], radius: number, maxResults: number): Promise<string> {
  const amenityFilter = types.map(t => `"amenity"="${t}"`).join('');
  const bbox = `${lat - radius / 111000},${lng - radius / (111000 * Math.cos(lat * Math.PI / 180))},${lat + radius / 111000},${lng + radius / (111000 * Math.cos(lat * Math.PI / 180))}`;
  const query = `[out:json][timeout:10];(node[${amenityFilter || '"amenity"'}](${bbox}););out body ${maxResults};`;

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!resp.ok) throw new Error(`Overpass API failed: ${resp.status}`);
  const data = await resp.json() as any;
  if (!data.elements?.length) return '';
  return data.elements.map((el: any, i: number) => {
    const name = el.tags?.name || 'Unknown';
    const parts = [`${i + 1}. ${name}`];
    if (el.tags?.['addr:street']) parts.push(`   Address: ${el.tags['addr:street']}`);
    parts.push(`   Location: ${el.lat}, ${el.lon}`);
    if (el.tags?.amenity) parts.push(`   Type: ${el.tags.amenity}`);
    return parts.join('\n');
  }).join('\n\n');
}

export function registerPlacesTools(registry: ToolRegistry): void {
  registry.registerTool(
    'places_text_search',
    'Search for places using a natural-language query. Uses Google Places API if available, otherwise falls back to OpenStreetMap.',
    z.object({
      text_query: z.string().describe('Natural-language search query'),
      latitude: z.number().default(0).describe('Optional latitude to bias results toward'),
      longitude: z.number().default(0).describe('Optional longitude to bias results toward'),
      radius: z.number().default(5000).describe('Bias radius in meters'),
      max_results: z.number().default(5).describe('Max results (1-20)'),
      open_now: z.boolean().default(false).describe('Only show places open now'),
    }),
    async (args, _ctx) => {
      if (hasGoogleAuth()) {
        try {
          const result = await googleTextSearch(
            args.text_query,
            args.latitude || undefined, args.longitude || undefined,
            args.radius, args.max_results, args.open_now,
          );
          if (result) return result;
        } catch { /* fall through to OSM */ }
      }

      try {
        const result = await osmTextSearch(
          args.text_query,
          args.latitude || undefined, args.longitude || undefined,
          args.max_results,
        );
        if (result) return result;
      } catch (err: any) {
        return `Error searching for places: ${err.message}`;
      }

      return 'No results found for your search.';
    },
    'always',
  );

  registry.registerTool(
    'places_nearby_search',
    'Search for nearby places by type and coordinates. Uses Google Places API if available, otherwise falls back to OpenStreetMap.',
    z.object({
      latitude: z.number().describe('Latitude of the search center'),
      longitude: z.number().describe('Longitude of the search center'),
      included_types: z.array(z.string()).describe('Place types to include, e.g. ["restaurant"], ["cafe"]'),
      radius: z.number().default(5000).describe('Search radius in meters (max 50000)'),
      max_results: z.number().default(5).describe('Max results (1-20)'),
      rank_by: z.string().default('POPULARITY').describe('Rank by POPULARITY or DISTANCE'),
    }),
    async (args, _ctx) => {
      if (hasGoogleAuth()) {
        try {
          const authHeaders = getGoogleAuthHeaders();
          const body: any = {
            includedTypes: args.included_types,
            maxResultCount: args.max_results,
            rankPreference: args.rank_by,
            locationRestriction: {
              circle: { center: { latitude: args.latitude, longitude: args.longitude }, radius: args.radius },
            },
          };
          const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.location,places.types',
              ...authHeaders,
            },
            body: JSON.stringify(body),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            if (data.places?.length) {
              return data.places.map((p: any, i: number) => {
                const parts = [`${i + 1}. ${p.displayName?.text || 'Unknown'}`];
                if (p.formattedAddress) parts.push(`   Address: ${p.formattedAddress}`);
                if (p.rating) parts.push(`   Rating: ${p.rating}/5`);
                if (p.location) parts.push(`   Location: ${p.location.latitude}, ${p.location.longitude}`);
                return parts.join('\n');
              }).join('\n\n');
            }
          }
        } catch { /* fall through to OSM */ }
      }

      try {
        const result = await osmNearbySearch(args.latitude, args.longitude, args.included_types, args.radius, args.max_results);
        if (result) return result;
      } catch (err: any) {
        return `Error searching nearby places: ${err.message}`;
      }

      return 'No nearby places found.';
    },
    'always',
  );

  registry.registerTool(
    'setup_google_auth',
    'Set up Google Cloud authentication and enable the Places API. Call this when a Places API request fails with auth errors.',
    z.object({}),
    async (_args, _ctx) => {
      const authHeaders = getGoogleAuthHeaders();
      const hasAuth = Object.keys(authHeaders).length > 0;
      const method = authHeaders.Authorization ? 'gcloud OAuth' : authHeaders['X-Goog-Api-Key'] ? 'API key' : 'none';
      const steps = [
        'Google Places API authentication options:',
        '',
        'Option 1 (recommended): Use gcloud CLI',
        '  gcloud auth application-default login',
        '  # Ensure Places API is enabled in your project',
        '',
        'Option 2: Use an API key',
        '  export GOOGLE_PLACES_API_KEY="your-api-key"',
        '',
        `Current status: ${hasAuth ? `Authenticated via ${method}` : 'No authentication found'}`,
      ];
      return steps.join('\n');
    },
    'always',
  );
}
