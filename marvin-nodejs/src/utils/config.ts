/**
 * Configuration management - paths, profile loading, preferences
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { UserPreferences, SavedPlace, ChatLogEntry, Profile, CONFIG_DIR, NOTES_DIR } from '../types.js';

const DEFAULT_PREFERENCES: UserPreferences = {
  dietary: [],
  spice_tolerance: 'medium',
  favorite_cuisines: [],
  avoid_cuisines: [],
  has_car: true,
  max_distance_km: 10,
  budget: 'any',
  accessibility: [],
  notes: ''
};

export function getProfileDir(profileName: string): string {
  return join(CONFIG_DIR, 'profiles', profileName);
}

export function ensureProfileDir(profileName: string): void {
  const dir = getProfileDir(profileName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getActiveProfile(): string {
  const lastProfilePath = join(CONFIG_DIR, 'last_profile');
  if (existsSync(lastProfilePath)) {
    return readFileSync(lastProfilePath, 'utf-8').trim();
  }
  return 'main';
}

export function setActiveProfile(profileName: string): void {
  ensureProfileDir(profileName);
  const lastProfilePath = join(CONFIG_DIR, 'last_profile');
  writeFileSync(lastProfilePath, profileName);
}

export function loadPreferences(profileName: string): UserPreferences {
  const prefsPath = join(getProfileDir(profileName), 'preferences.yaml');
  if (existsSync(prefsPath)) {
    const content = readFileSync(prefsPath, 'utf-8');
    return { ...DEFAULT_PREFERENCES, ...(yaml.load(content) as UserPreferences) };
  }
  return { ...DEFAULT_PREFERENCES };
}

export function savePreferences(profileName: string, prefs: UserPreferences): void {
  ensureProfileDir(profileName);
  const prefsPath = join(getProfileDir(profileName), 'preferences.yaml');
  writeFileSync(prefsPath, yaml.dump(prefs));
}

export function loadSavedPlaces(profileName: string): SavedPlace[] {
  const placesPath = join(getProfileDir(profileName), 'saved_places.json');
  if (existsSync(placesPath)) {
    return JSON.parse(readFileSync(placesPath, 'utf-8'));
  }
  return [];
}

export function saveSavedPlaces(profileName: string, places: SavedPlace[]): void {
  ensureProfileDir(profileName);
  const placesPath = join(getProfileDir(profileName), 'saved_places.json');
  writeFileSync(placesPath, JSON.stringify(places, null, 2));
}

export function loadChatLog(profileName: string): ChatLogEntry[] {
  const logPath = join(getProfileDir(profileName), 'chat_log.json');
  if (existsSync(logPath)) {
    return JSON.parse(readFileSync(logPath, 'utf-8'));
  }
  return [];
}

export function saveChatLog(profileName: string, log: ChatLogEntry[]): void {
  ensureProfileDir(profileName);
  const logPath = join(getProfileDir(profileName), 'chat_log.json');
  writeFileSync(logPath, JSON.stringify(log, null, 2));
}

export function appendToChatLog(profileName: string, entry: ChatLogEntry): void {
  const log = loadChatLog(profileName);
  log.push(entry);
  // Keep only last 100 entries
  if (log.length > 100) {
    log.splice(0, log.length - 100);
  }
  saveChatLog(profileName, log);
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function ensureNotesDir(): void {
  if (!existsSync(NOTES_DIR)) {
    mkdirSync(NOTES_DIR, { recursive: true });
  }
}

export function getCompactHistory(profileName: string, maxEntries = 20, maxChars = 200): string {
  const log = loadChatLog(profileName);
  const recent = log.slice(-maxEntries);
  return recent.map(e => {
    const text = e.text.length > maxChars ? e.text.slice(0, maxChars) + '...' : e.text;
    return `${e.role}: ${text}`;
  }).join('\n');
}

export function formatPreferencesForSystem(prefs: UserPreferences): string {
  const lines = ['User preferences:'];
  if (prefs.dietary.length) lines.push(`- Dietary: ${prefs.dietary.join(', ')}`);
  lines.push(`- Spice tolerance: ${prefs.spice_tolerance}`);
  if (prefs.favorite_cuisines.length) lines.push(`- Favorite cuisines: ${prefs.favorite_cuisines.join(', ')}`);
  if (prefs.avoid_cuisines.length) lines.push(`- Avoid cuisines: ${prefs.avoid_cuisines.join(', ')}`);
  lines.push(`- Has car: ${prefs.has_car}`);
  lines.push(`- Max distance: ${prefs.max_distance_km}km`);
  lines.push(`- Budget: ${prefs.budget}`);
  if (prefs.accessibility.length) lines.push(`- Accessibility: ${prefs.accessibility.join(', ')}`);
  if (prefs.notes) lines.push(`- Notes: ${prefs.notes}`);
  return lines.join('\n');
}

export function formatSavedPlacesForSystem(places: SavedPlace[]): string {
  if (places.length === 0) return 'No saved places.';
  return ['Saved places:'].concat(places.map(p => {
    let line = `- ${p.label}`;
    if (p.name) line += `: ${p.name}`;
    if (p.address) line += ` (${p.address})`;
    return line;
  })).join('\n');
}
