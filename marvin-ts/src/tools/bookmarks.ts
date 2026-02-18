import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerBookmarksTools(registry: ToolRegistry): void {
  registry.registerTool(
    'bookmark_save',
    'Save a bookmark with URL, title, tags, and notes',
    z.object({
      url: z.string().describe('URL to bookmark'),
      title: z.string().default('').describe('Bookmark title'),
      tags: z.string().default('').describe('Comma-separated tags'),
      notes: z.string().default('').describe('Notes'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'bookmark_list',
    'List saved bookmarks',
    z.object({
      tag: z.string().default('').describe('Optional tag filter'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'bookmark_search',
    'Search bookmarks by title/URL/notes/tags',
    z.object({
      query: z.string().describe('Search query'),
    }),
    async () => 'Not yet implemented',
    'always',
  );
}
