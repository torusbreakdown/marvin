/**
 * Google Gemini Provider
 * Supports Gemini models via Google AI API
 */

import { BaseProvider } from './base';
import { LLMMessage, ToolCall, ToolDefinition, LLMResponse } from '../../types';
import { logger } from '../../utils/logger';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';
  readonly supportsStreaming = true;
  readonly supportsTools = true;
  
  // Pricing per 1M tokens (input, output)
  private pricing: Map<string, [number, number]> = new Map([
    ['gemini-3-pro-preview', [1.25, 5]],
    ['gemini-3-flash-preview', [0.075, 0.3]],
    ['gemini-1.5-pro', [1.25, 5]],
    ['gemini-1.5-flash', [0.075, 0.3]],
    ['gemini-pro', [0.5, 1.5]],
  ]);
  
  async complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string
  ): Promise<LLMResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    
    const body: Record<string, unknown> = {
      contents: this.formatMessages(messages),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    };
    
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: this.formatTools(tools) }];
    }
    
    logger.debug('Gemini request', { model, messageCount: messages.length });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${this.apiKey}`;
    
    const body: Record<string, unknown> = {
      contents: this.formatMessages(messages),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
      },
    };
    
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: this.formatTools(tools) }];
    }
    
    logger.debug('Gemini streaming request', { model });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
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
      
      // Gemini sends newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const chunk = JSON.parse(line);
          const candidates = chunk.candidates || [];
          
          for (const candidate of candidates) {
            const parts = candidate.content?.parts || [];
            
            for (const part of parts) {
              if (part.text) {
                content += part.text;
                onChunk(part.text);
              }
              
              if (part.functionCall) {
                toolCalls.push({
                  id: part.functionCall.name + '_' + Date.now(),
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args),
                  },
                });
              }
            }
          }
          
          if (chunk.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount || 0;
            outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
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
    const pricing = this.pricing.get(model) || [1.25, 5];
    const [inputPrice, outputPrice] = pricing;
    
    return (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  }
  
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    // Group messages by role for Gemini's format
    const contents = [];
    let currentRole: string | null = null;
    let currentParts: unknown[] = [];
    
    for (const msg of messages) {
      const role = msg.role === 'model' || msg.role === 'assistant' ? 'model' : 
                   msg.role === 'system' ? 'user' : msg.role;
      
      if (role !== currentRole && currentRole !== null) {
        contents.push({
          role: currentRole,
          parts: currentParts,
        });
        currentParts = [];
      }
      
      currentRole = role;
      
      // Handle tool responses
      if (msg.role === 'tool') {
        currentParts.push({
          functionResponse: {
            name: msg.name || 'unknown',
            response: { result: msg.content },
          },
        });
      } else {
        currentParts.push({ text: msg.content });
      }
    }
    
    if (currentRole && currentParts.length > 0) {
      contents.push({
        role: currentRole,
        parts: currentParts,
      });
    }
    
    return contents;
  }
  
  protected formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  
  protected parseResponse(data: unknown): LLMResponse {
    const resp = data as any;
    const candidates = resp.candidates || [];
    
    if (candidates.length === 0) {
      return {
        content: '',
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      };
    }
    
    const content = candidates[0].content;
    const parts = content?.parts || [];
    
    const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
    const functionCalls = parts.filter((p: any) => p.functionCall);
    
    return {
      content: textParts.join('') || undefined,
      toolCalls: functionCalls.length > 0 ? functionCalls.map((fc: any) => ({
        id: fc.functionCall.name + '_' + Date.now(),
        type: 'function',
        function: {
          name: fc.functionCall.name,
          arguments: JSON.stringify(fc.functionCall.args),
        },
      })) : undefined,
      usage: {
        inputTokens: resp.usageMetadata?.promptTokenCount || 0,
        outputTokens: resp.usageMetadata?.candidatesTokenCount || 0,
        cost: 0,
      },
    };
  }
}
