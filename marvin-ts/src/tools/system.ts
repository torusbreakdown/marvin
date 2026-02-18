import { z } from 'zod';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, SessionUsage } from '../types.js';

export interface SystemToolsOptions {
  getUsage: () => SessionUsage;
  onExit?: (message: string) => void;
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
    'Show session API usage and estimated costs',
    z.object({
      include_lifetime: z.boolean().default(false).describe('Include lifetime usage'),
    }),
    async (_args, _ctx) => {
      const usage = options.getUsage();
      const lines: string[] = [
        `Session Usage:`,
        `  Total cost: $${usage.totalCostUsd.toFixed(4)}`,
        `  LLM turns: ${usage.llmTurns}`,
        `  Model turns:`,
      ];
      for (const [model, count] of Object.entries(usage.modelTurns)) {
        const cost = usage.modelCost[model] ?? 0;
        lines.push(`    ${model}: ${count} turns ($${cost.toFixed(4)})`);
      }
      lines.push(`  Tool calls:`);
      for (const [tool, count] of Object.entries(usage.toolCallCounts)) {
        lines.push(`    ${tool}: ${count}`);
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
    async (args, _ctx) => {
      return `Switched to profile: ${args.name}`;
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
      return `Updated preference: ${args.key} = ${args.value}`;
    },
    'always',
  );
}
