import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateProfile, switchProfile, listProfiles } from '../../src/profiles/manager.js';

describe('profiles/manager.ts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-profiles-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadOrCreateProfile', () => {
    it('creates profile dir if missing', () => {
      const profile = loadOrCreateProfile('newuser', tmpDir);
      expect(profile.name).toBe('newuser');
      expect(existsSync(profile.profileDir)).toBe(true);
    });

    it('loads existing profile with prefs and saved places', () => {
      const profileDir = join(tmpDir, 'existing');
      mkdirSync(profileDir, { recursive: true });

      writeFileSync(join(profileDir, 'prefs.yaml'),
        'dietary:\n  - vegetarian\nbudget: medium\ndistance_unit: kilometers\n');

      writeFileSync(join(profileDir, 'saved_places.json'),
        JSON.stringify([
          { label: 'Home', name: 'My House', address: '123 Main St', lat: 40.7, lng: -74.0 },
        ]));

      writeFileSync(join(profileDir, 'chat_log.json'),
        JSON.stringify([
          { role: 'you', text: 'Hello', time: '10:00' },
        ]));

      const profile = loadOrCreateProfile('existing', tmpDir);
      expect(profile.name).toBe('existing');
      expect(profile.preferences.dietary).toEqual(['vegetarian']);
      expect(profile.preferences.budget).toBe('medium');
      expect(profile.preferences.distance_unit).toBe('kilometers');
      expect(profile.savedPlaces).toHaveLength(1);
      expect(profile.savedPlaces[0].label).toBe('Home');
      expect(profile.chatLog).toHaveLength(1);
    });
  });

  describe('switchProfile', () => {
    it('changes active profile, saves to last_profile', () => {
      loadOrCreateProfile('profile-a', tmpDir);

      const profile = switchProfile('profile-b', tmpDir);
      expect(profile.name).toBe('profile-b');

      const lastProfile = readFileSync(join(tmpDir, 'last_profile'), 'utf-8').trim();
      expect(lastProfile).toBe('profile-b');
    });
  });

  describe('listProfiles', () => {
    it('returns all profile names', () => {
      loadOrCreateProfile('alice', tmpDir);
      loadOrCreateProfile('bob', tmpDir);
      loadOrCreateProfile('charlie', tmpDir);

      const names = listProfiles(tmpDir);
      expect(names).toContain('alice');
      expect(names).toContain('bob');
      expect(names).toContain('charlie');
      expect(names).toHaveLength(3);
    });
  });
});
