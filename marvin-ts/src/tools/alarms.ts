import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ToolRegistry } from './registry.js';
import type { ToolContext } from '../types.js';

interface AlarmEntry {
  label: string;
  message: string;
  time: string; // ISO string of when the alarm fires
}

function getAlarmsDir(overrideDir?: string): string {
  return overrideDir ?? join(homedir(), '.config', 'local-finder', 'alarms');
}

function parseRelativeTime(timeStr: string): Date | null {
  const match = timeStr.match(/^(\d+)\s*(m|h|min|mins|hour|hours)$/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const now = new Date();
  if (unit.startsWith('h')) {
    now.setHours(now.getHours() + val);
  } else {
    now.setMinutes(now.getMinutes() + val);
  }
  return now;
}

function parseTime(timeStr: string): Date | null {
  // Try relative time first
  const rel = parseRelativeTime(timeStr);
  if (rel) return rel;

  // Try absolute YYYY-MM-DD HH:MM
  const absMatch = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (absMatch) {
    return new Date(
      parseInt(absMatch[1]),
      parseInt(absMatch[2]) - 1,
      parseInt(absMatch[3]),
      parseInt(absMatch[4]),
      parseInt(absMatch[5]),
    );
  }

  // Try HH:MM for today/tomorrow
  const hhmmMatch = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (hhmmMatch) {
    const now = new Date();
    const target = new Date();
    target.setHours(parseInt(hhmmMatch[1]), parseInt(hhmmMatch[2]), 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  return null;
}

export function registerAlarmsTools(registry: ToolRegistry, alarmsDirOverride?: string): void {
  const alarmsDir = getAlarmsDir(alarmsDirOverride);

  registry.registerTool(
    'set_alarm',
    'Set an alarm that fires at a specific time',
    z.object({
      time: z.string().describe("When: 'HH:MM', 'YYYY-MM-DD HH:MM', or relative like '30m', '2h'"),
      message: z.string().describe('Alarm message'),
      label: z.string().default('local-finder-alarm').describe('Short label'),
    }),
    async (args, _ctx) => {
      const fireTime = parseTime(args.time);
      if (!fireTime) return `Error: Could not parse time: ${args.time}`;

      if (!existsSync(alarmsDir)) mkdirSync(alarmsDir, { recursive: true });
      const entry: AlarmEntry = {
        label: args.label,
        message: args.message,
        time: fireTime.toISOString(),
      };
      writeFileSync(join(alarmsDir, `${args.label}.json`), JSON.stringify(entry, null, 2));
      return `Alarm set: "${args.label}" at ${fireTime.toLocaleString()} — ${args.message}`;
    },
    'always',
  );

  registry.registerTool(
    'list_alarms',
    'List all active alarms',
    z.object({}),
    async (_args, _ctx) => {
      if (!existsSync(alarmsDir)) return 'No active alarms.';
      const files = readdirSync(alarmsDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) return 'No active alarms.';
      return files.map(f => {
        const entry: AlarmEntry = JSON.parse(readFileSync(join(alarmsDir, f), 'utf-8'));
        return `• ${entry.label} — ${entry.time} — ${entry.message}`;
      }).join('\n');
    },
    'always',
  );

  registry.registerTool(
    'cancel_alarm',
    'Cancel an alarm by its label',
    z.object({
      label: z.string().describe('Label of alarm to cancel'),
    }),
    async (args, _ctx) => {
      const filePath = join(alarmsDir, `${args.label}.json`);
      if (!existsSync(filePath)) return `Error: No alarm found with label: ${args.label}`;
      unlinkSync(filePath);
      return `Cancelled alarm: ${args.label}`;
    },
    'always',
  );
}
