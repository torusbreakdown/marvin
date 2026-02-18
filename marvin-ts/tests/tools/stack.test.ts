import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerStackTools } from '../../src/tools/stack.js';
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

describe('Stack Tools', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerStackTools(registry);
  });

  describe('registration', () => {
    it('registers stack_search and stack_answers', () => {
      expect(registry.get('stack_search')).toBeDefined();
      expect(registry.get('stack_answers')).toBeDefined();
    });
  });

  describe('stack_search', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns question titles, scores, answer counts, and tags', async () => {
      const responseData = JSON.stringify({
        items: [
          {
            question_id: 111,
            title: 'How to parse JSON in TypeScript?',
            score: 42,
            answer_count: 5,
            tags: ['typescript', 'json'],
            link: 'https://stackoverflow.com/q/111',
            is_answered: true,
          },
          {
            question_id: 222,
            title: 'TypeScript generics explained',
            score: 28,
            answer_count: 3,
            tags: ['typescript', 'generics'],
            link: 'https://stackoverflow.com/q/222',
            is_answered: true,
          },
        ],
      });

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        // Stack Exchange API returns gzip-compressed JSON
        zlib.gzip(responseData, (err, compressed) => {
          if (err) { res.writeHead(500); res.end(); return; }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          });
          res.end(compressed);
        });
      }));

      const result = await registry.executeTool(
        'stack_search',
        { query: 'typescript json', __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('How to parse JSON');
      expect(result).toContain('42');
      expect(result).toContain('111');
      expect(result).toContain('typescript');
    });
  });

  describe('stack_answers', () => {
    let server: http.Server;
    let baseUrl: string;

    afterEach(() => { if (server) server.close(); });

    it('returns answer body and score', async () => {
      const responseData = JSON.stringify({
        items: [
          {
            answer_id: 999,
            score: 55,
            is_accepted: true,
            body: '<p>You can use <code>JSON.parse()</code> to parse JSON strings.</p>',
          },
          {
            answer_id: 998,
            score: 12,
            is_accepted: false,
            body: '<p>Another approach is to use a library.</p>',
          },
        ],
      });

      ({ server, baseUrl } = await createTestServer((_req, res) => {
        zlib.gzip(responseData, (err, compressed) => {
          if (err) { res.writeHead(500); res.end(); return; }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          });
          res.end(compressed);
        });
      }));

      const result = await registry.executeTool(
        'stack_answers',
        { question_id: 111, __test_url: baseUrl },
        makeCtx(),
      );

      expect(result).toContain('JSON.parse()');
      expect(result).toContain('55');
      expect(result).toContain('accepted');
    });
  });
});
