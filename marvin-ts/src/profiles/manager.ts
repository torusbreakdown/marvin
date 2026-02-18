import type { UserProfile } from '../types.js';

export class ProfileManager {
  // Profile load/save, switch, list
}

export function loadOrCreateProfile(name: string): UserProfile {
  // Load profile from disk or create default
  return {
    name,
    profileDir: '',
    preferences: {},
    savedPlaces: [],
    chatLog: [],
    ntfySubscriptions: [],
    oauthTokens: {},
    inputHistory: [],
  };
}

export function loadProfile(name: string): UserProfile | null {
  // Load existing profile, return null if not found
  return null;
}

export function saveProfile(profile: UserProfile): void {
  // Save profile to disk
}

export function switchProfile(name: string): UserProfile {
  // Switch to a different profile
  return loadOrCreateProfile(name);
}

export function listProfiles(): string[] {
  // List available profile names
  return [];
}
