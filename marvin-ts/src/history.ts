import type { ChatLogEntry } from './types.js';

export function loadChatLog(profileDir: string): ChatLogEntry[] {
  // Load chat_log.json from profile directory
  return [];
}

export function saveChatLog(profileDir: string, entries: ChatLogEntry[]): void {
  // Save full chat_log.json to profile directory
}

export function appendChatLog(profileDir: string, entry: ChatLogEntry): void {
  // Append entry to chat_log.json
}

export function compactHistory(chatLog: ChatLogEntry[]): ChatLogEntry[] {
  // Compact old entries into summary entries
  return chatLog;
}

export function searchHistoryBackups(profileDir: string, query: string): string[] {
  // Search through history backup files
  return [];
}

/** @deprecated Use appendChatLog instead */
export const appendChat = appendChatLog;
