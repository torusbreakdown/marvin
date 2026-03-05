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

  private lastResponseId: string | null = null;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    if (this.name === 'openai') {
      return await this.chatResponses(messages, options);
    }
    return await this.chatCompletions(messages, options);
  }

  private async chatCompletions(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
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
        // SECURITY NOTE: errBody is truncated to 500 chars. The API key is sent via
        // Authorization header, not the body, so it should not appear in error responses.
        // If a provider ever echoes auth headers in errors, this would need scrubbing.
        throw new Error(`${response.status} ${response.statusText}: ${errBody.slice(0, 500)}`);
      }

      if (shouldStream) {
        return await this.parseStreamingResponse(response, options?.onDelta);
      } else {
        return await this.parseNonStreamingResponse(response);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async chatResponses(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    const hasTools = options?.tools && options.tools.length > 0;
    // Force stream=false when tools are provided (tool calls can't stream reliably)
    const shouldStream = hasTools ? false : (options?.stream ?? false);

    const isToolContinuation = messages.length > 0 && messages[messages.length - 1].role === 'tool';

    const effort = this.getOpenAIReasoningEffort();
    const body: Record<string, unknown> = {
      model: this.model,
      ...(effort ? { reasoning: { effort } } : {}),
      ...(hasTools ? { tools: this.convertToolsForResponses(options!.tools!) } : {}),
      ...(options?.extraBody ?? {}),
      ...(shouldStream ? { stream: true } : {}),
    };

    if (isToolContinuation && this.lastResponseId) {
      // Continuation mode: send tool results referencing the previous response
      const toolMsgs: Message[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'tool') break;
        toolMsgs.push(m);
      }
      toolMsgs.reverse();

      body.previous_response_id = this.lastResponseId;
      body.input = toolMsgs.map((m) => ({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content ?? '',
      }));
    } else {
      // Non-continuation: convert full history to Responses API input format.
      // Inline tool results as user messages since Responses API doesn't support role=tool in input.
      this.lastResponseId = null;
      body.input = messages
        .filter(m => m.role !== 'tool')
        .map(m => {
          if (m.tool_calls?.length) {
            // Convert assistant tool_call messages to plain text so context isn't lost
            const callSummary = m.tool_calls.map(tc => `Called ${tc.function.name}(${tc.function.arguments})`).join('; ');
            return { role: 'assistant', content: m.content ? `${m.content}\n[${callSummary}]` : `[${callSummary}]` };
          }
          return { role: m.role, content: m.content ?? '' };
        });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
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
        return await this.parseResponsesStreamingResponse(response, options?.onDelta);
      } else {
        return await this.parseResponsesNonStreamingResponse(response);
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
      ...(msg?.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
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

  private async parseStreamingResponse(response: Response, onDelta?: (text: string) => void): Promise<ChatResult> {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
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
          // Kimi reasoning_content comes before content
          if (delta.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
          }

          if (delta.content) {
            contentParts.push(delta.content);
            onDelta?.(delta.content);
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
      ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('') } : {}),
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

  private getOpenAIReasoningEffort(): string | null {
    // Only inject for the real OpenAI provider, not other OpenAI-compatible backends.
    if (this.name !== 'openai') return null;
    if (!this.model.startsWith('gpt-5')) return null;
    return 'xhigh';
  }

  // Responses API uses a flat tool schema: {type, name, description, parameters}
  // Chat Completions uses nested: {type, function: {name, description, parameters}}
  private convertToolsForResponses(tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>): any[] {
    return tools.map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  private async parseResponsesNonStreamingResponse(response: Response): Promise<ChatResult> {
    const json = await response.json() as any;
    if (json?.id) this.lastResponseId = json.id;

    const toolCalls: ToolCall[] = (json?.output ?? [])
      .filter((o: any) => o?.type === 'function_call' && o?.name)
      .map((o: any) => ({
        id: o.call_id ?? o.id ?? '',
        type: 'function' as const,
        function: {
          name: o.name,
          arguments: o.arguments ?? '{}',
        },
      }))
      .filter((tc: ToolCall) => !!tc.id);

    const content = this.extractResponsesOutputText(json);

    const message: Message = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return {
      message,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }

  private async parseResponsesStreamingResponse(response: Response, onDelta?: (text: string) => void): Promise<ChatResult> {
    const contentParts: string[] = [];
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
        if (!data || data === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        // Only capture output_text deltas, skip reasoning deltas
        if (chunk?.type && typeof chunk.type === 'string' && chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
          contentParts.push(chunk.delta);
          onDelta?.(chunk.delta);
        }

        if (chunk?.response?.id) {
          this.lastResponseId = chunk.response.id;
        }

        const u = chunk?.response?.usage ?? chunk?.usage;
        if (u) {
          usage.inputTokens = u.input_tokens ?? usage.inputTokens;
          usage.outputTokens = u.output_tokens ?? usage.outputTokens;
        }
      }
    }

    const message: Message = {
      role: 'assistant',
      content: contentParts.length > 0 ? contentParts.join('') : null,
    };

    return { message, usage };
  }

  private extractResponsesOutputText(json: any): string | null {
    // Do NOT use json.output_text — it includes reasoning/thinking summaries.
    // Only extract text from explicit 'message' output items.
    const parts: string[] = [];
    for (const item of json?.output ?? []) {
      // Skip reasoning items entirely
      if (item?.type === 'reasoning') continue;

      if (item?.type === 'message') {
        for (const c of item.content ?? []) {
          if (c?.type === 'output_text' && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }

    return parts.length > 0 ? parts.join('') : null;
  }

  destroy(): void {
    // No persistent resources to clean up for HTTP-based provider
  }

  /** Clear continuation state (e.g. after context compaction). */
  resetContinuation(): void {
    this.lastResponseId = null;
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
