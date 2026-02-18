import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

function getCalDir(overrideDir?: string): string {
  return overrideDir ?? join(homedir(), '.config', 'local-finder', 'calendar');
}

function parseIcsEvents(dir: string): Array<{ uid: string; summary: string; dtstart: string; dtend?: string; file: string }> {
  if (!existsSync(dir)) return [];
  const events: Array<{ uid: string; summary: string; dtstart: string; dtend?: string; file: string }> = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ics'))) {
    const content = readFileSync(join(dir, f), 'utf-8');
    const uid = content.match(/UID:(.+)/)?.[1]?.trim() ?? '';
    const summary = content.match(/SUMMARY:(.+)/)?.[1]?.trim() ?? '';
    const dtstart = content.match(/DTSTART:(.+)/)?.[1]?.trim() ?? '';
    const dtend = content.match(/DTEND:(.+)/)?.[1]?.trim();
    events.push({ uid, summary, dtstart, dtend, file: f });
  }
  return events;
}

export function registerCalendarTools(registry: ToolRegistry, calDirOverride?: string): void {
  const calDir = getCalDir(calDirOverride);

  registry.registerTool(
    'calendar_list_upcoming',
    'List upcoming calendar events',
    z.object({
      days: z.number().default(7).describe('Number of days to look ahead'),
    }),
    async (_args, _ctx) => {
      const events = parseIcsEvents(calDir);
      if (events.length === 0) return 'No upcoming events.';
      return events
        .map(e => `• ${e.summary} — ${e.dtstart}${e.dtend ? ` to ${e.dtend}` : ''} (UID: ${e.uid})`)
        .join('\n');
    },
    'always',
  );

  registry.registerTool(
    'calendar_add_event',
    'Add a calendar event',
    z.object({
      title: z.string().describe('Event title'),
      start: z.string().describe('Start time (YYYY-MM-DD HH:MM)'),
      end: z.string().default('').describe('End time (YYYY-MM-DD HH:MM)'),
      description: z.string().default('').describe('Event description'),
    }),
    async (args, _ctx) => {
      if (!existsSync(calDir)) {
        const { mkdirSync } = await import('fs');
        mkdirSync(calDir, { recursive: true });
      }
      const uid = randomUUID();
      const dtstart = args.start.replace(/[-: ]/g, '').replace(/(\d{8})(\d{4})/, '$1T$2' + '00');
      const dtend = args.end ? args.end.replace(/[-: ]/g, '').replace(/(\d{8})(\d{4})/, '$1T$2' + '00') : '';
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        `SUMMARY:${args.title}`,
        `DTSTART:${dtstart}`,
        ...(dtend ? [`DTEND:${dtend}`] : []),
        ...(args.description ? [`DESCRIPTION:${args.description}`] : []),
        `UID:${uid}`,
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      writeFileSync(join(calDir, `${uid}.ics`), ics);
      return `Added event: ${args.title} (UID: ${uid})`;
    },
    'always',
  );

  registry.registerTool(
    'calendar_delete_event',
    'Delete a calendar event by UID or title',
    z.object({
      uid: z.string().default('').describe('Event UID'),
      title: z.string().default('').describe('Event title (alternative to UID)'),
    }),
    async (args, _ctx) => {
      const events = parseIcsEvents(calDir);
      const match = events.find(e =>
        (args.uid && e.uid === args.uid) ||
        (args.title && e.summary.toLowerCase().includes(args.title.toLowerCase()))
      );
      if (!match) return 'Error: Event not found.';
      unlinkSync(join(calDir, match.file));
      return `Deleted event: ${match.summary}`;
    },
    'always',
  );
}
