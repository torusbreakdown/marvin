import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerTravelTools(registry: ToolRegistry): void {
  registry.registerTool(
    'estimate_travel_time',
    'Estimate travel time between two locations',
    z.object({
      origin: z.string().describe('Starting location'),
      destination: z.string().describe('Destination'),
      mode: z.string().default('driving').describe('Travel mode'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'get_directions',
    'Get turn-by-turn directions',
    z.object({
      origin: z.string().describe('Starting location'),
      destination: z.string().describe('Destination'),
    }),
    async () => 'Not yet implemented',
    'always',
  );
}
