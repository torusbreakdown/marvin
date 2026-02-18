import { z } from 'zod';
import { execSync } from 'node:child_process';
import { isPrivateUrl } from './ssrf.js';
import type { ToolRegistry } from './registry.js';

// SECURITY: Block requests to internal/private network addresses (SSRF protection)
export function validateUrl(url: string): string | null {
  return isPrivateUrl(url);
}

function lynxDump(url: string): { text: string; error?: string } {
  try {
    const result = execSync(
      `lynx -dump -nolist -nonumbers -width=120 -accept_all_cookies ${JSON.stringify(url)}`,
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { text: result.trim() };
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.slice(0, 300) || '';
    const msg = e.message?.slice(0, 300) || 'unknown error';
    return { text: '', error: `lynx failed: ${msg} ${stderr}`.trim() };
  }
}

async function fetchText(url: string, headers?: Record<string, string>, _redirectCount = 0): Promise<string> {
  // SECURITY: Limit redirect depth to prevent infinite redirect loops
  if (_redirectCount > 5) throw new Error('Too many redirects');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Marvin/1.0)',
      ...headers,
    },
    redirect: 'manual', // SECURITY: Don't auto-follow redirects — validate each hop
  });
  // Handle redirects manually to prevent SSRF via 302 to internal IPs
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error(`HTTP ${res.status} redirect with no Location header`);
    const redirectErr = validateUrl(location);
    if (redirectErr) throw new Error(`Redirect blocked (SSRF): ${redirectErr}`);
    return fetchText(location, headers, _redirectCount + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.text();
}

function stripHtml(html: string): string {
  // Remove script/style blocks entirely
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function parseDdgResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // Match result blocks - DDG HTML uses class="result" with result__a and result__snippet
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(resultRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const link = links[i];
    const snippet = snippets[i];
    results.push({
      title: stripHtml(link[2]),
      url: link[1],
      snippet: snippet ? stripHtml(snippet[1]) : '',
    });
  }

  return results;
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/));
  const wordsB = new Set(b.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

interface NewsArticle {
  title: string;
  url: string;
  description: string;
  publishedAt: string;
  source?: string;
}

function deduplicateNews(articles: NewsArticle[]): NewsArticle[] {
  const deduped: NewsArticle[] = [];
  for (const article of articles) {
    const isDuplicate = deduped.some(existing => titleSimilarity(existing.title, article.title) > 0.6);
    if (!isDuplicate) deduped.push(article);
  }
  return deduped;
}

export function registerWebTools(registry: ToolRegistry): void {
  registry.registerTool(
    'web_search',
    'Search the web using DuckDuckGo. Returns titles, URLs, and snippets.',
    z.object({
      query: z.string().describe('The search query'),
      max_results: z.number().default(5).describe('Maximum number of results to return (1-20)'),
      time_filter: z.string().default('').describe("Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)"),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, time_filter, __test_url } = args;
      const params = new URLSearchParams({ q: query });
      if (time_filter) params.set('df', time_filter);
      const url = __test_url || `https://html.duckduckgo.com/html/?${params.toString()}`;
      const html = await fetchText(url);
      const results = parseDdgResults(html, max_results);
      if (results.length === 0) return `No results found for: ${query}`;
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'search_news',
    'Search for recent news articles. Queries multiple sources and deduplicates results.',
    z.object({
      query: z.string().describe('News search query'),
      max_results: z.number().default(20).describe('Max results per source (1-50)'),
      time_filter: z.string().default('').describe("Time filter: 'd' = past day, 'w' = past week, 'm' = past month"),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, __test_url } = args;
      const allArticles: NewsArticle[] = [];

      if (__test_url) {
        // Test mode: fetch from two endpoints to simulate multiple sources
        try {
          const gnewsRes = await fetchText(`${__test_url}/gnews?q=${encodeURIComponent(query)}`);
          const gnewsData = JSON.parse(gnewsRes);
          if (gnewsData.articles) {
            allArticles.push(...gnewsData.articles.map((a: any) => ({
              title: a.title, url: a.url, description: a.description,
              publishedAt: a.publishedAt, source: 'gnews',
            })));
          }
        } catch {}
        try {
          const ddgRes = await fetchText(`${__test_url}/ddg?q=${encodeURIComponent(query)}`);
          const ddgData = JSON.parse(ddgRes);
          if (ddgData.articles) {
            allArticles.push(...ddgData.articles.map((a: any) => ({
              title: a.title, url: a.url, description: a.description,
              publishedAt: a.publishedAt, source: 'ddg',
            })));
          }
        } catch {}
      } else {
        // Production: query GNews and DDG News
        const gnewsKey = process.env.GNEWS_API_KEY;
        if (gnewsKey) {
          try {
            const gnewsUrl = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=${max_results}&apikey=${gnewsKey}&lang=en`;
            const data = JSON.parse(await fetchText(gnewsUrl));
            if (data.articles) {
              allArticles.push(...data.articles.map((a: any) => ({
                title: a.title, url: a.url, description: a.description,
                publishedAt: a.publishedAt, source: 'GNews',
              })));
            }
          } catch {}
        }
        // DDG News fallback (HTML scraping)
        try {
          const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&iar=news`;
          const html = await fetchText(ddgUrl);
          const results = parseDdgResults(html, max_results);
          allArticles.push(...results.map(r => ({
            title: r.title, url: r.url, description: r.snippet,
            publishedAt: '', source: 'DDG News',
          })));
        } catch {}
      }

      const deduped = deduplicateNews(allArticles);
      if (deduped.length === 0) return `No news found for: ${query}`;
      return deduped.slice(0, max_results).map((a, i) =>
        `${i + 1}. ${a.title}\n   ${a.url}\n   ${a.description}${a.publishedAt ? `\n   Published: ${a.publishedAt}` : ''}`
      ).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'browse_web',
    'Read a web page URL. Returns page content as text. Do NOT speculate about robots.txt or scraping restrictions — just report what the tool returns.',
    z.object({
      url: z.string().describe('The URL to browse'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const target = args.__test_url || args.url;
      if (!args.__test_url) {
        const urlErr = validateUrl(target);
        if (urlErr) return urlErr;
      }
      // Try lynx first (handles JS-blocked sites, cookies, redirects)
      const lynx = lynxDump(target);
      let text = lynx.text;
      if (!text) {
        // Fallback to fetch if lynx unavailable or fails
        try {
          let html = await fetchText(target);
          html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
          html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
          html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
          html = html.replace(/<!--[\s\S]*?-->/g, '');
          text = html;
        } catch {
          // Both lynx and fetch failed — report what we know
          return lynx.error || `Could not load ${target}. The page may require authentication or is unavailable.`;
        }
      }
      const MAX_CHARS = 400_000;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + '\n\n[Truncated]';
      }
      return text || lynx.error || `Could not load ${target}. The page may require authentication or is unavailable.`;
    },
    'always',
  );

  registry.registerTool(
    'scrape_page',
    'Fetch raw HTML of a web page. Returns the HTML source truncated to max_length.',
    z.object({
      url: z.string().describe('The URL to scrape'),
      max_length: z.number().default(4000).describe('Maximum characters to return (1-8000)'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const target = args.__test_url || args.url;
      // SECURITY: SSRF protection — block internal/private URLs (skip for test URLs)
      if (!args.__test_url) {
        const urlErr = validateUrl(target);
        if (urlErr) return urlErr;
      }
      const html = await fetchText(target);
      if (html.length > args.max_length) {
        return html.slice(0, args.max_length) + '\n\n[Truncated]';
      }
      return html;
    },
    'always',
  );
}
