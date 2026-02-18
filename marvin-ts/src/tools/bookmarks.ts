import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from './registry.js';

interface Bookmark {
  url: string;
  title: string;
  tags: string[];
  notes?: string;
  created: string;
}

function bookmarksPath(profileDir: string): string {
  return join(profileDir, 'bookmarks.json');
}

function loadBookmarks(profileDir: string): Bookmark[] {
  const path = bookmarksPath(profileDir);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveBookmarks(profileDir: string, bookmarks: Bookmark[]): void {
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  writeFileSync(bookmarksPath(profileDir), JSON.stringify(bookmarks, null, 2));
}

function formatBookmark(b: Bookmark): string {
  let s = `- ${b.title || b.url}\n  ${b.url}`;
  if (b.tags.length) s += `\n  Tags: ${b.tags.join(', ')}`;
  if (b.notes) s += `\n  Notes: ${b.notes}`;
  s += `\n  Saved: ${b.created}`;
  return s;
}

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
    async (args, ctx) => {
      const bookmarks = loadBookmarks(ctx.profileDir);
      const tags = args.tags ? args.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
      const bookmark: Bookmark = {
        url: args.url,
        title: args.title || args.url,
        tags,
        ...(args.notes ? { notes: args.notes } : {}),
        created: new Date().toISOString(),
      };
      bookmarks.push(bookmark);
      saveBookmarks(ctx.profileDir, bookmarks);
      return `Bookmark saved: ${bookmark.title} (${bookmark.url})`;
    },
    'always',
  );

  registry.registerTool(
    'bookmark_list',
    'List saved bookmarks',
    z.object({
      tag: z.string().default('').describe('Optional tag filter'),
    }),
    async (args, ctx) => {
      let bookmarks = loadBookmarks(ctx.profileDir);
      if (args.tag) {
        const tag = args.tag.toLowerCase();
        bookmarks = bookmarks.filter(b => b.tags.some(t => t.toLowerCase() === tag));
      }
      if (bookmarks.length === 0) return 'No bookmarks found.';
      return bookmarks.map(formatBookmark).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'bookmark_search',
    'Search bookmarks by title/URL/notes/tags',
    z.object({
      query: z.string().describe('Search query'),
    }),
    async (args, ctx) => {
      const bookmarks = loadBookmarks(ctx.profileDir);
      const q = args.query.toLowerCase();
      const matches = bookmarks.filter(b =>
        b.url.toLowerCase().includes(q) ||
        b.title.toLowerCase().includes(q) ||
        (b.notes && b.notes.toLowerCase().includes(q)) ||
        b.tags.some(t => t.toLowerCase().includes(q))
      );
      if (matches.length === 0) return `No bookmarks matching "${args.query}".`;
      return matches.map(formatBookmark).join('\n\n');
    },
    'always',
  );
}
