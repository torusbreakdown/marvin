import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolRegistry } from './registry.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

async function wikiApi(params: Record<string, string>, testUrl?: string): Promise<any> {
  const qs = new URLSearchParams({ format: 'json', ...params });
  const url = testUrl || `${WIKI_API}?${qs.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Marvin/1.0 (CLI assistant)' },
  });
  if (!res.ok) throw new Error(`Wikipedia API error: HTTP ${res.status}`);
  return res.json();
}

function sanitizeFilename(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '_');
}

export function registerWikiTools(registry: ToolRegistry): void {
  registry.registerTool(
    'wiki_search',
    'Search Wikipedia for articles matching a query. Returns titles, snippets, and page IDs.',
    z.object({
      query: z.string().describe('Search query'),
      max_results: z.number().default(5).describe('Max results (1-10)'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, __test_url } = args;
      const data = await wikiApi({
        action: 'query', list: 'search', srsearch: query,
        srlimit: String(max_results),
      }, __test_url);
      const results = data?.query?.search;
      if (!results || results.length === 0) return `No Wikipedia articles found for: ${query}`;
      return results.map((r: any, i: number) => {
        const snippet = r.snippet.replace(/<[^>]+>/g, '');
        return `${i + 1}. ${r.title} (pageid: ${r.pageid})\n   ${snippet}`;
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'wiki_summary',
    'Get a concise summary of a Wikipedia article (1-3 paragraphs).',
    z.object({
      title: z.string().describe('Wikipedia article title'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { title, __test_url } = args;
      const data = await wikiApi({
        action: 'query', titles: title, prop: 'extracts',
        exintro: '1', explaintext: '1',
      }, __test_url);
      const pages = data?.query?.pages;
      if (!pages) return `Article not found: ${title}`;
      const page = Object.values(pages)[0] as any;
      if (!page?.extract) return `No summary available for: ${title}`;
      return `# ${page.title}\n\n${page.extract}`;
    },
    'always',
  );

  registry.registerTool(
    'wiki_full',
    'Fetch the full content of a Wikipedia article and save it to disk. Returns confirmation with file path.',
    z.object({
      title: z.string().describe('Wikipedia article title'),
      __test_url: z.string().optional(),
    }),
    async (args, ctx) => {
      const { title, __test_url } = args;
      const data = await wikiApi({
        action: 'query', titles: title, prop: 'extracts',
        explaintext: '1',
      }, __test_url);
      const pages = data?.query?.pages;
      if (!pages) return `Article not found: ${title}`;
      const page = Object.values(pages)[0] as any;
      if (!page?.extract) return `No content available for: ${title}`;

      const wikiDir = path.join(ctx.profileDir, 'wiki');
      fs.mkdirSync(wikiDir, { recursive: true });
      const filename = `${sanitizeFilename(page.title || title)}.txt`;
      const filePath = path.join(wikiDir, filename);
      fs.writeFileSync(filePath, page.extract, 'utf-8');

      const preview = page.extract.slice(0, 200);
      return `Article "${page.title}" saved to ${filePath} (${page.extract.length} chars).\n\nPreview: ${preview}...`;
    },
    'always',
  );

  registry.registerTool(
    'wiki_grep',
    'Search through a previously fetched Wikipedia article saved on disk. Use wiki_full first.',
    z.object({
      title: z.string().describe('Wikipedia article title (must have been fetched with wiki_full first)'),
      pattern: z.string().describe('Text or regex pattern to search for'),
    }),
    async (args, ctx) => {
      const { title, pattern } = args;
      const wikiDir = path.join(ctx.profileDir, 'wiki');
      const filename = `${sanitizeFilename(title)}.txt`;
      const filePath = path.join(wikiDir, filename);

      if (!fs.existsSync(filePath)) {
        return `Error: Article "${title}" not found on disk. Use wiki_full to fetch it first.`;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const regex = new RegExp(pattern, 'gi');
      const matches: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          // Include context lines
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 1);
          const block = lines.slice(start, end + 1)
            .map((l, j) => `${start + j + 1}: ${l}`)
            .join('\n');
          matches.push(block);
        }
      }

      if (matches.length === 0) return `No matches for "${pattern}" in article "${title}".`;
      return `Found ${matches.length} match(es) in "${title}":\n\n${matches.join('\n---\n')}`;
    },
    'always',
  );
}
