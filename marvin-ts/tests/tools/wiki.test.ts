import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerWikiTools } from '../../src/tools/wiki.js';
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

describe('Wiki Tools', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerWikiTools(registry);
  });

  describe('registration', () => {
    it('registers wiki_search, wiki_summary, wiki_full, wiki_grep', () => {
      expect(registry.get('wiki_search')).toBeDefined();
      expect(registry.get('wiki_summary')).toBeDefined();
      expect(registry.get('wiki_full')).toBeDefined();
      expect(registry.get('wiki_grep')).toBeDefined();
    });
  });

  describe('wiki_search', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns article titles and snippets', async () => {
      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query: {
            search: [
              { title: 'TypeScript', snippet: 'TypeScript is a programming language', pageid: 123 },
              { title: 'JavaScript', snippet: 'JavaScript is a scripting language', pageid: 456 },
            ],
          },
        }));
      }));

      const result = await registry.executeTool(
        'wiki_search',
        { query: 'typescript', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('TypeScript');
      expect(result).toContain('JavaScript');
      expect(result).toContain('programming language');
    });
  });

  describe('wiki_summary', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns article intro', async () => {
      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query: {
            pages: {
              '123': {
                title: 'TypeScript',
                extract: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
              },
            },
          },
        }));
      }));

      const result = await registry.executeTool(
        'wiki_summary',
        { title: 'TypeScript', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('TypeScript');
      expect(result).toContain('strongly typed');
    });
  });

  describe('wiki_full', () => {
    let server: http.Server;
    let baseUrl: string;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));
    });

    afterEach(() => {
      if (server) server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves full article to disk and returns confirmation', async () => {
      const fullText = 'TypeScript is a programming language developed by Microsoft. '.repeat(50);
      ({ server, baseUrl } = await createTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          query: {
            pages: {
              '123': {
                title: 'TypeScript',
                extract: fullText,
              },
            },
          },
        }));
      }));

      const ctx = makeCtx({ profileDir: tmpDir });
      const result = await registry.executeTool(
        'wiki_full',
        { title: 'TypeScript', __test_url: baseUrl },
        ctx,
      );

      expect(result).toContain('TypeScript');
      expect(result).toContain('saved');
      // File should exist on disk
      const wikiDir = path.join(tmpDir, 'wiki');
      const files = fs.readdirSync(wikiDir);
      expect(files.length).toBeGreaterThan(0);
      const content = fs.readFileSync(path.join(wikiDir, files[0]), 'utf-8');
      expect(content).toContain('TypeScript');
    });
  });

  describe('wiki_grep', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-grep-test-'));
      const wikiDir = path.join(tmpDir, 'wiki');
      fs.mkdirSync(wikiDir, { recursive: true });
      fs.writeFileSync(
        path.join(wikiDir, 'TypeScript.txt'),
        'Line 1: TypeScript is a language.\nLine 2: It was developed by Microsoft.\nLine 3: Anders Hejlsberg led the development.\nLine 4: It compiles to JavaScript.\n',
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('searches within saved article', async () => {
      const ctx = makeCtx({ profileDir: tmpDir });
      const result = await registry.executeTool(
        'wiki_grep',
        { title: 'TypeScript', pattern: 'Microsoft' },
        ctx,
      );

      expect(result).toContain('Microsoft');
      expect(result).toContain('Line 2');
    });

    it('returns error for article not yet fetched', async () => {
      const ctx = makeCtx({ profileDir: tmpDir });
      const result = await registry.executeTool(
        'wiki_grep',
        { title: 'Nonexistent Article', pattern: 'test' },
        ctx,
      );

      expect(result).toContain('Error');
      expect(result).toContain('wiki_full');
    });
  });
});
