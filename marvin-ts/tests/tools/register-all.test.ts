import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerAllTools } from '../../src/tools/register-all.js';
import type { SessionUsage } from '../../src/types.js';

describe('registerAllTools', () => {
  it('registers all tool modules without errors', () => {
    const registry = new ToolRegistry();
    const usage: SessionUsage = {
      totalCostUsd: 0,
      llmTurns: 0,
      modelTurns: {},
      modelCost: {},
      toolCallCounts: {},
    };

    expect(() => registerAllTools(registry, { getUsage: () => usage })).not.toThrow();
  });

  it('registers a large number of tools', () => {
    const registry = new ToolRegistry();
    const usage: SessionUsage = {
      totalCostUsd: 0,
      llmTurns: 0,
      modelTurns: {},
      modelCost: {},
      toolCallCounts: {},
    };

    registerAllTools(registry, { getUsage: () => usage });
    const allTools = registry.getAll();
    // Should have registered many tools from all 33 modules
    expect(allTools.length).toBeGreaterThan(30);
  });

  it('includes tools from key modules', () => {
    const registry = new ToolRegistry();
    const usage: SessionUsage = {
      totalCostUsd: 0,
      llmTurns: 0,
      modelTurns: {},
      modelCost: {},
      toolCallCounts: {},
    };

    registerAllTools(registry, { getUsage: () => usage });

    // Spot-check tools from different categories
    expect(registry.get('web_search')).toBeDefined();
    expect(registry.get('git_status')).toBeDefined();
    expect(registry.get('write_note')).toBeDefined();
    expect(registry.get('exit_app')).toBeDefined();
    expect(registry.get('get_usage')).toBeDefined();
    expect(registry.get('osm_search')).toBeDefined();
  });

  it('all registered tools have valid OpenAI schemas', () => {
    const registry = new ToolRegistry();
    const usage: SessionUsage = {
      totalCostUsd: 0,
      llmTurns: 0,
      modelTurns: {},
      modelCost: {},
      toolCallCounts: {},
    };

    registerAllTools(registry, { getUsage: () => usage });
    const schemas = registry.getOpenAISchemas();

    expect(schemas.length).toBeGreaterThan(30);
    for (const schema of schemas) {
      expect(schema.type).toBe('function');
      expect(schema.function.name).toBeTruthy();
      expect(schema.function.description).toBeTruthy();
      expect(schema.function.parameters.type).toBe('object');
    }
  });
});
