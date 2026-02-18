import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerMediaTools } from '../../src/tools/media.js';
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

const omdbSearchResponse = {
  Search: [
    { Title: 'The Matrix', Year: '1999', imdbID: 'tt0133093', Type: 'movie', Poster: 'https://example.com/poster.jpg' },
    { Title: 'The Matrix Reloaded', Year: '2003', imdbID: 'tt0234215', Type: 'movie', Poster: 'https://example.com/poster2.jpg' },
  ],
  totalResults: '2',
  Response: 'True',
};

const omdbDetailResponse = {
  Title: 'The Matrix',
  Year: '1999',
  Rated: 'R',
  Runtime: '136 min',
  Genre: 'Action, Sci-Fi',
  Director: 'Lana Wachowski, Lilly Wachowski',
  Actors: 'Keanu Reeves, Laurence Fishburne',
  Plot: 'A computer hacker learns about the true nature of reality.',
  Ratings: [
    { Source: 'Internet Movie Database', Value: '8.7/10' },
    { Source: 'Rotten Tomatoes', Value: '83%' },
  ],
  imdbRating: '8.7',
  Response: 'True',
};

const rawgSearchResponse = {
  results: [
    { id: 3498, name: 'Grand Theft Auto V', released: '2013-09-17', rating: 4.47, platforms: [{ platform: { name: 'PC' } }] },
    { id: 4200, name: 'Portal 2', released: '2011-04-19', rating: 4.61, platforms: [{ platform: { name: 'PC' } }] },
  ],
};

describe('Media Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerMediaTools(registry);
    ctx = makeCtx();
  });

  describe('search_movies', () => {
    it('registers the tool', () => {
      expect(registry.get('search_movies')).toBeDefined();
    });

    it('returns titles and ratings from OMDB', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => omdbSearchResponse,
      });
      vi.stubGlobal('fetch', mockFetch);
      process.env.OMDB_API_KEY = 'test-key';

      const result = await registry.executeTool('search_movies', { query: 'The Matrix' }, ctx);
      expect(result).toContain('The Matrix');
      expect(result).toContain('1999');
      expect(result).toContain('tt0133093');

      delete process.env.OMDB_API_KEY;
      vi.unstubAllGlobals();
    });

    it('falls back to DDG when no OMDB key', async () => {
      delete process.env.OMDB_API_KEY;
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ RelatedTopics: [{ Text: 'The Matrix (1999 film)', FirstURL: 'https://example.com' }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('search_movies', { query: 'The Matrix' }, ctx);
      expect(result).toContain('Matrix');

      vi.unstubAllGlobals();
    });
  });

  describe('get_movie_details', () => {
    it('registers the tool', () => {
      expect(registry.get('get_movie_details')).toBeDefined();
    });

    it('returns full details from OMDB', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => omdbDetailResponse,
      });
      vi.stubGlobal('fetch', mockFetch);
      process.env.OMDB_API_KEY = 'test-key';

      const result = await registry.executeTool('get_movie_details', { title: 'The Matrix' }, ctx);
      expect(result).toContain('The Matrix');
      expect(result).toContain('8.7');
      expect(result).toContain('Keanu Reeves');
      expect(result).toContain('Action');

      delete process.env.OMDB_API_KEY;
      vi.unstubAllGlobals();
    });
  });

  describe('search_games', () => {
    it('registers the tool', () => {
      expect(registry.get('search_games')).toBeDefined();
    });

    it('returns titles and platforms from RAWG', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rawgSearchResponse,
      });
      vi.stubGlobal('fetch', mockFetch);
      process.env.RAWG_API_KEY = 'test-key';

      const result = await registry.executeTool('search_games', { query: 'GTA' }, ctx);
      expect(result).toContain('Grand Theft Auto V');
      expect(result).toContain('PC');

      delete process.env.RAWG_API_KEY;
      vi.unstubAllGlobals();
    });
  });

  describe('get_game_details', () => {
    it('registers the tool', () => {
      expect(registry.get('get_game_details')).toBeDefined();
    });
  });
});
