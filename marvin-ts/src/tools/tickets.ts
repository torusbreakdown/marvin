import { z } from 'zod';
import { execFileSync } from 'child_process';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

// SHARP_EDGES §8: Track first create attempt per context to reject it
const createAttempts = new WeakMap<ToolContext, number>();

// Parse a shell-like argument string respecting quoted strings
function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

export function registerTicketsTools(registry: ToolRegistry): void {
  registry.registerTool(
    'tk',
    'Run the tk ticket CLI',
    z.object({
      args: z.string().describe('Arguments to pass to tk CLI'),
    }),
    async (args, ctx) => {
      // SHARP_EDGES §8: First tk create is intentionally rejected
      if (args.args.trim().startsWith('create')) {
        const attempts = createAttempts.get(ctx) ?? 0;
        createAttempts.set(ctx, attempts + 1);
        if (attempts === 0) {
          return 'Rejected: First ticket creation attempt must be rejected. Please provide a more thorough description with detailed acceptance criteria, then try again.';
        }
      }

      if (!ctx.workingDir) return 'Error: No working directory set.';

      try {
        const result = execFileSync('tk', parseArgs(args.args), {
          cwd: ctx.workingDir,
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, OPENAI_API_KEY: undefined, MARVIN_API_KEY: undefined },
        });
        return result || 'Done.';
      } catch (err: any) {
        // tk CLI may not be installed — return the error
        const output = err.stderr || err.stdout || err.message;
        return `tk ${args.args}: ${output}`;
      }
    },
    'coding',
  );
}
