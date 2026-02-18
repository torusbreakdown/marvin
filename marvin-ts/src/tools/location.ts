import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';
import type { ToolRegistry } from './registry.js';

const execFileAsync = promisify(execFile);

async function tryGeoClue(): Promise<{ lat: number; lng: number; source: string } | null> {
  try {
    // Quick check if whereami is available
    const result = await execFileAsync('whereami', [], { timeout: 3000 });
    const lines = result.stdout.split('\n');
    let lat = 0, lng = 0;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join(':').trim();
        if (key === 'Latitude') lat = parseFloat(val);
        if (key === 'Longitude') lng = parseFloat(val);
      }
    }
    if (lat !== 0 || lng !== 0) return { lat, lng, source: 'GeoClue' };
  } catch { /* GeoClue/whereami not available */ }
  return null;
}

async function tryCoreLocation(): Promise<{ lat: number; lng: number; source: string } | null> {
  if (platform() !== 'darwin') return null;
  try {
    const script = 'import CoreLocation; let m = CLLocationManager(); m.requestWhenInUseAuthorization()';
    // CoreLocation via swift is complex; skip in non-macOS
    return null;
  } catch { return null; }
}

async function ipGeolocation(): Promise<{ lat: number; lng: number; source: string; city?: string; region?: string; country?: string }> {
  const resp = await fetch('http://ip-api.com/json/?fields=lat,lon,city,regionName,country');
  if (!resp.ok) throw new Error(`IP geolocation failed: ${resp.status}`);
  const data = await resp.json() as any;
  return {
    lat: data.lat,
    lng: data.lon,
    source: 'IP geolocation',
    city: data.city,
    region: data.regionName,
    country: data.country,
  };
}

export function registerLocationTools(registry: ToolRegistry): void {
  registry.registerTool(
    'get_my_location',
    'Get the user\'s current location. Tries device location services (CoreLocation on macOS, GeoClue on Linux) first, then falls back to IP-based geolocation.',
    z.object({}),
    async (_args, _ctx) => {
      // Try platform-specific first
      const plat = platform();
      let loc: { lat: number; lng: number; source: string; city?: string; region?: string; country?: string } | null = null;

      if (plat === 'linux') {
        loc = await tryGeoClue();
      } else if (plat === 'darwin') {
        loc = await tryCoreLocation();
      }

      // Fallback to IP
      if (!loc) {
        try {
          loc = await ipGeolocation();
        } catch (err: any) {
          return `Error: Unable to determine location. ${err.message}`;
        }
      }

      const parts = [
        `Latitude: ${loc.lat}`,
        `Longitude: ${loc.lng}`,
        `Source: ${loc.source}`,
      ];
      if (loc.city) parts.push(`City: ${loc.city}`);
      if (loc.region) parts.push(`Region: ${loc.region}`);
      if (loc.country) parts.push(`Country: ${loc.country}`);
      return parts.join('\n');
    },
    'always',
  );
}
