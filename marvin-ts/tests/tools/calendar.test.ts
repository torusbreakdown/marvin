import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerCalendarTools } from '../../src/tools/calendar.js';
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

describe('Calendar Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-cal-'));
    registry = new ToolRegistry();
    registerCalendarTools(registry, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('calendar_list_upcoming', () => {
    it('returns events from .ics files', async () => {
      const icsContent = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'SUMMARY:Team Meeting',
        'DTSTART:29990101T100000',
        'DTEND:29990101T110000',
        'UID:test-event-1',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      writeFileSync(join(tmpDir, 'test.ics'), icsContent);

      const ctx = makeCtx();
      const result = await registry.executeTool('calendar_list_upcoming', {}, ctx);
      expect(result).toContain('Team Meeting');
    });

    it('returns message when no events', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool('calendar_list_upcoming', {}, ctx);
      expect(result.toLowerCase()).toContain('no');
    });
  });

  describe('calendar_add_event', () => {
    it('creates .ics file for new event', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'calendar_add_event',
        {
          title: 'Lunch',
          start: '2099-06-15 12:00',
          end: '2099-06-15 13:00',
        },
        ctx,
      );
      expect(result).toContain('Lunch');
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.ics'));
      expect(files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('calendar_delete_event', () => {
    it('deletes event by UID', async () => {
      const icsContent = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'SUMMARY:Delete Me',
        'DTSTART:29990101T100000',
        'UID:delete-me-uid',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      writeFileSync(join(tmpDir, 'delete-test.ics'), icsContent);

      const ctx = makeCtx();
      const result = await registry.executeTool(
        'calendar_delete_event',
        { uid: 'delete-me-uid' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('delet');
    });
  });

  describe('platform detection', () => {
    it('detects current platform as linux or darwin', async () => {
      // The tool should work on the current platform
      const ctx = makeCtx();
      const result = await registry.executeTool('calendar_list_upcoming', {}, ctx);
      // Should not error about unsupported platform
      expect(result).not.toContain('unsupported platform');
    });
  });
});
