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
    await provider.chat([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'test' },
    ], { stream: false, tools });

    const req = mock.lastRequest()!;
    expect(req.url).toBe('/responses');
    const body = JSON.parse(req.body);
    expect(body.reasoning?.effort).toBe('high');  // Tool calls use 'high' to prevent CoT bloat
    expect(body.tools).toBeDefined();
    expect(body.tools[0].name).toBe('test');
    expect(body.tools[0].type).toBe('function');
    // System message extracted to instructions parameter
    expect(body.instructions).toContain('You are a helpful assistant.');
    expect(body.instructions).toContain('function_call mechanism');
    // System message NOT in input
    const inputRoles = body.input.map((m: any) => m.role);
    expect(inputRoles).not.toContain('system');
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

  it('falls back to non-continuation when lastResponseId is cleared (after compaction)', async () => {
    let call = 0;
    mock.setHandler((_req, bodyStr) => {
      call++;
      const body = JSON.parse(bodyStr);
      if (call === 1) {
        return {
          status: 200,
          body: JSON.stringify({
            id: 'resp_1',
            output: [{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        };
      }
      // After resetContinuation, should NOT use previous_response_id
      expect(body.previous_response_id).toBeUndefined();
      // Tool results should be dropped, assistant tool_call inlined as text
      const inputs = body.input as Array<{ role: string; content: string }>;
      expect(inputs.some((i: { content: string }) => i.content.includes('web_search'))).toBe(true);
      return {
        status: 200,
        body: JSON.stringify({
          id: 'resp_3',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }],
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

    // Simulate compaction clearing continuation state
    provider.resetContinuation();

    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      r1.message,
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'RESULT' },
    ];
    const r2 = await provider.chat(messages, { stream: false, tools });
    expect(r2.message.content).toBe('recovered');
  });

  it('groups tools into namespaces with tool_search when tool count > 15', async () => {
    mock.setHandler(() => ({
      status: 200,
      body: JSON.stringify({
        id: 'resp_ns',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }));

    const provider = new OpenAICompatProvider(openaiConfig);
    const makeT = (n: string) => ({
      type: 'function' as const,
      function: { name: n, description: `${n} desc`, parameters: { type: 'object' as const, properties: {}, required: [] as string[] } },
    });
    const tools = [
      makeT('run_command'), makeT('set_working_dir'), makeT('get_working_dir'),
      makeT('web_search'), makeT('search_news'), makeT('browse_web'), makeT('scrape_page'),
      makeT('wiki_search'), makeT('wiki_summary'),
      makeT('read_file'), makeT('create_file'), makeT('list_files'), makeT('grep_files'),
      makeT('git_status'), makeT('git_diff'), makeT('git_log'),
      makeT('exit_app'), makeT('get_usage'), makeT('custom_tool_1'), makeT('custom_tool_2'),
    ];

    await provider.chat([{ role: 'user', content: 'test' }], { stream: false, tools });

    const req = mock.lastRequest()!;
    const body = JSON.parse(req.body);
    const toolTypes = body.tools.map((t: any) => t.type);

    expect(toolTypes).toContain('namespace');
    expect(toolTypes).toContain('tool_search');

    const directNames = body.tools.filter((t: any) => t.type === 'function').map((t: any) => t.name);
    expect(directNames).toContain('run_command');
    expect(directNames).toContain('set_working_dir');
    expect(directNames).toContain('exit_app');
    expect(directNames).toContain('custom_tool_1');

    const webNs = body.tools.find((t: any) => t.type === 'namespace' && t.name === 'marvin_web');
    expect(webNs).toBeDefined();
    expect(webNs.tools.every((t: any) => t.defer_loading === true)).toBe(true);
    expect(webNs.tools.map((t: any) => t.name)).toContain('web_search');
  });
});
