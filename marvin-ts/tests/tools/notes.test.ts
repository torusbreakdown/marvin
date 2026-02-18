import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerNotesTools } from '../../src/tools/notes.js';
import type { ToolContext } from '../../src/types.js';

let tmpDir: string;
let notesDir: string;
let projectDir: string;
let registry: ToolRegistry;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: projectDir,
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

describe('Notes Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-notes-'));
    notesDir = join(tmpDir, 'Notes');
    projectDir = join(tmpDir, 'project');
    mkdirSync(notesDir, { recursive: true });
    mkdirSync(join(projectDir, '.marvin', 'notes'), { recursive: true });
    registry = new ToolRegistry();
    registerNotesTools(registry, notesDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('write_note', () => {
    it('creates file in ~/Notes/ in interactive mode', async () => {
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool(
        'write_note',
        { filename: 'test.md', content: '# My Note\nHello world' },
        ctx,
      );
      expect(result).toContain('test.md');
      expect(existsSync(join(notesDir, 'test.md'))).toBe(true);
      expect(readFileSync(join(notesDir, 'test.md'), 'utf-8')).toBe('# My Note\nHello world');
    });

    it('creates file in .marvin/notes/ in coding mode (SHARP_EDGES §13)', async () => {
      const ctx = makeCtx({ codingMode: true, workingDir: projectDir });
      const result = await registry.executeTool(
        'write_note',
        { filename: 'impl-notes.md', content: 'Implementation details' },
        ctx,
      );
      expect(result).toContain('impl-notes.md');
      const expectedPath = join(projectDir, '.marvin', 'notes', 'impl-notes.md');
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf-8')).toBe('Implementation details');
    });
  });

  describe('read_note', () => {
    it('reads note content from notes dir', async () => {
      writeFileSync(join(notesDir, 'existing.md'), 'Hello from note');
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool(
        'read_note',
        { filename: 'existing.md' },
        ctx,
      );
      expect(result).toContain('Hello from note');
    });

    it('returns error for missing note', async () => {
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool(
        'read_note',
        { filename: 'nonexistent.md' },
        ctx,
      );
      expect(result).toContain('Error');
    });
  });

  describe('notes_ls', () => {
    it('lists all notes in notes dir', async () => {
      writeFileSync(join(notesDir, 'a.md'), 'aaa');
      writeFileSync(join(notesDir, 'b.txt'), 'bbb');
      mkdirSync(join(notesDir, 'subdir'));
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool('notes_ls', {}, ctx);
      expect(result).toContain('a.md');
      expect(result).toContain('b.txt');
      expect(result).toContain('subdir');
    });
  });

  describe('search_notes', () => {
    it('finds matching content in notes', async () => {
      writeFileSync(join(notesDir, 'recipe.md'), 'chicken tikka masala\ningredients: chicken');
      writeFileSync(join(notesDir, 'other.md'), 'nothing here');
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool(
        'search_notes',
        { query: 'chicken' },
        ctx,
      );
      expect(result).toContain('recipe.md');
      expect(result).toContain('chicken');
    });

    it('returns message when no matches found', async () => {
      writeFileSync(join(notesDir, 'note.md'), 'nothing relevant');
      const ctx = makeCtx({ codingMode: false });
      const result = await registry.executeTool(
        'search_notes',
        { query: 'zzznonexistent' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('no match');
    });
  });
});
