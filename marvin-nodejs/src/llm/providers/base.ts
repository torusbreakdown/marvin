/**
 * Base LLM Provider Interface
 * All LLM providers must implement this interface
 */

import { LLMMessage, ToolCall, ToolDefinition, LLMResponse, CostInfo } from '../../types';

export interface LLMProvider {
  /** Provider name identifier */
  readonly name: string;
  
  /** Whether this provider supports streaming */
  readonly supportsStreaming: boolean;
  
  /** Whether this provider supports tool calling */
  readonly supportsTools: boolean;
  
  /**
   * Send messages to LLM and get response (non-streaming)
   * @param messages - Conversation messages
   * @param tools - Available tool definitions
   * @param model - Model to use
   * @returns Response with content and/or tool calls
   */
  complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string
  ): Promise<LLMResponse>;
  
  /**
   * Send messages to LLM and stream response
   * @param messages - Conversation messages  
   * @param tools - Available tool definitions
   * @param model - Model to use
   * @param onChunk - Callback for each text chunk
   * @returns Response with final content and/or tool calls
   */
  stream(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse>;
  
  /**
   * Estimate cost for a request
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   * @param model - Model used
   * @returns Cost in USD
   */
  estimateCost(inputTokens: number, outputTokens: number, model: string): number;
}

export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string;
  abstract readonly supportsStreaming: boolean;
  abstract readonly supportsTools: boolean;
  
  protected apiKey?: string;
  protected baseUrl?: string;
  
  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  
  abstract complete(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string
  ): Promise<LLMResponse>;
  
  abstract stream(
    messages: LLMMessage[],
    tools: ToolDefinition[],
    model: string,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse>;
  
  abstract estimateCost(inputTokens: number, outputTokens: number, model: string): number;
  
  /**
   * Convert internal message format to provider-specific format
   */
  protected abstract formatMessages(messages: LLMMessage[]): unknown[];
  
  /**
   * Convert provider-specific response to internal format
   */
  protected abstract parseResponse(response: unknown): LLMResponse;
  
  /**
   * Count tokens in text (approximate if no tokenizer available)
   */
  protected countTokens(text: string): number {
    // Rough approximation: ~4 chars per token for English text
    return Math.ceil(text.length / 4);
  }
}
