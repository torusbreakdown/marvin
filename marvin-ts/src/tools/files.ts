import { z } from 'zod';
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, mkdirSync, realpathSync } from 'fs';
import { join, resolve, isAbsolute, dirname, relative } from 'path';
import { execFileSync } from 'child_process';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function validatePath(path: string, ctx: ToolContext): string | null {
  if (!ctx.workingDir) return 'Error: No working directory set.';
  // SECURITY: Block null bytes that could truncate paths at the OS level
  if (path.includes('\0')) {
    return 'Error: Null bytes are not allowed in paths.';
  }
  if (isAbsolute(path)) {
    const tree = getTree(ctx.workingDir, 2);
    return `Error: Absolute paths are not allowed. Use relative paths.\nWorking directory: ${ctx.workingDir}\n\nDirectory tree:\n${tree}`;
  }
  if (path.includes('..')) {
    const tree = getTree(ctx.workingDir, 2);
    return `Error: Path traversal with ".." is not allowed.\nWorking directory: ${ctx.workingDir}\n\nDirectory tree:\n${tree}`;
  }
  return null;
}

function resolvePath(path: string, ctx: ToolContext): string {
  return resolve(ctx.workingDir!, path);
}

// SECURITY: After resolving, verify the real path (following symlinks) stays within the sandbox
function validateRealPath(resolvedPath: string, ctx: ToolContext): string | null {
  if (!existsSync(resolvedPath)) return null; // file doesn't exist yet — OK for create_file
  try {
    const realPath = realpathSync(resolvedPath);
    const realWorkingDir = realpathSync(ctx.workingDir!);
    const rel = relative(realWorkingDir, realPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return `Error: Path resolves outside working directory via symlink. Resolved to: ${realPath}`;
    }
  } catch {
    // realpathSync fails if path doesn't exist — that's fine for writes
  }
  return null;
}

function getTree(dir: string, maxDepth: number, prefix = '', depth = 0): string {
  if (depth >= maxDepth) return '';
  let result = '';
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      result += `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}\n`;
      if (entry.isDirectory()) {
        result += getTree(join(dir, entry.name), maxDepth, prefix + '  ', depth + 1);
      }
    }
  } catch { /* ignore */ }
  return result;
}

export function registerFilesTools(registry: ToolRegistry): void {
  // read_file
  registry.registerTool(
    'read_file',
    'Read a file with line numbers',
    z.object({
      path: z.string().describe('Relative path to file'),
      start_line: z.number().optional().describe('Start line (1-based)'),
      end_line: z.number().optional().describe('End line (1-based, inclusive)'),
    }),
    async (args, ctx) => {
      const pathErr = validatePath(args.path, ctx);
      if (pathErr) return pathErr;
      const fullPath = resolvePath(args.path, ctx);
      if (!existsSync(fullPath)) {
        return `Error: File not found: ${args.path}\nWorking directory: ${ctx.workingDir}`;
      }
      // SECURITY: Check symlinks don't escape sandbox
      const symlinkErr = validateRealPath(fullPath, ctx);
      if (symlinkErr) return symlinkErr;

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // 10KB guard
      const stat = statSync(fullPath);
      if (stat.size > 10_000 && args.start_line == null && args.end_line == null) {
        return `Error: File is ${stat.size} bytes (${lines.length} lines) which exceeds 10KB limit. Use start_line/end_line to read a section.\n\nExamples:\n  read_file({path: "${args.path}", start_line: 1, end_line: 50})\n  read_file({path: "${args.path}", start_line: 100, end_line: 200})`;
      }

      const start = (args.start_line ?? 1) - 1;
      const end = args.end_line ?? lines.length;
      const slice = lines.slice(start, end);

      return slice
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join('\n');
    },
    'coding',
  );

  // create_file
  registry.registerTool(
    'create_file',
    'Create a new file',
    z.object({
      path: z.string().describe('Relative path for new file'),
      content: z.string().default('').describe('File content'),
    }),
    async (args, ctx) => {
      const pathErr = validatePath(args.path, ctx);
      if (pathErr) return pathErr;
      const fullPath = resolvePath(args.path, ctx);
      if (existsSync(fullPath)) {
        return `Error: File already exists: ${args.path}. Use apply_patch to edit.`;
      }
      // SECURITY: Validate that parent directory (if it exists) doesn't escape sandbox via symlink
      const dir = dirname(fullPath);
      if (existsSync(dir)) {
        const symlinkErr = validateRealPath(dir, ctx);
        if (symlinkErr) return symlinkErr;
      }
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // SECURITY: Re-validate after mkdir in case of race condition
      const parentCheck = validateRealPath(dir, ctx);
      if (parentCheck) return parentCheck;
      writeFileSync(fullPath, args.content, 'utf-8');
      return `Created ${args.path}`;
    },
    'coding',
  );

  // append_file
  registry.registerTool(
    'append_file',
    'Append content to an existing file',
    z.object({
      path: z.string().describe('Relative path to file'),
      content: z.string().default('').describe('Content to append'),
    }),
    async (args, ctx) => {
      const pathErr = validatePath(args.path, ctx);
      if (pathErr) return pathErr;
      const fullPath = resolvePath(args.path, ctx);
      if (!existsSync(fullPath)) {
        return `Error: File not found: ${args.path}. Use create_file first.`;
      }
      // SECURITY: Check symlinks don't escape sandbox
      const symlinkErr = validateRealPath(fullPath, ctx);
      if (symlinkErr) return symlinkErr;
      appendFileSync(fullPath, args.content, 'utf-8');
      return `Appended to ${args.path}`;
    },
    'coding',
  );

  // apply_patch
  registry.registerTool(
    'apply_patch',
    'Edit a file by replacing exact string match',
    z.object({
      path: z.string().describe('Relative path to file'),
      old_str: z.string().default('').describe('Exact string to find'),
      new_str: z.string().default('').describe('Replacement string'),
      __raw_patch: z.string().optional().describe('Raw Codex patch (internal)'),
    }),
    async (args, ctx) => {
      // Handle Codex patch format
      // SECURITY: __raw_patch is a stub — log but don't claim success for unprocessed patches
      if (args.__raw_patch) {
        return `Error: Codex patch format detected but not yet implemented. Please use the standard path/old_str/new_str parameters instead.`;
      }

      const pathErr = validatePath(args.path, ctx);
      if (pathErr) return pathErr;
      const fullPath = resolvePath(args.path, ctx);
      if (!existsSync(fullPath)) {
        return `Error: File not found: ${args.path}`;
      }
      // SECURITY: Check symlinks don't escape sandbox
      const symlinkErr = validateRealPath(fullPath, ctx);
      if (symlinkErr) return symlinkErr;
      const content = readFileSync(fullPath, 'utf-8');
      if (!content.includes(args.old_str)) {
        return `Error: old_str not found in ${args.path}. Make sure you copy the exact text including whitespace.`;
      }
      const newContent = content.replace(args.old_str, args.new_str);
      writeFileSync(fullPath, newContent, 'utf-8');
      return `Applied patch to ${args.path}`;
    },
    'coding',
  );

  // list_files (tree)
  registry.registerTool(
    'list_files',
    'List directory tree structure',
    z.object({
      path: z.string().default('.').describe('Directory to list (relative)'),
      max_depth: z.number().default(3).describe('Max depth'),
    }),
    async (args, ctx) => {
      const pathErr = validatePath(args.path, ctx);
      if (pathErr) return pathErr;
      const fullPath = resolvePath(args.path, ctx);
      if (!existsSync(fullPath)) {
        return `Error: Directory not found: ${args.path}`;
      }
      // SECURITY: Check symlinks don't escape sandbox
      const symlinkErr = validateRealPath(fullPath, ctx);
      if (symlinkErr) return symlinkErr;
      return getTree(fullPath, args.max_depth);
    },
    'coding',
  );

  // grep_files
  registry.registerTool(
    'grep_files',
    'Search for pattern in files',
    z.object({
      pattern: z.string().describe('Regex pattern to search'),
      glob_filter: z.string().default('*').describe('Glob filter'),
      max_results: z.number().default(20).describe('Max matches'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      try {
        const result = execFileSync('grep', [
          '-rn', '--include', args.glob_filter,
          '-m', String(args.max_results),
          args.pattern, '.',
        ], {
          cwd: ctx.workingDir,
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
    'coding',
  );

  // find_files
  registry.registerTool(
    'find_files',
    'Find files by name pattern',
    z.object({
      pattern: z.string().describe('Glob pattern to match'),
    }),
    async (args, ctx) => {
      if (!ctx.workingDir) return 'Error: No working directory set.';
      try {
        const result = execFileSync('find', [
          '.', '-name', args.pattern, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*',
        ], {
          cwd: ctx.workingDir,
          encoding: 'utf-8',
          timeout: 10_000,
        });
        return result || 'No files found.';
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
    'coding',
  );
}
