import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatLogEntry } from './types.js';

export function loadChatLog(profileDir: string): ChatLogEntry[] {
  const filePath = join(profileDir, 'chat_log.json');
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ChatLogEntry[];
  } catch {
    return [];
  }
}

export function saveChatLog(profileDir: string, entries: ChatLogEntry[]): void {
  mkdirSync(profileDir, { recursive: true });
  const filePath = join(profileDir, 'chat_log.json');
  writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

export function appendChatLog(profileDir: string, entry: ChatLogEntry): void {
  const existing = loadChatLog(profileDir);
  existing.push(entry);
  saveChatLog(profileDir, existing);
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
