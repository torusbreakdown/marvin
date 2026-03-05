import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { OpenAICompatProvider } from '../../src/llm/openai.js';
import type { ProviderConfig, Message } from '../../src/types.js';

function createMockServer(): {
  server: Server;
  port: () => number;
  setHandler: (fn: (req: IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> }) => void;
  lastRequest: () => { method: string; url: string; headers: Record<string, string>; body: string } | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let handler: (req: IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> } = () => ({ status: 200, body: '' });
  let last: { method: string; url: string; headers: Record<string, string>; body: string } | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf-8');
      last = {
        method: req.method!,
        url: req.url!,
        headers: req.headers as Record<string, string>,
        body: bodyStr,
      };
      const result = handler(req, bodyStr);
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
      res.end(result.body);
    });
  });

  return {
    server,
    port: () => (server.address() as any).port as number,
    setHandler: (fn) => { handler = fn; },
    lastRequest: () => last,
    start: () => new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); }),
    stop: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

describe('OpenAICompatProvider (Responses API)', () => {
  const mock = createMockServer();
  let openaiConfig: ProviderConfig;

  beforeAll(async () => {
    await mock.start();
    openaiConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'test-key-123',
      baseUrl: `http://127.0.0.1:${mock.port()}`,
      timeoutMs: 300_000,
      maxToolRounds: 10,
    };
  });

  afterAll(async () => {
    await mock.stop();
  });

  it('uses /responses and injects reasoning.effort:xhigh (even with tools)', async () => {
    mock.setHandler(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }));

    const provider = new OpenAICompatProvider(openaiConfig);
    const tools = [{
      type: 'function' as const,
      function: { name: 'test', description: 'test', parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
    }];
    await provider.chat([{ role: 'user', content: 'test' }], { stream: false, tools });

    const req = mock.lastRequest()!;
    expect(req.url).toBe('/responses');
    const body = JSON.parse(req.body);
    expect(body.reasoning?.effort).toBe('xhigh');
    expect(body.tools).toBeDefined();
    expect(body.tools[0].name).toBe('test');
    expect(body.tools[0].type).toBe('function');
  });

  it('continues tool calls via previous_response_id + function_call_output input', async () => {
    let call = 0;
    mock.setHandler((_req, bodyStr) => {
      call++;
      const body = JSON.parse(bodyStr);
      if (call === 1) {
        expect(body.input).toEqual([{ role: 'user', content: 'hi' }]);
        return {
          status: 200,
          body: JSON.stringify({
            id: 'resp_1',
            output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        };
      }

      expect(body.previous_response_id).toBe('resp_1');
      expect(body.input).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'RESULT' }]);
      return {
        status: 200,
        body: JSON.stringify({
          id: 'resp_2',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });

    const provider = new OpenAICompatProvider(openaiConfig);
    const tools = [{
      type: 'function' as const,
      function: { name: 'web_search', description: 'Search', parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
    }];

    const r1 = await provider.chat([{ role: 'user', content: 'hi' }], { stream: false, tools });
    expect(r1.message.tool_calls?.[0].id).toBe('call_1');

    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      r1.message,
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'RESULT' },
    ];
    const r2 = await provider.chat(messages, { stream: false, tools });
    expect(r2.message.content).toBe('done');
  });
});
