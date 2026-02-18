import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerCodingTools } from '../../src/tools/coding.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: null,
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

describe('Coding Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-coding-'));
    registry = new ToolRegistry();
    registerCodingTools(registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('set_working_dir', () => {
    it('validates directory exists and sets it in context', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'set_working_dir',
        { path: tmpDir },
        ctx,
      );
      expect(result).toContain(tmpDir);
      expect(ctx.workingDir).toBe(tmpDir);
    });

    it('rejects nonexistent directory', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'set_working_dir',
        { path: '/nonexistent/dir/xyz123' },
        ctx,
      );
      expect(result).toContain('Error');
    });
  });

  describe('review_status', () => {
    it('reads .marvin/jobs/ JSON and checks status', async () => {
      const jobsDir = join(tmpDir, '.marvin', 'jobs');
      mkdirSync(jobsDir, { recursive: true });
      writeFileSync(
        join(jobsDir, 'job-1.json'),
        JSON.stringify({
          id: 'job-1',
          pid: 99999999,
          status: 'running',
          started: new Date().toISOString(),
          ticket: 'T-001',
        }),
      );

      const ctx = makeCtx({ workingDir: tmpDir });
      const result = await registry.executeTool('review_status', {}, ctx);
      expect(result).toContain('job-1');
    });

    it('reports no jobs when directory is empty', async () => {
      mkdirSync(join(tmpDir, '.marvin', 'jobs'), { recursive: true });
      const ctx = makeCtx({ workingDir: tmpDir });
      const result = await registry.executeTool('review_status', {}, ctx);
      expect(result.toLowerCase()).toContain('no');
    });
  });
});
