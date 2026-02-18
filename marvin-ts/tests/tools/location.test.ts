import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerLocationTools } from '../../src/tools/location.js';
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

describe('Location Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerLocationTools(registry);
    ctx = makeCtx();
  });

  describe('get_my_location', () => {
    it('registers the tool', () => {
      expect(registry.get('get_my_location')).toBeDefined();
    });

    it('returns lat, lng, and source', async () => {
      // Mock fetch for IP fallback
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ lat: 47.6, lon: -122.3, city: 'Seattle', regionName: 'Washington', country: 'US' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('get_my_location', {}, ctx);
      expect(result).toContain('47.6');
      expect(result).toContain('-122.3');
      expect(result).toMatch(/source/i);

      vi.unstubAllGlobals();
    });

    it('handles IP geolocation failure gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('get_my_location', {}, ctx);
      expect(result).toMatch(/error|unable|failed/i);

      vi.unstubAllGlobals();
    });
  });
});
