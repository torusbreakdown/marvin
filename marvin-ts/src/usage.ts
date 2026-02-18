import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUsage } from './types.js';

// Per-million-token pricing (input, output) in USD
const COST_TABLE: Record<string, [number, number]> = {
  'gemini-3-pro-preview':      [1.25,  10.00],
  'llama-3.3-70b-versatile':   [0.59,   0.79],
  'gpt-5.1':                   [2.00,   8.00],
  'gpt-5.2':                   [2.50,  10.00],
  'gpt-5.3-codex':             [3.00,  12.00],
  'claude-haiku-4.5':          [0.80,   4.00],
  'claude-sonnet-4.5':         [3.00,  15.00],
  'claude-opus-4.6':           [15.00,  75.00],
  'qwen3-coder:30b':           [0.00,   0.00],  // local
  'qwen/qwen3-32b':            [0.20,   0.20],
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_TABLE[model] ?? [0.50, 1.50]; // fallback
  return (inputTokens / 1_000_000) * rates[0] + (outputTokens / 1_000_000) * rates[1];
}

export interface CostLogEntry {
  ts: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface PersistedUsage {
  llmTurns: number;
  totalCostUsd: number;
  modelTurns: Record<string, number>;
  modelCost: Record<string, number>;
  toolCallCounts: Record<string, number>;
}

export class UsageTracker {
  private sessionTurns = 0;
  private sessionCost = 0;
  private sessionModelTurns: Record<string, number> = {};
  private sessionModelCost: Record<string, number> = {};
  private sessionToolCalls: Record<string, number> = {};
  private lifetime: PersistedUsage | null = null;
  private persistDir: string;

  constructor(persistDir: string) {
    this.persistDir = persistDir;
  }

  recordTurn(provider: string, model: string, inputTokens: number, outputTokens: number): void {
    this.sessionTurns++;
    const cost = estimateCost(model, inputTokens, outputTokens);
    this.sessionCost += cost;
    this.sessionModelTurns[model] = (this.sessionModelTurns[model] ?? 0) + 1;
    this.sessionModelCost[model] = (this.sessionModelCost[model] ?? 0) + cost;

    // Append to timestamped cost log
    const entry: CostLogEntry = {
      ts: new Date().toISOString(),
      provider, model, inputTokens, outputTokens, costUsd: cost,
    };
    try {
      mkdirSync(this.persistDir, { recursive: true });
      appendFileSync(join(this.persistDir, 'cost-log.jsonl'), JSON.stringify(entry) + '\n');
    } catch { /* ignore */ }
  }

  recordToolCall(toolName: string): void {
    this.sessionToolCalls[toolName] = (this.sessionToolCalls[toolName] ?? 0) + 1;
  }

  getSessionUsage(): SessionUsage {
    return {
      totalCostUsd: this.sessionCost,
      llmTurns: this.sessionTurns,
      modelTurns: { ...this.sessionModelTurns },
      modelCost: { ...this.sessionModelCost },
      toolCallCounts: { ...this.sessionToolCalls },
    };
  }

  getLifetimeUsage(): SessionUsage {
    if (!this.lifetime) {
      return this.getSessionUsage();
    }
    const merged: SessionUsage = {
      totalCostUsd: this.lifetime.totalCostUsd + this.sessionCost,
      llmTurns: this.lifetime.llmTurns + this.sessionTurns,
      modelTurns: { ...this.lifetime.modelTurns },
      modelCost: { ...this.lifetime.modelCost },
      toolCallCounts: { ...this.lifetime.toolCallCounts },
    };
    for (const [k, v] of Object.entries(this.sessionModelTurns)) {
      merged.modelTurns[k] = (merged.modelTurns[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(this.sessionModelCost)) {
      merged.modelCost[k] = (merged.modelCost[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(this.sessionToolCalls)) {
      merged.toolCallCounts[k] = (merged.toolCallCounts[k] ?? 0) + v;
    }
    return merged;
  }

  summary(): string {
    const usage = this.getSessionUsage();
    const lines: string[] = [`Session: ${usage.llmTurns} turns, $${usage.totalCostUsd.toFixed(4)}`];
    for (const [model, turns] of Object.entries(usage.modelTurns)) {
      const cost = usage.modelCost[model] ?? 0;
      lines.push(`  ${model}: ${turns} turns, $${cost.toFixed(4)}`);
    }
    if (Object.keys(usage.toolCallCounts).length > 0) {
      const toolParts = Object.entries(usage.toolCallCounts)
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');
      lines.push(`Tools: ${toolParts}`);
    }
    return lines.join('\n');
  }

  save(): void {
    mkdirSync(this.persistDir, { recursive: true });
    const lifetime = this.getLifetimeUsage();
    const data: PersistedUsage = {
      llmTurns: lifetime.llmTurns,
      totalCostUsd: lifetime.totalCostUsd,
      modelTurns: lifetime.modelTurns,
      modelCost: lifetime.modelCost,
      toolCallCounts: lifetime.toolCallCounts,
    };
    writeFileSync(join(this.persistDir, 'usage.json'), JSON.stringify(data, null, 2));
  }

  load(): void {
    const filePath = join(this.persistDir, 'usage.json');
    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      this.lifetime = JSON.parse(raw) as PersistedUsage;
    } catch {
      this.lifetime = null;
    }
  }

  queryCostLog(since?: string, until?: string): { entries: CostLogEntry[]; totalCost: number; totalMessages: number; totalInput: number; totalOutput: number; byModel: Record<string, { cost: number; messages: number }> } {
    const logPath = join(this.persistDir, 'cost-log.jsonl');
    const entries: CostLogEntry[] = [];
    try {
      if (!existsSync(logPath)) return { entries: [], totalCost: 0, totalMessages: 0, totalInput: 0, totalOutput: 0, byModel: {} };
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as CostLogEntry;
          if (since && e.ts < since) continue;
          if (until && e.ts > until) continue;
          entries.push(e);
        } catch { /* skip malformed */ }
      }
    } catch { /* ignore */ }

    let totalCost = 0, totalInput = 0, totalOutput = 0;
    const byModel: Record<string, { cost: number; messages: number }> = {};
    for (const e of entries) {
      totalCost += e.costUsd;
      totalInput += e.inputTokens;
      totalOutput += e.outputTokens;
      if (!byModel[e.model]) byModel[e.model] = { cost: 0, messages: 0 };
      byModel[e.model].cost += e.costUsd;
      byModel[e.model].messages += 1;
    }
    return { entries, totalCost, totalMessages: entries.length, totalInput, totalOutput, byModel };
  }
}
