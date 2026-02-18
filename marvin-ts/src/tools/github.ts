import { z } from 'zod';
import { existsSync, readFileSync, mkdirSync, realpathSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function getClonesDir(overrideDir?: string): string {
  return overrideDir ?? join(homedir(), 'github-clones');
}

// SECURITY: Validate that a path does not escape the repo directory
function validateRepoPath(inputPath: string, repoDir: string): string | null {
  if (isAbsolute(inputPath)) {
    return `Error: Absolute paths are not allowed. Use a path relative to the repo root.`;
  }
  if (inputPath.includes('..')) {
    return `Error: Path traversal with ".." is not allowed.`;
  }
  if (inputPath.includes('\0')) {
    return `Error: Null bytes are not allowed in paths.`;
  }
  const resolved = resolve(repoDir, inputPath);
  const rel = relative(repoDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return `Error: Path escapes the repository directory.`;
  }
  // SECURITY: Check symlinks don't escape repo directory (cloned repos can contain symlinks)
  if (existsSync(resolved)) {
    try {
      const realPath = realpathSync(resolved);
      const realRepo = realpathSync(repoDir);
      const realRel = relative(realRepo, realPath);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        return `Error: Path resolves outside repository via symlink.`;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function registerGithubTools(registry: ToolRegistry, clonesDirOverride?: string): void {
  const clonesDir = getClonesDir(clonesDirOverride);

  registry.registerTool(
    'github_clone',
    'Clone a GitHub repo to local directory',
    z.object({
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
    }),
    async (args, _ctx) => {
      // SECURITY: Sanitize owner/repo to prevent path traversal
      if (args.owner.includes('..') || args.owner.includes('/') || args.repo.includes('..') || args.repo.includes('/')) {
        return `Error: Invalid owner/repo name. Must not contain ".." or "/".`;
      }
      const repoDir = join(clonesDir, args.owner, args.repo);
      if (existsSync(repoDir)) {
        return `Repository already cloned at: ${repoDir}`;
      }
      mkdirSync(join(clonesDir, args.owner), { recursive: true });
      try {
        execFileSync('git', ['clone', `https://github.com/${args.owner}/${args.repo}.git`, repoDir], {
          encoding: 'utf-8',
          timeout: 120_000,
          env: { ...process.env, GIT_DIR: undefined },
        });
        return `Cloned ${args.owner}/${args.repo} to ${repoDir}`;
      } catch (err: any) {
        return `Error cloning: ${err.message}`;
      }
    },
    'always',
  );

  registry.registerTool(
    'github_read_file',
    'Read a file from a cloned GitHub repo',
    z.object({
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path within the repo'),
    }),
    async (args, _ctx) => {
      if (args.owner.includes('..') || args.owner.includes('/') || args.repo.includes('..') || args.repo.includes('/')) {
        return `Error: Invalid owner/repo name.`;
      }
      const repoDir = join(clonesDir, args.owner, args.repo);
      if (!existsSync(repoDir)) {
        return `Error: Repository ${args.owner}/${args.repo} not cloned. Use github_clone first.`;
      }
      // SECURITY: Validate path stays within repo directory
      const pathErr = validateRepoPath(args.path, repoDir);
      if (pathErr) return pathErr;
      const filePath = join(repoDir, args.path);
      if (!existsSync(filePath)) {
        return `Error: File not found: ${args.path} in ${args.owner}/${args.repo}`;
      }
      return readFileSync(filePath, 'utf-8');
    },
    'always',
  );

  registry.registerTool(
    'github_grep',
    'Search within a cloned GitHub repo',
    z.object({
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      pattern: z.string().describe('Search pattern'),
    }),
    async (args, _ctx) => {
      if (args.owner.includes('..') || args.owner.includes('/') || args.repo.includes('..') || args.repo.includes('/')) {
        return `Error: Invalid owner/repo name.`;
      }
      const repoDir = join(clonesDir, args.owner, args.repo);
      if (!existsSync(repoDir)) {
        return `Error: Repository ${args.owner}/${args.repo} not cloned.`;
      }
      try {
        const result = execFileSync('grep', ['-rn', args.pattern, '.'], {
          cwd: repoDir,
          encoding: 'utf-8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        return result || 'No matches found.';
      } catch (err: any) {
        if (err.status === 1) return 'No matches found.';
        return `Error: ${err.message}`;
      }
    },
    'always',
  );
}
