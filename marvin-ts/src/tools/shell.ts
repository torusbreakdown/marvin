import { z } from 'zod';
import { exec } from 'child_process';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

export function registerShellTools(registry: ToolRegistry): void {
  registry.registerTool(
    'run_command',
    'Execute a shell command in the working directory',
    z.object({
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().default(60).describe('Timeout in seconds'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';

      // SECURITY: In interactive mode, require user confirmation for shell commands.
      // In non-interactive mode (sub-agent), commands are auto-approved by design —
      // the calling process is responsible for sandboxing. This is intentional:
      // non-interactive mode is used for automated coding workflows where the LLM
      // needs to run build/test commands without human intervention.
      if (!ctx.nonInteractive && ctx.confirmCommand) {
        // SECURITY: Strip ANSI escape codes so the command preview can't hide malicious content
        const sanitizedPreview = args.command.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
        const confirmed = await ctx.confirmCommand(sanitizedPreview);
        if (!confirmed) {
          return 'Command declined by user.';
        }
      }

      // SECURITY: Filter sensitive environment variables from child process
      const sanitizedEnv = { ...process.env };
      const sensitiveKeys = ['OPENAI_API_KEY', 'MARVIN_API_KEY', 'GNEWS_API_KEY', 'STEAM_API_KEY',
        'OMDB_API_KEY', 'RAWG_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SPOTIFY_CLIENT_SECRET'];
      for (const key of sensitiveKeys) {
        delete sanitizedEnv[key];
      }

      return new Promise<string>((resolve) => {
        const timeoutMs = args.timeout * 1000;
        const child = exec(args.command, {
          cwd: ctx.workingDir!,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...sanitizedEnv },
        }, (error, stdout, stderr) => {
          if (error) {
            if (error.killed || error.message.includes('TIMEOUT') || (error as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.signal === 'SIGTERM') {
              resolve(`Command timeout after ${args.timeout}s: ${args.command}`);
              return;
            }
            const output = [stdout, stderr].filter(Boolean).join('\n');
            resolve(output || `Command failed with exit code ${error.code}: ${error.message}`);
            return;
          }
          resolve(stdout || stderr || '(no output)');
        });
      });
    },
    'coding',
  );
}
