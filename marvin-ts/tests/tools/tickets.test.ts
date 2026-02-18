import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerTicketsTools } from '../../src/tools/tickets.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: tmpDir,
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

describe('Tickets Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-tickets-'));
    registry = new ToolRegistry();
    registerTicketsTools(registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('tk', () => {
    it('registers the tk tool', () => {
      const tool = registry.get('tk');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('tk');
      expect(tool!.category).toBe('coding');
    });

    it('first tk create is intentionally rejected (SHARP_EDGES §8)', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'tk',
        { args: 'create "Quick task"' },
        ctx,
      );
      // First creation must be rejected
      expect(result.toLowerCase()).toMatch(/reject|denied|thorough|detailed|description/);
    });

    it('second tk create attempt is allowed through', async () => {
      const ctx = makeCtx();
      // First attempt — rejected
      await registry.executeTool('tk', { args: 'create "Quick task"' }, ctx);
      // Second attempt — should not be rejected by the gate
      const result = await registry.executeTool(
        'tk',
        { args: 'create "Detailed task with acceptance criteria"' },
        ctx,
      );
      // Should not contain the rejection message
      expect(result.toLowerCase()).not.toMatch(/rejected|denied/);
    });
  });
});
