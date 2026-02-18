import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ContextBudget } from './types.js';

export const WARN_THRESHOLD = 180_000;
export const COMPACT_THRESHOLD = 200_000;
export const HARD_LIMIT = 226_000;

export class ContextBudgetManager {
  private budget: ContextBudget = {
    warnThreshold: WARN_THRESHOLD,
    compactThreshold: COMPACT_THRESHOLD,
    hardLimit: HARD_LIMIT,
    currentTokens: 0,
  };

  getBudget(): ContextBudget {
    return { ...this.budget };
  }

  updateActual(usage: { inputTokens: number; outputTokens: number }): void {
    this.budget.currentTokens = usage.inputTokens + usage.outputTokens;
  }

  checkBudget(messages: Message[]): 'ok' | 'warn' | 'compact' | 'reject' {
    const estimated = estimateTokens(messages);
    if (estimated >= this.budget.hardLimit) return 'reject';
    if (estimated >= this.budget.compactThreshold) return 'compact';
    if (estimated >= this.budget.warnThreshold) return 'warn';
    return 'ok';
  }

  truncateResult(result: string): string {
    const remaining = (this.budget.hardLimit - this.budget.currentTokens) * 4;
    if (remaining <= 0) return 'Error: No room in context budget for this result.';
    if (result.length > remaining) {
      const omitted = result.length - remaining;
      return result.slice(0, remaining) + `\n[Result truncated — ${omitted} chars omitted due to context budget.]`;
    }
    return result;
  }

  async compact(messages: Message[]): Promise<Message[]> {
    const backupDir = join(process.cwd(), '.marvin', 'logs');
    return compactContext(messages, backupDir);
  }
}

/** Estimate tokens for a message array: sum of JSON.stringify lengths / 4 */
export function estimateTokens(messages: Message[]): number {
  if (messages.length === 0) return 0;
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** Compact context: keep system[0] + last 8, summarize middle, write backup JSONL */
export function compactContext(messages: Message[], backupDir: string): Message[] {
  // 1. Write backup to JSONL
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `context-backup-${Date.now()}.jsonl`);
  const lines = messages.map(m => JSON.stringify(m)).join('\n');
  writeFileSync(backupPath, lines + '\n');

  // 2. Split: keep system prompt + last 8 messages
  const systemMsg = messages[0];
  const keepCount = 8;
  const keptMessages = messages.slice(-keepCount);
  const droppedMessages = messages.slice(1, -keepCount);

  // 3. Generate summary from dropped messages
  const userTopics = droppedMessages
    .filter(m => m.role === 'user' && m.content)
    .map(m => m.content!.slice(0, 100).replace(/\n/g, ' '))
    .slice(0, 15);

  const toolNames = new Set<string>();
  for (const m of droppedMessages) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNames.add(tc.function.name);
      }
    }
    if (m.role === 'tool' && m.name) {
      toolNames.add(m.name);
    }
  }

  const assistantSnippets = droppedMessages
    .filter(m => m.role === 'assistant' && m.content)
    .map(m => m.content!.slice(0, 80))
    .slice(0, 5);

  let summaryParts = [`[Context compacted. ${droppedMessages.length} messages summarized.`];
  if (userTopics.length > 0) {
    summaryParts.push(`Earlier conversation covered: ${userTopics.join('; ')}`);
  }
  if (toolNames.size > 0) {
    summaryParts.push(`Tools used: ${[...toolNames].join(', ')}`);
  }
  if (assistantSnippets.length > 0) {
    summaryParts.push(`Key responses: ${assistantSnippets.join(' | ')}`);
  }
  summaryParts[summaryParts.length - 1] += ']';

  const summaryMsg: Message = {
    role: 'system',
    content: summaryParts.join(' '),
  };

  return [systemMsg, summaryMsg, ...keptMessages];
}

/** Gate a tool result against context budget thresholds. Truncates or returns error. */
export function budgetGateResult(
  toolName: string,
  result: string,
  currentTokens: number,
  thresholds: { warnThreshold: number; compactThreshold: number; hardLimit: number },
): string {
  if (currentTokens >= thresholds.hardLimit) {
    return `Error: context budget exceeded (${currentTokens} tokens). Cannot add ${toolName} result. Use compact_history to free space or use start_line/end_line for large files.`;
  }

  const remainingTokens = thresholds.hardLimit - currentTokens;
  const remainingChars = remainingTokens * 4;

  if (currentTokens >= thresholds.warnThreshold && result.length > remainingChars) {
    const truncated = result.slice(0, remainingChars);
    const omitted = result.length - remainingChars;
    return truncated + `\n[Result truncated — ${omitted} chars omitted due to context budget.]`;
  }

  return result;
}
