import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export function loadPreferences(profileDir: string): Record<string, unknown> {
  const filePath = join(profileDir, 'prefs.yaml');
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, 'utf-8');
    return (YAML.parse(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

export function savePreferences(profileDir: string, prefs: Record<string, unknown>): void {
  mkdirSync(profileDir, { recursive: true });
  const filePath = join(profileDir, 'prefs.yaml');
  writeFileSync(filePath, YAML.stringify(prefs));
}

export function updatePreference(profileDir: string, key: string, value: unknown): void {
  const prefs = loadPreferences(profileDir);
  prefs[key] = value;
  savePreferences(profileDir, prefs);
}

/** @deprecated Use loadPreferences instead */
export const loadPrefs = loadPreferences;

/** @deprecated Use updatePreference instead */
export function updatePrefs(profileDir: string, prefs: Record<string, unknown>): void {
  savePreferences(profileDir, prefs);
}
