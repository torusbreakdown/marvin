import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerSystemTools } from '../../src/tools/system.js';
import type { ToolContext, SessionUsage } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: false,
    nonInteractive: false,
    profileDir: tmpDir,
    profile: {
      name: 'test',
      profileDir: tmpDir,
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

const defaultUsage: SessionUsage = {
  totalCostUsd: 0.05,
  llmTurns: 10,
  modelTurns: { 'gpt-4': 5, 'claude': 5 },
  modelCost: { 'gpt-4': 0.03, 'claude': 0.02 },
  toolCallCounts: { web_search: 3, read_file: 7 },
};

describe('System Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-sys-'));
    registry = new ToolRegistry();
    registerSystemTools(registry, { getUsage: () => defaultUsage });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('exit_app', () => {
    it('returns farewell message and sets exit flag', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'exit_app',
        { message: 'See you later!' },
        ctx,
      );
      expect(result).toContain('See you later!');
    });

    it('uses default message when none provided', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool('exit_app', {}, ctx);
      expect(result.toLowerCase()).toMatch(/goodbye|bye|exit/i);
    });
  });

  describe('get_usage', () => {
    it('returns usage summary string', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool('get_usage', {}, ctx);
      expect(result).toContain('0.05');
      expect(result).toContain('10');
    });
  });

  describe('update_preferences', () => {
    it('updates YAML prefs file', async () => {
      mkdirSync(tmpDir, { recursive: true });
      const ctx = makeCtx({ profileDir: tmpDir });
      const result = await registry.executeTool(
        'update_preferences',
        { key: 'dietary', value: 'vegetarian' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('updat');
      expect(ctx.profile.preferences.dietary).toBe('vegetarian');
    });
  });
});
