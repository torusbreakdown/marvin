import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UsageTracker } from '../src/usage.js';

describe('usage.ts — UsageTracker', () => {
  let tmpDir: string;
  let tracker: UsageTracker;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'marvin-usage-'));
    tracker = new UsageTracker(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('recordTurn', () => {
    it('adds token counts per provider', () => {
      tracker.recordTurn('groq', 'llama-3.3-70b', 1000, 500);
      tracker.recordTurn('groq', 'llama-3.3-70b', 2000, 800);

      const usage = tracker.getSessionUsage();
      expect(usage.llmTurns).toBe(2);
      expect(usage.modelTurns['llama-3.3-70b']).toBe(2);
      expect(usage.totalCostUsd).toBeGreaterThan(0);
    });

    it('tracks multiple providers separately', () => {
      tracker.recordTurn('groq', 'llama-3.3-70b', 1000, 500);
      tracker.recordTurn('gemini', 'gemini-3-pro-preview', 2000, 1000);

      const usage = tracker.getSessionUsage();
      expect(usage.llmTurns).toBe(2);
      expect(usage.modelTurns['llama-3.3-70b']).toBe(1);
      expect(usage.modelTurns['gemini-3-pro-preview']).toBe(1);
      expect(Object.keys(usage.modelCost)).toContain('llama-3.3-70b');
      expect(Object.keys(usage.modelCost)).toContain('gemini-3-pro-preview');
    });
  });

  describe('recordToolCall', () => {
    it('increments tool call count', () => {
      tracker.recordToolCall('web_search');
      tracker.recordToolCall('web_search');
      tracker.recordToolCall('read_file');

      const usage = tracker.getSessionUsage();
      expect(usage.toolCallCounts['web_search']).toBe(2);
      expect(usage.toolCallCounts['read_file']).toBe(1);
    });
  });

  describe('summary', () => {
    it('returns formatted string with per-provider breakdown', () => {
      tracker.recordTurn('groq', 'llama-3.3-70b', 5000, 2000);
      tracker.recordTurn('gemini', 'gemini-3-pro-preview', 3000, 1500);
      tracker.recordToolCall('web_search');

      const summary = tracker.summary();
      expect(typeof summary).toBe('string');
      expect(summary).toContain('llama-3.3-70b');
      expect(summary).toContain('gemini-3-pro-preview');
      expect(summary).toContain('$');
      expect(summary.length).toBeGreaterThan(20);
    });
  });

  describe('save/load', () => {
    it('persists to JSON file', () => {
      tracker.recordTurn('groq', 'llama-3.3-70b', 1000, 500);
      tracker.recordToolCall('web_search');
      tracker.save();

      expect(existsSync(join(tmpDir, 'usage.json'))).toBe(true);

      const tracker2 = new UsageTracker(tmpDir);
      tracker2.load();
      const usage = tracker2.getLifetimeUsage();
      expect(usage.llmTurns).toBeGreaterThan(0);
    });
  });

  describe('lifetimeSummary', () => {
    it('accumulates across saves', () => {
      tracker.recordTurn('groq', 'llama-3.3-70b', 1000, 500);
      tracker.save();

      const tracker2 = new UsageTracker(tmpDir);
      tracker2.load();
      tracker2.recordTurn('groq', 'llama-3.3-70b', 2000, 800);
      tracker2.save();

      const tracker3 = new UsageTracker(tmpDir);
      tracker3.load();
      const lifetime = tracker3.getLifetimeUsage();
      expect(lifetime.llmTurns).toBe(2);
    });
  });

  describe('cost estimation', () => {
    it('calculates cost per provider using cost table', () => {
      // Groq is cheap/free, Gemini has known pricing
      tracker.recordTurn('gemini', 'gemini-3-pro-preview', 1_000_000, 500_000);
      const usage = tracker.getSessionUsage();
      expect(usage.totalCostUsd).toBeGreaterThan(0);
      expect(usage.modelCost['gemini-3-pro-preview']).toBeGreaterThan(0);
    });

    it('handles unknown providers with fallback pricing', () => {
      tracker.recordTurn('unknown-provider', 'unknown-model', 1000, 500);
      const usage = tracker.getSessionUsage();
      // Should not throw, should have some cost (even if 0 for unknown)
      expect(typeof usage.totalCostUsd).toBe('number');
    });
  });
});
