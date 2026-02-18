import { z } from 'zod';
import { execFileSync } from 'child_process';
import { isAbsolute } from 'path';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function runGit(args: string[], cwd: string): string {
  // SHARP_EDGES §6: Unset GIT_DIR before all git operations
  delete process.env.GIT_DIR;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_DIR: undefined },
    });
  } catch (err: any) {
    return err.stderr || err.stdout || err.message;
  }
}

export function registerGitTools(registry: ToolRegistry): void {
  // git_status
  registry.registerTool(
    'git_status',
    'Show git status of the working directory',
    z.object({}),
    async (_args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      const result = runGit(['status'], ctx.workingDir);
      return result || 'nothing to commit, working tree clean';
    },
    'coding',
  );

  // git_diff
  registry.registerTool(
    'git_diff',
    'Show git diff',
    z.object({
      staged: z.boolean().default(false).describe('Show staged changes only'),
      path: z.string().optional().describe('Specific file to diff'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      const gitArgs = ['diff'];
      if (args.staged) gitArgs.push('--cached');
      if (args.path) {
        // SECURITY: Reject absolute paths and traversal in git diff path
        if (isAbsolute(args.path) || args.path.includes('..')) {
          return 'Error: Only relative paths within the working directory are allowed.';
        }
        gitArgs.push('--', args.path);
      }
      const result = runGit(gitArgs, ctx.workingDir);
      return result || 'No changes.';
    },
    'coding',
  );

  // git_log
  registry.registerTool(
    'git_log',
    'Show recent git commits',
    z.object({
      max_count: z.number().default(10).describe('Number of commits to show'),
      oneline: z.boolean().default(true).describe('One-line format'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      const gitArgs = ['log', `--max-count=${args.max_count}`];
      if (args.oneline) gitArgs.push('--oneline');
      return runGit(gitArgs, ctx.workingDir);
    },
    'coding',
  );

  // git_blame
  registry.registerTool(
    'git_blame',
    'Show git blame for a file',
    z.object({
      path: z.string().describe('File path to blame'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      // SECURITY: Reject absolute paths and traversal in git blame path
      if (isAbsolute(args.path) || args.path.includes('..')) {
        return 'Error: Only relative paths within the working directory are allowed.';
      }
      if (args.path.startsWith('-')) {
        return 'Error: Path must not start with "-".';
      }
      return runGit(['blame', '--', args.path], ctx.workingDir);
    },
    'coding',
  );

  // git_commit
  registry.registerTool(
    'git_commit',
    'Stage and commit changes',
    z.object({
      message: z.string().describe('Commit message'),
      add_all: z.boolean().default(true).describe('Stage all changes before committing'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      if (args.add_all) {
        runGit(['add', '-A'], ctx.workingDir);
      }
      const result = runGit(['commit', '-m', args.message], ctx.workingDir);
      if (result.includes('nothing to commit')) return result;
      return `Committed: ${args.message}\n${result}`;
    },
    'coding',
  );

  // git_branch
  registry.registerTool(
    'git_branch',
    'List or manage git branches',
    z.object({}),
    async (_args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      return runGit(['branch'], ctx.workingDir);
    },
    'coding',
  );

  // git_checkout
  registry.registerTool(
    'git_checkout',
    'Checkout a branch, commit, or file',
    z.object({
      target: z.string().describe('Branch name, commit hash, or file path'),
      create_branch: z.boolean().default(false).describe('Create a new branch'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      // SECURITY: Reject targets that look like git options to prevent option injection
      if (args.target.startsWith('-')) {
        return 'Error: Target must not start with "-".';
      }
      const gitArgs = ['checkout'];
      if (args.create_branch) gitArgs.push('-b');
      gitArgs.push(args.target);
      const result = runGit(gitArgs, ctx.workingDir);
      return result || `Checked out ${args.target}`;
    },
    'coding',
  );
}
