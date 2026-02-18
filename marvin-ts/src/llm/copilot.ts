import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
} from '../types.js';

export class CopilotProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private session: unknown | null = null;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    // Stub — requires @github/copilot-sdk at runtime
    throw new Error(
      'CopilotProvider.chat() is not yet implemented. ' +
      'Install @github/copilot-sdk and implement the SDK lifecycle.',
    );
  }

  destroy(): void {
    if (this.session) {
      // In full implementation: (this.session as any).destroy()
      this.session = null;
    }
  }
}
