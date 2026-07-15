import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPrivateUrl } from './ssrf.js';
import type { ToolRegistry } from './registry.js';
import { getSecret } from '../secrets.js';

const execFileAsync = promisify(execFile);

// Many sites reject lynx's default User-Agent (e.g. Reddit serves an empty
// page). Spoof a mainstream desktop browser so pages render normally. lynx
// prints a "does not contain Lynx" warning to stderr, which we ignore.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// SECURITY: Block requests to internal/private network addresses (SSRF protection)
export function validateUrl(url: string): string | null {
  return isPrivateUrl(url);
}

// New Reddit is JS-heavy and blocks simple clients; old.reddit.com renders as
// static HTML that lynx/fetch can read. Rewrite reddit hosts to old.reddit.com.
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/^(www\.|new\.|np\.|amp\.)?reddit\.com$/i.test(u.hostname)) {
      u.hostname = 'old.reddit.com';
      return u.toString();
    }
  } catch { /* not a parseable URL — leave unchanged */ }
  return url;
}

// Runs lynx asynchronously (execFile, not execSync) so it never blocks the
// event loop while a page loads — lynx's timeout can be up to 30s.
async function lynxDump(url: string): Promise<{ text: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'lynx',
      ['-dump', '-nolist', '-nonumbers', '-width=120', '-accept_all_cookies', `-useragent=${BROWSER_UA}`, url],
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { text: stdout.trim() };
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
    signal: AbortSignal.timeout(15_000),
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
    let url = link[1];
    // Extract real URL from DDG redirect links
    try {
      const uddg = new URL(url, 'https://duckduckgo.com').searchParams.get('uddg');
      if (uddg) url = uddg;
    } catch { /* keep original */ }
    results.push({
      title: stripHtml(link[2]),
      url,
      snippet: snippet ? stripHtml(snippet[1]) : '',
    });
  }

  return results;
}

interface SearchResult { title: string; url: string; snippet: string }

// Parse ddgr's `--json` output into the common result shape. ddgr emits an
// array of { title, url, abstract }.
function parseDdgrJson(json: string, maxResults: number): SearchResult[] {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, maxResults).map((r: any) => ({
    title: (r.title || '').trim(),
    url: (r.url || '').trim(),
    snippet: (r.abstract || '').trim(),
  })).filter(r => r.url);
}

// DuckDuckGo's plain HTML endpoint returns thin results; ddgr scrapes the
// richer results page and returns clean JSON. Falls back to HTML scraping upstream.
async function ddgrSearch(query: string, maxResults: number, timeFilter: string): Promise<SearchResult[]> {
  const n = Math.min(Math.max(maxResults, 1), 25); // ddgr caps at 25 per page
  const args = ['--json', '--np', '-n', String(n)];
  if (timeFilter && ['d', 'w', 'm', 'y'].includes(timeFilter)) args.push('-t', timeFilter);
  args.push(query);
  const { stdout } = await execFileAsync('ddgr', args, {
    encoding: 'utf-8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseDdgrJson(stdout, maxResults);
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
  // In-memory page cache for browse_web pagination (URL → full text)
  const pageCache = new Map<string, { text: string; ts: number }>();
  const PAGE_CACHE_TTL = 5 * 60_000; // 5 minutes
  const PAGE_CHUNK_SIZE = 10_000; // chars per page

  function getCachedOrNull(url: string): string | null {
    const entry = pageCache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.ts > PAGE_CACHE_TTL) { pageCache.delete(url); return null; }
    return entry.text;
  }

  registry.registerTool(
    'web_search',
    'Search the web using DuckDuckGo (via ddgr). Returns titles, URLs, and snippets.',
    z.object({
      query: z.string().describe('The search query'),
      max_results: z.number().default(5).describe('Maximum number of results to return (1-25)'),
      time_filter: z.string().default('').describe("Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)"),
      __test_json: z.string().optional(),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const { query, max_results, time_filter, __test_json, __test_url } = args;
      try {
        let results: SearchResult[];
        if (__test_json !== undefined) {
          // Test seam: parse canned ddgr JSON instead of spawning ddgr.
          results = parseDdgrJson(__test_json, max_results);
        } else {
          try {
            results = await ddgrSearch(query, max_results, time_filter);
          } catch {
            // Fallback: ddgr missing/failed — scrape DuckDuckGo's HTML endpoint.
            const params = new URLSearchParams({ q: query });
            if (time_filter) params.set('df', time_filter);
            const url = __test_url || `https://html.duckduckgo.com/html/?${params.toString()}`;
            const html = await fetchText(url);
            results = parseDdgResults(html, max_results);
          }
        }
        if (results.length === 0) return `No results found for: ${query}`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
      } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.message?.includes('abort')) {
          return `Search timed out for: ${query}. You can try again.`;
        }
        return `Search failed: ${e?.message || e}`;
      }
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
        const gnewsKey = getSecret('GNEWS_API_KEY');
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
    'Read a web page URL. Returns page content as text (paginated). Use start_index to continue reading if the result says "[Page truncated]". Do NOT speculate about robots.txt or scraping restrictions — just report what the tool returns.',
    z.object({
      url: z.string().describe('The URL to browse'),
      start_index: z.number().default(0).describe('Character offset to start reading from (for pagination). Use the value from [Page truncated] to continue.'),
      __test_url: z.string().optional(),
    }),
    async (args) => {
      const target = args.__test_url || normalizeUrl(args.url);
      const startIndex = args.start_index || 0;

      if (!args.__test_url) {
        const urlErr = validateUrl(target);
        if (urlErr) return urlErr;
      }

      // Check cache first (for pagination continuations)
      let fullText = getCachedOrNull(target);

      if (fullText === null) {
        // Try lynx first (handles JS-blocked sites, cookies, redirects)
        const lynx = await lynxDump(target);
        fullText = lynx.text;
        if (!fullText) {
          // Fallback to fetch if lynx unavailable or fails
          try {
            let html = await fetchText(target);
            html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
            html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
            html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
            html = html.replace(/<!--[\s\S]*?-->/g, '');
            fullText = html;
          } catch {
            return lynx.error || `Could not load ${target}. The page may require authentication or is unavailable.`;
          }
        }
        if (!fullText) {
          return lynx.error || `Could not load ${target}. The page may require authentication or is unavailable.`;
        }
        // Cache the full text for pagination
        pageCache.set(target, { text: fullText, ts: Date.now() });
      }

      const totalLength = fullText.length;

      if (startIndex >= totalLength) {
        return `[End of page — no more content after index ${startIndex}. Total length: ${totalLength}]`;
      }

      const chunk = fullText.slice(startIndex, startIndex + PAGE_CHUNK_SIZE);
      const endIndex = startIndex + chunk.length;

      if (endIndex < totalLength) {
        const remaining = totalLength - endIndex;
        return chunk + `\n\n[Page truncated. Showing ${startIndex}-${endIndex} of ${totalLength} chars. Call browse_web with start_index=${endIndex} to continue reading (${remaining} chars remaining).]`;
      }

      return chunk;
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
      const target = args.__test_url || normalizeUrl(args.url);
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
