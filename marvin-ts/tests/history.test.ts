import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatLogEntry } from '../src/types.js';
import { loadChatLog, appendChatLog, saveChatLog } from '../src/history.js';

describe('history.ts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-history-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadChatLog', () => {
    it('reads chat_log.json from profile dir, returns ChatLogEntry[]', () => {
      const entries: ChatLogEntry[] = [
        { role: 'you', text: 'Hello', time: '14:30' },
        { role: 'assistant', text: 'Hi there!', time: '14:30' },
        { role: 'system', text: 'Mode changed', time: '14:31' },
      ];
      require('node:fs').writeFileSync(
        join(tmpDir, 'chat_log.json'),
        JSON.stringify(entries),
      );

      const result = loadChatLog(tmpDir);
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe('you');
      expect(result[0].text).toBe('Hello');
      expect(result[0].time).toBe('14:30');
      expect(result[1].role).toBe('assistant');
      expect(result[2].role).toBe('system');
    });

    it('missing file → empty array', () => {
      const result = loadChatLog(tmpDir);
      expect(result).toEqual([]);
    });
  });

  describe('appendChat', () => {
    it('appends entry with role, text, time', () => {
      // Create initial file
      const initial: ChatLogEntry[] = [
        { role: 'you', text: 'First', time: '10:00' },
      ];
      require('node:fs').writeFileSync(
        join(tmpDir, 'chat_log.json'),
        JSON.stringify(initial),
      );

      const newEntry: ChatLogEntry = { role: 'assistant', text: 'Response', time: '10:01' };
      appendChatLog(tmpDir, newEntry);

      const result = loadChatLog(tmpDir);
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe('assistant');
      expect(result[1].text).toBe('Response');
      expect(result[1].time).toBe('10:01');
    });

    it('creates file if it doesn\'t exist', () => {
      const entry: ChatLogEntry = { role: 'you', text: 'First message', time: '09:00' };
      appendChatLog(tmpDir, entry);

      expect(existsSync(join(tmpDir, 'chat_log.json'))).toBe(true);
      const result = loadChatLog(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('First message');
    });
  });

  describe('saveChatLog', () => {
    it('writes full array', () => {
      const entries: ChatLogEntry[] = [
        { role: 'you', text: 'Hello', time: '08:00' },
        { role: 'assistant', text: 'Hi', time: '08:00' },
        { role: 'you', text: 'Bye', time: '08:05' },
      ];

      saveChatLog(tmpDir, entries);

      const raw = readFileSync(join(tmpDir, 'chat_log.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].role).toBe('you');
      expect(parsed[2].text).toBe('Bye');
    });
  });

  describe('format', () => {
    it('entries have role "you"|"assistant"|"system", text string, time "HH:MM"', () => {
      const entries: ChatLogEntry[] = [
        { role: 'you', text: 'hello', time: '14:30' },
        { role: 'assistant', text: 'hi', time: '14:31' },
        { role: 'system', text: 'info', time: '14:32' },
      ];

      saveChatLog(tmpDir, entries);
      const loaded = loadChatLog(tmpDir);

      for (const entry of loaded) {
        expect(['you', 'assistant', 'system']).toContain(entry.role);
        expect(typeof entry.text).toBe('string');
        expect(typeof entry.time).toBe('string');
      }
    });
  });
});
