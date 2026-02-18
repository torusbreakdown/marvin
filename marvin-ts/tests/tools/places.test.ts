import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerPlacesTools } from '../../src/tools/places.js';
import type { ToolContext } from '../../src/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: false,
    nonInteractive: false,
    profileDir: '/tmp/profile',
    profile: {
      name: 'test',
      profileDir: '/tmp/profile',
      preferences: {},
      savedPlaces: [],
      chatLog: [],
      ntfySubscriptions: [],
      oauthTokens: {},
      inputHistory: [],
    },
    ...overrides,
  };
}

const osmSearchResults = [
  { display_name: 'Cafe Latte, 123 Main St, Seattle, WA', lat: '47.6', lon: '-122.3', type: 'cafe' },
  { display_name: 'Coffee Shop, 456 Pine St, Seattle, WA', lat: '47.61', lon: '-122.31', type: 'cafe' },
];

describe('Places Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerPlacesTools(registry);
    ctx = makeCtx();
  });

  describe('places_text_search', () => {
    it('registers the tool', () => {
      expect(registry.get('places_text_search')).toBeDefined();
    });

    it('returns places with names and addresses via OSM fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => osmSearchResults,
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('places_text_search', {
        text_query: 'coffee shops in Seattle',
      }, ctx);

      expect(result).toContain('Cafe Latte');
      expect(result).toContain('123 Main St');

      vi.unstubAllGlobals();
    });

    it('handles no results', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('places_text_search', {
        text_query: 'nonexistent place xyzzy',
      }, ctx);
      expect(result).toMatch(/no.*results|no.*places|not found/i);

      vi.unstubAllGlobals();
    });
  });

  describe('places_nearby_search', () => {
    it('registers the tool', () => {
      expect(registry.get('places_nearby_search')).toBeDefined();
    });

    it('returns places near coordinates via OSM fallback', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          elements: [
            { tags: { name: 'Central Park Cafe', amenity: 'cafe', 'addr:street': '5th Ave' }, lat: 40.78, lon: -73.97 },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('places_nearby_search', {
        latitude: 40.78,
        longitude: -73.97,
        included_types: ['cafe'],
      }, ctx);
      expect(result).toContain('Central Park Cafe');

      vi.unstubAllGlobals();
    });
  });

  describe('setup_google_auth', () => {
    it('registers the tool', () => {
      expect(registry.get('setup_google_auth')).toBeDefined();
    });
  });
});
