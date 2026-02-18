import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UserProfile, SavedPlace, ChatLogEntry } from '../types.js';
import { loadPreferences } from './prefs.js';
import { loadChatLog } from '../history.js';

const DEFAULT_BASE_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
  '.config', 'local-finder', 'profiles',
);

export class ProfileManager {
  private baseDir: string;
  private active: UserProfile | null = null;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? DEFAULT_BASE_DIR;
  }

  getActive(): UserProfile | null {
    return this.active;
  }

  load(name: string): UserProfile {
    this.active = loadOrCreateProfile(name, this.baseDir);
    return this.active;
  }

  switch(name: string): UserProfile {
    this.active = switchProfile(name, this.baseDir);
    return this.active;
  }

  list(): string[] {
    return listProfiles(this.baseDir);
  }
}

export function loadOrCreateProfile(name: string, baseDir?: string): UserProfile {
  const base = baseDir ?? DEFAULT_BASE_DIR;
  const profileDir = join(base, name);

  mkdirSync(profileDir, { recursive: true });

  // Load preferences
  const preferences = loadPreferences(profileDir);

  // Load saved places
  let savedPlaces: SavedPlace[] = [];
  try {
    const placesPath = join(profileDir, 'saved_places.json');
    if (existsSync(placesPath)) {
      savedPlaces = JSON.parse(readFileSync(placesPath, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Load chat log
  const chatLog = loadChatLog(profileDir);

  // Load ntfy subscriptions
  let ntfySubscriptions: Array<{ topic: string; lastMessageId?: string }> = [];
  try {
    const ntfyPath = join(profileDir, 'ntfy_subscriptions.json');
    if (existsSync(ntfyPath)) {
      ntfySubscriptions = JSON.parse(readFileSync(ntfyPath, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Load OAuth tokens
  let oauthTokens: Record<string, unknown> = {};
  try {
    const tokensPath = join(profileDir, 'tokens.json');
    if (existsSync(tokensPath)) {
      oauthTokens = JSON.parse(readFileSync(tokensPath, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Load input history
  let inputHistory: string[] = [];
  try {
    const histPath = join(profileDir, 'history');
    if (existsSync(histPath)) {
      inputHistory = readFileSync(histPath, 'utf-8').split('\n').filter(Boolean);
    } else if (chatLog.length > 0) {
      // Seed from chat log user messages
      inputHistory = chatLog.filter(e => e.role === 'you').map(e => e.text);
    }
  } catch { /* ignore */ }

  return {
    name,
    profileDir,
    preferences,
    savedPlaces,
    chatLog,
    ntfySubscriptions,
    oauthTokens,
    inputHistory,
  };
}

export function loadProfile(name: string, baseDir?: string): UserProfile | null {
  const base = baseDir ?? DEFAULT_BASE_DIR;
  const profileDir = join(base, name);
  if (!existsSync(profileDir)) return null;
  return loadOrCreateProfile(name, base);
}

export function saveProfile(profile: UserProfile): void {
  mkdirSync(profile.profileDir, { recursive: true });

  writeFileSync(
    join(profile.profileDir, 'saved_places.json'),
    JSON.stringify(profile.savedPlaces, null, 2),
  );

  writeFileSync(
    join(profile.profileDir, 'chat_log.json'),
    JSON.stringify(profile.chatLog, null, 2),
  );
}

export function switchProfile(name: string, baseDir?: string): UserProfile {
  const base = baseDir ?? DEFAULT_BASE_DIR;
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'last_profile'), name);
  return loadOrCreateProfile(name, base);
}

export function listProfiles(baseDir?: string): string[] {
  const base = baseDir ?? DEFAULT_BASE_DIR;
  try {
    if (!existsSync(base)) return [];
    return readdirSync(base).filter(entry => {
      const fullPath = join(base, entry);
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
