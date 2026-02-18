import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerMapsTools } from '../../src/tools/maps.js';
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

describe('Maps Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerMapsTools(registry);
    ctx = makeCtx();
  });

  describe('osm_search', () => {
    it('registers the tool', () => {
      expect(registry.get('osm_search')).toBeDefined();
    });

    it('returns search results from Nominatim', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { display_name: 'Eiffel Tower, Paris, France', lat: '48.8584', lon: '2.2945', type: 'attraction', importance: 0.9 },
        ],
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('osm_search', { query: 'Eiffel Tower' }, ctx);
      expect(result).toContain('Eiffel Tower');
      expect(result).toContain('48.8584');

      vi.unstubAllGlobals();
    });
  });

  describe('overpass_query', () => {
    it('registers the tool', () => {
      expect(registry.get('overpass_query')).toBeDefined();
    });

    it('executes an Overpass query and returns results', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          elements: [
            { type: 'node', id: 123, lat: 48.85, lon: 2.29, tags: { name: 'Eiffel Tower', tourism: 'attraction' } },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('overpass_query', {
        query: '[out:json];node["tourism"="attraction"](48.8,2.2,48.9,2.4);out;',
      }, ctx);
      expect(result).toContain('Eiffel Tower');

      vi.unstubAllGlobals();
    });
  });
});
