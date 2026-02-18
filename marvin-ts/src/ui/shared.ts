import type { StatusBarData } from '../types.js';

export interface UI {
  start(): Promise<void>;
  displayMessage(role: string, text: string): void;
  displaySystem(text: string): void;
  displayError(text: string): void;
  displayToolCall(toolNames: string[]): void;
  beginStream(): void;
  streamDelta(text: string): void;
  endStream(): void;
  promptInput(): Promise<string>;
  promptConfirm(command: string): Promise<boolean>;
  showStatus(status: StatusBarData): void;
  destroy(): void;
}

export function formatMessage(role: string, text: string): string {
  // Format a message for display
  return `${role}: ${text}`;
}

export function formatToolCall(toolNames: string[]): string {
  // Format tool call display string
  return `🔧 ${toolNames.join(', ')}`;
}
