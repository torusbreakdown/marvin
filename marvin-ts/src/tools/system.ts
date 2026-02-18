import { z } from 'zod';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, SessionUsage } from '../types.js';
import type { CostLogEntry } from '../usage.js';
import { switchProfile } from '../profiles/manager.js';
import { savePreferences } from '../profiles/prefs.js';

export interface SystemToolsOptions {
  getUsage: () => SessionUsage;
  queryCostLog: (since?: string, until?: string) => { entries: CostLogEntry[]; totalCost: number; totalMessages: number; totalInput: number; totalOutput: number; byModel: Record<string, { cost: number; messages: number }> };
  onExit?: (message: string) => void;
  onProfileSwitch?: (profileName: string) => void;
}

export function registerSystemTools(registry: ToolRegistry, options: SystemToolsOptions): void {
  registry.registerTool(
    'exit_app',
    'Exit the application',
    z.object({
      message: z.string().default('Goodbye!').describe('Farewell message'),
    }),
    async (args, _ctx) => {
      if (options.onExit) options.onExit(args.message);
      return args.message;
    },
    'always',
  );

  registry.registerTool(
    'get_usage',
    'Show API usage, costs, and message counts. Supports querying by time window (e.g., today, this week, last 24h, or custom ISO date range).',
    z.object({
      period: z.string().default('session').describe('Time period: "session" (current), "today", "24h", "7d", "30d", "all", or ISO date like "2026-02-01"'),
      until: z.string().default('').describe('Optional end date (ISO format). Defaults to now.'),
    }),
    async (args, _ctx) => {
      if (args.period === 'session') {
        const usage = options.getUsage();
        const lines: string[] = [
          `Session Usage:`,
          `  Total cost: $${usage.totalCostUsd.toFixed(4)}`,
          `  LLM turns: ${usage.llmTurns}`,
        ];
        for (const [model, count] of Object.entries(usage.modelTurns)) {
          const cost = usage.modelCost[model] ?? 0;
          lines.push(`  ${model}: ${count} turns ($${cost.toFixed(4)})`);
        }
        return lines.join('\n');
      }

      // Resolve time window
      let since: string | undefined;
      const until = args.until || undefined;
      const now = new Date();
      switch (args.period) {
        case 'today': {
          const d = new Date(now); d.setHours(0, 0, 0, 0);
          since = d.toISOString(); break;
        }
        case '24h': since = new Date(now.getTime() - 86400_000).toISOString(); break;
        case '7d': since = new Date(now.getTime() - 7 * 86400_000).toISOString(); break;
        case '30d': since = new Date(now.getTime() - 30 * 86400_000).toISOString(); break;
        case 'all': since = undefined; break;
        default: since = args.period; break;
      }

      const result = options.queryCostLog(since, until);
      if (result.totalMessages === 0) return `No usage found for period "${args.period}".`;

      const lines: string[] = [
        `Usage${since ? ` since ${since.slice(0, 19)}` : ' (all time)'}:`,
        `  Total cost: $${result.totalCost.toFixed(4)}`,
        `  Messages: ${result.totalMessages}`,
        `  Tokens: ${result.totalInput.toLocaleString()} in / ${result.totalOutput.toLocaleString()} out`,
      ];
      for (const [model, data] of Object.entries(result.byModel)) {
        lines.push(`  ${model}: ${data.messages} msgs ($${data.cost.toFixed(4)})`);
      }
      return lines.join('\n');
    },
    'always',
  );

  registry.registerTool(
    'switch_profile',
    'Switch to a different user profile',
    z.object({
      name: z.string().describe('Profile name to switch to'),
    }),
    async (args, ctx) => {
      const newProfile = switchProfile(args.name);
      // Update the live context so subsequent tool calls use the new profile
      Object.assign(ctx.profile, newProfile);
      options.onProfileSwitch?.(args.name);
      return `Switched to profile: ${args.name}. Preferences and history loaded.`;
    },
    'always',
  );

  registry.registerTool(
    'update_preferences',
    'Update user preferences',
    z.object({
      key: z.string().describe('Preference key'),
      value: z.string().describe('Preference value'),
    }),
    async (args, ctx) => {
      // SECURITY: Block prototype pollution via __proto__, constructor, prototype keys
      if (args.key === '__proto__' || args.key === 'constructor' || args.key === 'prototype') {
        return `Error: Reserved key "${args.key}" is not allowed.`;
      }
      (ctx.profile.preferences as Record<string, unknown>)[args.key] = args.value;
      savePreferences(ctx.profileDir, ctx.profile.preferences as Record<string, unknown>);
      return `Updated preference: ${args.key} = ${args.value}`;
    },
    'always',
  );
}
