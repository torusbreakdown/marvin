import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerNtfyTools, pollSubscriptions } from '../../src/tools/ntfy.js';
import type { ToolContext, UserProfile } from '../../src/types.js';

let tmpDir: string;
let registry: ToolRegistry;

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    name: 'test',
    profileDir: '/tmp/profile',
    preferences: {},
    savedPlaces: [],
    chatLog: [],
    ntfySubscriptions: [],
    oauthTokens: {},
    inputHistory: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: false,
    nonInteractive: false,
    profileDir: tmpDir,
    profile: makeProfile({ profileDir: tmpDir }),
    ...overrides,
  };
}

describe('Ntfy Tools', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-ntfy-'));
    registry = new ToolRegistry();
    registerNtfyTools(registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generate_ntfy_topic', () => {
    it('returns topic with multi-word name', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool(
        'generate_ntfy_topic',
        { label: 'test alerts' },
        ctx,
      );
      expect(result).toContain('ntfy.sh');
      // Topic name should have dashes (multi-word)
      const topicMatch = result.match(/topic[:\s]+(\S+)/i) || result.match(/ntfy\.sh\/(\S+)/);
      expect(topicMatch).not.toBeNull();
    });
  });

  describe('ntfy_subscribe', () => {
    it('saves subscription to profile', async () => {
      const profile = makeProfile({ profileDir: tmpDir });
      const ctx = makeCtx({ profile });
      const result = await registry.executeTool(
        'ntfy_subscribe',
        { topic: 'test-topic-123' },
        ctx,
      );
      expect(result.toLowerCase()).toContain('subscrib');
      expect(ctx.profile.ntfySubscriptions.length).toBeGreaterThanOrEqual(1);
      expect(ctx.profile.ntfySubscriptions.some(s => s.topic === 'test-topic-123')).toBe(true);
    });
  });

  describe('ntfy_publish', () => {
    it('sends HTTP POST to ntfy.sh (mocked)', async () => {
      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => 'ok',
      });

      try {
        const ctx = makeCtx();
        // Must subscribe first before publishing (security requirement)
        ctx.profile.ntfySubscriptions.push({ topic: 'test-topic' });
        const result = await registry.executeTool(
          'ntfy_publish',
          { topic: 'test-topic', message: 'Hello!', title: 'Test' },
          ctx,
        );
        expect(result.toLowerCase()).toContain('sent');
        expect(globalThis.fetch).toHaveBeenCalledWith(
          'https://ntfy.sh/test-topic',
          expect.objectContaining({ method: 'POST' }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('ntfy_list', () => {
    it('shows subscriptions from profile', async () => {
      const profile = makeProfile({
        profileDir: tmpDir,
        ntfySubscriptions: [{ topic: 'my-topic-1' }, { topic: 'my-topic-2' }],
      });
      const ctx = makeCtx({ profile });
      const result = await registry.executeTool('ntfy_list', {}, ctx);
      expect(result).toContain('my-topic-1');
      expect(result).toContain('my-topic-2');
    });

    it('shows message when no subscriptions', async () => {
      const ctx = makeCtx();
      const result = await registry.executeTool('ntfy_list', {}, ctx);
      expect(result.toLowerCase()).toContain('no');
    });
  });

  describe('pollSubscriptions', () => {
    it('returns empty array when no subscriptions', async () => {
      const profile = makeProfile();
      const messages = await pollSubscriptions(profile);
      expect(messages).toEqual([]);
    });
  });
});
