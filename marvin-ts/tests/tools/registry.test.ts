import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: true,
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

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('registerTool()', () => {
    it('stores tool with name, description, schema, handler, category', () => {
      const schema = z.object({ path: z.string() });
      const handler = async () => 'ok';

      registry.registerTool(
        'read_file',
        'Read a file',
        schema,
        handler,
        'coding',
      );

      const tools = registry.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('read_file');
      expect(tools[0].description).toBe('Read a file');
      expect(tools[0].category).toBe('coding');
      expect(tools[0].handler).toBe(handler);
    });
  });

  describe('getTools()', () => {
    beforeEach(() => {
      registry.registerTool('read_file', 'Read', z.object({}), async () => '', 'coding');
      registry.registerTool('web_search', 'Search', z.object({}), async () => '', 'always');
      registry.registerTool('git_status', 'Status', z.object({}), async () => '', 'coding');
    });

    it('returns all tools when no filter', () => {
      expect(registry.getTools()).toHaveLength(3);
    });

    it('filters by category', () => {
      const codingTools = registry.getTools('coding');
      expect(codingTools).toHaveLength(2);
      expect(codingTools.every(t => t.category === 'coding')).toBe(true);
    });

    it('returns always-category tools', () => {
      const alwaysTools = registry.getTools('always');
      expect(alwaysTools).toHaveLength(1);
      expect(alwaysTools[0].name).toBe('web_search');
    });
  });

  describe('getOpenAISchemas()', () => {
    it('converts Zod schema to OpenAI function format correctly', () => {
      const schema = z.object({
        path: z.string().describe('File path'),
        count: z.number().describe('Line count'),
        verbose: z.boolean().describe('Verbose output'),
        mode: z.enum(['read', 'write']).describe('Operation mode'),
        start_line: z.number().optional().describe('Start line'),
        max_depth: z.number().default(3).describe('Max depth'),
      });

      registry.registerTool('test_tool', 'A test tool', schema, async () => '', 'always');

      const schemas = registry.getOpenAISchemas();
      expect(schemas).toHaveLength(1);

      const fn = schemas[0];
      expect(fn.type).toBe('function');
      expect(fn.function.name).toBe('test_tool');
      expect(fn.function.description).toBe('A test tool');

      const params = fn.function.parameters;
      expect(params.type).toBe('object');

      // Required fields: path, count, verbose, mode (not optional or default)
      expect(params.required).toContain('path');
      expect(params.required).toContain('count');
      expect(params.required).toContain('verbose');
      expect(params.required).toContain('mode');
      expect(params.required).not.toContain('start_line');
      expect(params.required).not.toContain('max_depth');

      // Property types
      const props = params.properties as Record<string, any>;
      expect(props.path.type).toBe('string');
      expect(props.path.description).toBe('File path');
      expect(props.count.type).toBe('number');
      expect(props.verbose.type).toBe('boolean');
      expect(props.mode.enum).toEqual(['read', 'write']);
      expect(props.start_line.type).toBe('number');
      expect(props.max_depth.type).toBe('number');
    });

    it('filters schemas by category', () => {
      registry.registerTool('a', 'A', z.object({}), async () => '', 'coding');
      registry.registerTool('b', 'B', z.object({}), async () => '', 'always');

      expect(registry.getOpenAISchemas('coding')).toHaveLength(1);
      expect(registry.getOpenAISchemas('coding')[0].function.name).toBe('a');
    });
  });

  describe('executeTool()', () => {
    it('calls handler with validated args', async () => {
      const schema = z.object({ path: z.string() });
      let receivedArgs: any;
      const handler = async (args: z.infer<typeof schema>) => {
        receivedArgs = args;
        return 'result';
      };
      registry.registerTool('read_file', 'Read', schema, handler, 'always');

      const ctx = makeCtx();
      const result = await registry.executeTool('read_file', { path: 'foo.ts' }, ctx);
      expect(result).toBe('result');
      expect(receivedArgs).toEqual({ path: 'foo.ts' });
    });

    it('parses string args via JSON.parse then validates (SHARP_EDGES §1)', async () => {
      const schema = z.object({ path: z.string() });
      let receivedArgs: any;
      registry.registerTool('read_file', 'Read', schema, async (args) => {
        receivedArgs = args;
        return 'ok';
      }, 'always');

      const result = await registry.executeTool(
        'read_file',
        '{"path": "bar.ts"}',
        makeCtx(),
      );
      expect(result).toBe('ok');
      expect(receivedArgs).toEqual({ path: 'bar.ts' });
    });

    it('returns helpful error for invalid JSON string args', async () => {
      const schema = z.object({ path: z.string() });
      registry.registerTool('read_file', 'Read', schema, async () => 'ok', 'always');

      const result = await registry.executeTool(
        'read_file',
        'not valid json at all',
        makeCtx(),
      );
      expect(result).toContain('Error');
      expect(result).toContain('path');
      // Must NOT be an opaque error
      expect(result).not.toContain('Detailed information is not available');
    });

    it('routes "*** Begin Patch" string to apply_patch handler', async () => {
      let receivedArgs: any;
      const patchSchema = z.object({
        path: z.string(),
        old_str: z.string(),
        new_str: z.string(),
      });
      registry.registerTool('apply_patch', 'Patch', patchSchema, async (args) => {
        receivedArgs = args;
        return 'patched';
      }, 'coding');

      const patchContent = '*** Begin Patch\n*** Update File: src/main.ts\n@@@ some diff';
      const result = await registry.executeTool('apply_patch', patchContent, makeCtx());
      // Should pass the raw patch string to handler (handler deals with Codex format)
      expect(result).toBe('patched');
      expect(receivedArgs).toBeDefined();
    });

    it('returns actionable error with field name for missing required field', async () => {
      const schema = z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File content'),
      });
      registry.registerTool('create_file', 'Create', schema, async () => 'ok', 'coding');

      const result = await registry.executeTool('create_file', { path: 'foo.ts' }, makeCtx());
      expect(result).toContain('Error');
      expect(result).toContain('content');
    });

    it('returns "Unknown tool" for unregistered tool', async () => {
      const result = await registry.executeTool('nonexistent', {}, makeCtx());
      expect(result).toContain('Unknown tool');
      expect(result).toContain('nonexistent');
    });

    it('rejects coding-only tools when codingMode=false', async () => {
      registry.registerTool('read_file', 'Read', z.object({}), async () => 'ok', 'coding');

      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool('read_file', {}, ctx);
      expect(result).toContain('coding mode');
    });

    it('allows "always" tools regardless of codingMode', async () => {
      registry.registerTool('web_search', 'Search', z.object({ q: z.string() }), async () => 'results', 'always');

      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool('web_search', { q: 'test' }, ctx);
      expect(result).toBe('results');
    });

    it('catches handler errors and returns actionable message', async () => {
      registry.registerTool('boom', 'Boom', z.object({}), async () => {
        throw new Error('Something exploded');
      }, 'always');

      const result = await registry.executeTool('boom', {}, makeCtx());
      expect(result).toContain('Error');
      expect(result).toContain('Something exploded');
    });
  });
});
