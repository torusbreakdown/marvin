import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerGithubTools } from '../../src/tools/github.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let clonesDir: string;
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

describe('GitHub Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-gh-'));
    clonesDir = join(tmpDir, 'github-clones');
    mkdirSync(clonesDir, { recursive: true });
    registry = new ToolRegistry();
    registerGithubTools(registry, clonesDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('github_read_file', () => {
    it('reads file from cloned repo directory', async () => {
      const repoDir = join(clonesDir, 'owner', 'repo');
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, 'README.md'), '# Hello World');

      const ctx = makeCtx();
      const result = await registry.executeTool(
        'github_read_file',
        { owner: 'owner', repo: 'repo', path: 'README.md' },
        ctx,
      );
      expect(result).toContain('Hello World');
    });

    it('returns error for non-cloned repo', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'github_read_file',
        { owner: 'nobody', repo: 'nothing', path: 'file.txt' },
        ctx,
      );
      expect(result).toContain('Error');
    });
  });

  describe('github_grep', () => {
    it('searches within cloned repo', async () => {
      const repoDir = join(clonesDir, 'testorg', 'testrepo');
      mkdirSync(repoDir, { recursive: true });
      writeFileSync(join(repoDir, 'main.ts'), 'function hello() {\n  return "world";\n}\n');

      const ctx = makeCtx();
      const result = await registry.executeTool(
        'github_grep',
        { owner: 'testorg', repo: 'testrepo', pattern: 'hello' },
        ctx,
      );
      expect(result).toContain('hello');
      expect(result).toContain('main.ts');
    });
  });

  describe('github_clone', () => {
    it('registers the tool', () => {
      const tool = registry.get('github_clone');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('github_clone');
    });
  });
});
