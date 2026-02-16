/**
 * Ollama Provider
 * Local LLM support via Ollama API
 */

import { LLMProvider, LLMMessage, LLMResponse, ToolCall, ToolDefinition } from './base';
import { logger } from '../../utils/logger';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private baseUrl: string;
  private model: string;
  private maxRetries = 3;

  constructor() {
    this.baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'qwen3-coder:30b';
  }

  async chat(
    messages: LLMMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
    }
  ): Promise<LLMResponse> {
    const url = `${this.baseUrl}/api/chat`;
    
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.debug(`Ollama request attempt ${attempt}`);
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        
        // Calculate approximate cost (Ollama is free, but track usage)
        const promptTokens = data.prompt_eval_count || this.estimateTokens(messages);
        const completionTokens = data.eval_count || 0;
        
        return {
          content: data.message?.content || '',
          toolCalls: this.extractToolCalls(data.message),
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            cost: 0, // Ollama is free
          },
          model: this.model,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Ollama request failed (attempt ${attempt}):`, error);
        
        if (attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }

    throw lastError || new Error('Ollama request failed after all retries');
  }

  async *stream(
    messages: LLMMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      tools?: ToolDefinition[];
    }
  ): AsyncGenerator<string, LLMResponse, unknown> {
    const url = `${this.baseUrl}/api/chat`;
    
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertTools(options.tools);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Ollama response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let toolCalls: ToolCall[] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            
            if (data.message?.content) {
              const content = data.message.content;
              fullContent += content;
              yield content;
            }
            
            if (data.message?.tool_calls) {
              toolCalls = this.extractToolCalls(data.message);
            }
          } catch {
            // Ignore parse errors for incomplete chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      toolCalls,
      usage: {
        promptTokens: this.estimateTokens(messages),
        completionTokens: this.estimateTokens([{ role: 'assistant', content: fullContent }]),
        totalTokens: 0,
        cost: 0,
      },
      model: this.model,
    };
  }

  isAvailable(): boolean {
    // Check if Ollama is running
    return true; // Assume available; will fail at request time if not
  }

  getDefaultModel(): string {
    return this.model;
  }

  private convertTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private extractToolCalls(message: { tool_calls?: Array<Record<string, unknown>> }): ToolCall[] | undefined {
    if (!message.tool_calls?.length) return undefined;

    return message.tool_calls.map((tc: Record<string, unknown>) => ({
      name: (tc.function as Record<string, unknown>)?.name as string,
      arguments: (tc.function as Record<string, unknown>)?.arguments as Record<string, unknown>,
    }));
  }

  private estimateTokens(messages: LLMMessage[]): number {
    // Rough estimation: ~4 chars per token
    const text = messages.map(m => m.content).join('');
    return Math.ceil(text.length / 4);
  }
}
