import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerTimersTools(registry: ToolRegistry): void {
  registry.registerTool(
    'timer_start',
    'Start a named countdown or stopwatch',
    z.object({
      name: z.string().describe('Timer name'),
      duration: z.string().default('').describe('Duration (e.g. "5m", "1h30m") or empty for stopwatch'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'timer_check',
    'Check timer status',
    z.object({
      name: z.string().default('').describe('Timer name (empty for all)'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'timer_stop',
    'Stop a timer and report final time',
    z.object({
      name: z.string().describe('Timer name to stop'),
    }),
    async () => 'Not yet implemented',
    'always',
  );
}
