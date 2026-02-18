import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerAcademicTools } from '../../src/tools/academic.js';
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

function createTestServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('Academic Tools', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerAcademicTools(registry);
  });

  describe('registration', () => {
    it('registers search_papers and search_arxiv', () => {
      expect(registry.get('search_papers')).toBeDefined();
      expect(registry.get('search_arxiv')).toBeDefined();
    });
  });

  describe('search_papers', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns titles, authors, year, citations', async () => {
      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            {
              title: 'Attention Is All You Need',
              authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
              year: 2017,
              citationCount: 90000,
              abstract: 'We propose a new architecture...',
              url: 'https://semanticscholar.org/paper/123',
              openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762' },
            },
            {
              title: 'BERT: Pre-training',
              authors: [{ name: 'Jacob Devlin' }],
              year: 2019,
              citationCount: 50000,
              abstract: 'We introduce BERT...',
              url: 'https://semanticscholar.org/paper/456',
              openAccessPdf: null,
            },
          ],
        }));
      }));

      const result = await registry.executeTool(
        'search_papers',
        { query: 'transformer', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('Attention Is All You Need');
      expect(result).toContain('Vaswani');
      expect(result).toContain('2017');
      expect(result).toContain('90000');
      expect(result).toContain('BERT');
      expect(result).toContain('Devlin');
    });
  });

  describe('search_arxiv', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns titles, authors, abstract, PDF links', async () => {
      const atomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <title>Deep Residual Learning</title>
    <author><name>Kaiming He</name></author>
    <author><name>Xiangyu Zhang</name></author>
    <summary>We present a residual learning framework...</summary>
    <link href="http://arxiv.org/abs/1512.03385v1" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/1512.03385v1" rel="related" type="application/pdf" title="pdf"/>
    <published>2015-12-10T00:00:00Z</published>
  </entry>
  <entry>
    <title>Generative Adversarial Networks</title>
    <author><name>Ian Goodfellow</name></author>
    <summary>We propose a new framework for estimating generative models...</summary>
    <link href="http://arxiv.org/abs/1406.2661v1" rel="alternate" type="text/html"/>
    <link href="http://arxiv.org/pdf/1406.2661v1" rel="related" type="application/pdf" title="pdf"/>
    <published>2014-06-10T00:00:00Z</published>
  </entry>
</feed>`;

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
        res.end(atomFeed);
      }));

      const result = await registry.executeTool(
        'search_arxiv',
        { query: 'deep learning', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('Deep Residual Learning');
      expect(result).toContain('Kaiming He');
      expect(result).toContain('residual learning');
      expect(result).toContain('pdf');
      expect(result).toContain('Generative Adversarial');
      expect(result).toContain('Goodfellow');
    });
  });
});
