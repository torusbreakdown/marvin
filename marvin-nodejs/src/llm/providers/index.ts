/**
 * LLM Provider Registry
 * Factory for creating provider instances
 */

import { LLMProvider } from './base';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { logger } from '../../utils/logger';

export * from './base';

const providers: Map<string, () => LLMProvider> = new Map([
  ['openai', () => new OpenAIProvider()],
  ['anthropic', () => new AnthropicProvider()],
  ['gemini', () => new GeminiProvider()],
  ['ollama', () => new OllamaProvider()],
]);

export function getProvider(name: string): LLMProvider {
  const factory = providers.get(name.toLowerCase());
  if (!factory) {
    throw new Error(`Unknown LLM provider: ${name}. Available: ${Array.from(providers.keys()).join(', ')}`);
  }
  return factory();
}

export function getAvailableProviders(): string[] {
  return Array.from(providers.keys());
}

export function detectProvider(): string {
  // Check environment variables to determine which provider to use
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  
  // Default based on env vars
  const provider = process.env.LLM_PROVIDER || 'openai';
  logger.debug(`Using LLM provider: ${provider}`);
  return provider;
}
