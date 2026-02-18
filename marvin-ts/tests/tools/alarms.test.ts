import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerAlarmsTools } from '../../src/tools/alarms.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

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

describe('Alarms Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-alarms-'));
    registry = new ToolRegistry();
    registerAlarmsTools(registry, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('set_alarm', () => {
    it('creates alarm entry file', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'set_alarm',
        { time: '2099-12-31 23:59', message: 'New Year!', label: 'nye-alarm' },
        ctx,
      );
      expect(result).toContain('nye-alarm');
      expect(result.toLowerCase()).toContain('alarm');
    });

    it('supports relative time like 30m', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'set_alarm',
        { time: '30m', message: 'Timer up' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('alarm');
      expect(result).not.toContain('Error');
    });
  });

  describe('list_alarms', () => {
    it('lists active alarms', async () => {
      const ctx = makeCtx();
      // Set an alarm first
      await registry.executeTool(
        'set_alarm',
        { time: '2099-12-31 23:59', message: 'Test alarm', label: 'test-list' },
        ctx,
      );
      const result = await registry.executeTool('list_alarms', {}, ctx);
      expect(result).toContain('test-list');
    });

    it('shows message when no alarms', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool('list_alarms', {}, ctx);
      expect(result.toLowerCase()).toContain('no');
    });
  });

  describe('cancel_alarm', () => {
    it('removes alarm by label', async () => {
      const ctx = makeCtx();
      await registry.executeTool(
        'set_alarm',
        { time: '2099-12-31 23:59', message: 'Cancel me', label: 'cancel-test' },
        ctx,
      );
      const result = await registry.executeTool(
        'cancel_alarm',
        { label: 'cancel-test' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('cancel');

      // Verify it's gone
      const listResult = await registry.executeTool('list_alarms', {}, ctx);
      expect(listResult).not.toContain('cancel-test');
    });
  });
});
