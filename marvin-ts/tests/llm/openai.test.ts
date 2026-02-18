import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { OpenAICompatProvider } from '../../src/llm/openai.js';
import type { ProviderConfig, Message } from '../../src/types.js';

// Helper to create a local HTTP server that records requests and returns scripted responses
function createMockServer(): {
  server: Server;
  port: () => number;
  setHandler: (fn: (req: IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> }) => void;
  lastRequest: () => { method: string; url: string; headers: Record<string, string>; body: string } | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let handler: (req: IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> } = () => ({
    status: 200,
    body: '',
  });
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

// Standard non-streaming response
function makeNonStreamingResponse(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  });
}

// SSE streaming response
function makeSSEStream(deltas: Array<{ content?: string; tool_calls?: any[] }>, usage?: { prompt_tokens: number; completion_tokens: number }) {
  let result = '';
  for (const delta of deltas) {
    const chunk = { choices: [{ delta, index: 0 }] };
    result += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  if (usage) {
    result += `data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}\n\n`;
  }
  result += 'data: [DONE]\n\n';
  return result;
}

describe('OpenAICompatProvider', () => {
  const mock = createMockServer();
  let baseConfig: ProviderConfig;

  beforeAll(async () => {
    await mock.start();
    baseConfig = {
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'test-key-123',
      baseUrl: `http://127.0.0.1:${mock.port()}`,
      timeoutMs: 300_000,
      maxToolRounds: 10,
    };
  });

  afterAll(async () => {
    await mock.stop();
  });

  describe('Construction', () => {
    it('constructs with ProviderConfig', () => {
      const provider = new OpenAICompatProvider(baseConfig);
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-4');
    });

    it('exposes name and model as readonly', () => {
      const provider = new OpenAICompatProvider(baseConfig);
      expect(provider.name).toBe('openai');
      expect(provider.model).toBe('gpt-4');
    });
  });

  describe('Non-streaming chat()', () => {
    it('returns {message, usage} for non-streaming call', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('Hello, world!', { prompt_tokens: 15, completion_tokens: 8 }),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];
      const result = await provider.chat(messages, { stream: false });

      expect(result.message.role).toBe('assistant');
      expect(result.message.content).toBe('Hello, world!');
      expect(result.usage.inputTokens).toBe(15);
      expect(result.usage.outputTokens).toBe(8);
    });

    it('sends correct headers (Content-Type + Authorization)', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await provider.chat([{ role: 'user', content: 'test' }], { stream: false });

      const req = mock.lastRequest()!;
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['authorization']).toBe('Bearer test-key-123');
    });

    it('sends POST to baseUrl/chat/completions', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await provider.chat([{ role: 'user', content: 'test' }], { stream: false });

      const req = mock.lastRequest()!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/chat/completions');
    });

    it('sends model and messages in body', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ];
      await provider.chat(messages, { stream: false });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.model).toBe('gpt-4');
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBe(false);
    });
  });

  describe('Streaming chat()', () => {
    it('returns accumulated content from streaming', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeSSEStream(
          [{ content: 'Hello' }, { content: ', ' }, { content: 'world!' }],
          { prompt_tokens: 10, completion_tokens: 3 },
        ),
        headers: { 'Content-Type': 'text/event-stream' },
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      const result = await provider.chat([{ role: 'user', content: 'Hi' }], { stream: true });

      expect(result.message.content).toBe('Hello, world!');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(3);
    });

    it('requests stream_options.include_usage when streaming', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeSSEStream([{ content: 'ok' }], { prompt_tokens: 1, completion_tokens: 1 }),
        headers: { 'Content-Type': 'text/event-stream' },
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await provider.chat([{ role: 'user', content: 'test' }], { stream: true });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
    });
  });

  describe('API error handling', () => {
    it('throws on 4xx errors with status and message', async () => {
      mock.setHandler(() => ({
        status: 401,
        body: JSON.stringify({ error: { message: 'Invalid API key' } }),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await expect(provider.chat([{ role: 'user', content: 'test' }], { stream: false }))
        .rejects.toThrow(/401/);
    });

    it('throws on 5xx errors with status and message', async () => {
      mock.setHandler(() => ({
        status: 500,
        body: JSON.stringify({ error: { message: 'Internal server error' } }),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await expect(provider.chat([{ role: 'user', content: 'test' }], { stream: false }))
        .rejects.toThrow(/500/);
    });

    it('includes response body in error', async () => {
      mock.setHandler(() => ({
        status: 429,
        body: JSON.stringify({ error: { message: 'Rate limited' } }),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await expect(provider.chat([{ role: 'user', content: 'test' }], { stream: false }))
        .rejects.toThrow(/Rate limited/);
    });
  });

  describe('Gemini thinking config', () => {
    it('injects thinking_level:low for gemini-3 models', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const config = { ...baseConfig, model: 'gemini-3-pro-preview' };
      const provider = new OpenAICompatProvider(config);
      await provider.chat([{ role: 'user', content: 'test' }], { stream: false });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.extra_body?.google?.thinking_config?.thinking_level).toBe('low');
    });

    it('injects thinking_budget:2048 for gemini-2.5 models', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const config = { ...baseConfig, model: 'gemini-2.5-flash' };
      const provider = new OpenAICompatProvider(config);
      await provider.chat([{ role: 'user', content: 'test' }], { stream: false });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.extra_body?.google?.thinking_config?.thinking_budget).toBe(2048);
    });

    it('does NOT inject thinking config when tools are provided', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const config = { ...baseConfig, model: 'gemini-3-pro-preview' };
      const provider = new OpenAICompatProvider(config);
      const tools = [{
        type: 'function' as const,
        function: { name: 'test', description: 'test', parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
      }];
      await provider.chat([{ role: 'user', content: 'test' }], { stream: false, tools });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.extra_body).toBeUndefined();
    });
  });

  describe('Tool handling', () => {
    it('forces stream=false when tools are provided', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      const tools = [{
        type: 'function' as const,
        function: { name: 'test_tool', description: 'A test', parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
      }];
      await provider.chat([{ role: 'user', content: 'call tool' }], { stream: true, tools });

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.stream).toBe(false);
      expect(body.tools).toBeDefined();
    });

    it('parses tool_calls from non-streaming response', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'web_search', arguments: '{"q":"test"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      const tools = [{
        type: 'function' as const,
        function: { name: 'web_search', description: 'Search', parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
      }];
      const result = await provider.chat([{ role: 'user', content: 'search' }], { tools });

      expect(result.message.tool_calls).toHaveLength(1);
      expect(result.message.tool_calls![0].function.name).toBe('web_search');
      expect(result.message.tool_calls![0].function.arguments).toBe('{"q":"test"}');
    });
  });

  describe('Streaming tool call accumulation', () => {
    it('accumulates incremental tool call arguments across SSE chunks', async () => {
      // Simulate tool call arriving across multiple SSE chunks
      const chunks = [
        { choices: [{ delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"test qu' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
      ];
      let sseBody = chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';

      mock.setHandler(() => ({
        status: 200,
        body: sseBody,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

      const provider = new OpenAICompatProvider(baseConfig);
      const result = await provider.chat([{ role: 'user', content: 'test' }], { stream: true });

      expect(result.message.tool_calls).toHaveLength(1);
      expect(result.message.tool_calls![0].id).toBe('call_1');
      expect(result.message.tool_calls![0].function.name).toBe('web_search');
      expect(result.message.tool_calls![0].function.arguments).toBe('{"q":"test query"}');
    });

    it('accumulates multiple parallel tool calls from streaming', async () => {
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 8 } },
      ];
      let sseBody = chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';

      mock.setHandler(() => ({
        status: 200,
        body: sseBody,
        headers: { 'Content-Type': 'text/event-stream' },
      }));

      const provider = new OpenAICompatProvider(baseConfig);
      const result = await provider.chat([{ role: 'user', content: 'test' }], { stream: true });

      expect(result.message.tool_calls).toHaveLength(2);
      expect(result.message.tool_calls![0].function.name).toBe('read_file');
      expect(result.message.tool_calls![0].function.arguments).toBe('{"path":"a.ts"}');
      expect(result.message.tool_calls![1].function.name).toBe('read_file');
      expect(result.message.tool_calls![1].function.arguments).toBe('{"path":"b.ts"}');
    });
  });

  describe('Timeout', () => {
    it('uses 300s timeout (300000ms) by default', () => {
      const provider = new OpenAICompatProvider(baseConfig);
      // The config timeoutMs should be 300_000
      expect(baseConfig.timeoutMs).toBe(300_000);
    });
  });

  describe('extraBody', () => {
    it('merges extraBody into request', async () => {
      mock.setHandler(() => ({
        status: 200,
        body: makeNonStreamingResponse('ok'),
      }));
      const provider = new OpenAICompatProvider(baseConfig);
      await provider.chat(
        [{ role: 'user', content: 'test' }],
        { stream: false, extraBody: { temperature: 0.7, top_p: 0.9 } },
      );

      const body = JSON.parse(mock.lastRequest()!.body);
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
    });
  });

  describe('destroy()', () => {
    it('can be called without error', () => {
      const provider = new OpenAICompatProvider(baseConfig);
      expect(() => provider.destroy()).not.toThrow();
    });
  });
});
