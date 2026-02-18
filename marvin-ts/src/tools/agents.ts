import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerAgentsTools(registry: ToolRegistry): void {
  registry.registerTool(
    'launch_agent',
    'Launch a sub-agent to execute a task',
    z.object({
      ticket_id: z.string().describe('Ticket ID for the task'),
      prompt: z.string().describe('Task prompt for the sub-agent'),
      model: z.string().default('auto').describe("Model: 'auto', 'codex', or 'opus'"),
      working_dir: z.string().optional().describe('Working directory'),
      design_first: z.boolean().default(false).describe('Run spec & architecture first'),
      tdd: z.boolean().default(false).describe('Enable TDD workflow'),
    }),
    async () => 'Not yet implemented',
    'coding',
  );
}
