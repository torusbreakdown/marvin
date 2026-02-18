import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlainUI } from '../../src/ui/plain.js';
import type { UI } from '../../src/ui/shared.js';

/**
 * Captures all writes to process.stdout/stderr during a test.
 */
function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });

  return {
    stdout,
    stderr,
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe('PlainUI', () => {
  let ui: PlainUI;

  beforeEach(() => {
    ui = new PlainUI({ provider: 'copilot', model: 'claude-haiku-4.5', profile: 'kevin' });
  });

  it('implements the UI interface', () => {
    // Verify all UI interface methods exist
    const iface: UI = ui;
    expect(typeof iface.start).toBe('function');
    expect(typeof iface.displayMessage).toBe('function');
    expect(typeof iface.displaySystem).toBe('function');
    expect(typeof iface.displayError).toBe('function');
    expect(typeof iface.displayToolCall).toBe('function');
    expect(typeof iface.beginStream).toBe('function');
    expect(typeof iface.streamDelta).toBe('function');
    expect(typeof iface.endStream).toBe('function');
    expect(typeof iface.promptInput).toBe('function');
    expect(typeof iface.promptConfirm).toBe('function');
    expect(typeof iface.showStatus).toBe('function');
    expect(typeof iface.destroy).toBe('function');
  });

  describe('displayMessage', () => {
    it('formats user role as "You:"', () => {
      const out = captureOutput();
      try {
        ui.displayMessage('user', 'hello world');
        expect(out.stdoutText()).toContain('You:');
        expect(out.stdoutText()).toContain('hello world');
      } finally {
        out.restore();
      }
    });

    it('formats assistant role as "🤖 Marvin:"', () => {
      const out = captureOutput();
      try {
        ui.displayMessage('assistant', 'I can help');
        expect(out.stdoutText()).toContain('🤖 Marvin:');
        expect(out.stdoutText()).toContain('I can help');
      } finally {
        out.restore();
      }
    });

    it('formats system role as "⚙️ System:"', () => {
      const out = captureOutput();
      try {
        ui.displayMessage('system', 'session started');
        expect(out.stdoutText()).toContain('⚙️ System:');
        expect(out.stdoutText()).toContain('session started');
      } finally {
        out.restore();
      }
    });
  });

  describe('displayToolCall', () => {
    it('formats single tool call', () => {
      const out = captureOutput();
      try {
        ui.displayToolCall(['web_search']);
        expect(out.stdoutText()).toContain('🔧 web_search');
      } finally {
        out.restore();
      }
    });

    it('formats multiple tool calls comma-separated', () => {
      const out = captureOutput();
      try {
        ui.displayToolCall(['tool1', 'tool2']);
        expect(out.stdoutText()).toContain('🔧 tool1, tool2');
      } finally {
        out.restore();
      }
    });

    it('indents tool call lines with two spaces', () => {
      const out = captureOutput();
      try {
        ui.displayToolCall(['tool1', 'tool2']);
        expect(out.stdoutText()).toMatch(/^ {2}🔧/m);
      } finally {
        out.restore();
      }
    });
  });

  describe('displaySystem', () => {
    it('shows system messages', () => {
      const out = captureOutput();
      try {
        ui.displaySystem('Profile switched to: alex');
        expect(out.stdoutText()).toContain('Profile switched to: alex');
      } finally {
        out.restore();
      }
    });
  });

  describe('displayError', () => {
    it('shows error with ⚠️ prefix', () => {
      const out = captureOutput();
      try {
        ui.displayError('something went wrong');
        expect(out.stdoutText()).toContain('⚠️');
        expect(out.stdoutText()).toContain('something went wrong');
      } finally {
        out.restore();
      }
    });
  });

  describe('streaming lifecycle', () => {
    it('beginStream/streamDelta/endStream works', () => {
      const out = captureOutput();
      try {
        ui.beginStream();
        ui.streamDelta('Hello');
        ui.streamDelta(' world');
        ui.endStream();
        const text = out.stdoutText();
        expect(text).toContain('Hello');
        expect(text).toContain(' world');
      } finally {
        out.restore();
      }
    });

    it('endStream adds a trailing newline', () => {
      const out = captureOutput();
      try {
        ui.beginStream();
        ui.streamDelta('content');
        ui.endStream();
        expect(out.stdoutText()).toMatch(/content\n/);
      } finally {
        out.restore();
      }
    });
  });

  describe('confirmCommand', () => {
    it('is a function returning a promise', async () => {
      // confirmCommand exists and returns a promise (we can't easily test readline interaction)
      expect(typeof ui.promptConfirm).toBe('function');
    });
  });

  describe('showStatus', () => {
    it('accepts status data without error', () => {
      expect(() => ui.showStatus({
        providerEmoji: '🤖',
        model: 'claude-haiku-4.5',
        profileName: 'kevin',
        messageCount: 5,
        costUsd: 0.001,
        totalTokens: 1000,
        codingMode: false,
        shellMode: false,
      })).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('can be called without error', () => {
      expect(() => ui.destroy()).not.toThrow();
    });
  });
});
