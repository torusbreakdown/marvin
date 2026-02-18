import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname, platform, arch, release, uptime, cpus, totalmem, freemem, userInfo } from 'node:os';
import type { ToolRegistry } from './registry.js';

function getSystemInfo(): string {
  const cpu = cpus();
  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;

  const lines: string[] = [
    `Hostname: ${hostname()}`,
    `OS: ${platform()} ${release()} (${arch()})`,
    `User: ${userInfo().username}`,
    `Uptime: ${formatDuration(uptime())}`,
    '',
    `CPU: ${cpu[0]?.model ?? 'unknown'} (${cpu.length} cores)`,
    `Memory: ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${Math.round(usedMem / totalMem * 100)}% used)`,
  ];

  // Load average (Unix only)
  try {
    const loadavg = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);
    lines.push(`Load: ${loadavg.slice(0, 3).join(' ')}`);
  } catch { /* not Linux */ }

  // GPU info
  try {
    const gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf-8', timeout: 5000 }).trim();
    for (const line of gpu.split('\n')) {
      const [name, memTotal, memUsed, util] = line.split(',').map(s => s.trim());
      lines.push(`GPU: ${name} — ${memUsed}/${memTotal} MiB VRAM (${util}% util)`);
    }
  } catch { /* no nvidia-smi */ }

  // Disk usage
  try {
    const df = execFileSync('df', ['-h', '--output=target,size,used,avail,pcent', '/'], { encoding: 'utf-8', timeout: 5000 });
    const dfLines = df.trim().split('\n');
    if (dfLines.length > 1) {
      lines.push('', 'Disk:');
      for (const dl of dfLines.slice(1)) {
        lines.push(`  ${dl.trim()}`);
      }
    }
  } catch { /* df not available */ }

  // Home disk if separate mount
  try {
    const dfHome = execFileSync('df', ['-h', '--output=target,size,used,avail,pcent', '/home'], { encoding: 'utf-8', timeout: 5000 });
    const dfLines = dfHome.trim().split('\n');
    if (dfLines.length > 1) {
      const homeLine = dfLines[1].trim();
      if (!homeLine.startsWith('/')) {
        // already shown
      } else {
        lines.push(`  ${homeLine}`);
      }
    }
  } catch { /* ok */ }

  return lines.join('\n');
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function registerUtilitiesTools(registry: ToolRegistry): void {
  registry.registerTool(
    'convert_units',
    'Convert between units or currencies',
    z.object({
      value: z.number().describe('Value to convert'),
      from: z.string().describe('Source unit'),
      to: z.string().describe('Target unit'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'dictionary_lookup',
    'Look up word definitions and synonyms',
    z.object({
      word: z.string().describe('Word to look up'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'translate_text',
    'Translate text between languages',
    z.object({
      text: z.string().describe('Text to translate'),
      from: z.string().default('en').describe('Source language code'),
      to: z.string().describe('Target language code'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'system_info',
    'Get system information (OS, CPU, memory, disk, GPU)',
    z.object({}),
    async () => getSystemInfo(),
    'always',
  );

  registry.registerTool(
    'read_rss',
    'Fetch and display RSS/Atom feed entries',
    z.object({
      url: z.string().describe('Feed URL'),
      max_entries: z.number().default(10).describe('Max entries'),
    }),
    async () => 'Not yet implemented',
    'always',
  );
}
