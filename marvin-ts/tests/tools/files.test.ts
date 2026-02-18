import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerFilesTools } from '../../src/tools/files.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;
let ctx: ToolContext;

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
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
  };
}

describe('File Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-files-'));
    registry = new ToolRegistry();
    registerFilesTools(registry);
    ctx = makeCtx(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('read_file', () => {
    it('reads content and returns with line numbers', async () => {
      writeFileSync(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\n');
      const result = await registry.executeTool('read_file', { path: 'hello.txt' }, ctx);
      expect(result).toContain('1:');
      expect(result).toContain('line1');
      expect(result).toContain('2:');
      expect(result).toContain('line2');
    });

    it('rejects files >10KB without start_line/end_line', async () => {
      const bigContent = 'x'.repeat(11_000);
      writeFileSync(join(tmpDir, 'big.txt'), bigContent);
      const result = await registry.executeTool('read_file', { path: 'big.txt' }, ctx);
      expect(result).toContain('Error');
      expect(result).toMatch(/line/i); // should mention line count or line ranges
    });

    it('reads specific line range with start_line/end_line', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(join(tmpDir, 'many.txt'), lines);
      const result = await registry.executeTool(
        'read_file',
        { path: 'many.txt', start_line: 5, end_line: 10 },
        ctx,
      );
      expect(result).toContain('line 5');
      expect(result).toContain('line 10');
      expect(result).not.toContain('line 4');
      expect(result).not.toContain('line 11');
    });

    it('allows large files when start_line/end_line are provided', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `content line ${i + 1}`).join('\n');
      writeFileSync(join(tmpDir, 'large.txt'), lines);
      const result = await registry.executeTool(
        'read_file',
        { path: 'large.txt', start_line: 1, end_line: 5 },
        ctx,
      );
      expect(result).toContain('content line 1');
      expect(result).not.toContain('Error');
    });
  });

  describe('create_file', () => {
    it('creates file and returns confirmation', async () => {
      const result = await registry.executeTool(
        'create_file',
        { path: 'new.txt', content: 'hello world' },
        ctx,
      );
      expect(result).toContain('Created');
      expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('hello world');
    });

    it('rejects absolute path with working dir in error', async () => {
      const result = await registry.executeTool(
        'create_file',
        { path: '/etc/passwd', content: 'hack' },
        ctx,
      );
      expect(result).toContain('Error');
      expect(result).toContain(tmpDir);
    });

    it('rejects path with ".."', async () => {
      const result = await registry.executeTool(
        'create_file',
        { path: '../escape.txt', content: 'hack' },
        ctx,
      );
      expect(result).toContain('Error');
      expect(result).toMatch(/\.\./);
    });

    it('creates nested directories', async () => {
      const result = await registry.executeTool(
        'create_file',
        { path: 'sub/dir/file.txt', content: 'nested' },
        ctx,
      );
      expect(result).toContain('Created');
      expect(readFileSync(join(tmpDir, 'sub/dir/file.txt'), 'utf-8')).toBe('nested');
    });
  });

  describe('append_file', () => {
    it('appends content to existing file', async () => {
      writeFileSync(join(tmpDir, 'existing.txt'), 'first\n');
      const result = await registry.executeTool(
        'append_file',
        { path: 'existing.txt', content: 'second\n' },
        ctx,
      );
      expect(result).toContain('Appended');
      expect(readFileSync(join(tmpDir, 'existing.txt'), 'utf-8')).toBe('first\nsecond\n');
    });
  });

  describe('apply_patch', () => {
    it('replaces old_str with new_str', async () => {
      writeFileSync(join(tmpDir, 'patch.txt'), 'hello world\nfoo bar\n');
      const result = await registry.executeTool(
        'apply_patch',
        { path: 'patch.txt', old_str: 'hello world', new_str: 'hello universe' },
        ctx,
      );
      expect(result).toContain('Applied');
      expect(readFileSync(join(tmpDir, 'patch.txt'), 'utf-8')).toContain('hello universe');
    });

    it('returns error when old_str not found', async () => {
      writeFileSync(join(tmpDir, 'patch2.txt'), 'hello world\n');
      const result = await registry.executeTool(
        'apply_patch',
        { path: 'patch2.txt', old_str: 'nonexistent text', new_str: 'replacement' },
        ctx,
      );
      expect(result).toContain('Error');
      expect(result).toContain('not found');
    });
  });

  describe('list_files', () => {
    it('lists directory tree', async () => {
      mkdirSync(join(tmpDir, 'src'));
      writeFileSync(join(tmpDir, 'src/main.ts'), '');
      writeFileSync(join(tmpDir, 'README.md'), '');
      const result = await registry.executeTool('list_files', { path: '.' }, ctx);
      expect(result).toContain('src');
      expect(result).toContain('main.ts');
      expect(result).toContain('README.md');
    });
  });

  describe('grep_files', () => {
    it('finds pattern matches', async () => {
      writeFileSync(join(tmpDir, 'search.ts'), 'function hello() {\n  return "world";\n}\n');
      const result = await registry.executeTool(
        'grep_files',
        { pattern: 'hello' },
        ctx,
      );
      expect(result).toContain('hello');
      expect(result).toContain('search.ts');
    });
  });

  describe('Path sandboxing', () => {
    it('rejects absolute paths with working dir and tree in error', async () => {
      writeFileSync(join(tmpDir, 'safe.txt'), 'safe');
      const result = await registry.executeTool(
        'read_file',
        { path: '/etc/passwd' },
        ctx,
      );
      expect(result).toContain('Error');
      expect(result.toLowerCase()).toContain('absolute');
      expect(result).toContain(tmpDir);
    });

    it('rejects ".." traversal', async () => {
      const result = await registry.executeTool(
        'read_file',
        { path: '../../../etc/passwd' },
        ctx,
      );
      expect(result).toContain('Error');
      expect(result).toMatch(/\.\./);
    });
  });
});
