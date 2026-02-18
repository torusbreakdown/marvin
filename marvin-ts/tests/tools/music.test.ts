import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerMusicTools } from '../../src/tools/music.js';
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

describe('Music Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerMusicTools(registry);
    ctx = makeCtx();
  });

  describe('music_search', () => {
    it('registers the tool', () => {
      expect(registry.get('music_search')).toBeDefined();
    });

    it('returns artists from MusicBrainz', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          artists: [
            { id: 'abc-123', name: 'Radiohead', country: 'GB', 'life-span': { begin: '1985' }, disambiguation: 'English rock band', score: 100 },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('music_search', { query: 'Radiohead', entity: 'artist' }, ctx);
      expect(result).toContain('Radiohead');

      vi.unstubAllGlobals();
    });

    it('returns albums from MusicBrainz', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          releases: [
            { id: 'def-456', title: 'OK Computer', date: '1997-05-21', country: 'GB', 'artist-credit': [{ name: 'Radiohead' }], score: 100 },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('music_search', { query: 'OK Computer', entity: 'release' }, ctx);
      expect(result).toContain('OK Computer');

      vi.unstubAllGlobals();
    });
  });

  describe('music_lookup', () => {
    it('registers the tool', () => {
      expect(registry.get('music_lookup')).toBeDefined();
    });

    it('returns artist details with discography', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          name: 'Radiohead',
          country: 'GB',
          'life-span': { begin: '1985' },
          'release-groups': [
            { title: 'OK Computer', 'primary-type': 'Album', 'first-release-date': '1997-05-21' },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('music_lookup', { mbid: 'abc-123', entity: 'artist' }, ctx);
      expect(result).toContain('Radiohead');
      expect(result).toContain('OK Computer');

      vi.unstubAllGlobals();
    });
  });
});
