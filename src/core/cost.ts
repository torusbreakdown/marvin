export type MarvinCost = {
  session_cost: number;
  llm_turns: number;
  model_turns: Record<string, number>;
  model_cost: Record<string, number>;
};

export class CostTracker {
  private llmTurns = 0;
  private modelTurns: Record<string, number> = {};
  private modelCost: Record<string, number> = {};

  addTurn(model: string, costUsd?: number) {
    this.llmTurns += 1;
    this.modelTurns[model] = (this.modelTurns[model] || 0) + 1;
    if (typeof costUsd === 'number') {
      this.modelCost[model] = (this.modelCost[model] || 0) + costUsd;
    }
  }

  snapshot(): MarvinCost {
    const session_cost = Object.values(this.modelCost).reduce((a, b) => a + b, 0);
    return {
      session_cost: Number(session_cost.toFixed(6)),
      llm_turns: this.llmTurns,
      model_turns: this.modelTurns,
      model_cost: this.modelCost
    };
  }

  emitToStderr() {
    const line = `MARVIN_COST:${JSON.stringify(this.snapshot())}`;
    process.stderr.write(line + '\n');
  }
}
