/**
 * Non-Interactive Mode Handler
 * Stdout streaming per MARVIN_API_SPEC.md
 */

import { Spinner } from './retro.js';
import { colors } from '../utils/colors.js';
import { CostInfo } from '../types.js';
import { logger } from '../utils/logger.js';

export interface NonInteractiveOptions {
  prompt: string;
  workingDir?: string;
  provider: string;
  model: string;
}

export class NonInteractiveHandler {
  private costInfo: CostInfo = {
    session_cost: 0,
    llm_turns: 0,
    model_turns: {},
    model_cost: {},
  };

  constructor(private options: NonInteractiveOptions) {}

  async run(): Promise<number> {
    try {
      // Output nothing on startup - wait for content
      // Stream tokens as they arrive
      // Final cost on stderr
      
      logger.info('Non-interactive mode started', {
        prompt: this.options.prompt.slice(0, 100) + '...',
        workingDir: this.options.workingDir,
      });
      
      // This would call the LLM and stream response
      // For now, just echo with proper format
      
      // Stream response to stdout
      const response = await this.generateResponse();
      
      // Output final cost to stderr
      this.emitCost();
      
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(colors.red('ERROR:'), message);
      this.emitCost();
      return 1;
    }
  }

  private async generateResponse(): Promise<string> {
    // This would integrate with the LLM system
    // For now, just output something
    console.log("This is Marvin in non-interactive mode. Full implementation requires LLM integration.");
    return "";
  }

  streamChunk(chunk: string): void {
    // Output raw text to stdout
    // Per spec: strip trailing \n to avoid doubled newlines
    process.stdout.write(chunk);
  }

  streamToolCall(tools: string[]): void {
    // Tool call marker on stdout
    console.log(`  🔧 ${tools.join(', ')}`);
  }

  trackCost(model: string, cost: number): void {
    this.costInfo.session_cost += cost;
    this.costInfo.llm_turns++;
    this.costInfo.model_turns[model] = (this.costInfo.model_turns[model] || 0) + 1;
    this.costInfo.model_cost[model] = (this.costInfo.model_cost[model] || 0) + cost;
  }

  private emitCost(): void {
    // Emit MARVIN_COST to stderr as final line
    const costJson = JSON.stringify(this.costInfo);
    console.error(`MARVIN_COST:${costJson}`);
  }
}
