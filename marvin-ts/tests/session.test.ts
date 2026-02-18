import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { SessionManager, type SessionManagerConfig } from '../src/session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Provider, Message, ChatResult, ChatOptions, UserProfile, ProviderConfig } from '../src/types.js';

function makeProfile(dir: string): UserProfile {
  return {
    name: 'test',
    profileDir: dir,
    preferences: {},
    savedPlaces: [],
    chatLog: [],
    ntfySubscriptions: [],
    oauthTokens: {},
    inputHistory: [],
  };
}

function makeFakeProvider(responses: ChatResult[]): Provider {
  let callIndex = 0;
  return {
    name: 'fake',
    model: 'fake-model',
    async chat(_messages: Message[], _options?: ChatOptions): Promise<ChatResult> {
      if (callIndex >= responses.length) throw new Error('No more responses');
      return responses[callIndex++];
    },
    destroy() {},
  };
}

function textResult(content: string): ChatResult {
  return {
    message: { role: 'assistant', content },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const providerConfig: ProviderConfig = {
  provider: 'openai',
  model: 'gpt-4',
  timeoutMs: 300_000,
  maxToolRounds: 10,
};

describe('SessionManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-session-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSession(responses: ChatResult[], codingMode = false): SessionManager {
    const registry = new ToolRegistry();
    registry.registerTool(
      'echo_tool',
      'Echo back the input',
      z.object({ text: z.string() }),
      async (args) => `Echo: ${args.text}`,
      'always',
    );

    const provider = makeFakeProvider(responses);

    return new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry,
      mode: codingMode ? 'coding' : 'surf',
      codingMode,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });
  }

  it('submit returns ChatResult with assistant message', async () => {
    const session = createSession([textResult('Hello!')]);
    const result = await session.submit('Hi');
    expect(result.message.content).toBe('Hello!');
    expect(result.message.role).toBe('assistant');
  });

  it('tracks usage after submit', async () => {
    const session = createSession([textResult('Response')]);
    await session.submit('Test');
    const usage = session.getUsage().getSessionUsage();
    expect(usage.llmTurns).toBe(1);
    expect(usage.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('appends messages to history', async () => {
    const session = createSession([
      textResult('First answer'),
      textResult('Second answer'),
    ]);
    await session.submit('First question');
    const state = session.getState();
    // Should have user message + assistant message
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[1].role).toBe('assistant');
  });

  it('prevents concurrent submits (busy guard)', async () => {
    const provider: Provider = {
      name: 'slow',
      model: 'slow-model',
      async chat(): Promise<ChatResult> {
        await new Promise(r => setTimeout(r, 100));
        return textResult('done');
      },
      destroy() {},
    };
    const session = new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry: new ToolRegistry(),
      mode: 'surf',
      codingMode: false,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });

    const p1 = session.submit('first');
    await expect(session.submit('second')).rejects.toThrow(/busy/i);
    await p1;
  });

  it('sets busy=false after submit completes', async () => {
    const session = createSession([textResult('Done')]);
    expect(session.getState().busy).toBe(false);
    await session.submit('Hi');
    expect(session.getState().busy).toBe(false);
  });

  it('sets busy=false even on error', async () => {
    const provider: Provider = {
      name: 'fail',
      model: 'fail-model',
      async chat(): Promise<ChatResult> {
        throw new Error('Provider failed');
      },
      destroy() {},
    };
    const session = new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry: new ToolRegistry(),
      mode: 'surf',
      codingMode: false,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });

    await expect(session.submit('Hi')).rejects.toThrow('Provider failed');
    expect(session.getState().busy).toBe(false);
  });

  it('toggleCodingMode flips the state', () => {
    const session = createSession([]);
    expect(session.getState().codingMode).toBe(false);
    session.toggleCodingMode();
    expect(session.getState().codingMode).toBe(true);
    session.toggleCodingMode();
    expect(session.getState().codingMode).toBe(false);
  });

  it('toggleShellMode flips the state', () => {
    const session = createSession([]);
    expect(session.getState().shellMode).toBe(false);
    session.toggleShellMode();
    expect(session.getState().shellMode).toBe(true);
  });

  it('destroy saves usage and destroys provider', async () => {
    let destroyed = false;
    const provider: Provider = {
      name: 'fake',
      model: 'fake',
      async chat(): Promise<ChatResult> {
        return textResult('ok');
      },
      destroy() { destroyed = true; },
    };
    const session = new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry: new ToolRegistry(),
      mode: 'surf',
      codingMode: false,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });
    await session.submit('test');
    await session.destroy();
    expect(destroyed).toBe(true);
  });

  it('includes tools from registry in provider call', async () => {
    let capturedOptions: ChatOptions | undefined;
    const provider: Provider = {
      name: 'capture',
      model: 'capture',
      async chat(_msgs: Message[], options?: ChatOptions): Promise<ChatResult> {
        capturedOptions = options;
        return textResult('ok');
      },
      destroy() {},
    };

    const registry = new ToolRegistry();
    registry.registerTool(
      'test_tool',
      'A test tool',
      z.object({ q: z.string() }),
      async () => 'result',
      'coding',
    );

    const session = new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry,
      mode: 'coding',
      codingMode: true,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });

    await session.submit('do something');
    expect(capturedOptions?.tools).toBeDefined();
    expect(capturedOptions!.tools!.length).toBeGreaterThan(0);
    const toolNames = capturedOptions!.tools!.map(t => t.function.name);
    expect(toolNames).toContain('test_tool');
  });

  it('wires tool execution through registry', async () => {
    let toolCalled = false;
    const registry = new ToolRegistry();
    registry.registerTool(
      'my_tool',
      'Test tool',
      z.object({ x: z.string() }),
      async (args) => {
        toolCalled = true;
        return `got: ${args.x}`;
      },
      'always',
    );

    const provider: Provider = {
      name: 'tool-caller',
      model: 'tool-model',
      async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
        // First call: return tool call; second call: return text
        const hasToolResult = messages.some(m => m.role === 'tool');
        if (hasToolResult) {
          return textResult('Done with tool');
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'my_tool', arguments: '{"x":"hello"}' },
            }],
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      destroy() {},
    };

    const session = new SessionManager({
      provider,
      providerConfig,
      profile: makeProfile(tmpDir),
      registry,
      mode: 'surf',
      codingMode: false,
      workingDir: tmpDir,
      nonInteractive: true,
      persistDir: tmpDir,
    });

    const result = await session.submit('use the tool');
    expect(toolCalled).toBe(true);
    expect(result.message.content).toBe('Done with tool');
  });
});
