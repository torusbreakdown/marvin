import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '../src/types.js';
import { ContextBudgetManager, estimateTokens, compactContext, budgetGateResult, WARN_THRESHOLD, COMPACT_THRESHOLD, HARD_LIMIT } from '../src/context.js';

describe('context.ts', () => {
  describe('constants', () => {
    it('WARN=180K, COMPACT=200K, MAX=226K', () => {
      expect(WARN_THRESHOLD).toBe(180_000);
      expect(COMPACT_THRESHOLD).toBe(200_000);
      expect(HARD_LIMIT).toBe(226_000);
    });
  });

  describe('estimateTokens', () => {
    it('returns reasonable count for an array of messages', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are Marvin.' },
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'I am doing well, thank you for asking!' },
      ];
      const tokens = estimateTokens(messages);
      // JSON.stringify length / 4 — should be roughly proportional to content size
      const expectedApprox = Math.ceil(JSON.stringify(messages).length / 4);
      expect(tokens).toBe(expectedApprox);
      expect(tokens).toBeGreaterThan(0);
    });

    it('empty messages → 0', () => {
      expect(estimateTokens([])).toBe(0);
    });
  });

  describe('compactContext', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'marvin-context-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('when tokens > compactThreshold, keeps system + last 8 messages, summarizes middle', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are Marvin.' },
      ];
      // Add 20 user/assistant pairs to exceed threshold conceptually
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `Question ${i}: ${'x'.repeat(100)}` });
        messages.push({ role: 'assistant', content: `Answer ${i}: ${'y'.repeat(100)}` });
      }

      const result = compactContext(messages, tmpDir);

      // Should have: system[0] + summary + last 8 = 10 messages
      expect(result.length).toBe(10);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toBe('You are Marvin.');

      // Second message should be a summary
      expect(result[1].role).toBe('system');
      expect(result[1].content).toContain('Context compacted');
      expect(result[1].content).toContain('messages summarized');

      // Last 8 messages should be preserved
      const last8 = messages.slice(-8);
      for (let i = 0; i < 8; i++) {
        expect(result[i + 2].content).toBe(last8[i].content);
      }
    });

    it('writes backup to provided path', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'More question' },
        { role: 'assistant', content: 'More answer' },
        { role: 'user', content: 'Even more' },
        { role: 'assistant', content: 'Even more answer' },
        { role: 'user', content: 'Last q' },
        { role: 'assistant', content: 'Last a' },
      ];

      compactContext(messages, tmpDir);

      // Should have written a backup file
      const files = require('node:fs').readdirSync(tmpDir);
      const backups = files.filter((f: string) => f.startsWith('context-backup-') && f.endsWith('.jsonl'));
      expect(backups.length).toBe(1);

      // Backup should contain all original messages as JSONL
      const backupContent = readFileSync(join(tmpDir, backups[0]), 'utf-8');
      const lines = backupContent.trim().split('\n');
      expect(lines.length).toBe(messages.length);
      expect(JSON.parse(lines[0]).role).toBe('system');
    });

    it('summary includes tool names, assistant content snippets', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Search for weather in Tokyo' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'weather_forecast', arguments: '{"city":"Tokyo"}' },
        }] },
        { role: 'tool', content: 'Sunny, 25°C', tool_call_id: 'call_1', name: 'weather_forecast' },
        { role: 'assistant', content: 'The weather in Tokyo is sunny.' },
        { role: 'user', content: 'Now search the web for restaurants' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call_2', type: 'function',
          function: { name: 'web_search', arguments: '{"q":"restaurants"}' },
        }] },
        { role: 'tool', content: 'Restaurant results...', tool_call_id: 'call_2', name: 'web_search' },
        { role: 'assistant', content: 'Here are some restaurants.' },
        // Need enough messages so there are dropped messages in the middle
        { role: 'user', content: 'q10' },
        { role: 'assistant', content: 'a10' },
        { role: 'user', content: 'q11' },
        { role: 'assistant', content: 'a11' },
        { role: 'user', content: 'q12' },
        { role: 'assistant', content: 'a12' },
        { role: 'user', content: 'q13' },
        { role: 'assistant', content: 'a13' },
      ];

      const result = compactContext(messages, tmpDir);
      const summary = result[1].content!;

      // Summary should mention tool names used
      expect(summary).toContain('weather_forecast');
      expect(summary).toContain('web_search');
      // Should include user query snippets
      expect(summary).toContain('Search for weather in Tokyo');
    });
  });

  describe('ContextBudgetManager class', () => {
    it('getBudget returns current budget state', () => {
      const mgr = new ContextBudgetManager();
      const budget = mgr.getBudget();
      expect(budget.warnThreshold).toBe(WARN_THRESHOLD);
      expect(budget.compactThreshold).toBe(COMPACT_THRESHOLD);
      expect(budget.hardLimit).toBe(HARD_LIMIT);
      expect(budget.currentTokens).toBe(0);
    });

    it('updateActual updates currentTokens', () => {
      const mgr = new ContextBudgetManager();
      mgr.updateActual({ inputTokens: 50_000, outputTokens: 10_000 });
      expect(mgr.getBudget().currentTokens).toBe(60_000);
    });

    it('checkBudget returns ok for small conversations', () => {
      const mgr = new ContextBudgetManager();
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
      ];
      expect(mgr.checkBudget(messages)).toBe('ok');
    });

    it('checkBudget returns warn when near threshold', () => {
      const mgr = new ContextBudgetManager();
      // Create messages that estimate to ~180K tokens (720K chars / 4)
      const bigContent = 'x'.repeat(720_000);
      const messages: Message[] = [
        { role: 'user', content: bigContent },
      ];
      expect(mgr.checkBudget(messages)).toBe('warn');
    });

    it('checkBudget returns reject when over hard limit', () => {
      const mgr = new ContextBudgetManager();
      const bigContent = 'x'.repeat(910_000);
      const messages: Message[] = [
        { role: 'user', content: bigContent },
      ];
      expect(mgr.checkBudget(messages)).toBe('reject');
    });

    it('truncateResult truncates when no room', () => {
      const mgr = new ContextBudgetManager();
      mgr.updateActual({ inputTokens: HARD_LIMIT, outputTokens: 0 });
      const result = mgr.truncateResult('some data');
      expect(result).toContain('No room');
    });

    it('truncateResult truncates long results to fit budget', () => {
      const mgr = new ContextBudgetManager();
      mgr.updateActual({ inputTokens: HARD_LIMIT - 100, outputTokens: 0 });
      const longResult = 'x'.repeat(10_000);
      const result = mgr.truncateResult(longResult);
      expect(result.length).toBeLessThan(longResult.length);
      expect(result).toContain('truncated');
    });

    it('truncateResult passes through short results', () => {
      const mgr = new ContextBudgetManager();
      mgr.updateActual({ inputTokens: 1000, outputTokens: 0 });
      const result = mgr.truncateResult('short');
      expect(result).toBe('short');
    });
  });

  describe('budgetGateResult', () => {
    it('truncates large tool results when near threshold', () => {
      const bigResult = 'x'.repeat(100_000);
      // Current tokens near hard limit, only (226000-224000)*4=8000 chars of room
      const gated = budgetGateResult('read_file', bigResult, 224_000, {
        warnThreshold: WARN_THRESHOLD,
        compactThreshold: COMPACT_THRESHOLD,
        hardLimit: HARD_LIMIT,
      });

      // Result should be truncated
      expect(gated.length).toBeLessThan(bigResult.length);
      expect(gated).toContain('truncated');
    });

    it('returns error when no room at all', () => {
      const result = budgetGateResult('read_file', 'some data', 226_000, {
        warnThreshold: WARN_THRESHOLD,
        compactThreshold: COMPACT_THRESHOLD,
        hardLimit: HARD_LIMIT,
      });

      expect(result).toContain('Error');
      expect(result).toContain('context budget');
    });
  });
});
