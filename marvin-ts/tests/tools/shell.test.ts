import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerShellTools } from '../../src/tools/shell.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: tmpDir,
    codingMode: true,
    nonInteractive: true, // auto-approve commands
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

describe('Shell Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-shell-'));
    registry = new ToolRegistry();
    registerShellTools(registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('run_command', () => {
    it('executes command and returns stdout', async () => {
      const result = await registry.executeTool(
        'run_command',
        { command: 'echo hello world' },
        makeCtx(),
      );
      expect(result).toContain('hello world');
    });

    it('timeout works', async () => {
      const result = await registry.executeTool(
        'run_command',
        { command: 'sleep 999', timeout: 1 },
        makeCtx(),
      );
      expect(result).toContain('timeout');
    }, 10_000);

    it('non-zero exit returns stderr', async () => {
      const result = await registry.executeTool(
        'run_command',
        { command: 'ls /nonexistent_dir_12345' },
        makeCtx(),
      );
      // Should contain error output (stderr or exit code info)
      expect(result).toMatch(/error|no such|exit|cannot/i);
    });

    it('requires confirmation in interactive mode when confirmCommand is provided', async () => {
      let confirmCalled = false;
      const ctx = makeCtx({
        nonInteractive: false,
        confirmCommand: async (cmd: string) => {
          confirmCalled = true;
          return false; // deny
        },
      });
      const result = await registry.executeTool(
        'run_command',
        { command: 'echo should not run' },
        ctx,
      );
      expect(confirmCalled).toBe(true);
      expect(result).toContain('declined');
    });
  });
});
