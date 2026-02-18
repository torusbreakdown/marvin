import { z } from 'zod';
import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerCodingTools(registry: ToolRegistry): void {
  registry.registerTool(
    'set_working_dir',
    'Set the working directory for coding operations',
    z.object({
      path: z.string().describe('Absolute path to working directory'),
    }),
    async (args, ctx) => {
      if (!existsSync(args.path)) {
        return `Error: Directory does not exist: ${args.path}`;
      }
      const stat = statSync(args.path);
      if (!stat.isDirectory()) {
        return `Error: Not a directory: ${args.path}`;
      }
      // SECURITY: In interactive mode, require user confirmation to change working directory.
      // An unrestricted set_working_dir allows the LLM to escape any sandbox by pointing
      // file operations at sensitive directories like /etc, /root, etc.
      if (!ctx.nonInteractive && ctx.confirmCommand) {
        const confirmed = await ctx.confirmCommand(`Set working directory to: ${args.path}`);
        if (!confirmed) {
          return 'Working directory change declined by user.';
        }
      }
      ctx.workingDir = args.path;
      return `Working directory set to: ${args.path}`;
    },
    'coding',
  );

  registry.registerTool(
    'get_working_dir',
    'Get the current working directory',
    z.object({}),
    async (_args, ctx) => {
      return ctx.workingDir ?? 'No working directory set.';
    },
    'coding',
  );

  registry.registerTool(
    'review_codebase',
    'Launch a background codebase review',
    z.object({
      ticket_id: z.string().describe('Ticket ID for tracking'),
      prompt: z.string().default('Review the codebase').describe('Review prompt'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      return `Background review launched for ticket ${args.ticket_id}. Use review_status to check progress.`;
    },
    'coding',
  );

  registry.registerTool(
    'review_status',
    'Check status of background review jobs',
    z.object({}),
    async (_args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      const jobsDir = join(ctx.workingDir, '.marvin', 'jobs');
      if (!existsSync(jobsDir)) return 'No background jobs found.';
      const files = readdirSync(jobsDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) return 'No background jobs found.';

      const lines: string[] = [];
      for (const f of files) {
        try {
          const job = JSON.parse(readFileSync(join(jobsDir, f), 'utf-8'));
          const alive = job.pid ? isProcessAlive(job.pid) : false;
          const status = alive ? 'running' : (job.status === 'running' ? 'dead (process gone)' : job.status);
          lines.push(`• ${job.id} — ${status} — ticket: ${job.ticket ?? 'none'} — started: ${job.started ?? 'unknown'}`);
        } catch {
          lines.push(`• ${f}: (corrupt job file)`);
        }
      }
      return lines.join('\n');
    },
    'coding',
  );
}
