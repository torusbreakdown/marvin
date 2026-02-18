import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

const timers = new Map<string, { start: number; duration?: number }>();

function parseDuration(dur: string): number {
  let ms = 0;
  const h = dur.match(/(\d+)\s*h/);
  const m = dur.match(/(\d+)\s*m(?!s)/);
  const s = dur.match(/(\d+)\s*s/);
  if (h) ms += parseInt(h[1], 10) * 3600000;
  if (m) ms += parseInt(m[1], 10) * 60000;
  if (s) ms += parseInt(s[1], 10) * 1000;
  return ms;
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function describeTimer(name: string, timer: { start: number; duration?: number }): string {
  const elapsed = Date.now() - timer.start;
  if (timer.duration != null) {
    const remaining = timer.duration - elapsed;
    if (remaining <= 0) return `⏰ '${name}': countdown finished (elapsed ${formatTime(elapsed)})`;
    return `⏳ '${name}': ${formatTime(remaining)} remaining`;
  }
  return `⏱️ '${name}': ${formatTime(elapsed)} elapsed`;
}

export function registerTimersTools(registry: ToolRegistry): void {
  registry.registerTool(
    'timer_start',
    'Start a named countdown or stopwatch',
    z.object({
      name: z.string().describe('Timer name'),
      duration: z.string().default('').describe('Duration (e.g. "5m", "1h30m") or empty for stopwatch'),
    }),
    async ({ name, duration }) => {
      const dur = duration.trim();
      const entry: { start: number; duration?: number } = { start: Date.now() };
      if (dur) {
        const ms = parseDuration(dur);
        if (ms <= 0) return `Invalid duration: '${dur}'`;
        entry.duration = ms;
      }
      timers.set(name, entry);
      return entry.duration != null
        ? `Timer '${name}' started (countdown: ${formatTime(entry.duration)})`
        : `Stopwatch '${name}' started`;
    },
    'always',
  );

  registry.registerTool(
    'timer_check',
    'Check timer status',
    z.object({
      name: z.string().default('').describe('Timer name (empty for all)'),
    }),
    async ({ name }) => {
      if (name) {
        const timer = timers.get(name);
        if (!timer) return `No timer named '${name}'`;
        return describeTimer(name, timer);
      }
      if (timers.size === 0) return 'No active timers';
      return Array.from(timers.entries())
        .map(([n, t]) => describeTimer(n, t))
        .join('\n');
    },
    'always',
  );

  registry.registerTool(
    'timer_stop',
    'Stop a timer and report final time',
    z.object({
      name: z.string().describe('Timer name to stop'),
    }),
    async ({ name }) => {
      const timer = timers.get(name);
      if (!timer) return `No timer named '${name}'`;
      const elapsed = Date.now() - timer.start;
      timers.delete(name);
      return `Timer '${name}' stopped after ${formatTime(elapsed)}`;
    },
    'always',
  );
}
