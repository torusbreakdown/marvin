import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const USER_AGENT = 'Marvin-Assistant/1.0';

interface GeoResult {
  lat: string;
  lon: string;
  display_name: string;
}

async function geocode(address: string): Promise<GeoResult> {
  const res = await fetch(
    `${NOMINATIM_URL}?q=${encodeURIComponent(address)}&format=json&limit=1`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) throw new Error(`Geocoding failed for "${address}": ${res.statusText}`);
  const data = (await res.json()) as GeoResult[];
  if (!data.length) throw new Error(`Could not find location: "${address}"`);
  return data[0];
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDistance(meters: number): string {
  const km = meters / 1000;
  const mi = km * 0.621371;
  return `${km.toFixed(1)} km (${mi.toFixed(1)} mi)`;
}

export function registerTravelTools(registry: ToolRegistry): void {
  registry.registerTool(
    'estimate_travel_time',
    'Estimate travel time between two locations',
    z.object({
      origin: z.string().describe('Starting location'),
      destination: z.string().describe('Destination'),
      mode: z.string().default('driving').describe('Travel mode'),
    }),
    async (args) => {
      const [orig, dest] = await Promise.all([geocode(args.origin), geocode(args.destination)]);
      const routeRes = await fetch(
        `${OSRM_URL}/${orig.lon},${orig.lat};${dest.lon},${dest.lat}?overview=false`,
      );
      if (!routeRes.ok) throw new Error(`Routing failed: ${routeRes.statusText}`);
      const routeData = (await routeRes.json()) as {
        code: string;
        routes: { distance: number; duration: number }[];
      };
      if (routeData.code !== 'Ok' || !routeData.routes.length) {
        throw new Error('No route found between the given locations.');
      }
      const route = routeData.routes[0];
      return [
        `From: ${orig.display_name}`,
        `To: ${dest.display_name}`,
        `Distance: ${formatDistance(route.distance)}`,
        `Estimated travel time: ${formatDuration(route.duration)}`,
        `Mode: ${args.mode}`,
      ].join('\n');
    },
    'always',
  );

  registry.registerTool(
    'get_directions',
    'Get turn-by-turn directions',
    z.object({
      origin: z.string().describe('Starting location'),
      destination: z.string().describe('Destination'),
    }),
    async (args) => {
      const [orig, dest] = await Promise.all([geocode(args.origin), geocode(args.destination)]);
      const routeRes = await fetch(
        `${OSRM_URL}/${orig.lon},${orig.lat};${dest.lon},${dest.lat}?steps=true&overview=false`,
      );
      if (!routeRes.ok) throw new Error(`Routing failed: ${routeRes.statusText}`);
      const routeData = (await routeRes.json()) as {
        code: string;
        routes: {
          distance: number;
          duration: number;
          legs: {
            steps: {
              maneuver: { type: string; modifier?: string };
              name: string;
              distance: number;
              duration: number;
            }[];
          }[];
        }[];
      };
      if (routeData.code !== 'Ok' || !routeData.routes.length) {
        throw new Error('No route found between the given locations.');
      }
      const route = routeData.routes[0];
      const steps = route.legs.flatMap((leg) => leg.steps);
      const lines = steps.map((step, i) => {
        const action = step.maneuver.modifier
          ? `${step.maneuver.type} ${step.maneuver.modifier}`
          : step.maneuver.type;
        const name = step.name || 'unnamed road';
        return `${i + 1}. ${action} on ${name} (${formatDistance(step.distance)}, ${formatDuration(step.duration)})`;
      });
      lines.push('');
      lines.push(`Total distance: ${formatDistance(route.distance)}`);
      lines.push(`Total time: ${formatDuration(route.duration)}`);
      lines.push(`From: ${orig.display_name}`);
      lines.push(`To: ${dest.display_name}`);
      return lines.join('\n');
    },
    'always',
  );
}
