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
    'Convert between units (length, weight, temperature, volume, data, time, speed). Also converts currencies via exchangerate.host.',
    z.object({
      value: z.number().describe('Value to convert'),
      from: z.string().describe('Source unit (e.g. km, lb, °F, GB, USD)'),
      to: z.string().describe('Target unit (e.g. mi, kg, °C, MB, EUR)'),
    }),
    async (args) => {
      const { value, from, to } = args;
      const fl = from.toLowerCase().replace(/[°\s]/g, '');
      const tl = to.toLowerCase().replace(/[°\s]/g, '');

      // Temperature
      const tempConvert: Record<string, (v: number) => Record<string, number>> = {
        c: (v) => ({ f: v * 9 / 5 + 32, k: v + 273.15, c: v }),
        f: (v) => ({ c: (v - 32) * 5 / 9, k: (v - 32) * 5 / 9 + 273.15, f: v }),
        k: (v) => ({ c: v - 273.15, f: (v - 273.15) * 9 / 5 + 32, k: v }),
      };
      if (tempConvert[fl] && tempConvert[fl](0)[tl] !== undefined) {
        const result = tempConvert[fl](value)[tl];
        return `${value}${from} = ${result.toFixed(2)}${to}`;
      }

      // Unit conversion factors (to SI base)
      const units: Record<string, { base: string; factor: number }> = {
        // Length (meters)
        m: { base: 'length', factor: 1 }, km: { base: 'length', factor: 1000 },
        cm: { base: 'length', factor: 0.01 }, mm: { base: 'length', factor: 0.001 },
        mi: { base: 'length', factor: 1609.344 }, miles: { base: 'length', factor: 1609.344 },
        ft: { base: 'length', factor: 0.3048 }, feet: { base: 'length', factor: 0.3048 },
        in: { base: 'length', factor: 0.0254 }, inches: { base: 'length', factor: 0.0254 },
        yd: { base: 'length', factor: 0.9144 }, yards: { base: 'length', factor: 0.9144 },
        nm: { base: 'length', factor: 1852 },
        // Weight (grams)
        g: { base: 'weight', factor: 1 }, kg: { base: 'weight', factor: 1000 },
        mg: { base: 'weight', factor: 0.001 }, lb: { base: 'weight', factor: 453.592 },
        lbs: { base: 'weight', factor: 453.592 }, oz: { base: 'weight', factor: 28.3495 },
        // Volume (liters)
        l: { base: 'volume', factor: 1 }, ml: { base: 'volume', factor: 0.001 },
        gal: { base: 'volume', factor: 3.78541 }, gallon: { base: 'volume', factor: 3.78541 },
        qt: { base: 'volume', factor: 0.946353 }, cup: { base: 'volume', factor: 0.236588 },
        tbsp: { base: 'volume', factor: 0.0147868 }, tsp: { base: 'volume', factor: 0.00492892 },
        // Data (bytes)
        b: { base: 'data', factor: 1 }, kb: { base: 'data', factor: 1024 },
        mb: { base: 'data', factor: 1048576 }, gb: { base: 'data', factor: 1073741824 },
        tb: { base: 'data', factor: 1099511627776 },
        // Time (seconds)
        s: { base: 'time', factor: 1 }, sec: { base: 'time', factor: 1 },
        min: { base: 'time', factor: 60 }, h: { base: 'time', factor: 3600 },
        hr: { base: 'time', factor: 3600 }, day: { base: 'time', factor: 86400 },
        days: { base: 'time', factor: 86400 }, week: { base: 'time', factor: 604800 },
        // Speed (m/s)
        'km/h': { base: 'speed', factor: 0.277778 }, 'kmh': { base: 'speed', factor: 0.277778 },
        'mph': { base: 'speed', factor: 0.44704 }, 'm/s': { base: 'speed', factor: 1 },
        'knots': { base: 'speed', factor: 0.514444 },
      };

      const fromU = units[fl];
      const toU = units[tl];
      if (fromU && toU && fromU.base === toU.base) {
        const result = value * fromU.factor / toU.factor;
        return `${value} ${from} = ${result.toFixed(6).replace(/\.?0+$/, '')} ${to}`;
      }

      // Try currency via exchangerate API
      try {
        const resp = await fetch(`https://api.exchangerate.host/convert?from=${encodeURIComponent(from.toUpperCase())}&to=${encodeURIComponent(to.toUpperCase())}&amount=${value}`);
        const data = await resp.json() as any;
        if (data.success && data.result != null) {
          return `${value} ${from.toUpperCase()} = ${data.result.toFixed(2)} ${to.toUpperCase()} (rate: ${data.info?.rate ?? 'N/A'})`;
        }
      } catch { /* not a currency */ }

      return `Cannot convert from "${from}" to "${to}". Supported: length (km, mi, ft, m, in), weight (kg, lb, oz, g), volume (l, gal, cup, ml), data (b, kb, mb, gb, tb), time (s, min, h, day), speed (km/h, mph, m/s, knots), temperature (C, F, K), or currency codes (USD, EUR, etc).`;
    },
    'always',
  );

  registry.registerTool(
    'dictionary_lookup',
    'Look up word definitions and synonyms using the free DictionaryAPI',
    z.object({
      word: z.string().describe('Word to look up'),
    }),
    async (args) => {
      const { word } = args;
      try {
        const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
        if (!resp.ok) return `No definition found for "${word}".`;
        const data = await resp.json() as any[];
        const entry = data[0];
        const lines: string[] = [`# ${entry.word}`];
        if (entry.phonetic) lines.push(`Pronunciation: ${entry.phonetic}`);
        for (const meaning of entry.meanings ?? []) {
          lines.push(`\n**${meaning.partOfSpeech}**`);
          for (const def of (meaning.definitions ?? []).slice(0, 3)) {
            lines.push(`  - ${def.definition}`);
            if (def.example) lines.push(`    Example: "${def.example}"`);
          }
          if (meaning.synonyms?.length) lines.push(`  Synonyms: ${meaning.synonyms.slice(0, 8).join(', ')}`);
        }
        return lines.join('\n');
      } catch (err) {
        return `Error looking up "${word}": ${(err as Error).message}`;
      }
    },
    'always',
  );

  registry.registerTool(
    'translate_text',
    'Translate text between languages using LibreTranslate or MyMemory',
    z.object({
      text: z.string().describe('Text to translate'),
      from: z.string().default('en').describe('Source language code (e.g. en, fr, de, ja)'),
      to: z.string().describe('Target language code (e.g. es, zh, ko, ar)'),
    }),
    async (args) => {
      const { text, from, to } = args;
      // Use MyMemory (free, no key needed, 5000 chars/day)
      try {
        const langpair = `${from}|${to}`;
        const resp = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`);
        const data = await resp.json() as any;
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          return `Translation (${from} → ${to}):\n${data.responseData.translatedText}`;
        }
        return `Translation failed: ${data.responseData?.translatedText ?? 'Unknown error'}`;
      } catch (err) {
        return `Translation error: ${(err as Error).message}`;
      }
    },
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
    async (args) => {
      const { url, max_entries } = args;
      try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'Marvin-Assistant/1.0' } });
        if (!resp.ok) return `Failed to fetch feed: ${resp.status} ${resp.statusText}`;
        const xml = await resp.text();

        // Simple RSS/Atom parser using regex (no dependency needed)
        const entries: Array<{ title: string; link: string; date?: string; summary?: string }> = [];

        // Try RSS <item> elements
        const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
        for (const item of items.slice(0, max_entries)) {
          const title = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() ?? '';
          const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? '';
          const date = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
          const desc = item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
          entries.push({ title, link, date, summary: desc?.slice(0, 200) });
        }

        // Try Atom <entry> elements if no RSS items found
        if (entries.length === 0) {
          const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
          for (const entry of atomEntries.slice(0, max_entries)) {
            const title = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
            const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*>/i)?.[1] ?? '';
            const date = entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1]?.trim();
            const summary = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
            entries.push({ title, link, date, summary: summary?.slice(0, 200) });
          }
        }

        if (entries.length === 0) return 'No entries found in feed.';

        return entries.map((e, i) =>
          `${i + 1}. ${e.title}\n   ${e.link}${e.date ? `\n   ${e.date}` : ''}${e.summary ? `\n   ${e.summary}` : ''}`
        ).join('\n\n');
      } catch (err) {
        return `Error fetching RSS feed: ${(err as Error).message}`;
      }
    },
    'always',
  );
}
