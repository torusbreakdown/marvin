// src/tools/search.ts - Web search, academic, and news tools

import { Tool, ToolContext } from './base.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Web search using DuckDuckGo via ddg CLI
export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Returns titles, URLs, and snippets. THIS IS THE DEFAULT TOOL FOR ALL WEB SEARCHES. Use this FIRST whenever the user asks to look something up, find information, search for anything online, check reviews, hours, menus, news, events, etc. Only use browse_web or scrape_page if you already have a specific URL and need to read the full page content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      max_results: { type: 'integer', default: 5, description: 'Maximum number of results to return (1-20)' },
      time_filter: { type: 'string', default: '', description: "Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)" }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number; time_filter?: string }): Promise<string> {
    const { query, max_results = 5, time_filter = '' } = args;
    
    try {
      // Try using ddgs CLI if available
      const cmd = `ddgs text -k "${query.replace(/"/g, '\\"')}" -n ${max_results}${time_filter ? ' -t ' + time_filter : ''} 2>/dev/null || echo "[]"`;
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
      
      // Parse results
      const lines = result.split('\n').filter(l => l.trim());
      if (lines.length === 0 || lines[0] === '[]') {
        // Fallback: try duckduckgo-search Python package directly
        return await webSearchFallback(query, max_results);
      }
      
      // Format results
      let output = `## Web Search: "${query}"\n\n`;
      lines.forEach((line, i) => {
        try {
          const item = JSON.parse(line);
          output += `${i + 1}. **${item.title || 'No Title'}**\n`;
          output += `   URL: ${item.href || item.url || 'N/A'}\n`;
          output += `   ${item.body || item.snippet || 'No snippet'}\n\n`;
        } catch (e) {
          // Skip malformed lines
        }
      });
      
      return output || 'No results found.';
    } catch (error) {
      return await webSearchFallback(query, max_results);
    }
  }
};

async function webSearchFallback(query: string, max: number): Promise<string> {
  try {
    // Use Python with duckduckgo-search
    const script = `
import json
from duckduckgo_search import DDGS
with DDGS() as ddgs:
    results = list(ddgs.text("${query.replace(/"/g, '\\"')}", max_results=${max}))
    print(json.dumps(results))
`;
    const result = execSync(`python3 -c '${script}'`, { encoding: 'utf-8', timeout: 30000 });
    const items = JSON.parse(result);
    
    let output = `## Web Search: "${query}"\n\n`;
    items.forEach((item: any, i: number) => {
      output += `${i + 1}. **${item.title || 'No Title'}**\n`;
      output += `   URL: ${item.href || item.url || 'N/A'}\n`;
      output += `   ${item.body || item.snippet || 'No snippet'}\n\n`;
    });
    
    return output || 'No results found.';
  } catch (e) {
    return `Web search failed. The ddgs library may not be installed. Try: pip install duckduckgo-search`;
  }
}

// News search
export const searchNewsTool: Tool = {
  name: 'search_news',
  description: "Search for recent news articles on ANY topic. Queries GNews, NewsAPI, and DuckDuckGo News simultaneously, deduplicates, and returns ALL articles from the last 2 days. Use this whenever the user asks about news, current events, headlines, what's happening, recent developments, or wants to know what's new in a field (e.g. 'indie game news', 'AI news', 'tech news'). IMPORTANT: Return ALL articles from the results to the user — do not summarize or omit any. The user wants an exhaustive list.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "News search query, e.g. 'AI regulation' or 'SpaceX launch'" },
      max_results: { type: 'integer', default: 20, description: 'Max results per source (1-50)' },
      time_filter: { type: 'string', default: '', description: "Time filter: 'd' = past day, 'w' = past week, 'm' = past month. Empty = any time." }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number; time_filter?: string }): Promise<string> {
    const { query, max_results = 20, time_filter = '' } = args;
    
    try {
      // Use ddgs news
      const script = `
import json
from duckduckgo_search import DDGS
with DDGS() as ddgs:
    results = list(ddgs.news("${query.replace(/"/g, '\\"')}", max_results=${max_results}))
    print(json.dumps(results))
`;
      const result = execSync(`python3 -c '${script}'`, { encoding: 'utf-8', timeout: 30000 });
      const items = JSON.parse(result);
      
      let output = `## News Search: "${query}"\n\n`;
      items.forEach((item: any, i: number) => {
        output += `${i + 1}. **${item.title || 'No Title'}**\n`;
        output += `   Source: ${item.source || 'Unknown'} | Date: ${item.date || 'Unknown'}\n`;
        output += `   URL: ${item.url || 'N/A'}\n`;
        output += `   ${item.body || item.excerpt || 'No excerpt'}\n\n`;
      });
      
      return output || 'No news results found.';
    } catch (e) {
      return `News search failed. Error: ${e}`;
    }
  }
};

// Academic papers search (Semantic Scholar)
export const searchPapersTool: Tool = {
  name: 'search_papers',
  description: 'Search for academic papers using Semantic Scholar. Returns titles, authors, year, citation count, abstract, and PDF links when available. Use this for general academic/scientific paper searches. Free, no API key.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for academic papers' },
      max_results: { type: 'integer', default: 5, description: 'Maximum results to return (1-20)' },
      year_min: { type: 'integer', default: 0, description: 'Filter papers from this year onward (0 = no filter)' },
      year_max: { type: 'integer', default: 0, description: 'Filter papers up to this year (0 = no filter)' },
      open_access_only: { type: 'boolean', default: false, description: 'Only return papers with free PDF links' }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number; year_min?: number; year_max?: number; open_access_only?: boolean }): Promise<string> {
    const { query, max_results = 5, year_min = 0, year_max = 0, open_access_only = false } = args;
    
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodedQuery}&fields=title,authors,year,citationCount,abstract,openAccessPdf&limit=${max_results}`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      const papers = data.data || [];
      
      let output = `## Academic Papers: "${query}"\n\n`;
      
      for (const paper of papers) {
        // Filter by year if specified
        if (year_min && paper.year < year_min) continue;
        if (year_max && paper.year > year_max) continue;
        if (open_access_only && !paper.openAccessPdf?.url) continue;
        
        output += `**${paper.title || 'Untitled'}**\n`;
        output += `Authors: ${paper.authors?.map((a: any) => a.name).join(', ') || 'Unknown'}\n`;
        output += `Year: ${paper.year || 'Unknown'} | Citations: ${paper.citationCount || 0}\n`;
        if (paper.openAccessPdf?.url) {
          output += `PDF: ${paper.openAccessPdf.url}\n`;
        }
        output += `Abstract: ${paper.abstract || 'No abstract available'}\n\n`;
      }
      
      return output || 'No papers found matching criteria.';
    } catch (error) {
      return `Search failed: ${error}`;
    }
  }
};

// arXiv search
export const searchArxivTool: Tool = {
  name: 'search_arxiv',
  description: "Search arXiv for preprints. Returns titles, authors, abstract, and direct PDF links. Best for recent/cutting-edge research in physics, CS, math, biology, and other sciences. Free, no API key.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for arXiv preprints' },
      max_results: { type: 'integer', default: 5, description: 'Maximum results (1-20)' },
      sort_by: { type: 'string', default: 'relevance', description: "Sort by: 'relevance', 'lastUpdatedDate', or 'submittedDate'" }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number; sort_by?: string }): Promise<string> {
    const { query, max_results = 5, sort_by = 'relevance' } = args;
    
    try {
      const encodedQuery = encodeURIComponent(query);
      const sortMap: Record<string, string> = {
        relevance: 'relevance',
        lastUpdatedDate: 'lastUpdatedDate',
        submittedDate: 'submittedDate'
      };
      const sort = sortMap[sort_by] || 'relevance';
      
      const url = `https://export.arxiv.org/api/query?search_query=all:${encodedQuery}&max_results=${max_results}&sortBy=${sort}&sortOrder=descending`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const xml = await response.text();
      
      // Parse XML response
      const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
      
      let output = `## arXiv Search: "${query}"\n\n`;
      
      for (const entry of entries) {
        const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim() || 'Untitled';
        const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.trim() || 'No abstract';
        const id = (entry.match(/<id>(.*?)<\/id>/) || [])[1] || '';
        const pdfUrl = id.replace('/abs/', '/pdf/');
        const authors = (entry.match(/<author>\s*<name>(.*?)<\/name>\s*<\/author>/g) || [])
          .map(m => m.match(/<name>(.*?)<\/name>/)?.[1] || '')
          .join(', ');
        const published = (entry.match(/<published>(.*?)<\/published>/) || [])[1]?.split('T')[0] || 'Unknown';
        
        output += `**${title}**\n`;
        output += `Authors: ${authors || 'Unknown'} | Published: ${published}\n`;
        output += `PDF: ${pdfUrl}\n`;
        output += `Abstract: ${summary}\n\n`;
      }
      
      return output || 'No arXiv results found.';
    } catch (error) {
      return `arXiv search failed: ${error}`;
    }
  }
};

// Movie search (OMDB fallback)
export const searchMoviesTool: Tool = {
  name: 'search_movies',
  description: "Search for movies and TV shows. Uses OMDB if API key is set, otherwise falls back to DuckDuckGo web search. Use this when users ask about film reviews, movie ratings, or 'is X movie good'.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Movie or TV show title to search for' },
      year: { type: 'string', description: 'Optional year to narrow results' },
      type: { type: 'string', description: "Optional type filter: 'movie', 'series', or 'episode'" }
    },
    required: ['query']
  },
  async execute(args: { query: string; year?: string; type?: string }): Promise<string> {
    const { query, year, type } = args;
    const apiKey = process.env.OMDB_API_KEY;
    
    if (!apiKey) {
      // Fallback to web search
      return webSearchTool.execute!({ query: `${query} movie review`, max_results: 5 });
    }
    
    try {
      let url = `https://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${apiKey}`;
      if (year) url += `&y=${year}`;
      if (type) url += `&type=${type}`;
      
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.Response === 'False') {
        return `No results found: ${data.Error}`;
      }
      
      let output = `## Movie Search: "${query}"\n\n`;
      
      for (const movie of data.Search || []) {
        output += `**${movie.Title}** (${movie.Year})\n`;
        output += `Type: ${movie.Type} | IMDb ID: ${movie.imdbID}\n\n`;
      }
      
      return output;
    } catch (error) {
      return `Search failed: ${error}`;
    }
  }
};

// Game search (RAWG fallback)
export const searchGamesTool: Tool = {
  name: 'search_games',
  description: "Search for video games. Uses RAWG if API key is set, otherwise falls back to DuckDuckGo web search. Use when users ask about game reviews or 'is X game good'.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Game title to search for' },
      max_results: { type: 'integer', default: 5, description: 'Max results (1-10)' }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number }): Promise<string> {
    const { query, max_results = 5 } = args;
    const apiKey = process.env.RAWG_API_KEY;
    
    if (!apiKey) {
      // Fallback to web search
      return webSearchTool.execute!({ query: `${query} game review`, max_results });
    }
    
    try {
      const url = `https://api.rawg.io/api/games?search=${encodeURIComponent(query)}&key=${apiKey}&page_size=${max_results}`;
      
      const response = await fetch(url);
      const data = await response.json();
      
      let output = `## Game Search: "${query}"\n\n`;
      
      for (const game of data.results || []) {
        output += `**${game.name}**\n`;
        output += `Released: ${game.released || 'Unknown'} | Rating: ${game.rating || 'N/A'}/5\n`;
        output += `Platforms: ${game.platforms?.map((p: any) => p.platform.name).join(', ') || 'Unknown'}\n`;
        output += `Game ID: ${game.id}\n\n`;
      }
      
      return output || 'No games found.';
    } catch (error) {
      return `Search failed: ${error}`;
    }
  }
};

// Wikipedia tools
export const wikiSearchTool: Tool = {
  name: 'wiki_search',
  description: 'Search Wikipedia for articles matching a query. Returns titles, snippets, and page IDs. Use wiki_summary or wiki_full to get article content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', default: 5, description: 'Max results (1-10)' }
    },
    required: ['query']
  },
  async execute(args: { query: string; max_results?: number }): Promise<string> {
    const { query, max_results = 5 } = args;
    
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${max_results}&format=json&origin=*`;
      
      const response = await fetch(url);
      const data = await response.json();
      
      let output = `## Wikipedia Search: "${query}"\n\n`;
      
      for (const item of data.query?.search || []) {
        output += `${item.title}\n`;
        output += `   ${item.snippet?.replace(/<[^>]*>/g, '')}\n\n`;
      }
      
      return output || 'No Wikipedia results found.';
    } catch (error) {
      return `Search failed: ${error}`;
    }
  }
};

export const wikiSummaryTool: Tool = {
  name: 'wiki_summary',
  description: 'Get a concise summary of a Wikipedia article (1-3 paragraphs). Good for quick facts. Use wiki_full for complete article content.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Wikipedia article title (from search results)' }
    },
    required: ['title']
  },
  async execute(args: { title: string }): Promise<string> {
    const { title } = args;
    
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      
      let output = `## ${data.title}\n\n`;
      output += `${data.extract}\n\n`;
      output += `Read more: ${data.content_urls?.desktop?.page || ''}`;
      
      return output;
    } catch (error) {
      return `Failed to get summary: ${error}`;
    }
  }
};

// Stack Overflow search
export const stackSearchTool: Tool = {
  name: 'stack_search',
  description: "Search Stack Exchange (Stack Overflow, Server Fault, Ask Ubuntu, Unix & Linux, etc.) for questions. Returns titles, scores, answer counts, and tags. Use stack_answers to get the actual answers for a question.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      site: { type: 'string', default: 'stackoverflow', description: "Stack Exchange site: stackoverflow, serverfault, superuser, askubuntu, unix, math, physics, gaming" },
      tagged: { type: 'string', description: "Filter by tags, semicolon-separated (e.g. 'python;asyncio')" },
      sort: { type: 'string', default: 'relevance', description: "Sort by: relevance, votes, creation, activity" },
      max_results: { type: 'integer', default: 5, description: 'Max results (1-10)' }
    },
    required: ['query']
  },
  async execute(args: { query: string; site?: string; tagged?: string; sort?: string; max_results?: number }): Promise<string> {
    const { query, site = 'stackoverflow', tagged, sort = 'relevance', max_results = 5 } = args;
    
    try {
      const sortMap: Record<string, string> = {
        relevance: '',
        votes: 'votes',
        creation: 'creation',
        activity: 'activity'
      };
      
      let url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=${sortMap[sort] || 'relevance'}&q=${encodeURIComponent(query)}&site=${site}&pagesize=${max_results}`;
      if (tagged) url += `&tagged=${tagged}`;
      
      const response = await fetch(url);
      const data = await response.json();
      
      let output = `## Stack Search: "${query}" (${site})\n\n`;
      
      for (const item of data.items || []) {
        output += `**${item.title}**\n`;
        output += `   Score: ${item.score} | Answers: ${item.answer_count} | Views: ${item.view_count}\n`;
        output += `   Tags: ${item.tags?.join(', ')}\n`;
        output += `   Question ID: ${item.question_id}\n\n`;
      }
      
      return output || 'No results found.';
    } catch (error) {
      return `Search failed: ${error}`;
    }
  }
};

// Browse web with lynx
export const browseWebTool: Tool = {
  name: 'browse_web',
  description: 'Read a specific web page URL using Lynx (text browser). ONLY use this when you have a specific URL and want to read its full content. Faster than scrape_page but cannot render JavaScript. Do NOT use this for searching — use web_search instead. Good for articles, docs, wiki pages. Rate-limited to 1 request/sec.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to browse' },
      max_length: { type: 'integer', default: 4000, description: 'Maximum characters to return (1-8000)' }
    },
    required: ['url']
  },
  async execute(args: { url: string; max_length?: number }): Promise<string> {
    const { url, max_length = 4000 } = args;
    
    try {
      // Check if lynx is available
      execSync('which lynx');
      
      const result = execSync(`lynx -dump -nolist "${url}" 2>/dev/null | head -c ${max_length}`, {
        encoding: 'utf-8',
        timeout: 30000
      });
      
      return result || 'No content retrieved.';
    } catch (error) {
      return `Browsing failed. Lynx may not be installed. Try: sudo apt install lynx\nError: ${error}`;
    }
  }
};

// Scrape page with Selenium
export const scrapePageTool: Tool = {
  name: 'scrape_page',
  description: 'Scrape a specific web page URL using Selenium + Firefox (headless). ONLY use this when you have a specific URL AND the page requires JavaScript to render. Do NOT use this for searching — use web_search instead. Slow (launches browser). Rate-limited to 1 request per 3 seconds.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to scrape' },
      extract: { type: 'string', default: 'text', description: "What to extract: 'text' for full visible text, 'menu' to try extracting menu items/prices, 'links' for all links on the page" },
      css_selector: { type: 'string', default: '', description: "Optional CSS selector to narrow extraction to a specific part of the page (e.g. '#menu', '.menu-items', 'main')" },
      max_length: { type: 'integer', default: 4000, description: 'Maximum characters to return (1-8000)' }
    },
    required: ['url']
  },
  async execute(args: { url: string; extract?: string; css_selector?: string; max_length?: number }): Promise<string> {
    return `Page scraping requires Selenium/Python. Use lynx (browse_web) for simple text extraction, or implement Python Selenium bridge.`;
  }
};
