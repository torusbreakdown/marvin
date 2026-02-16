/**
 * Location and Places Tools
 * get_my_location, places_text_search, places_nearby_search, save_place, list_places
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { loadSavedPlaces, saveSavedPlaces, getActiveProfile } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// IP Geolocation fallback
async function getLocationFromIP(): Promise<{ lat: number; lng: number; source: string }> {
  try {
    const response = await fetch('http://ip-api.com/json/');
    const data = await response.json();
    return {
      lat: data.lat,
      lng: data.lon,
      source: 'ip',
    };
  } catch (error) {
    throw new Error('Failed to get location from IP: ' + (error instanceof Error ? error.message : String(error)));
  }
}

export const getMyLocationTool = defineTool({
  name: 'get_my_location',
  description: "Get the user's current location. Tries the device's location services (CoreLocation on macOS, GeoClue on Linux) first, then falls back to IP-based geolocation. Returns latitude, longitude, and source.",
  parameters: z.object({}),
  readonly: true,
  
  async execute() {
    try {
      // Try IP geolocation as primary method
      const location = await getLocationFromIP();
      logger.info(`Location obtained: ${location.lat}, ${location.lng} (source: ${location.source})`);
      return `Location: ${location.lat}, ${location.lng} (source: ${location.source})`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const placesTextSearchTool = defineTool({
  name: 'places_text_search',
  description: "Search for places using a natural-language query. Automatically uses Google Places API if available, otherwise falls back to OpenStreetMap. Just call this tool — it always returns results. e.g. 'best ramen in downtown Seattle' or 'late night tacos Austin TX'",
  parameters: z.object({
    text_query: z.string().describe("Natural-language search query, e.g. 'best ramen in downtown Seattle' or 'late night tacos Austin TX'"),
    latitude: z.number().default(0).describe('Optional latitude to bias results toward'),
    longitude: z.number().default(0).describe('Optional longitude to bias results toward'),
    radius: z.number().default(5000).describe('Bias radius in meters (used with lat/lng)'),
    max_results: z.number().default(5).describe('Max results (1-20)'),
    open_now: z.boolean().default(false).describe('Only show places open now'),
  }),
  readonly: true,
  
  async execute({ text_query, latitude, longitude, radius, max_results, open_now }) {
    try {
      // Use Nominatim (OpenStreetMap) as fallback
      const query = encodeURIComponent(text_query);
      const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=${max_results}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Marvin/1.0 (Node.js assistant)',
        },
      });
      
      if (!response.ok) {
        throw new Error(`Nominatim API error: ${response.status}`);
      }
      
      const results = await response.json();
      
      if (!results || results.length === 0) {
        return `No places found for: ${text_query}`;
      }
      
      const lines: string[] = [`Found ${results.length} places for "${text_query}":`, ''];
      
      for (let i = 0; i < results.length; i++) {
        const place = results[i];
        lines.push(`${i + 1}. ${place.display_name}`);
        if (place.lat && place.lon) {
          lines.push(`   Location: ${place.lat}, ${place.lon}`);
        }
        lines.push('');
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const placesNearbySearchTool = defineTool({
  name: 'places_nearby_search',
  description: "Search for nearby places by type and coordinates. Automatically uses Google Places API if available, otherwise falls back to OpenStreetMap. Just call this tool — it always returns results. Use when you know the exact location (lat/lng) and place type.",
  parameters: z.object({
    latitude: z.number().describe('Latitude of the search center'),
    longitude: z.number().describe('Longitude of the search center'),
    included_types: z.array(z.string()).describe("Google place types to include, e.g. ['restaurant'], ['gym'], ['cafe', 'bakery']"),
    radius: z.number().default(5000).describe('Search radius in meters (max 50000)'),
    max_results: z.number().default(5).describe('Max results (1-20)'),
    rank_by: z.string().default('POPULARITY').describe('Rank by POPULARITY or DISTANCE'),
  }),
  readonly: true,
  
  async execute({ latitude, longitude, included_types, radius, max_results }) {
    try {
      // Use Overpass API (OpenStreetMap) for nearby search
      const types = included_types.map(t => `["${t}"]`).join('');
      const query = `[out:json];node(around:${radius},${latitude},${longitude})${types};out ${max_results};`;
      
      const url = 'https://overpass-api.de/api/interpreter';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      });
      
      if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status}`);
      }
      
      const data = await response.json();
      const elements = data.elements || [];
      
      if (elements.length === 0) {
        return `No places found within ${radius}m of ${latitude}, ${longitude}`;
      }
      
      const lines: string[] = [`Found ${elements.length} places:`, ''];
      
      for (let i = 0; i < elements.length; i++) {
        const place = elements[i];
        const tags = place.tags || {};
        lines.push(`${i + 1}. ${tags.name || 'Unnamed'} (${tags.amenity || tags.shop || 'place'})`);
        lines.push(`   Location: ${place.lat}, ${place.lon}`);
        if (tags.addr_street) {
          lines.push(`   Address: ${tags.addr_street} ${tags.addr_housenumber || ''}`);
        }
        lines.push('');
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const savePlaceTool = defineTool({
  name: 'save_place',
  description: "Save a place to the user's address book. Use this when the user says 'save this place', 'remember this address', 'bookmark this restaurant', 'that's my home address', or when they share a name, address, phone number, or website they want to keep. Also save places the user explicitly liked or wants to revisit.",
  parameters: z.object({
    label: z.string().describe("Short label/nickname for this place (e.g. 'home', 'work', 'mom', 'favorite ramen')"),
    name: z.string().optional().describe('Business or place name'),
    address: z.string().optional().describe('Street address'),
    phone: z.string().optional().describe('Phone number'),
    website: z.string().optional().describe('Website URL'),
    lat: z.number().optional().describe('Latitude'),
    lng: z.number().optional().describe('Longitude'),
    notes: z.string().optional().describe('Any extra notes (hours, menu favorites, etc.)'),
  }),
  readonly: false,
  
  async execute({ label, name, address, phone, website, lat, lng, notes }) {
    try {
      const profile = getActiveProfile();
      const places = loadSavedPlaces(profile);
      
      // Remove existing place with same label
      const existingIndex = places.findIndex(p => p.label === label);
      if (existingIndex >= 0) {
        places.splice(existingIndex, 1);
      }
      
      places.push({ label, name, address, phone, website, lat, lng, notes });
      saveSavedPlaces(profile, places);
      
      logger.info(`Saved place: ${label}`);
      return `Saved place: ${label}${name ? ` (${name})` : ''}`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const removePlaceTool = defineTool({
  name: 'remove_place',
  description: 'Remove a saved place from the user\'s address book by label.',
  parameters: z.object({
    label: z.string().describe('Label of the saved place to remove'),
  }),
  readonly: false,
  
  async execute({ label }) {
    try {
      const profile = getActiveProfile();
      const places = loadSavedPlaces(profile);
      
      const existingIndex = places.findIndex(p => p.label === label);
      if (existingIndex < 0) {
        return `No place found with label: ${label}`;
      }
      
      places.splice(existingIndex, 1);
      saveSavedPlaces(profile, places);
      
      logger.info(`Removed place: ${label}`);
      return `Removed place: ${label}`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const listPlacesTool = defineTool({
  name: 'list_places',
  description: "List all saved places in the user's address book. Call this when the user asks 'what places have I saved', 'show my addresses', or 'where is home'.",
  parameters: z.object({}),
  readonly: true,
  
  async execute() {
    try {
      const profile = getActiveProfile();
      const places = loadSavedPlaces(profile);
      
      if (places.length === 0) {
        return 'No saved places.';
      }
      
      const lines = ['Saved places:'];
      for (const place of places) {
        lines.push(`\n${place.label}:`);
        if (place.name) lines.push(`  Name: ${place.name}`);
        if (place.address) lines.push(`  Address: ${place.address}`);
        if (place.phone) lines.push(`  Phone: ${place.phone}`);
        if (place.website) lines.push(`  Website: ${place.website}`);
        if (place.lat && place.lng) lines.push(`  Location: ${place.lat}, ${place.lng}`);
        if (place.notes) lines.push(`  Notes: ${place.notes}`);
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
