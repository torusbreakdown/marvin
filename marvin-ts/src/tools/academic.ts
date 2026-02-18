import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

function parseAtomFeed(xml: string): Array<{
  title: string;
  authors: string[];
  abstract: string;
  pdfUrl: string;
  absUrl: string;
  published: string;
}> {
  const entries: Array<{
    title: string; authors: string[]; abstract: string;
    pdfUrl: string; absUrl: string; published: string;
  }> = [];

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
    const authorMatches = [...block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)];
    const authors = authorMatches.map(m => m[1].trim());
    const abstract = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
    const absUrl = block.match(/<link[^>]*href="([^"]*)"[^>]*rel="alternate"/)?.[1] ||
                   block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"/)?.[1] || '';
    const pdfUrl = block.match(/<link[^>]*href="([^"]*)"[^>]*title="pdf"/)?.[1] ||
                   block.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/)?.[1] || '';
    const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';

    entries.push({ title, authors, abstract, pdfUrl, absUrl, published });
  }

  return entries;
}

export function registerAcademicTools(registry: ToolRegistry): void {
  registry.registerTool(
    'search_papers',
    'Search for academic papers using Semantic Scholar. Returns titles, authors, year, citation count, abstract, and PDF links.',
    z.object({
      query: z.string().describe('Search query for academic papers'),
      max_results: z.number().default(5).describe('Maximum results to return (1-20)'),
      year_min: z.number().default(0).describe('Filter papers from this year onward (0 = no filter)'),
      year_max: z.number().default(0).describe('Filter papers up to this year (0 = no filter)'),
      open_access_only: z.boolean().default(false).describe('Only return papers with free PDF links'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, year_min, year_max, open_access_only, __test_url } = args;

      let url: string;
      if (__test_url) {
        url = __test_url;
      } else {
        const params = new URLSearchParams({
          query,
          limit: String(max_results),
          fields: 'title,authors,year,citationCount,abstract,url,openAccessPdf',
        });
        if (year_min) params.set('year', `${year_min}-${year_max || ''}`);
        url = `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
      }

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Marvin/1.0' },
      });
      if (!res.ok) throw new Error(`Semantic Scholar API error: HTTP ${res.status}`);
      const data = await res.json() as any;

      let papers: any[] = data.data || [];
      if (open_access_only) {
        papers = papers.filter((p: any) => p.openAccessPdf?.url);
      }

      if (papers.length === 0) return `No papers found for: ${query}`;

      return papers.slice(0, max_results).map((p: any, i: number) => {
        const authors = (p.authors || []).map((a: any) => a.name).join(', ');
        const pdf = p.openAccessPdf?.url ? `\n   PDF: ${p.openAccessPdf.url}` : '';
        return `${i + 1}. ${p.title}\n   Authors: ${authors}\n   Year: ${p.year} | Citations: ${p.citationCount}${pdf}\n   ${p.abstract || ''}`;
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'search_arxiv',
    'Search arXiv for preprints. Returns titles, authors, abstract, and direct PDF links.',
    z.object({
      query: z.string().describe('Search query for arXiv preprints'),
      max_results: z.number().default(5).describe('Maximum results (1-20)'),
      sort_by: z.string().default('relevance').describe("Sort by: 'relevance', 'lastUpdatedDate', or 'submittedDate'"),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, sort_by, __test_url } = args;

      let url: string;
      if (__test_url) {
        url = __test_url;
      } else {
        const params = new URLSearchParams({
          search_query: `all:${query}`,
          max_results: String(max_results),
          sortBy: sort_by,
          sortOrder: 'descending',
        });
        url = `http://export.arxiv.org/api/query?${params.toString()}`;
      }

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Marvin/1.0' },
      });
      if (!res.ok) throw new Error(`arXiv API error: HTTP ${res.status}`);
      const xml = await res.text();
      const entries = parseAtomFeed(xml);

      if (entries.length === 0) return `No arXiv preprints found for: ${query}`;

      return entries.slice(0, max_results).map((e, i) => {
        const authors = e.authors.join(', ');
        const year = e.published ? e.published.slice(0, 4) : '';
        return `${i + 1}. ${e.title}\n   Authors: ${authors}${year ? ` | ${year}` : ''}\n   ${e.absUrl}\n   pdf: ${e.pdfUrl}\n   ${e.abstract}`;
      }).join('\n\n');
    },
    'always',
  );
}
