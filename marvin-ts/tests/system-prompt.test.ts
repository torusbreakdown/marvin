import { describe, it, expect } from 'vitest';
import type { UserProfile, ChatLogEntry, Message } from '../src/types.js';
import { buildSystemMessage, seedHistoryMessages } from '../src/system-prompt.js';

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    name: 'testuser',
    profileDir: '/tmp/test-profile',
    preferences: {},
    savedPlaces: [],
    chatLog: [],
    ntfySubscriptions: [],
    oauthTokens: {},
    inputHistory: [],
    ...overrides,
  };
}

describe('system-prompt.ts', () => {
  describe('buildSystemMessage', () => {
    it('includes "You are Marvin" personality', () => {
      const profile = makeProfile();
      const msg = buildSystemMessage(profile);
      expect(msg).toContain('Marvin');
    });

    it('includes active profile name', () => {
      const profile = makeProfile({ name: 'alice' });
      const msg = buildSystemMessage(profile);
      expect(msg).toContain('alice');
    });

    it('includes preferences when present', () => {
      const profile = makeProfile({
        preferences: {
          dietary: ['vegetarian', 'gluten-free'],
          budget: 'medium',
          distance_unit: 'kilometers',
          cuisines: ['italian', 'japanese'],
        },
      });
      const msg = buildSystemMessage(profile);
      expect(msg).toContain('vegetarian');
      expect(msg).toContain('gluten-free');
      expect(msg).toContain('medium');
      expect(msg).toContain('kilometers');
      expect(msg).toContain('italian');
    });

    it('includes saved places with coordinates', () => {
      const profile = makeProfile({
        savedPlaces: [
          { label: 'Home', name: 'My House', address: '123 Main St', lat: 40.7128, lng: -74.0060 },
          { label: 'Work', name: 'Office', address: '456 Corp Ave', lat: 37.7749, lng: -122.4194 },
        ],
      });
      const msg = buildSystemMessage(profile);
      expect(msg).toContain('Home');
      expect(msg).toContain('My House');
      expect(msg).toContain('40.7128');
      expect(msg).toContain('Work');
      expect(msg).toContain('Office');
    });

    it('includes coding mode instructions when codingMode=true', () => {
      const profile = makeProfile();
      const msg = buildSystemMessage(profile, { codingMode: true });
      expect(msg).toContain('coding');
    });

    it('includes compact history (last 20 entries, 200 chars each)', () => {
      const chatLog: ChatLogEntry[] = [];
      for (let i = 0; i < 25; i++) {
        chatLog.push({ role: 'you', text: `Question ${i}: ${'x'.repeat(300)}`, time: '10:00' });
        chatLog.push({ role: 'assistant', text: `Answer ${i}`, time: '10:01' });
      }
      const profile = makeProfile({ chatLog });
      const msg = buildSystemMessage(profile);

      // Should contain recent conversation section
      expect(msg).toContain('conversation');
      // Long entries should be truncated (200 chars + ...)
      // Should NOT contain the full 300 x's
      const xCount = (msg.match(/x/g) || []).length;
      expect(xCount).toBeLessThan(300 * 20); // not all full entries
    });

    it('includes background job summary when jobs exist', () => {
      const profile = makeProfile();
      const msg = buildSystemMessage(profile, {
        backgroundJobs: [
          { id: 'job1', status: 'running', description: 'Building project' },
        ],
      });
      expect(msg).toContain('job1');
      expect(msg).toContain('running');
    });
  });

  describe('seedHistoryMessages', () => {
    it('converts ChatLogEntry[] to Message[] (you→user role mapping)', () => {
      const chatLog: ChatLogEntry[] = [
        { role: 'you', text: 'Hello', time: '10:00' },
        { role: 'assistant', text: 'Hi there!', time: '10:01' },
        { role: 'system', text: 'Mode changed', time: '10:02' },
        { role: 'you', text: 'Another question', time: '10:03' },
      ];

      const messages = seedHistoryMessages(chatLog);

      // System messages should be filtered out
      expect(messages).toHaveLength(3);

      // 'you' should become 'user'
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello');

      // 'assistant' stays 'assistant'
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].content).toBe('Hi there!');

      // Second 'you' → 'user'
      expect(messages[2].role).toBe('user');
      expect(messages[2].content).toBe('Another question');
    });

    it('limits to last 20 entries by default', () => {
      const chatLog: ChatLogEntry[] = [];
      for (let i = 0; i < 30; i++) {
        chatLog.push({ role: 'you', text: `msg-${i}`, time: '10:00' });
      }

      const messages = seedHistoryMessages(chatLog);
      // Last 20 entries, all 'you' so none filtered
      expect(messages).toHaveLength(20);
      expect(messages[0].content).toBe('msg-10');
      expect(messages[19].content).toBe('msg-29');
    });

    it('respects custom limit', () => {
      const chatLog: ChatLogEntry[] = [];
      for (let i = 0; i < 10; i++) {
        chatLog.push({ role: 'you', text: `msg-${i}`, time: '10:00' });
      }

      const messages = seedHistoryMessages(chatLog, 5);
      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe('msg-5');
    });
  });
});
