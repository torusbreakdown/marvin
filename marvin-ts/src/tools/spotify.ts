import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ToolRegistry } from './registry.js';

// ── Spotify OAuth + API plumbing ──────────────────────────────────────────

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const TOKEN_PATH = join(homedir(), '.marvin', 'spotify-tokens.json');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-modify',
  'user-library-read',
].join(' ');

interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  code_verifier?: string;
}

function loadCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    throw new Error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET environment variables');
  }
  return { clientId, clientSecret };
}

function loadTokens(): SpotifyTokens | null {
  try { return JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')); }
  catch { return null; }
}

function saveTokens(t: SpotifyTokens): void {
  mkdirSync(join(homedir(), '.marvin'), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function exchangeCode(code: string, verifier: string): Promise<SpotifyTokens> {
  const { clientId, clientSecret } = loadCreds();
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed (${resp.status}): ${await resp.text()}`);
  const d = await resp.json() as any;
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + (d.expires_in - 60) * 1000,
  };
}

async function refreshToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error('Not authenticated. Run spotify_auth first.');
  const { clientId, clientSecret } = loadCreds();
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed (${resp.status}): ${await resp.text()}`);
  const d = await resp.json() as any;
  const updated: SpotifyTokens = {
    access_token: d.access_token,
    refresh_token: d.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (d.expires_in - 60) * 1000,
  };
  saveTokens(updated);
  return updated.access_token;
}

async function getToken(): Promise<string> {
  const t = loadTokens();
  if (!t?.access_token) throw new Error('Not authenticated. Run spotify_auth first.');
  return Date.now() >= t.expires_at ? refreshToken() : t.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const call = async (token: string) => {
    const resp = await fetch(`${SPOTIFY_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    return resp;
  };

  let resp = await call(await getToken());
  if (resp.status === 401) {
    resp = await call(await refreshToken());
  }
  if (!resp.ok) return { error: `Spotify API ${resp.status}: ${await resp.text()}` };
  if (resp.status === 204) return {};
  return resp.json();
}

// Resolve a single track query to a Spotify URI. Tries ISRC first, falls back to text search.
async function resolveTrack(query: string, isrc?: string): Promise<{ uri: string; name: string; artist: string } | null> {
  // Try ISRC lookup first (most precise)
  if (isrc) {
    const d = await api(`/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`);
    const t = d?.tracks?.items?.[0];
    if (t) return { uri: t.uri, name: t.name, artist: t.artists?.map((a: any) => a.name).join(', ') };
  }
  // Fall back to text search
  const d = await api(`/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
  const t = d?.tracks?.items?.[0];
  if (t) return { uri: t.uri, name: t.name, artist: t.artists?.map((a: any) => a.name).join(', ') };
  return null;
}

// ── Tool registration ─────────────────────────────────────────────────────

export function registerSpotifyTools(registry: ToolRegistry): void {

  // ── Auth ──

  registry.registerTool(
    'spotify_auth',
    'Start or complete Spotify OAuth. Call with no args to get the auth URL. Call with redirect_url after authorizing in browser.',
    z.object({
      redirect_url: z.string().default('').describe('The full redirect URL from your browser after authorizing. Leave empty to start auth flow.'),
    }),
    async (args, _ctx) => {
      try {
        if (!args.redirect_url) {
          // Step 1: generate PKCE, build auth URL, save verifier
          const { clientId } = loadCreds();
          const { verifier, challenge } = generatePKCE();
          saveTokens({ access_token: '', refresh_token: '', expires_at: 0, code_verifier: verifier });
          const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: REDIRECT_URI,
            scope: SCOPES,
            code_challenge_method: 'S256',
            code_challenge: challenge,
          });
          return `Open this URL in your browser to authorize Spotify:\n\n${SPOTIFY_AUTH_URL}?${params}\n\nAfter authorizing, copy the full redirect URL from your browser (it will start with ${REDIRECT_URI}) and call spotify_auth again with redirect_url set to that URL.`;
        }

        // Step 2: extract code from redirect URL, exchange for tokens
        const url = new URL(args.redirect_url);
        const code = url.searchParams.get('code');
        if (!code) return `Error: No authorization code found in URL. Got error: ${url.searchParams.get('error') || 'unknown'}`;

        const saved = loadTokens();
        if (!saved?.code_verifier) return 'Error: No pending auth flow. Call spotify_auth with no arguments first.';

        const tokens = await exchangeCode(code, saved.code_verifier);
        saveTokens(tokens);

        // Fetch user profile to confirm
        const me = await api('/me');
        return `✓ Authenticated as ${me.display_name || me.id}. Spotify tools are now active.`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );

  // ── Resolve tracks (bridge from MusicBrainz) ──

  registry.registerTool(
    'spotify_search',
    'Resolve tracks on Spotify by ISRC (from MusicBrainz) or text query. Use music_search for discovery, then this to get Spotify URIs.',
    z.object({
      query: z.string().describe('Track search query (e.g. "Bohemian Rhapsody Queen"), or leave empty if using ISRC'),
      isrc: z.string().default('').describe('ISRC code from MusicBrainz recording lookup (most precise match)'),
      max_results: z.number().default(5).describe('Max results for text search (1-20). ISRC always returns best match.'),
    }),
    async (args, _ctx) => {
      try {
        // Single ISRC lookup
        if (args.isrc) {
          const track = await resolveTrack(args.query || '', args.isrc);
          if (!track) return `No Spotify match found for ISRC ${args.isrc}`;
          return `Found: ${track.name} — ${track.artist}\nURI: ${track.uri}`;
        }

        // Text search (multi-result)
        const limit = Math.min(Math.max(args.max_results, 1), 20);
        const d = await api(`/search?q=${encodeURIComponent(args.query)}&type=track&limit=${limit}`);
        if (d.error) return d.error;
        const items = d?.tracks?.items || [];
        if (!items.length) return `No Spotify tracks found for "${args.query}"`;

        return items.map((t: any, i: number) => {
          const artists = t.artists?.map((a: any) => a.name).join(', ');
          return `${i + 1}. ${t.name} — ${artists}\n   Album: ${t.album?.name || 'Unknown'}\n   URI: ${t.uri}`;
        }).join('\n\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );

  // ── Playlist management ──

  registry.registerTool(
    'spotify_create_playlist',
    "Create a Spotify playlist on the authenticated user's account.",
    z.object({
      name: z.string().describe('Playlist name'),
      description: z.string().default('').describe('Playlist description'),
      public: z.boolean().default(false).describe('Whether the playlist is public'),
    }),
    async (args, _ctx) => {
      try {
        const me = await api('/me');
        if (me.error) return me.error;

        const playlist = await api(`/users/${me.id}/playlists`, {
          method: 'POST',
          body: JSON.stringify({ name: args.name, description: args.description, public: args.public }),
        });
        if (playlist.error) return playlist.error;
        return `✓ Created playlist "${playlist.name}"\n  ID: ${playlist.id}\n  URL: ${playlist.external_urls?.spotify || 'N/A'}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );

  registry.registerTool(
    'spotify_add_tracks',
    'Add tracks to a Spotify playlist. Accepts Spotify URIs, ISRCs, or text queries (resolved via search).',
    z.object({
      playlist_id: z.string().describe('Spotify playlist ID'),
      tracks: z.array(z.string()).describe("Track identifiers: Spotify URIs (spotify:track:xxx), ISRCs, or search queries like 'Bohemian Rhapsody Queen'"),
    }),
    async (args, _ctx) => {
      try {
        const uris: string[] = [];
        const failures: string[] = [];

        for (const track of args.tracks) {
          if (track.startsWith('spotify:track:')) {
            uris.push(track);
          } else if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(track)) {
            // Looks like an ISRC
            const resolved = await resolveTrack('', track);
            if (resolved) uris.push(resolved.uri);
            else failures.push(`${track} (ISRC not found)`);
          } else {
            // Text query
            const resolved = await resolveTrack(track);
            if (resolved) uris.push(resolved.uri);
            else failures.push(`"${track}" (no match)`);
          }
        }

        if (!uris.length) return `Could not resolve any tracks.\nFailed: ${failures.join(', ')}`;

        // Spotify accepts up to 100 URIs per request
        for (let i = 0; i < uris.length; i += 100) {
          const batch = uris.slice(i, i + 100);
          const result = await api(`/playlists/${args.playlist_id}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ uris: batch }),
          });
          if (result.error) return result.error;
        }

        const msg = `✓ Added ${uris.length} track(s) to playlist.`;
        return failures.length ? `${msg}\nFailed to resolve: ${failures.join(', ')}` : msg;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );

  // ── Playback control ──

  registry.registerTool(
    'spotify_playback',
    'Control Spotify playback: play, pause, skip, previous, or queue a track.',
    z.object({
      action: z.enum(['play', 'pause', 'next', 'previous', 'queue']).describe('Playback action'),
      track_uri: z.string().default('').describe('Spotify track URI (required for queue, optional for play to start a specific track)'),
    }),
    async (args, _ctx) => {
      try {
        switch (args.action) {
          case 'play': {
            const body = args.track_uri ? { uris: [args.track_uri] } : undefined;
            const r = await api('/me/player/play', { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
            return r.error || '▶ Playing';
          }
          case 'pause': {
            const r = await api('/me/player/pause', { method: 'PUT' });
            return r.error || '⏸ Paused';
          }
          case 'next': {
            const r = await api('/me/player/next', { method: 'POST' });
            return r.error || '⏭ Skipped to next';
          }
          case 'previous': {
            const r = await api('/me/player/previous', { method: 'POST' });
            return r.error || '⏮ Previous track';
          }
          case 'queue': {
            if (!args.track_uri) return 'Error: track_uri is required for queue action';
            const r = await api(`/me/player/queue?uri=${encodeURIComponent(args.track_uri)}`, { method: 'POST' });
            return r.error || `✓ Added to queue: ${args.track_uri}`;
          }
        }
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );

  registry.registerTool(
    'spotify_now_playing',
    'Get the currently playing track on Spotify.',
    z.object({}),
    async (_args, _ctx) => {
      try {
        const d = await api('/me/player/currently-playing');
        if (d.error) return d.error;
        if (!d.item) return 'Nothing is currently playing.';

        const t = d.item;
        const artists = t.artists?.map((a: any) => a.name).join(', ');
        const progress = t.progress_ms ? `${Math.floor(d.progress_ms / 60000)}:${String(Math.floor((d.progress_ms % 60000) / 1000)).padStart(2, '0')}` : '?';
        const duration = t.duration_ms ? `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, '0')}` : '?';
        const state = d.is_playing ? '▶' : '⏸';

        return `${state} ${t.name} — ${artists}\n  Album: ${t.album?.name || 'Unknown'}\n  Progress: ${progress} / ${duration}\n  URI: ${t.uri}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    'always',
  );
}
