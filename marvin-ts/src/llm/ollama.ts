import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
} from '../types.js';
import { OpenAICompatProvider } from './openai.js';

export class OllamaProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly inner: OpenAICompatProvider;

  constructor(config: ProviderConfig) {
    this.name = 'ollama';
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';

    // Ollama exposes an OpenAI-compatible endpoint at /v1
    this.inner = new OpenAICompatProvider({
      ...config,
      provider: 'ollama',
      baseUrl: `${this.baseUrl.replace(/\/+$/, '')}/v1`,
      apiKey: 'ollama', // Ollama doesn't require a real key but the header is expected
    });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    // Set num_ctx for Ollama — default 4096 is too small for tool-calling
    const ollamaOptions = {
      ...options,
      extraBody: {
        ...options?.extraBody,
        options: { num_ctx: 32768 },
      },
    };
    try {
      return await this.inner.chat(messages, ollamaOptions);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new Error(
          `Cannot connect to Ollama at ${this.baseUrl}. Is Ollama running? Start with: ollama serve`,
        );
      }
      throw err;
    }
  }

  destroy(): void {
    this.inner.destroy();
  }
}
