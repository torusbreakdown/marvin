import { describe, it, expect } from 'vitest';
import { z, ZodObject } from 'zod';
import type {
  ToolDef,
  ToolContext,
  OpenAIFunctionDef,
  MessageRole,
  Message,
  ToolCall,
  ProviderConfig,
  StreamCallbacks,
  ChatResult,
  SessionState,
  UserProfile,
  SavedPlace,
  ChatLogEntry,
  NtfySubscription,
  ContextBudget,
  UsageRecord,
  SessionUsage,
  StatusBarData,
  CliArgs,
} from '../src/types.js';

describe('types.ts — Core Interfaces', () => {
  describe('ToolDef', () => {
    it('has name, description, schema (ZodObject), handler (async), category', () => {
      const schema = z.object({ query: z.string() });
      const tool: ToolDef = {
        name: 'test_tool',
        description: 'A test tool',
        schema,
        handler: async (_args: any, _ctx: ToolContext) => 'result',
        category: 'always',
      };
      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.schema).toBeInstanceOf(ZodObject);
      expect(typeof tool.handler).toBe('function');
      expect(tool.category).toBe('always');
    });

    it('supports optional requiresConfirmation', () => {
      const schema = z.object({});
      const tool: ToolDef = {
        name: 'dangerous',
        description: 'needs confirm',
        schema,
        handler: async () => 'ok',
        category: 'coding',
        requiresConfirmation: true,
      };
      expect(tool.requiresConfirmation).toBe(true);
    });

    it('category accepts coding, readonly, always', () => {
      const schema = z.object({});
      const base = { name: 'x', description: 'x', schema, handler: async () => '' };
      const c1: ToolDef = { ...base, category: 'coding' };
      const c2: ToolDef = { ...base, category: 'readonly' };
      const c3: ToolDef = { ...base, category: 'always' };
      expect(c1.category).toBe('coding');
      expect(c2.category).toBe('readonly');
      expect(c3.category).toBe('always');
    });
  });

  describe('ToolContext', () => {
    it('has workingDir, codingMode, nonInteractive, profileDir, profile', () => {
      const profile: UserProfile = {
        name: 'default',
        profileDir: '/tmp/profiles/default',
        preferences: {},
        savedPlaces: [],
        chatLog: [],
        ntfySubscriptions: [],
        oauthTokens: {},
        inputHistory: [],
      };
      const ctx: ToolContext = {
        workingDir: '/tmp',
        codingMode: true,
        nonInteractive: false,
        profileDir: '/tmp/profiles/default',
        profile,
      };
      expect(ctx.workingDir).toBe('/tmp');
      expect(ctx.codingMode).toBe(true);
      expect(ctx.nonInteractive).toBe(false);
      expect(ctx.profileDir).toBe('/tmp/profiles/default');
      expect(ctx.profile.name).toBe('default');
    });

    it('has optional confirmCommand', () => {
      const profile: UserProfile = {
        name: 'default',
        profileDir: '/tmp',
        preferences: {},
        savedPlaces: [],
        chatLog: [],
        ntfySubscriptions: [],
        oauthTokens: {},
        inputHistory: [],
      };
      const ctx: ToolContext = {
        workingDir: null,
        codingMode: false,
        nonInteractive: false,
        profileDir: '/tmp',
        profile,
        confirmCommand: async (cmd: string) => true,
      };
      expect(typeof ctx.confirmCommand).toBe('function');
    });
  });

  describe('OpenAIFunctionDef', () => {
    it('has type=function and nested function object', () => {
      const def: OpenAIFunctionDef = {
        type: 'function',
        function: {
          name: 'test',
          description: 'a test function',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      };
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('test');
      expect(def.function.description).toBe('a test function');
      expect(def.function.parameters.type).toBe('object');
      expect(def.function.parameters.required).toEqual(['q']);
    });
  });

  describe('Message', () => {
    it('has role and content', () => {
      const msg: Message = { role: 'user', content: 'hello' };
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('hello');
    });

    it('supports optional tool_calls on assistant messages', () => {
      const msg: Message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"q":"test"}' },
          },
        ],
      };
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0].id).toBe('call_1');
      expect(msg.tool_calls![0].type).toBe('function');
      expect(msg.tool_calls![0].function.name).toBe('web_search');
      expect(msg.tool_calls![0].function.arguments).toBe('{"q":"test"}');
    });

    it('supports tool_call_id and name on tool messages', () => {
      const msg: Message = {
        role: 'tool',
        content: 'result data',
        tool_call_id: 'call_1',
        name: 'web_search',
      };
      expect(msg.tool_call_id).toBe('call_1');
      expect(msg.name).toBe('web_search');
    });

    it('accepts all MessageRole values', () => {
      const roles: MessageRole[] = ['system', 'user', 'assistant', 'tool'];
      roles.forEach((r) => {
        const msg: Message = { role: r, content: 'test' };
        expect(msg.role).toBe(r);
      });
    });
  });

  describe('ToolCall', () => {
    it('has id, type=function, function with name and arguments string', () => {
      const tc: ToolCall = {
        id: 'call_abc',
        type: 'function',
        function: { name: 'weather_forecast', arguments: '{"city":"NYC"}' },
      };
      expect(tc.id).toBe('call_abc');
      expect(tc.type).toBe('function');
      expect(tc.function.name).toBe('weather_forecast');
      expect(typeof tc.function.arguments).toBe('string');
    });
  });

  describe('ProviderConfig', () => {
    it('has provider, model, timeoutMs, maxToolRounds', () => {
      const cfg: ProviderConfig = {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'key123',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      expect(cfg.provider).toBe('groq');
      expect(cfg.model).toBe('llama-3.3-70b-versatile');
      expect(cfg.apiKey).toBe('key123');
      expect(cfg.timeoutMs).toBe(180_000);
      expect(cfg.maxToolRounds).toBe(10);
    });

    it('has optional apiKey and baseUrl', () => {
      const cfg: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.baseUrl).toBe('http://localhost:11434');
    });

    it('accepts all provider values', () => {
      const providers: ProviderConfig['provider'][] = [
        'copilot', 'gemini', 'groq', 'openai', 'ollama', 'openai-compat',
      ];
      providers.forEach((p) => {
        const cfg: ProviderConfig = {
          provider: p,
          model: 'test',
          timeoutMs: 1000,
          maxToolRounds: 1,
        };
        expect(cfg.provider).toBe(p);
      });
    });
  });

  describe('StreamCallbacks', () => {
    it('has onDelta, onToolCallStart, onComplete, onError', () => {
      const cb: StreamCallbacks = {
        onDelta: (text: string) => {},
        onToolCallStart: (names: string[]) => {},
        onComplete: (msg: Message) => {},
        onError: (err: Error) => {},
      };
      expect(typeof cb.onDelta).toBe('function');
      expect(typeof cb.onToolCallStart).toBe('function');
      expect(typeof cb.onComplete).toBe('function');
      expect(typeof cb.onError).toBe('function');
    });
  });

  describe('ChatResult', () => {
    it('has message and usage with inputTokens and outputTokens', () => {
      const result: ChatResult = {
        message: { role: 'assistant', content: 'Hello!' },
        usage: { inputTokens: 100, outputTokens: 50 },
      };
      expect(result.message.role).toBe('assistant');
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
    });
  });

  describe('SessionState', () => {
    it('has busy, messages, codingMode, shellMode, workingDir, provider, nonInteractive, ntfyTopic, abortController, done', () => {
      let resolve!: () => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });

      const state: SessionState = {
        busy: false,
        messages: [],
        codingMode: false,
        shellMode: false,
        workingDir: null,
        provider: {
          provider: 'copilot',
          model: 'claude-haiku-4.5',
          timeoutMs: 180_000,
          maxToolRounds: 10,
        },
        nonInteractive: false,
        ntfyTopic: null,
        abortController: null,
        done: { promise, resolve, reject },
      };
      expect(state.busy).toBe(false);
      expect(state.messages).toEqual([]);
      expect(state.codingMode).toBe(false);
      expect(state.shellMode).toBe(false);
      expect(state.workingDir).toBeNull();
      expect(state.provider.provider).toBe('copilot');
      expect(state.nonInteractive).toBe(false);
      expect(state.ntfyTopic).toBeNull();
      expect(state.abortController).toBeNull();
      expect(state.done.promise).toBeInstanceOf(Promise);
      expect(typeof state.done.resolve).toBe('function');
      expect(typeof state.done.reject).toBe('function');
    });
  });

  describe('UserProfile', () => {
    it('has name, profileDir, preferences, savedPlaces, chatLog, ntfySubscriptions, oauthTokens, inputHistory', () => {
      const profile: UserProfile = {
        name: 'alice',
        profileDir: '/home/alice/.config/local-finder/profiles/alice',
        preferences: {
          dietary: ['vegetarian'],
          budget: 'medium',
          distance_unit: 'kilometers',
          cuisines: ['italian', 'japanese'],
        },
        savedPlaces: [
          { label: 'Home', name: 'My House', address: '123 Main St', lat: 40.7, lng: -74.0, notes: 'front door' },
        ],
        chatLog: [
          { role: 'you', text: 'hello', time: '2024-01-01T00:00:00Z' },
        ],
        ntfySubscriptions: [{ topic: 'my-topic', lastMessageId: 'msg1' }],
        oauthTokens: { spotify: { access_token: 'abc' } },
        inputHistory: ['previous command'],
      };
      expect(profile.name).toBe('alice');
      expect(profile.profileDir).toContain('alice');
      expect(profile.preferences.dietary).toEqual(['vegetarian']);
      expect(profile.preferences.budget).toBe('medium');
      expect(profile.preferences.distance_unit).toBe('kilometers');
      expect(profile.preferences.cuisines).toEqual(['italian', 'japanese']);
      expect(profile.savedPlaces).toHaveLength(1);
      expect(profile.savedPlaces[0].label).toBe('Home');
      expect(profile.savedPlaces[0].lat).toBe(40.7);
      expect(profile.savedPlaces[0].lng).toBe(-74.0);
      expect(profile.savedPlaces[0].notes).toBe('front door');
      expect(profile.chatLog).toHaveLength(1);
      expect(profile.ntfySubscriptions).toHaveLength(1);
      expect(profile.ntfySubscriptions[0].topic).toBe('my-topic');
      expect(profile.oauthTokens).toHaveProperty('spotify');
      expect(profile.inputHistory).toEqual(['previous command']);
    });
  });

  describe('SavedPlace', () => {
    it('has label, name, address, lat, lng, optional notes', () => {
      const place: SavedPlace = {
        label: 'Office',
        name: 'Tech HQ',
        address: '456 Innovation Dr',
        lat: 37.7749,
        lng: -122.4194,
      };
      expect(place.label).toBe('Office');
      expect(place.notes).toBeUndefined();
    });
  });

  describe('ChatLogEntry', () => {
    it('has role (you|assistant|system), text, time', () => {
      const entries: ChatLogEntry[] = [
        { role: 'you', text: 'hello', time: '2024-01-01T00:00:00Z' },
        { role: 'assistant', text: 'hi there', time: '2024-01-01T00:00:01Z' },
        { role: 'system', text: 'mode changed', time: '2024-01-01T00:00:02Z' },
      ];
      expect(entries[0].role).toBe('you');
      expect(entries[1].role).toBe('assistant');
      expect(entries[2].role).toBe('system');
      entries.forEach((e) => {
        expect(typeof e.text).toBe('string');
        expect(typeof e.time).toBe('string');
      });
    });
  });

  describe('NtfySubscription', () => {
    it('has topic, optional lastMessageId', () => {
      const sub: NtfySubscription = { topic: 'my-alerts' };
      expect(sub.topic).toBe('my-alerts');
      expect(sub.lastMessageId).toBeUndefined();
    });
  });

  describe('ContextBudget', () => {
    it('has warnThreshold, compactThreshold, hardLimit, currentTokens', () => {
      const budget: ContextBudget = {
        warnThreshold: 180_000,
        compactThreshold: 200_000,
        hardLimit: 226_000,
        currentTokens: 50_000,
      };
      expect(budget.warnThreshold).toBe(180_000);
      expect(budget.compactThreshold).toBe(200_000);
      expect(budget.hardLimit).toBe(226_000);
      expect(budget.currentTokens).toBe(50_000);
    });
  });

  describe('UsageRecord', () => {
    it('has provider, model, inputTokens, outputTokens, costUsd, timestamp', () => {
      const rec: UsageRecord = {
        provider: 'groq',
        model: 'llama-3.3-70b',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.002,
        timestamp: '2024-01-01T00:00:00Z',
      };
      expect(rec.provider).toBe('groq');
      expect(rec.model).toBe('llama-3.3-70b');
      expect(rec.inputTokens).toBe(1000);
      expect(rec.outputTokens).toBe(500);
      expect(rec.costUsd).toBe(0.002);
      expect(typeof rec.timestamp).toBe('string');
    });
  });

  describe('SessionUsage', () => {
    it('has totalCostUsd, llmTurns, modelTurns, modelCost, toolCallCounts', () => {
      const usage: SessionUsage = {
        totalCostUsd: 0.15,
        llmTurns: 5,
        modelTurns: { 'gpt-4': 3, 'claude': 2 },
        modelCost: { 'gpt-4': 0.10, 'claude': 0.05 },
        toolCallCounts: { 'web_search': 3, 'read_file': 7 },
      };
      expect(usage.totalCostUsd).toBe(0.15);
      expect(usage.llmTurns).toBe(5);
      expect(usage.modelTurns['gpt-4']).toBe(3);
      expect(usage.modelCost['claude']).toBe(0.05);
      expect(usage.toolCallCounts['web_search']).toBe(3);
    });
  });

  describe('StatusBarData', () => {
    it('has providerEmoji, model, profileName, messageCount, costUsd, totalTokens, codingMode, shellMode', () => {
      const status: StatusBarData = {
        providerEmoji: '🤖',
        model: 'gpt-4',
        profileName: 'default',
        messageCount: 42,
        costUsd: 1.23,
        totalTokens: 50000,
        codingMode: true,
        shellMode: false,
      };
      expect(status.providerEmoji).toBe('🤖');
      expect(status.model).toBe('gpt-4');
      expect(status.profileName).toBe('default');
      expect(status.messageCount).toBe(42);
      expect(status.costUsd).toBe(1.23);
      expect(status.totalTokens).toBe(50000);
      expect(status.codingMode).toBe(true);
      expect(status.shellMode).toBe(false);
    });
  });

  describe('CliArgs', () => {
    it('has plain, nonInteractive required; provider, prompt, workingDir, ntfy, inlinePrompt optional', () => {
      const args: CliArgs = {
        plain: false,
        nonInteractive: true,
        prompt: 'What is the weather?',
        workingDir: '/tmp/project',
        ntfy: 'my-topic',
        provider: 'groq',
        inlinePrompt: 'quick question',
      };
      expect(args.plain).toBe(false);
      expect(args.nonInteractive).toBe(true);
      expect(args.prompt).toBe('What is the weather?');
      expect(args.workingDir).toBe('/tmp/project');
      expect(args.ntfy).toBe('my-topic');
      expect(args.provider).toBe('groq');
      expect(args.inlinePrompt).toBe('quick question');
    });
  });
});
