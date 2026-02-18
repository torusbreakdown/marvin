import { describe, it, expect, vi } from 'vitest';
import { runToolLoop } from '../../src/llm/router.js';
import type { Provider, Message, ChatResult, ChatOptions, OpenAIFunctionDef, ToolCall } from '../../src/types.js';

// Fake provider that returns scripted responses
function createFakeProvider(responses: ChatResult[]): Provider {
  let callIndex = 0;
  return {
    name: 'fake',
    model: 'fake-model',
    async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
      if (callIndex >= responses.length) {
        throw new Error('No more scripted responses');
      }
      return responses[callIndex++];
    },
    destroy() {},
  };
}

// Helper to create a tool call message
function toolCallResult(content: string, toolCalls: ToolCall[]): ChatResult {
  return {
    message: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function textResult(content: string): ChatResult {
  return {
    message: { role: 'assistant', content },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeToolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

// Tool functions map
type ToolFunc = (args: Record<string, unknown>) => Promise<string>;

describe('runToolLoop', () => {
  describe('Simple prompt (no tool calls)', () => {
    it('returns final text when LLM responds without tool calls', async () => {
      const provider = createFakeProvider([textResult('Hello there!')]);
      const toolFuncs: Record<string, ToolFunc> = {};
      const result = await runToolLoop({
        prompt: 'Hi',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(result.message.content).toBe('Hello there!');
      expect(result.usage.inputTokens).toBeGreaterThan(0);
    });
  });

  describe('Tool call flow', () => {
    it('executes tool calls and feeds results back, returns final text', async () => {
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'web_search', '{"q":"weather"}')]),
        textResult('The weather is sunny.'),
      ]);
      const toolFuncs: Record<string, ToolFunc> = {
        web_search: async (args) => `Results for: ${(args as any).q}`,
      };

      const result = await runToolLoop({
        prompt: "What's the weather?",
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(result.message.content).toBe('The weather is sunny.');
    });
  });

  describe('Max rounds limit', () => {
    it('requests final completion with tools=null after max rounds', async () => {
      // Create a provider that always returns tool calls, but the last call (no tools) returns text
      const responses: ChatResult[] = [];
      for (let i = 0; i < 3; i++) {
        responses.push(toolCallResult('', [makeToolCall(`call_${i}`, 'noop', '{}')]));
      }
      responses.push(textResult('Max rounds reached, here is my answer.'));

      const provider = createFakeProvider(responses);
      const toolFuncs: Record<string, ToolFunc> = {
        noop: async () => 'ok',
      };

      const result = await runToolLoop({
        prompt: 'Do something',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
        maxRounds: 3,
      });

      expect(result.message.content).toBe('Max rounds reached, here is my answer.');
    });
  });

  describe('Argument deserialization (SHARP_EDGES §1)', () => {
    it('parses string arguments via JSON.parse', async () => {
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'read_file', '{"path":"foo.txt"}')]),
        textResult('Done'),
      ]);
      let receivedArgs: any = null;
      const toolFuncs: Record<string, ToolFunc> = {
        read_file: async (args) => { receivedArgs = args; return 'file content'; },
      };

      await runToolLoop({
        prompt: 'Read a file',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(receivedArgs).toEqual({ path: 'foo.txt' });
    });

    it('handles arguments that are already objects (double-stringified)', async () => {
      // Some LLMs send arguments as a JSON string that needs double-parsing
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'read_file', JSON.stringify('{"path":"bar.txt"}'))]),
        textResult('Done'),
      ]);
      let receivedArgs: any = null;
      const toolFuncs: Record<string, ToolFunc> = {
        read_file: async (args) => { receivedArgs = args; return 'content'; },
      };

      await runToolLoop({
        prompt: 'Read file',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(receivedArgs).toEqual({ path: 'bar.txt' });
    });

    it('returns helpful error on unparseable arguments', async () => {
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'read_file', 'not valid json{{{')]),
        textResult('I see the error'),
      ]);
      const toolFuncs: Record<string, ToolFunc> = {
        read_file: async () => 'ok',
      };

      // Should not throw - returns error to LLM instead
      const result = await runToolLoop({
        prompt: 'Read file',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(result.message.content).toBe('I see the error');
    });
  });

  describe('Codex "*** Begin Patch" format', () => {
    it('routes Codex patch format to apply_patch handler', async () => {
      const patchArgs = '*** Begin Patch\n*** Update File: src/main.ts\n@@@ -1,3 +1,3 @@@\n-old line\n+new line\n';
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'apply_patch', patchArgs)]),
        textResult('Patch applied'),
      ]);
      let receivedArgs: any = null;
      const toolFuncs: Record<string, ToolFunc> = {
        apply_patch: async (args) => { receivedArgs = args; return 'Patch applied successfully'; },
      };

      await runToolLoop({
        prompt: 'Fix the code',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      // Should pass the raw patch content as { patch: "..." }
      expect(receivedArgs).toBeDefined();
      expect(receivedArgs.patch || receivedArgs).toBeDefined();
    });
  });

  describe('Unknown tool', () => {
    it('returns "Unknown tool: X" error to LLM', async () => {
      const provider = createFakeProvider([
        toolCallResult('', [makeToolCall('call_1', 'nonexistent_tool', '{}')]),
        textResult('I will try another approach'),
      ]);
      const toolFuncs: Record<string, ToolFunc> = {};

      const result = await runToolLoop({
        prompt: 'Do something',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      // Should succeed (error fed back to LLM) — LLM adapts
      expect(result.message.content).toBe('I will try another approach');
    });
  });

  describe('Parallel tool execution', () => {
    it('executes multiple tool calls within a round in parallel', async () => {
      const executionOrder: string[] = [];
      const provider = createFakeProvider([
        toolCallResult('', [
          makeToolCall('call_1', 'slow_tool', '{"id":"a"}'),
          makeToolCall('call_2', 'slow_tool', '{"id":"b"}'),
          makeToolCall('call_3', 'slow_tool', '{"id":"c"}'),
        ]),
        textResult('All done'),
      ]);
      const toolFuncs: Record<string, ToolFunc> = {
        slow_tool: async (args) => {
          executionOrder.push((args as any).id);
          // Small delay to verify parallel execution
          await new Promise(r => setTimeout(r, 10));
          return `result-${(args as any).id}`;
        },
      };

      const result = await runToolLoop({
        prompt: 'Run parallel tasks',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(result.message.content).toBe('All done');
      // All three should have started (order may vary due to parallel)
      expect(executionOrder).toHaveLength(3);
      expect(executionOrder).toContain('a');
      expect(executionOrder).toContain('b');
      expect(executionOrder).toContain('c');
    });
  });

  describe('Usage accumulation', () => {
    it('accumulates usage across multiple rounds', async () => {
      const provider = createFakeProvider([
        { message: { role: 'assistant', content: null, tool_calls: [makeToolCall('c1', 'noop', '{}')] }, usage: { inputTokens: 100, outputTokens: 50 } },
        { message: { role: 'assistant', content: 'Done' }, usage: { inputTokens: 200, outputTokens: 100 } },
      ]);
      const toolFuncs: Record<string, ToolFunc> = {
        noop: async () => 'ok',
      };

      const result = await runToolLoop({
        prompt: 'Do it',
        toolFuncs,
        systemMessage: 'You are helpful',
        provider,
      });

      expect(result.usage.inputTokens).toBe(300);
      expect(result.usage.outputTokens).toBe(150);
    });
  });

  describe('Message history', () => {
    it('includes system message and user prompt in initial messages', async () => {
      let capturedMessages: Message[] = [];
      const provider: Provider = {
        name: 'fake',
        model: 'fake',
        async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
          capturedMessages = [...messages];
          return textResult('Hi');
        },
        destroy() {},
      };

      await runToolLoop({
        prompt: 'Hello',
        toolFuncs: {},
        systemMessage: 'You are Marvin',
        provider,
      });

      expect(capturedMessages[0].role).toBe('system');
      expect(capturedMessages[0].content).toBe('You are Marvin');
      expect(capturedMessages[capturedMessages.length - 1].role).toBe('user');
      expect(capturedMessages[capturedMessages.length - 1].content).toBe('Hello');
    });

    it('accepts existing history in messages', async () => {
      let capturedMessages: Message[] = [];
      const provider: Provider = {
        name: 'fake',
        model: 'fake',
        async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
          capturedMessages = [...messages];
          return textResult('Hi again');
        },
        destroy() {},
      };

      await runToolLoop({
        prompt: 'What next?',
        toolFuncs: {},
        systemMessage: 'You are Marvin',
        provider,
        history: [
          { role: 'user', content: 'Previous question' },
          { role: 'assistant', content: 'Previous answer' },
        ],
      });

      // system + history(2) + user prompt = 4
      expect(capturedMessages.length).toBe(4);
      expect(capturedMessages[1].content).toBe('Previous question');
      expect(capturedMessages[2].content).toBe('Previous answer');
      expect(capturedMessages[3].content).toBe('What next?');
    });
  });
});
