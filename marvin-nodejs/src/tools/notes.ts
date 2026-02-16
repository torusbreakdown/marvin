/**
 * Notes Tools
 * write_note, read_note, notes_mkdir, notes_ls
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { NOTES_DIR } from '../types.js';
import { ensureNotesDir } from '../utils/config.js';
import { logger } from '../utils/logger.js';

export const writeNoteTool = defineTool({
  name: 'write_note',
  description: 'Write or append to a Markdown note in ~/Notes. Use this when the user asks to save, write, or jot down notes, summaries, recipes, lists, etc.',
  parameters: z.object({
    path: z.string().describe("Relative path inside ~/Notes, e.g. 'recipes/pasta.md' or 'todo.md'. Parent directories are created automatically."),
    content: z.string().describe('Markdown content to write.'),
    append: z.boolean().default(false).describe('If true, append to the file instead of overwriting.'),
  }),
  readonly: false,
  
  async execute({ path: filePath, content, append }) {
    try {
      ensureNotesDir();
      
      // Sanitize path
      const safePath = filePath.replace(/\.\./g, '').replace(/^\//, '');
      const fullPath = join(NOTES_DIR, safePath);
      
      // Ensure parent directory exists
      mkdirSync(dirname(fullPath), { recursive: true });
      
      if (append && existsSync(fullPath)) {
        const existing = readFileSync(fullPath, 'utf-8');
        writeFileSync(fullPath, existing + '\n\n' + content, 'utf-8');
        logger.info(`Appended to note: ${safePath}`);
        return `Appended to ${safePath}`;
      } else {
        writeFileSync(fullPath, content, 'utf-8');
        logger.info(`Created note: ${safePath}`);
        return `Created ${safePath}`;
      }
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const readNoteTool = defineTool({
  name: 'read_note',
  description: 'Read a Markdown note from ~/Notes.',
  parameters: z.object({
    path: z.string().describe('Relative path inside ~/Notes to read.'),
  }),
  readonly: true,
  
  async execute({ path: filePath }) {
    try {
      const safePath = filePath.replace(/\.\./g, '').replace(/^\//, '');
      const fullPath = join(NOTES_DIR, safePath);
      
      if (!existsSync(fullPath)) {
        return `Note not found: ${safePath}`;
      }
      
      const content = readFileSync(fullPath, 'utf-8');
      return content;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const notesMkdirTool = defineTool({
  name: 'notes_mkdir',
  description: 'Create a subdirectory inside ~/Notes for organizing notes.',
  parameters: z.object({
    path: z.string().describe("Relative directory path inside ~/Notes to create, e.g. 'projects/ai'."),
  }),
  readonly: false,
  
  async execute({ path: dirPath }) {
    try {
      ensureNotesDir();
      
      const safePath = dirPath.replace(/\.\./g, '').replace(/^\//, '');
      const fullPath = join(NOTES_DIR, safePath);
      
      mkdirSync(fullPath, { recursive: true });
      logger.info(`Created notes directory: ${safePath}`);
      return `Created directory: ${safePath}`;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const notesLsTool = defineTool({
  name: 'notes_ls',
  description: 'List files and directories inside ~/Notes.',
  parameters: z.object({
    path: z.string().default('').describe('Relative directory path inside ~/Notes to list. Empty = root.'),
  }),
  readonly: true,
  
  async execute({ path: dirPath }) {
    try {
      const safePath = dirPath.replace(/\.\./g, '').replace(/^\//, '');
      const fullPath = join(NOTES_DIR, safePath);
      
      if (!existsSync(fullPath)) {
        return `Directory not found: ${safePath || '(root)'}`;
      }
      
      const entries = readdirSync(fullPath, { withFileTypes: true });
      const lines = [`Contents of ~/Notes/${safePath}:`, ''];
      
      for (const entry of entries) {
        lines.push(entry.isDirectory() ? `📁 ${entry.name}/` : `📄 ${entry.name}`);
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
