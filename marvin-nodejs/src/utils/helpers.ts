/**
 * General utility helpers
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

/**
 * Execute a shell command with timeout
 */
export async function execCommand(
  command: string,
  timeout = 60000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ stdout, stderr: stderr || 'Command timed out', exitCode: 124 });
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Parse relative time strings like "30m", "2h", "1h30m"
 */
export function parseRelativeTime(timeStr: string): Date | null {
  const now = new Date();
  const match = timeStr.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/i);
  
  if (!match) return null;
  
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  
  if (hours === 0 && minutes === 0) return null;
  
  now.setHours(now.getHours() + hours);
  now.setMinutes(now.getMinutes() + minutes);
  return now;
}

/**
 * Generate a random ID
 */
export function generateId(length = 8): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if a value is a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely parse JSON
 */
export function safeJsonParse<T>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Sanitize a string for use as a filename
 */
export function sanitizeFilename(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Generate correct-horse-battery-staple style random words
 */
export function generateRandomWords(count = 5): string {
  const words = [
    'apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape',
    'honeydew', 'kiwi', 'lemon', 'mango', 'nectarine', 'orange', 'papaya',
    'quince', 'raspberry', 'strawberry', 'tangerine', 'ugli', 'vanilla',
    'watermelon', 'xigua', 'yam', 'zucchini', 'amber', 'blue', 'crimson',
    'diamond', 'emerald', 'fuchsia', 'gold', 'hazel', 'ivory', 'jade',
    'khaki', 'lavender', 'magenta', 'navy', 'olive', 'purple', 'quartz',
    'ruby', 'silver', 'teal', 'umber', 'violet', 'white', 'xanadu',
    'yellow', 'azure', 'bronze', 'copper', 'denim', 'ebony', 'flame'
  ];
  
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    selected.push(words[Math.floor(Math.random() * words.length)]);
  }
  return selected.join('-');
}
