/**
 * OpenAI / OpenAI-Compatible Provider
 * Supports OpenAI, OpenRouter, and other OpenAI-compatible endpoints
 */

import { BaseProvider } from './base';
import { LLMMessage, ToolCall, ToolDefinition, LLMResponse, CostInfo } from '../../types';
import { logger } from '../../utils/logger';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  readonly supportsStreaming = true;
  readonly supportsTools = true;
  
  // Default pricing per 1M tokens (input, output)
  private pricing: Map<string, [number, number]> = new Map([
    ['gpt-4', [30, 60]],
    ['gpt-4-turbo', [10, 30]],
    ['gpt-3.5-turbo', [0.5, 1.5]],
    ['gpt-5.2', [2, 6]],
    ['gpt-5.3-codex', [3, 9]],
  ]);
  
  async complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string
  ): Promise<LLMResponse> {
    const url = this.baseUrl || 'https://api.openai.com/v1/chat/completions';
    
    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages),
      temperature: 0.7,
      max_tokens: 4096,
    };
    
    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = 'auto';
    }
    
    logger.debug('OpenAI request', { url, model, messageCount: messages.length });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }
    
    const data = await response.json();
    return this.parseResponse(data);
  }
  
  async stream(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    const url = this.baseUrl || 'https://api.openai.com/v1/chat/completions';
    
    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages),
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
    };
    
    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = 'auto';
    }
    
    logger.debug('OpenAI streaming request', { url, model });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }
    
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }
    
    let content = '';
    let toolCalls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
        
        const data = line.replace(/^data: /, '');
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          
          if (delta?.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          
          if (delta?.tool_calls) {
            // Accumulate tool calls
            for (const tc of delta.tool_calls) {
              const existing = toolCalls[tc.index];
              if (existing) {
                existing.function.arguments += tc.function.arguments || '';
              } else {
                toolCalls[tc.index] = {
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || '',
                  },
                };
              }
            }
          }
          
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens;
            outputTokens = chunk.usage.completion_tokens;
          }
        } catch (e) {
          // Ignore parse errors for malformed chunks
        }
      }
    }
    
    // Count tokens if not provided
    if (inputTokens === 0) {
      inputTokens = messages.reduce((sum, m) => sum + this.countTokens(m.content), 0);
    }
    if (outputTokens === 0) {
      outputTokens = this.countTokens(content);
    }
    
    return {
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens,
        outputTokens,
        cost: this.estimateCost(inputTokens, outputTokens, model),
      },
    };
  }
  
  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    const pricing = this.pricing.get(model) || [10, 30]; // Default to GPT-4 pricing
    const [inputPrice, outputPrice] = pricing;
    
    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  }
  
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    return messages.map(m => ({
      role: m.role === 'tool' ? 'function' : m.role,
      content: m.content,
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));
  }
  
  protected formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
  
  protected parseResponse(data: unknown): LLMResponse {
    const choice = (data as any).choices?.[0];
    const message = choice?.message;
    
    return {
      content: message?.content || undefined,
      toolCalls: message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      usage: {
        inputTokens: (data as any).usage?.prompt_tokens || 0,
        outputTokens: (data as any).usage?.completion_tokens || 0,
        cost: 0, // Set by caller
      },
    };
  }
}
