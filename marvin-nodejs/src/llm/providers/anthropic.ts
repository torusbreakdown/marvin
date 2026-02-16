/**
 * Anthropic Claude Provider
 * Supports Claude models via Anthropic API
 */

import { BaseProvider } from './base';
import { LLMMessage, ToolCall, ToolDefinition, LLMResponse } from '../../types';
import { logger } from '../../utils/logger';

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly supportsStreaming = true;
  readonly supportsTools = true;
  
  // Pricing per 1M tokens (input, output)
  private pricing: Map<string, [number, number]> = new Map([
    ['claude-opus-4.6', [15, 75]],
    ['claude-sonnet-4', [3, 15]],
    ['claude-haiku-3', [0.25, 1.25]],
    ['claude-3-5-sonnet', [3, 15]],
    ['claude-3-opus', [15, 75]],
  ]);
  
  async complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string
  ): Promise<LLMResponse> {
    const url = this.baseUrl || 'https://api.anthropic.com/v1/messages';
    
    // Separate system message from conversation
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages: this.formatMessages(conversationMessages),
    };
    
    if (systemMessage) {
      body.system = systemMessage.content;
    }
    
    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
    }
    
    logger.debug('Anthropic request', { model, messageCount: messages.length });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
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
    const url = this.baseUrl || 'https://api.anthropic.com/v1/messages';
    
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages: this.formatMessages(conversationMessages),
      stream: true,
    };
    
    if (systemMessage) {
      body.system = systemMessage.content;
    }
    
    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
    }
    
    logger.debug('Anthropic streaming request', { model });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
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
        if (!line.startsWith('data: ')) continue;
        
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        
        try {
          const chunk = JSON.parse(data);
          
          if (chunk.type === 'content_block_delta') {
            if (chunk.delta.type === 'text_delta') {
              content += chunk.delta.text;
              onChunk(chunk.delta.text);
            }
          } else if (chunk.type === 'message_start') {
            inputTokens = chunk.message.usage?.input_tokens || 0;
          } else if (chunk.type === 'message_delta') {
            outputTokens = chunk.usage?.output_tokens || 0;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
    
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
    const pricing = this.pricing.get(model) || [3, 15];
    const [inputPrice, outputPrice] = pricing;
    
    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  }
  
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    return messages.map(m => {
      // Convert tool responses to Anthropic's format
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          }],
        };
      }
      
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      };
    });
  }
  
  protected formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  
  protected parseResponse(data: unknown): LLMResponse {
    const resp = data as any;
    const content = resp.content || [];
    
    const textContent = content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
    
    const toolUseBlocks = content.filter((c: any) => c.type === 'tool_use');
    
    return {
      content: textContent || undefined,
      toolCalls: toolUseBlocks.length > 0 ? toolUseBlocks.map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      })) : undefined,
      usage: {
        inputTokens: resp.usage?.input_tokens || 0,
        outputTokens: resp.usage?.output_tokens || 0,
        cost: 0,
      },
    };
  }
}
