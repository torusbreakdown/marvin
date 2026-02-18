import type { Message, ChatLogEntry, MessageRole } from './types.js';

export function buildSystemMessage(): string {
  // Build the system prompt with personality, prefs, history, etc.
  return '';
}

export function seedHistoryMessages(chatLog: ChatLogEntry[], limit: number = 20): Message[] {
  const recent = chatLog.slice(-limit);
  return recent
    .filter(entry => entry.role !== 'system')
    .map(entry => ({
      role: (entry.role === 'you' ? 'user' : entry.role) as MessageRole,
      content: entry.text,
    }));
}
