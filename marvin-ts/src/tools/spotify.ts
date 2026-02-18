import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerSpotifyTools(registry: ToolRegistry): void {
  registry.registerTool(
    'spotify_auth',
    'Authorize Marvin to access your Spotify account. Call with no arguments to start the auth flow.',
    z.object({
      auth_code: z.string().default('').describe('Authorization code from Spotify redirect URL. Leave empty to get the auth URL.'),
    }),
    async (_args, _ctx) => {
      // Stub: requires OAuth setup with client ID/secret
      return 'Spotify OAuth is not yet configured. To set up:\n1. Create a Spotify app at https://developer.spotify.com/dashboard\n2. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables\n3. Run spotify_auth again to start the OAuth flow';
    },
    'always',
  );

  registry.registerTool(
    'spotify_search',
    'Search Spotify for tracks, artists, albums, or playlists. Requires Spotify auth.',
    z.object({
      query: z.string().describe('Search query (song name, artist, album)'),
      search_type: z.string().default('track').describe("Type: 'track', 'artist', 'album', or 'playlist'"),
      max_results: z.number().default(10).describe('Max results (1-20)'),
    }),
    async (_args, _ctx) => {
      return 'Error: Spotify not authenticated. Run spotify_auth first to connect your Spotify account.';
    },
    'always',
  );

  registry.registerTool(
    'spotify_create_playlist',
    "Create a new Spotify playlist on the authenticated user's account.",
    z.object({
      name: z.string().describe('Playlist name'),
      description: z.string().default('').describe('Playlist description'),
      public: z.boolean().default(false).describe('Whether the playlist is public'),
    }),
    async (_args, _ctx) => {
      return 'Error: Spotify not authenticated. Run spotify_auth first to connect your Spotify account.';
    },
    'always',
  );

  registry.registerTool(
    'spotify_add_tracks',
    'Add tracks to a Spotify playlist by search query.',
    z.object({
      playlist_id: z.string().describe('Spotify playlist ID'),
      track_queries: z.array(z.string()).describe("List of track queries to search and add, e.g. ['Bohemian Rhapsody Queen']"),
    }),
    async (_args, _ctx) => {
      return 'Error: Spotify not authenticated. Run spotify_auth first to connect your Spotify account.';
    },
    'always',
  );
}
