/**
 * Web Search and Scraping Tools
 * web_search, browse_web, search_news, search_papers, search_arxiv
 */

import { z } from 'zod';
import { defineTool } from './base.js';
import { logger } from '../utils/logger.js';

export const webSearchTool = defineTool({
  name: 'web_search',
  description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. THIS IS THE DEFAULT TOOL FOR ALL WEB SEARCHES. Use this FIRST whenever the user asks to look something up, find information, search for anything online, check reviews, hours, menus, news, events, etc. Only use browse_web or scrape_page if you already have a specific URL and need to read the full page content.",
  parameters: z.object({
    query: z.string().describe('The search query'),
    max_results: z.number().default(5).describe('Maximum number of results to return (1-20)'),
    time_filter: z.string().default('').describe("Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)"),
  }),
  readonly: true,
  
  async execute({ query, max_results, time_filter }) {
    try {
      // Use DuckDuckGo HTML search
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      
      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }
      
      const html = await response.text();
      
      // Simple HTML parsing for results
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < max_results) {
        const [, href, title, snippet] = match;
        // Clean up HTML entities
        const cleanTitle = title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        const cleanSnippet = snippet.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        
        results.push({
          title: cleanTitle,
          url: href,
          snippet: cleanSnippet,
        });
      }
      
      if (results.length === 0) {
        return `No results found for: ${query}`;
      }
      
      const lines = results.map((r, i) => 
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      );
      
      return lines.join('\n\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const searchNewsTool = defineTool({
  name: 'search_news',
  description: "Search for recent news articles on ANY topic. Queries GNews, NewsAPI, and DuckDuckGo News simultaneously, deduplicates, and returns ALL articles from the last 2 days. Use this whenever the user asks about news, current events, headlines, what's happening, recent developments, or wants to know what's new in a field (e.g. 'indie game news', 'AI news', 'tech news'). IMPORTANT: Return ALL articles from the results to the user — do not summarize or omit any. The user wants an exhaustive list.",
  parameters: z.object({
    query: z.string().describe("News search query, e.g. 'AI regulation' or 'SpaceX launch'"),
    max_results: z.number().default(20).describe('Max results per source (1-50)'),
    time_filter: z.string().default('').describe("Time filter: 'd' = past day, 'w' = past week, 'm' = past month. Empty = any time."),
  }),
  readonly: true,
  
  async execute({ query, max_results }) {
    try {
      // Use GNews API if key available, otherwise fallback to web search
      const apiKey = process.env.GNEWS_API_KEY;
      
      if (apiKey) {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://gnews.io/api/v4/search?q=${encodedQuery}&max=${max_results}&apikey=${apiKey}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.articles && data.articles.length > 0) {
          const lines = data.articles.map((a: any, i: number) => 
            `${i + 1}. ${a.title}\n   ${a.url}\n   ${a.description || 'No description'}`
          );
          return lines.join('\n\n');
        }
      }
      
      // Fallback to web search
      return webSearchTool.execute({ query: `${query} news`, max_results, time_filter: 'd' });
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const searchPapersTool = defineTool({
  name: 'search_papers',
  description: "Search for academic papers using Semantic Scholar. Returns titles, authors, year, citation count, abstract, and PDF links when available. Use this for general academic/scientific paper searches. Free, no API key.",
  parameters: z.object({
    query: z.string().describe('Search query for academic papers'),
    max_results: z.number().default(5).describe('Maximum results to return (1-20)'),
    year_min: z.number().default(0).describe('Filter papers from this year onward (0 = no filter)'),
    year_max: z.number().default(0).describe('Filter papers up to this year (0 = no filter)'),
    open_access_only: z.boolean().default(false).describe('Only return papers with free PDF links'),
  }),
  readonly: true,
  
  async execute({ query, max_results, year_min, year_max, open_access_only }) {
    try {
      const encodedQuery = encodeURIComponent(query);
      let url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&limit=${max_results}&fields=title,authors,year,citationCount,abstract,openAccessPdf`;
      
      if (year_min > 0) {
        url += `&year=${year_min}-${year_max || new Date().getFullYear()}`;
      }
      
      const response = await fetch(url);
      const data = await response.json();
      
      const papers = data.data || [];
      
      if (papers.length === 0) {
        return `No papers found for: ${query}`;
      }
      
      const lines: string[] = [];
      
      for (let i = 0; i < papers.length; i++) {
        const p = papers[i];
        if (open_access_only && !p.openAccessPdf) continue;
        
        lines.push(`${i + 1}. ${p.title}`);
        lines.push(`   Authors: ${p.authors?.map((a: any) => a.name).join(', ') || 'Unknown'}`);
        lines.push(`   Year: ${p.year || 'Unknown'} | Citations: ${p.citationCount || 0}`);
        if (p.openAccessPdf) {
          lines.push(`   PDF: ${p.openAccessPdf.url}`);
        }
        if (p.abstract) {
          const shortAbstract = p.abstract.slice(0, 200) + (p.abstract.length > 200 ? '...' : '');
          lines.push(`   Abstract: ${shortAbstract}`);
        }
        lines.push('');
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const searchArxivTool = defineTool({
  name: 'search_arxiv',
  description: "Search arXiv for preprints. Returns titles, authors, abstract, and direct PDF links. Best for recent/cutting-edge research in physics, CS, math, biology, and other sciences. Free, no API key.",
  parameters: z.object({
    query: z.string().describe('Search query for arXiv preprints'),
    max_results: z.number().default(5).describe('Maximum results (1-20)'),
    sort_by: z.string().default('relevance').describe("Sort by: 'relevance', 'lastUpdatedDate', or 'submittedDate'"),
  }),
  readonly: true,
  
  async execute({ query, max_results, sort_by }) {
    try {
      const encodedQuery = encodeURIComponent(query);
      const sortParam = sort_by === 'lastUpdatedDate' ? '-lastUpdatedDate' : 
                        sort_by === 'submittedDate' ? '-submitted' : 'relevance';
      
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${max_results}&sortBy=${sortParam}&sortOrder=descending`;
      
      const response = await fetch(url);
      const xml = await response.text();
      
      // Simple XML parsing for entries
      const entries: Array<{
        title: string;
        authors: string[];
        summary: string;
        id: string;
        pdfUrl: string;
      }> = [];
      
      const entryRegex = /<entry>(.*?)<\/entry>/gs;
      let match;
      
      while ((match = entryRegex.exec(xml)) !== null) {
        const entryXml = match[1];
        
        const titleMatch = entryXml.match(/<title>(.*?)<\/title>/s);
        const summaryMatch = entryXml.match(/<summary>(.*?)<\/summary>/s);
        const idMatch = entryXml.match(/<id>(.*?)<\/id>/);
        
        const authors: string[] = [];
        const authorRegex = /<author>.*?<name>(.*?)<\/name>.*?<\/author>/gs;
        let authorMatch;
        while ((authorMatch = authorRegex.exec(entryXml)) !== null) {
          authors.push(authorMatch[1]);
        }
        
        if (titleMatch) {
          const id = idMatch?.[1] || '';
          const arxivId = id.split('/').pop()?.replace('abs/', '') || '';
          
          entries.push({
            title: titleMatch[1].replace(/\s+/g, ' ').trim(),
            authors,
            summary: summaryMatch?.[1].replace(/\s+/g, ' ').trim() || '',
            id,
            pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
          });
        }
      }
      
      if (entries.length === 0) {
        return `No arXiv papers found for: ${query}`;
      }
      
      const lines: string[] = [];
      
      for (let i = 0; i < entries.length; i++) {
        const p = entries[i];
        lines.push(`${i + 1}. ${p.title}`);
        lines.push(`   Authors: ${p.authors.join(', ') || 'Unknown'}`);
        lines.push(`   PDF: ${p.pdfUrl}`);
        if (p.summary) {
          const shortSummary = p.summary.slice(0, 200) + (p.summary.length > 200 ? '...' : '');
          lines.push(`   ${shortSummary}`);
        }
        lines.push('');
      }
      
      return lines.join('\n');
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

export const browseWebTool = defineTool({
  name: 'browse_web',
  description: "Read a specific web page URL using Lynx (text browser). ONLY use this when you have a specific URL and want to read its full content. Faster than scrape_page but cannot render JavaScript. Do NOT use this for searching — use web_search instead. Good for articles, docs, wiki pages. Rate-limited to 1 request/sec.",
  parameters: z.object({
    url: z.string().describe('The URL to browse'),
    max_length: z.number().default(4000).describe('Maximum characters to return (1-8000)'),
  }),
  readonly: true,
  
  async execute({ url, max_length }) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Marvin/1.0; +https://github.com/)',
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const html = await response.text();
      
      // Simple HTML to text conversion
      let text = html
        .replace(/<script[^>]*>.*?<\/script>/gs, '')
        .replace(/<style[^>]*>.*?<\/style>/gs, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (text.length > max_length) {
        text = text.slice(0, max_length) + '\n\n[Content truncated...]';
      }
      
      return text;
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
