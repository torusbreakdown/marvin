import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerGitTools } from '../../src/tools/git.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeCtx(): ToolContext {
  return {
    workingDir: tmpDir,
    codingMode: true,
    nonInteractive: true,
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

function gitInit() {
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
}

describe('Git Tools', () => {
  beforeEach(() => {
    // SHARP_EDGES §6: unset GIT_DIR to prevent parent contamination
    delete process.env.GIT_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-git-'));
    registry = new ToolRegistry();
    registerGitTools(registry);
    gitInit();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('git_status', () => {
    it('shows status of working directory', async () => {
      writeFileSync(join(tmpDir, 'test.txt'), 'hello');
      const result = await registry.executeTool('git_status', {}, makeCtx());
      expect(result).toContain('test.txt');
    });

    it('shows clean status when nothing changed', async () => {
      writeFileSync(join(tmpDir, 'test.txt'), 'hello');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      const result = await registry.executeTool('git_status', {}, makeCtx());
      expect(result).toContain('clean');
    });
  });

  describe('GIT_DIR is unset', () => {
    it('unsets GIT_DIR before operations', async () => {
      // Set GIT_DIR to something wrong — should be cleaned up
      process.env.GIT_DIR = '/nonexistent/.git';
      writeFileSync(join(tmpDir, 'test.txt'), 'hello');
      const result = await registry.executeTool('git_status', {}, makeCtx());
      // Should succeed despite wrong GIT_DIR
      expect(result).toContain('test.txt');
      // Clean up
      delete process.env.GIT_DIR;
    });
  });

  describe('git_diff', () => {
    it('shows diff of changes', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'original');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      writeFileSync(join(tmpDir, 'file.txt'), 'modified');
      const result = await registry.executeTool('git_diff', {}, makeCtx());
      expect(result).toContain('modified');
    });
  });

  describe('git_log', () => {
    it('shows recent commits', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'hello');
      execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'pipe' });
      const result = await registry.executeTool('git_log', {}, makeCtx());
      expect(result).toContain('initial commit');
    });
  });

  describe('git_commit', () => {
    it('stages and commits changes', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'hello');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      writeFileSync(join(tmpDir, 'new.txt'), 'new file');
      const result = await registry.executeTool(
        'git_commit',
        { message: 'add new file', add_all: true },
        makeCtx(),
      );
      expect(result).toContain('Committed');
      // Verify commit exists
      const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' });
      expect(log).toContain('add new file');
    });
  });

  describe('git_branch', () => {
    it('lists branches', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'hello');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      const result = await registry.executeTool('git_branch', {}, makeCtx());
      expect(result).toMatch(/main|master/);
    });
  });

  describe('git_checkout', () => {
    it('creates and checks out new branch', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'hello');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      const result = await registry.executeTool(
        'git_checkout',
        { target: 'feature-branch', create_branch: true },
        makeCtx(),
      );
      expect(result).toContain('feature-branch');
      const branch = execSync('git branch --show-current', { cwd: tmpDir, encoding: 'utf-8' }).trim();
      expect(branch).toBe('feature-branch');
    });
  });

  describe('git_blame', () => {
    it('shows blame for a file', async () => {
      writeFileSync(join(tmpDir, 'file.txt'), 'hello\nworld\n');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
      const result = await registry.executeTool(
        'git_blame',
        { path: 'file.txt' },
        makeCtx(),
      );
      expect(result).toContain('hello');
      expect(result).toContain('Test');
    });
  });
});
