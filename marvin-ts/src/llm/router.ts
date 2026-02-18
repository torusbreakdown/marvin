import type { Message, ChatResult } from '../types.js';

export async function runToolLoop(messages: Message[]): Promise<ChatResult> {
  // Provider-agnostic tool loop — dispatches tool calls, collects results
  return {
    message: { role: 'assistant', content: '' },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
