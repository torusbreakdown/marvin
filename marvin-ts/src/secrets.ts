/**
 * Secrets module — loads API keys from `pass` (GPG-encrypted password store),
 * falling back to environment variables.
 *
 * Keys are stored under `marvin/<KEY_NAME>` in the password store.
 * Example: `pass marvin/MOONSHOT_API_KEY`
 */

import { execFileSync } from 'node:child_process';

const cache = new Map<string, string | undefined>();

/**
 * Get a secret by name. Checks (in order):
 *   1. In-process cache
 *   2. `pass marvin/<name>`
 *   3. `process.env[name]`
 *
 * Returns undefined if not found anywhere.
 */
export function getSecret(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);

  let value: string | undefined;

  // Try `pass` first
  try {
    value = execFileSync('pass', [`marvin/${name}`], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // pass not installed, key not found, or GPG locked — fall through
  }

  // Fall back to environment variable
  if (!value) {
    value = process.env[name];
  }

  cache.set(name, value || undefined);
  return value || undefined;
}

/**
 * Store a secret in `pass`. Throws if `pass` is not available.
 */
export function setSecret(name: string, value: string): void {
  execFileSync('pass', ['insert', '-e', `marvin/${name}`], {
    input: value,
    encoding: 'utf-8',
    timeout: 5_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cache.set(name, value);
}

/**
 * List all secret names stored under `marvin/` in pass.
 */
export function listSecrets(): string[] {
  try {
    const out = execFileSync('pass', ['ls', 'marvin'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse tree output: lines like "├── KEY_NAME" or "└── KEY_NAME"
    return out.split('\n')
      .map(l => l.replace(/[│├└──\s]/g, '').trim())
      .filter(l => l.length > 0 && l !== 'marvin');
  } catch {
    return [];
  }
}

/** Clear the in-process cache (useful after setSecret in another process). */
export function clearSecretCache(): void {
  cache.clear();
}
