import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerSteamTools(registry: ToolRegistry): void {
  registry.registerTool(
    'steam_search',
    'Search the Steam store for games. Returns titles, app IDs, and prices. No API key required.',
    z.object({
      query: z.string().describe('Game title to search for on Steam'),
      max_results: z.number().default(10).describe('Max results (1-25)'),
    }),
    async (args, _ctx) => {
      const resp = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(args.query)}&l=en&cc=us`);
      if (!resp.ok) return `Error: Steam search failed (${resp.status})`;
      const data = await resp.json() as any;
      if (!data.items?.length) return 'No games found.';

      return data.items.slice(0, args.max_results).map((item: any, i: number) => {
        const parts = [`${i + 1}. ${item.name}`];
        parts.push(`   App ID: ${item.id}`);
        if (item.price) {
          const price = item.price.final === 0 ? 'Free' : `$${(item.price.final / 100).toFixed(2)}`;
          parts.push(`   Price: ${price}`);
        }
        return parts.join('\n');
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'steam_app_details',
    'Get detailed info for a Steam game by app ID. No API key required.',
    z.object({
      app_id: z.number().describe('Steam app ID (from steam_search results)'),
    }),
    async (args, _ctx) => {
      const resp = await fetch(`https://store.steampowered.com/api/appdetails?appids=${args.app_id}&l=en`);
      if (!resp.ok) return `Error: Steam API failed (${resp.status})`;
      const data = await resp.json() as any;
      const appData = data[String(args.app_id)];
      if (!appData?.success) return 'Error: Game not found.';
      const d = appData.data;

      const parts = [
        `${d.name}`,
        `Type: ${d.type}`,
        `Release: ${d.release_date?.date || 'TBA'}`,
        `Developer: ${d.developers?.join(', ') || 'Unknown'}`,
        `Publisher: ${d.publishers?.join(', ') || 'Unknown'}`,
      ];
      if (d.price_overview) {
        parts.push(`Price: ${d.price_overview.final_formatted}`);
        if (d.price_overview.discount_percent) parts.push(`Discount: ${d.price_overview.discount_percent}%`);
      } else {
        parts.push('Price: Free');
      }
      if (d.genres) parts.push(`Genres: ${d.genres.map((g: any) => g.description).join(', ')}`);
      if (d.short_description) parts.push(`\n${d.short_description}`);
      if (d.metacritic) parts.push(`\nMetacritic: ${d.metacritic.score}`);
      return parts.join('\n');
    },
    'always',
  );

  registry.registerTool(
    'steam_featured',
    'Get current Steam featured games and specials/deals. No API key required.',
    z.object({}),
    async (_args, _ctx) => {
      const resp = await fetch('https://store.steampowered.com/api/featured/?l=en&cc=us');
      if (!resp.ok) return `Error: Steam featured API failed (${resp.status})`;
      const data = await resp.json() as any;

      const sections: string[] = [];
      if (data.featured_win?.length) {
        sections.push('Featured Games:');
        for (const g of data.featured_win.slice(0, 10)) {
          const price = g.final_price === 0 ? 'Free' : `$${(g.final_price / 100).toFixed(2)}`;
          sections.push(`  • ${g.name} — ${price}${g.discount_percent ? ` (-${g.discount_percent}%)` : ''}`);
        }
      }
      if (data.specials?.items?.length) {
        sections.push('\nSpecials:');
        for (const g of data.specials.items.slice(0, 10)) {
          const price = g.final_price === 0 ? 'Free' : `$${(g.final_price / 100).toFixed(2)}`;
          sections.push(`  • ${g.name} — ${price} (-${g.discount_percent}%)`);
        }
      }
      return sections.length ? sections.join('\n') : 'No featured games available.';
    },
    'always',
  );

  registry.registerTool(
    'steam_player_stats',
    'Get current player count and global achievement stats for a Steam game.',
    z.object({
      app_id: z.number().describe('Steam app ID'),
    }),
    async (args, _ctx) => {
      const parts: string[] = [];
      // Player count (no key needed)
      try {
        const resp = await fetch(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${args.app_id}`);
        if (resp.ok) {
          const data = await resp.json() as any;
          if (data.response?.result === 1) {
            parts.push(`Current players: ${data.response.player_count.toLocaleString()}`);
          }
        }
      } catch { /* ignore */ }

      // Achievements (needs key)
      const steamKey = process.env.STEAM_API_KEY;
      if (steamKey) {
        try {
          const resp = await fetch(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${args.app_id}`);
          if (resp.ok) {
            const data = await resp.json() as any;
            const achievements = data.achievementpercentages?.achievements || [];
            if (achievements.length) {
              parts.push(`\nTop achievements:`);
              for (const a of achievements.slice(0, 5)) {
                parts.push(`  • ${a.name}: ${a.percent.toFixed(1)}%`);
              }
            }
          }
        } catch { /* ignore */ }
      }

      return parts.length ? parts.join('\n') : 'No stats available for this game.';
    },
    'always',
  );

  registry.registerTool(
    'steam_user_games',
    "Get a Steam user's owned games list with playtime. Requires STEAM_API_KEY.",
    z.object({
      steam_id: z.string().describe("Steam user's 64-bit ID"),
    }),
    async (args, _ctx) => {
      const key = process.env.STEAM_API_KEY;
      if (!key) return 'Error: STEAM_API_KEY not set.';

      const resp = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${key}&steamid=${args.steam_id}&include_appinfo=1&include_played_free_games=1&format=json`);
      if (!resp.ok) return `Error: Steam API failed (${resp.status})`;
      const data = await resp.json() as any;
      const games = data.response?.games || [];
      if (!games.length) return 'No games found or profile is private.';

      const sorted = games.sort((a: any, b: any) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
      return `Total games: ${data.response.game_count}\n\n` + sorted.slice(0, 20).map((g: any, i: number) => {
        const hours = (g.playtime_forever / 60).toFixed(1);
        return `${i + 1}. ${g.name} — ${hours}h played`;
      }).join('\n');
    },
    'always',
  );

  registry.registerTool(
    'steam_user_summary',
    "Get a Steam user's profile summary. Requires STEAM_API_KEY.",
    z.object({
      steam_id: z.string().describe("Steam user's 64-bit ID"),
    }),
    async (args, _ctx) => {
      const key = process.env.STEAM_API_KEY;
      if (!key) return 'Error: STEAM_API_KEY not set.';

      const resp = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${args.steam_id}`);
      if (!resp.ok) return `Error: Steam API failed (${resp.status})`;
      const data = await resp.json() as any;
      const player = data.response?.players?.[0];
      if (!player) return 'Player not found.';

      const states = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];
      const parts = [
        `Name: ${player.personaname}`,
        `Status: ${states[player.personastate] || 'Unknown'}`,
        `Profile: ${player.profileurl}`,
      ];
      if (player.gameextrainfo) parts.push(`Playing: ${player.gameextrainfo}`);
      if (player.timecreated) parts.push(`Member since: ${new Date(player.timecreated * 1000).toLocaleDateString()}`);
      return parts.join('\n');
    },
    'always',
  );
}
