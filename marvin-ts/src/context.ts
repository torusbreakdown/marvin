import type { Message, ContextBudget } from './types.js';

export class ContextBudgetManager {
  private budget: ContextBudget = {
    warnThreshold: 180_000,
    compactThreshold: 200_000,
    hardLimit: 226_000,
    currentTokens: 0,
  };

  getBudget(): ContextBudget {
    return { ...this.budget };
  }

  updateActual(usage: { inputTokens: number; outputTokens: number }): void {
    this.budget.currentTokens = usage.inputTokens + usage.outputTokens;
  }

  checkBudget(messages: Message[]): 'ok' | 'warn' | 'compact' | 'reject' {
    const estimated = estimateTokens(JSON.stringify(messages));
    if (estimated >= this.budget.hardLimit) return 'reject';
    if (estimated >= this.budget.compactThreshold) return 'compact';
    if (estimated >= this.budget.warnThreshold) return 'warn';
    return 'ok';
  }

  truncateResult(result: string): string {
    // Placeholder — truncate large tool results to fit budget
    return result;
  }

  async compact(messages: Message[]): Promise<Message[]> {
    // Placeholder — compact middle messages, keep last 8
    return messages;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function compactContext(messages: unknown[], targetTokens: number): unknown[] {
  return messages;
}
