import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
} from '../types.js';
import { OpenAICompatProvider } from './openai.js';

export class LlamaServerProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly inner: OpenAICompatProvider;

  constructor(config: ProviderConfig) {
    this.name = 'llama-server';
    this.model = config.model;
    this.baseUrl = config.baseUrl ?? 'http://localhost:8080';

    this.inner = new OpenAICompatProvider({
      ...config,
      provider: 'llama-server',
      baseUrl: this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1',
      apiKey: config.apiKey ?? '', // llama-server doesn't require auth by default
    });
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    try {
      return await this.inner.chat(messages, options);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new Error(
          `Cannot connect to llama-server at ${this.baseUrl}. Is it running? Start with: llama-server -m <model.gguf> --port 8080`,
        );
      }
      if (msg.includes('model') && msg.includes('not found')) {
        throw new Error(
          `Model not found on llama-server. Note: llama-server serves one model at a time — the model is set at startup, not per-request.`,
        );
      }
      throw err;
    }
  }

  destroy(): void {
    this.inner.destroy();
  }
}
