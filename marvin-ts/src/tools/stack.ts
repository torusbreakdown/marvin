import { z } from 'zod';
import * as zlib from 'node:zlib';
import type { ToolRegistry } from './registry.js';

async function fetchStackExchange(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Marvin/1.0' },
  });
  if (!res.ok) throw new Error(`Stack Exchange API error: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  // Try parsing as JSON first (fetch may have auto-decompressed)
  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch {
    // If that fails, try manual gzip decompression (raw gzip response)
    try {
      const decompressed = zlib.gunzipSync(buffer);
      return JSON.parse(decompressed.toString('utf-8'));
    } catch {
      throw new Error('Failed to parse Stack Exchange API response');
    }
  }
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function registerStackTools(registry: ToolRegistry): void {
  registry.registerTool(
    'stack_search',
    'Search Stack Exchange for questions. Returns titles, scores, answer counts, and tags.',
    z.object({
      query: z.string().describe('Search query'),
      site: z.string().default('stackoverflow').describe('Stack Exchange site'),
      tagged: z.string().optional().describe('Filter by tags, semicolon-separated'),
      sort: z.string().default('relevance').describe("Sort by: relevance, votes, creation, activity"),
      max_results: z.number().default(5).describe('Max results (1-10)'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, site, tagged, sort, max_results, __test_url } = args;

      let url: string;
      if (__test_url) {
        url = __test_url;
      } else {
        const params = new URLSearchParams({
          order: 'desc', sort, intitle: query, site,
          pagesize: String(max_results), filter: 'default',
        });
        if (tagged) params.set('tagged', tagged);
        url = `https://api.stackexchange.com/2.3/search?${params.toString()}`;
      }

      const data = await fetchStackExchange(url);
      const items = data.items || [];
      if (items.length === 0) return `No questions found for: ${query}`;

      return items.slice(0, max_results).map((q: any, i: number) => {
        const tags = (q.tags || []).join(', ');
        const answered = q.is_answered ? '✓' : '✗';
        return `${i + 1}. [${answered}] ${stripHtmlTags(q.title)} (id: ${q.question_id})\n   Score: ${q.score} | Answers: ${q.answer_count} | Tags: ${tags}\n   ${q.link || ''}`;
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'stack_answers',
    'Get the top answers for a Stack Exchange question by ID.',
    z.object({
      question_id: z.number().describe('Question ID from search results'),
      site: z.string().default('stackoverflow').describe('Stack Exchange site'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { question_id, site, __test_url } = args;

      let url: string;
      if (__test_url) {
        url = __test_url;
      } else {
        const params = new URLSearchParams({
          order: 'desc', sort: 'votes', site,
          filter: 'withbody',
        });
        url = `https://api.stackexchange.com/2.3/questions/${question_id}/answers?${params.toString()}`;
      }

      const data = await fetchStackExchange(url);
      const items = data.items || [];
      if (items.length === 0) return `No answers found for question ${question_id}`;

      return items.map((a: any, i: number) => {
        const accepted = a.is_accepted ? ' ★ accepted' : '';
        const body = stripHtmlTags(a.body || '');
        return `--- Answer ${i + 1} (score: ${a.score}${accepted}) ---\n${body}`;
      }).join('\n\n');
    },
    'always',
  );
}
