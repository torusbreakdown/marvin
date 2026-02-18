import { describe, it, expect } from 'vitest';
import { CopilotProvider } from '../../src/llm/copilot.js';
import type { ProviderConfig } from '../../src/types.js';

describe('CopilotProvider', () => {
  const config: ProviderConfig = {
    provider: 'copilot',
    model: 'claude-haiku-4.5',
    timeoutMs: 180_000,
    maxToolRounds: 10,
  };

  describe('Construction', () => {
    it('constructs with ProviderConfig', () => {
      const provider = new CopilotProvider(config);
      expect(provider.name).toBe('copilot');
      expect(provider.model).toBe('claude-haiku-4.5');
    });
  });

  describe('Lifecycle invariants', () => {
    it('copilotToken is null initially (lazy creation)', () => {
      const provider = new CopilotProvider(config);
      expect((provider as any).copilotToken).toBeNull();
    });

    it('destroy() clears token state', () => {
      const provider = new CopilotProvider(config);
      provider.destroy();
      expect((provider as any).copilotToken).toBeNull();
      expect((provider as any).githubToken).toBeNull();
    });

    it('destroy() can be called multiple times without error', () => {
      const provider = new CopilotProvider(config);
      expect(() => {
        provider.destroy();
        provider.destroy();
        provider.destroy();
      }).not.toThrow();
    });

    it('stores timeoutMs from config', () => {
      const provider = new CopilotProvider(config);
      expect((provider as any).timeoutMs).toBe(180_000);
    });

    it('stores timeoutMs for coding mode (900s)', () => {
      const codingConfig = { ...config, timeoutMs: 900_000 };
      const provider = new CopilotProvider(codingConfig);
      expect((provider as any).timeoutMs).toBe(900_000);
    });
  });

  describe('Provider interface', () => {
    it('has chat method', () => {
      const provider = new CopilotProvider(config);
      expect(typeof provider.chat).toBe('function');
    });

    it('has destroy method', () => {
      const provider = new CopilotProvider(config);
      expect(typeof provider.destroy).toBe('function');
    });

    it('has readonly name and model', () => {
      const provider = new CopilotProvider(config);
      expect(provider.name).toBe('copilot');
      expect(provider.model).toBe('claude-haiku-4.5');
    });
  });
});
