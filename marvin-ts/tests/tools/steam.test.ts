import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerSteamTools } from '../../src/tools/steam.js';
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

describe('Steam Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerSteamTools(registry);
    ctx = makeCtx();
  });

  describe('steam_search', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_search')).toBeDefined();
    });

    it('returns games from Steam store search', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            { id: 730, name: 'Counter-Strike 2', logo: '', price: { final: 0, currency: 'USD' } },
            { id: 570, name: 'Dota 2', logo: '', price: { final: 0, currency: 'USD' } },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('steam_search', { query: 'Counter-Strike' }, ctx);
      expect(result).toContain('Counter-Strike 2');

      vi.unstubAllGlobals();
    });
  });

  describe('steam_app_details', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_app_details')).toBeDefined();
    });
  });

  describe('steam_featured', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_featured')).toBeDefined();
    });
  });

  describe('steam_player_stats', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_player_stats')).toBeDefined();
    });
  });

  describe('steam_user_games', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_user_games')).toBeDefined();
    });
  });

  describe('steam_user_summary', () => {
    it('registers the tool', () => {
      expect(registry.get('steam_user_summary')).toBeDefined();
    });
  });
});
