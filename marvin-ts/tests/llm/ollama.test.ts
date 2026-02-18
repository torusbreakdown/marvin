import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';
import type { ProviderConfig } from '../../src/types.js';

describe('OllamaProvider', () => {
  describe('Construction', () => {
    it('constructs with default localhost:11434 URL', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      expect(provider.name).toBe('ollama');
      expect(provider.model).toBe('qwen3-coder:30b');
    });

    it('uses custom URL from config', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://192.168.1.100:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      expect((provider as any).baseUrl).toContain('192.168.1.100');
    });

    it('wraps OpenAICompatProvider internally', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      // The internal provider should exist
      expect((provider as any).inner).toBeDefined();
    });
  });

  describe('Provider interface', () => {
    it('has chat method', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      expect(typeof provider.chat).toBe('function');
    });

    it('has destroy method', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      expect(typeof provider.destroy).toBe('function');
    });

    it('destroy can be called without error', () => {
      const config: ProviderConfig = {
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        baseUrl: 'http://localhost:11434',
        timeoutMs: 180_000,
        maxToolRounds: 10,
      };
      const provider = new OllamaProvider(config);
      expect(() => provider.destroy()).not.toThrow();
    });
  });
});
