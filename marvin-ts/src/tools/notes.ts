import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, realpathSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function getNotesDir(ctx: ToolContext, overrideDir?: string): string {
  // SHARP_EDGES §13: coding mode writes to .marvin/notes/ inside project
  if (ctx.codingMode && ctx.workingDir) {
    const dir = join(ctx.workingDir, '.marvin', 'notes');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }
  return overrideDir ?? join(homedir(), 'Notes');
}

// SECURITY: Validate that a filename/path does not escape the notes directory
function validateNotesPath(name: string, baseDir: string): string | null {
  if (isAbsolute(name)) {
    return `Error: Absolute paths are not allowed. Use a simple filename.`;
  }
  if (name.includes('..')) {
    return `Error: Path traversal with ".." is not allowed.`;
  }
  const resolved = resolve(baseDir, name);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return `Error: Path escapes the notes directory.`;
  }
  return null;
}

export function registerNotesTools(registry: ToolRegistry, notesBaseDir?: string): void {
  registry.registerTool(
    'write_note',
    'Save a note to ~/Notes/ (interactive) or .marvin/notes/ (coding mode)',
    z.object({
      filename: z.string().describe('Filename for the note'),
      content: z.string().describe('Note content'),
    }),
    async (args, ctx) => {
      const dir = getNotesDir(ctx, notesBaseDir);
      const pathErr = validateNotesPath(args.filename, dir);
      if (pathErr) return pathErr;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, args.filename), args.content, 'utf-8');
      return `Saved note: ${args.filename}`;
    },
    'always',
  );

  registry.registerTool(
    'read_note',
    'Read a note file',
    z.object({
      filename: z.string().describe('Filename to read'),
    }),
    async (args, ctx) => {
      const dir = getNotesDir(ctx, notesBaseDir);
      const pathErr = validateNotesPath(args.filename, dir);
      if (pathErr) return pathErr;
      const filePath = join(dir, args.filename);
      if (!existsSync(filePath)) {
        return `Error: Note not found: ${args.filename}`;
      }
      return readFileSync(filePath, 'utf-8');
    },
    'always',
  );

  registry.registerTool(
    'notes_ls',
    'List files and directories in notes directory',
    z.object({
      path: z.string().default('').describe('Subdirectory to list'),
    }),
    async (args, ctx) => {
      const dir = getNotesDir(ctx, notesBaseDir);
      if (args.path) {
        const pathErr = validateNotesPath(args.path, dir);
        if (pathErr) return pathErr;
      }
      const target = args.path ? join(dir, args.path) : dir;
      if (!existsSync(target)) return `Error: Directory not found: ${args.path || '/'}`;
      const entries = readdirSync(target, { withFileTypes: true });
      return entries
        .map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`)
        .join('\n') || 'Empty directory';
    },
    'always',
  );

  registry.registerTool(
    'notes_mkdir',
    'Create subdirectory inside notes directory',
    z.object({
      name: z.string().describe('Directory name to create'),
    }),
    async (args, ctx) => {
      const dir = getNotesDir(ctx, notesBaseDir);
      const pathErr = validateNotesPath(args.name, dir);
      if (pathErr) return pathErr;
      const target = join(dir, args.name);
      mkdirSync(target, { recursive: true });
      return `Created directory: ${args.name}`;
    },
    'always',
  );

  registry.registerTool(
    'search_notes',
    'Search notes for matching content',
    z.object({
      query: z.string().describe('Text to search for'),
    }),
    async (args, ctx) => {
      const dir = getNotesDir(ctx, notesBaseDir);
      if (!existsSync(dir)) return 'No matches found.';
      try {
        const result = execFileSync('grep', ['-rn', '--include=*', args.query, '.'], {
          cwd: dir,
          encoding: 'utf-8',
          timeout: 10_000,
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
