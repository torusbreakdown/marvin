import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
  ToolCall,
} from '../types.js';

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    const hasTools = options?.tools && options.tools.length > 0;
    // Force stream=false when tools are provided (tool calls can't stream reliably)
    const shouldStream = hasTools ? false : (options?.stream ?? false);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: shouldStream,
      ...(hasTools ? { tools: options!.tools } : {}),
      ...(options?.extraBody ?? {}),
    };

    if (shouldStream) {
      body.stream_options = { include_usage: true };
    }

    // Gemini thinking config injection (only when no tools)
    if (!hasTools) {
      const thinkingConfig = this.getGeminiThinkingConfig();
      if (thinkingConfig) {
        body.extra_body = { google: { thinking_config: thinkingConfig } };
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`);
      }

      if (shouldStream) {
        return await this.parseStreamingResponse(response);
      } else {
        return await this.parseNonStreamingResponse(response);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async parseNonStreamingResponse(response: Response): Promise<ChatResult> {
    const json = await response.json() as any;
    const choice = json.choices?.[0];
    const msg = choice?.message;

    const message: Message = {
      role: 'assistant',
      content: msg?.content ?? null,
      ...(msg?.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    };

    return {
      message,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  private async parseStreamingResponse(response: Response): Promise<ChatResult> {
    const contentParts: string[] = [];
    const toolCallAccum = new Map<number, { id: string; name: string; args: string[] }>();
    let usage = { inputTokens: 0, outputTokens: 0 };

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (delta.content) {
            contentParts.push(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, { id: tc.id ?? '', name: '', args: [] });
              }
              const accum = toolCallAccum.get(idx)!;
              if (tc.id) accum.id = tc.id;
              if (tc.function?.name) accum.name += tc.function.name;
              if (tc.function?.arguments) accum.args.push(tc.function.arguments);
            }
          }
        }

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args.join('') },
      }));

    const message: Message = {
      role: 'assistant',
      content: contentParts.length > 0 ? contentParts.join('') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return { message, usage };
  }

  private getGeminiThinkingConfig(): Record<string, unknown> | null {
    if (this.model.startsWith('gemini-3')) {
      return { thinking_level: 'low' };
    }
    if (this.model.startsWith('gemini-2.5')) {
      return { thinking_budget: 2048 };
    }
    return null;
  }

  destroy(): void {
    // No persistent resources to clean up for HTTP-based provider
  }
}

// Combine multiple AbortSignals into one
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** @deprecated Use OpenAICompatProvider */
export const OpenAIProvider = OpenAICompatProvider;
