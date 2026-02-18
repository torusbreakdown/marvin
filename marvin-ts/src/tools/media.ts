import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

async function ddgSearch(query: string): Promise<any[]> {
  const resp = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`);
  if (!resp.ok) return [];
  const data = await resp.json() as any;
  return data.RelatedTopics || [];
}

export function registerMediaTools(registry: ToolRegistry): void {
  registry.registerTool(
    'search_movies',
    'Search for movies and TV shows. Uses OMDB if API key is set, otherwise falls back to DuckDuckGo.',
    z.object({
      query: z.string().describe('Movie or TV show title to search for'),
      year: z.string().default('').describe('Optional year to narrow results'),
      type: z.string().default('').describe("Optional type: 'movie', 'series', or 'episode'"),
    }),
    async (args, _ctx) => {
      const apiKey = process.env.OMDB_API_KEY;

      if (apiKey) {
        const params = new URLSearchParams({ apikey: apiKey, s: args.query });
        if (args.year) params.set('y', args.year);
        if (args.type) params.set('type', args.type);

        const resp = await fetch(`https://www.omdbapi.com/?${params}`);
        if (resp.ok) {
          const data = await resp.json() as any;
          if (data.Response === 'True' && data.Search?.length) {
            return data.Search.map((m: any, i: number) => {
              return `${i + 1}. ${m.Title} (${m.Year})\n   Type: ${m.Type}\n   IMDb ID: ${m.imdbID}`;
            }).join('\n\n');
          }
        }
      }

      // DDG fallback
      const topics = await ddgSearch(`${args.query} movie ${args.year}`);
      if (topics.length) {
        return topics.slice(0, 5).map((t: any, i: number) => {
          return `${i + 1}. ${t.Text || 'No description'}\n   URL: ${t.FirstURL || ''}`;
        }).join('\n\n');
      }
      return 'No results found.';
    },
    'always',
  );

  registry.registerTool(
    'get_movie_details',
    'Get detailed info and reviews for a specific movie/show from OMDB.',
    z.object({
      title: z.string().default('').describe('Movie title (use this or imdb_id)'),
      imdb_id: z.string().default('').describe("IMDb ID like 'tt1234567'"),
    }),
    async (args, _ctx) => {
      const apiKey = process.env.OMDB_API_KEY;
      if (!apiKey) return 'Error: OMDB_API_KEY not set. Set the environment variable to use this tool.';

      const params = new URLSearchParams({ apikey: apiKey, plot: 'full' });
      if (args.imdb_id) params.set('i', args.imdb_id);
      else if (args.title) params.set('t', args.title);
      else return 'Error: Provide either title or imdb_id.';

      const resp = await fetch(`https://www.omdbapi.com/?${params}`);
      if (!resp.ok) return `Error: OMDB request failed (${resp.status})`;
      const data = await resp.json() as any;
      if (data.Response === 'False') return `Error: ${data.Error || 'Movie not found'}`;

      const parts = [
        `${data.Title} (${data.Year})`,
        `Rated: ${data.Rated} | Runtime: ${data.Runtime}`,
        `Genre: ${data.Genre}`,
        `Director: ${data.Director}`,
        `Actors: ${data.Actors}`,
        ``,
        `Plot: ${data.Plot}`,
      ];
      if (data.Ratings?.length) {
        parts.push('', 'Ratings:');
        for (const r of data.Ratings) {
          parts.push(`  ${r.Source}: ${r.Value}`);
        }
      }
      if (data.imdbRating) parts.push(`\nIMDb Rating: ${data.imdbRating}/10`);
      if (data.Awards && data.Awards !== 'N/A') parts.push(`Awards: ${data.Awards}`);
      return parts.join('\n');
    },
    'always',
  );

  registry.registerTool(
    'search_games',
    'Search for video games. Uses RAWG if API key is set, otherwise falls back to DuckDuckGo.',
    z.object({
      query: z.string().describe('Game title to search for'),
      max_results: z.number().default(5).describe('Max results (1-10)'),
    }),
    async (args, _ctx) => {
      const apiKey = process.env.RAWG_API_KEY;

      if (apiKey) {
        const params = new URLSearchParams({ key: apiKey, search: args.query, page_size: String(args.max_results) });
        const resp = await fetch(`https://api.rawg.io/api/games?${params}`);
        if (resp.ok) {
          const data = await resp.json() as any;
          if (data.results?.length) {
            return data.results.map((g: any, i: number) => {
              const platforms = g.platforms?.map((p: any) => p.platform?.name).filter(Boolean).join(', ') || 'Unknown';
              return `${i + 1}. ${g.name} (${g.released || 'TBA'})\n   Rating: ${g.rating}/5\n   Platforms: ${platforms}\n   ID: ${g.id}`;
            }).join('\n\n');
          }
        }
      }

      // DDG fallback
      const topics = await ddgSearch(`${args.query} video game`);
      if (topics.length) {
        return topics.slice(0, args.max_results).map((t: any, i: number) => {
          return `${i + 1}. ${t.Text || 'No description'}\n   URL: ${t.FirstURL || ''}`;
        }).join('\n\n');
      }
      return 'No results found.';
    },
    'always',
  );

  registry.registerTool(
    'get_game_details',
    'Get detailed info for a video game from RAWG by its ID.',
    z.object({
      game_id: z.number().describe('RAWG game ID (from search_games results)'),
    }),
    async (args, _ctx) => {
      const apiKey = process.env.RAWG_API_KEY;
      if (!apiKey) return 'Error: RAWG_API_KEY not set. Set the environment variable to use this tool.';

      const resp = await fetch(`https://api.rawg.io/api/games/${args.game_id}?key=${apiKey}`);
      if (!resp.ok) return `Error: RAWG request failed (${resp.status})`;
      const g = await resp.json() as any;

      const platforms = g.platforms?.map((p: any) => p.platform?.name).join(', ') || 'Unknown';
      const genres = g.genres?.map((g2: any) => g2.name).join(', ') || 'Unknown';
      const devs = g.developers?.map((d: any) => d.name).join(', ') || 'Unknown';

      const parts = [
        `${g.name} (${g.released || 'TBA'})`,
        `Rating: ${g.rating}/5 (${g.ratings_count || 0} ratings)`,
        `Metacritic: ${g.metacritic || 'N/A'}`,
        `Platforms: ${platforms}`,
        `Genres: ${genres}`,
        `Developers: ${devs}`,
        '',
        `Description: ${g.description_raw || g.description || 'No description'}`,
      ];
      return parts.join('\n');
    },
    'always',
  );
}
