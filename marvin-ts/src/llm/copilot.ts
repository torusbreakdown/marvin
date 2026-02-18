import { execSync } from 'node:child_process';
import type {
  ProviderConfig,
  Provider,
  Message,
  ChatOptions,
  ChatResult,
  ToolCall,
} from '../types.js';

// Copilot API token (short-lived, ~30 min). Exchanged from GitHub OAuth token.
interface CopilotToken {
  token: string;
  expiresAt: number; // unix timestamp
}

const COPILOT_API_BASE = 'https://api.githubcopilot.com';
const COPILOT_VERSION = '0.26.7';

export class CopilotProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly timeoutMs: number;
  private copilotToken: CopilotToken | null = null;
  private githubToken: string | null = null;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
    const token = await this.ensureCopilotToken();
    const hasTools = options?.tools && options.tools.length > 0;
    const shouldStream = hasTools ? false : (options?.stream ?? false);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: shouldStream,
      ...(hasTools ? { tools: options!.tools } : {}),
    };

    if (shouldStream) {
      body.stream_options = { include_usage: true };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'copilot-integration-id': 'vscode-chat',
          'editor-version': 'vscode/1.99.0',
          'editor-plugin-version': `copilot-chat/${COPILOT_VERSION}`,
          'user-agent': `GitHubCopilotChat/${COPILOT_VERSION}`,
          'openai-intent': 'conversation-panel',
          'x-github-api-version': '2025-04-01',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        // If 401, invalidate token so next call re-fetches
        if (response.status === 401) this.copilotToken = null;
        throw new Error(`Copilot API ${response.status}: ${errBody.slice(0, 500)}`);
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

  destroy(): void {
    this.copilotToken = null;
    this.githubToken = null;
  }

  /**
   * Get a valid Copilot API token. Flow:
   * 1. Get GitHub token from `gh auth token`
   * 2. Exchange for Copilot token via internal API
   * 3. Cache and refresh when expired (tokens last ~30 min)
   */
  private async ensureCopilotToken(): Promise<string> {
    if (this.copilotToken && Date.now() / 1000 < this.copilotToken.expiresAt - 60) {
      return this.copilotToken.token;
    }

    // Get GitHub OAuth token
    if (!this.githubToken) {
      try {
        this.githubToken = execSync('gh auth token', { encoding: 'utf-8' }).trim();
      } catch {
        throw new Error(
          'Failed to get GitHub token. Run `gh auth login` first, or set GITHUB_TOKEN env var.',
        );
      }
    }

    // Exchange for Copilot token
    const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: 'application/json',
        'User-Agent': `GitHubCopilotChat/${COPILOT_VERSION}`,
        'X-Github-Api-Version': '2025-04-01',
      },
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Failed to get Copilot token (${resp.status}): ${err.slice(0, 300)}. Ensure you have a Copilot subscription.`);
    }

    const data = await resp.json() as { token: string; expires_at: number; refresh_in: number };
    this.copilotToken = { token: data.token, expiresAt: data.expires_at };
    return data.token;
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

  private async parseStreamingResponse(response: Response, onDelta?: (text: string) => void): Promise<ChatResult> {
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
        try { chunk = JSON.parse(data); } catch { continue; }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
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
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return { message, usage };
  }
}

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
