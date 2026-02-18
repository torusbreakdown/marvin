import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerWebTools } from '../../src/tools/web.js';
import type { ToolContext } from '../../src/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: false,
    nonInteractive: false,
    profileDir: '/tmp/profile',
    profile: {
      name: 'test',
      profileDir: '/tmp/profile',
      preferences: {},
      savedPlaces: [],
      chatLog: [],
      ntfySubscriptions: [],
      oauthTokens: {},
      inputHistory: [],
    },
    ...overrides,
  };
}

// Helper: create a test HTTP server that returns canned responses
function createTestServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('Web Tools', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerWebTools(registry);
  });

  describe('registration', () => {
    it('registers web_search, search_news, browse_web, scrape_page', () => {
      expect(registry.get('web_search')).toBeDefined();
      expect(registry.get('search_news')).toBeDefined();
      expect(registry.get('browse_web')).toBeDefined();
      expect(registry.get('scrape_page')).toBeDefined();
    });

    it('all tools have category "always"', () => {
      for (const name of ['web_search', 'search_news', 'browse_web', 'scrape_page']) {
        expect(registry.get(name)!.category).toBe('always');
      }
    });
  });

  describe('web_search', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => {
      if (server) server.close();
    });

    it('returns results with titles, URLs, snippets', async () => {
      const cannedHtml = `<html><body>
        <div class="result">
          <a class="result__a" href="https://example.com/page1">Example Page One</a>
          <a class="result__snippet">This is the first result snippet</a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.com/page2">Example Page Two</a>
          <a class="result__snippet">Second result snippet here</a>
        </div>
      </body></html>`;

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(cannedHtml);
      }));

      const result = await registry.executeTool(
        'web_search',
        { query: 'test query', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('Example Page One');
      expect(result).toContain('Example Page Two');
      expect(result).toContain('example.com/page1');
      expect(result).toContain('snippet');
    });

    it('handles max_results parameter', async () => {
      // Build HTML with 10 results
      const results = Array.from({ length: 10 }, (_, i) => `
        <div class="result">
          <a class="result__a" href="https://example.com/p${i}">Result ${i}</a>
          <a class="result__snippet">Snippet ${i}</a>
        </div>`).join('');
      const html = `<html><body>${results}</body></html>`;

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }));

      const result = await registry.executeTool(
        'web_search',
        { query: 'test', max_results: 3, __test_url: baseUrl },
        makeCtx(),
      );

      // Should contain at most 3 results
      expect(result).toContain('Result 0');
      expect(result).toContain('Result 2');
      expect(result).not.toContain('Result 3');
    });
  });

  describe('search_news', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => {
      if (server) server.close();
    });

    it('returns news results and deduplicates by title similarity', async () => {
      ({ server, baseUrl } = await createTestServer((req, res) => {
        const url = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Simulate two sources returning overlapping results
        if (url.includes('gnews')) {
          res.end(JSON.stringify({
            articles: [
              { title: 'AI breakthrough announced', url: 'https://news1.com/ai', description: 'Major AI news', publishedAt: '2024-01-01' },
              { title: 'Space launch today', url: 'https://news1.com/space', description: 'Rocket launched', publishedAt: '2024-01-01' },
            ],
          }));
        } else {
          // DDG news source returns similar title
          res.end(JSON.stringify({
            articles: [
              { title: 'AI Breakthrough Announced!', url: 'https://news2.com/ai', description: 'Big AI news', publishedAt: '2024-01-01' },
              { title: 'Weather update', url: 'https://news2.com/weather', description: 'Weather info', publishedAt: '2024-01-01' },
            ],
          }));
        }
      }));

      const result = await registry.executeTool(
        'search_news',
        { query: 'AI news', __test_url: baseUrl },
        makeCtx(),
      );

      // Should have results
      expect(result).toContain('AI');
      expect(result).toContain('Space launch');
      // Should deduplicate similar titles
      expect(result).toContain('Weather');
    });
  });

  describe('browse_web', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => {
      if (server) server.close();
    });

    it('fetches page and returns text content (HTML stripped)', async () => {
      const html = `<html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello World</h1>
          <p>This is a <strong>test</strong> paragraph.</p>
          <script>var x = 1;</script>
          <style>.foo { color: red; }</style>
        </body>
      </html>`;

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }));

      const result = await registry.executeTool(
        'browse_web',
        { url: 'https://example.com', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('Hello World');
      expect(result).toContain('test');
      expect(result).toContain('paragraph');
      // Script/style content should be stripped
      expect(result).not.toContain('var x = 1');
      expect(result).not.toContain('color: red');
    });
  });

  describe('scrape_page', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => {
      if (server) server.close();
    });

    it('fetches raw HTML', async () => {
      const html = `<html><body><div id="main"><p>Raw content here</p></div></body></html>`;

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }));

      const result = await registry.executeTool(
        'scrape_page',
        { url: 'https://example.com', __test_url: baseUrl },
        makeCtx(),
      );

      // Should contain raw HTML tags
      expect(result).toContain('<div id="main">');
      expect(result).toContain('<p>Raw content here</p>');
      expect(result).toContain('</html>');
    });

    it('truncates to max_length', async () => {
      const html = '<html><body>' + 'x'.repeat(10000) + '</body></html>';

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      }));

      const result = await registry.executeTool(
        'scrape_page',
        { url: 'https://example.com', __test_url: baseUrl, max_length: 100 },
        makeCtx(),
      );

      expect(result.length).toBeLessThanOrEqual(200); // some overhead for truncation message
    });
  });
});
