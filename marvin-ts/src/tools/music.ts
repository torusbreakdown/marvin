import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MB_HEADERS = { 'User-Agent': 'Marvin-Assistant/1.0 (marvin@local)', Accept: 'application/json' };

export function registerMusicTools(registry: ToolRegistry): void {
  registry.registerTool(
    'music_search',
    'Search MusicBrainz for artists, albums (releases), or songs (recordings). Free, no API key required.',
    z.object({
      query: z.string().describe('Search query — artist name, album title, or song title'),
      entity: z.string().default('artist').describe("What to search for: 'artist', 'release' (album), or 'recording' (song)"),
      max_results: z.number().default(10).describe('Max results (1-25)'),
    }),
    async (args, _ctx) => {
      const resp = await fetch(`${MB_BASE}/${args.entity}/?query=${encodeURIComponent(args.query)}&limit=${args.max_results}&fmt=json`, {
        headers: MB_HEADERS,
      });
      if (!resp.ok) return `Error: MusicBrainz search failed (${resp.status})`;
      const data = await resp.json() as any;

      if (args.entity === 'artist') {
        const items = data.artists || [];
        if (!items.length) return 'No artists found.';
        return items.map((a: any, i: number) => {
          const parts = [`${i + 1}. ${a.name}`];
          if (a.country) parts.push(`   Country: ${a.country}`);
          if (a['life-span']?.begin) parts.push(`   Active since: ${a['life-span'].begin}`);
          if (a.disambiguation) parts.push(`   (${a.disambiguation})`);
          parts.push(`   MBID: ${a.id}`);
          return parts.join('\n');
        }).join('\n\n');
      }

      if (args.entity === 'release') {
        const items = data.releases || [];
        if (!items.length) return 'No releases found.';
        return items.map((r: any, i: number) => {
          const artist = r['artist-credit']?.map((c: any) => c.name).join(', ') || 'Unknown';
          const parts = [`${i + 1}. ${r.title}`];
          parts.push(`   Artist: ${artist}`);
          if (r.date) parts.push(`   Date: ${r.date}`);
          if (r.country) parts.push(`   Country: ${r.country}`);
          parts.push(`   MBID: ${r.id}`);
          return parts.join('\n');
        }).join('\n\n');
      }

      if (args.entity === 'recording') {
        const items = data.recordings || [];
        if (!items.length) return 'No recordings found.';
        return items.map((r: any, i: number) => {
          const artist = r['artist-credit']?.map((c: any) => c.name).join(', ') || 'Unknown';
          const parts = [`${i + 1}. ${r.title}`];
          parts.push(`   Artist: ${artist}`);
          if (r.length) parts.push(`   Duration: ${Math.floor(r.length / 60000)}:${String(Math.floor((r.length % 60000) / 1000)).padStart(2, '0')}`);
          parts.push(`   MBID: ${r.id}`);
          return parts.join('\n');
        }).join('\n\n');
      }

      return 'Invalid entity type. Use: artist, release, or recording.';
    },
    'always',
  );

  registry.registerTool(
    'music_lookup',
    'Look up detailed info for an artist, release, or recording by MusicBrainz ID (MBID).',
    z.object({
      mbid: z.string().describe('MusicBrainz ID (UUID) from search results'),
      entity: z.string().default('artist').describe("Entity type: 'artist', 'release', or 'recording'"),
    }),
    async (args, _ctx) => {
      let inc = '';
      if (args.entity === 'artist') inc = '?inc=release-groups&fmt=json';
      else if (args.entity === 'release') inc = '?inc=recordings&fmt=json';
      else inc = '?inc=releases&fmt=json';

      const resp = await fetch(`${MB_BASE}/${args.entity}/${args.mbid}${inc}`, {
        headers: MB_HEADERS,
      });
      if (!resp.ok) return `Error: MusicBrainz lookup failed (${resp.status})`;
      const data = await resp.json() as any;

      if (args.entity === 'artist') {
        const parts = [`Artist: ${data.name}`];
        if (data.country) parts.push(`Country: ${data.country}`);
        if (data['life-span']?.begin) parts.push(`Active since: ${data['life-span'].begin}`);
        if (data['life-span']?.ended) parts.push(`Ended: ${data['life-span'].end}`);
        const rgs = data['release-groups'] || [];
        if (rgs.length) {
          parts.push(`\nDiscography (${rgs.length} releases):`);
          for (const rg of rgs.slice(0, 20)) {
            parts.push(`  • ${rg.title} (${rg['primary-type'] || 'Unknown'}, ${rg['first-release-date'] || 'unknown date'})`);
          }
        }
        return parts.join('\n');
      }

      if (args.entity === 'release') {
        const parts = [`Release: ${data.title}`];
        if (data.date) parts.push(`Date: ${data.date}`);
        const tracks = data.media?.[0]?.tracks || [];
        if (tracks.length) {
          parts.push(`\nTracklist:`);
          for (const t of tracks) {
            parts.push(`  ${t.position}. ${t.title}`);
          }
        }
        return parts.join('\n');
      }

      const parts = [`Recording: ${data.title}`];
      if (data.length) parts.push(`Duration: ${Math.floor(data.length / 60000)}:${String(Math.floor((data.length % 60000) / 1000)).padStart(2, '0')}`);
      const releases = data.releases || [];
      if (releases.length) {
        parts.push(`\nAppears on:`);
        for (const r of releases.slice(0, 10)) {
          parts.push(`  • ${r.title} (${r.date || 'unknown date'})`);
        }
      }
      return parts.join('\n');
    },
    'always',
  );
}
