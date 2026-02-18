import type { Writable } from 'node:stream';
import type { StreamCallbacks, SessionUsage } from './types.js';

export interface NonInteractiveSession {
  submit(prompt: string, callbacks?: StreamCallbacks): Promise<any>;
  getUsage(): { getSessionUsage(): SessionUsage };
  destroy(): Promise<void>;
}

export interface RunNonInteractiveOptions {
  prompt: string;
  session: NonInteractiveSession;
  stdout: Writable;
  stderr: Writable;
}

/**
 * Run a single non-interactive prompt: stream tokens to stdout, emit cost to stderr.
 * Returns exit code (0 = success, 1 = error).
 */
export async function runNonInteractive(opts: RunNonInteractiveOptions): Promise<number> {
  const { prompt, session, stdout, stderr } = opts;

  let exitCode = 0;
  let errorReported = false;

  const callbacks: StreamCallbacks = {
    onDelta: (text: string) => {
      stdout.write(text);
    },
    onToolCallStart: (names: string[]) => {
      stdout.write(`  🔧 ${names.join(', ')}\n`);
    },
    onComplete: () => {},
    onError: (err: Error) => {
      stderr.write(`Error: ${err.message}\n`);
      errorReported = true;
    },
  };

  try {
    await session.submit(prompt, callbacks);
    stdout.write('\n');
  } catch (err) {
    if (!errorReported) {
      stderr.write(`Error: ${(err as Error).message}\n`);
    }
    exitCode = 1;
  }

  // Always emit cost data
  try {
    const usage = session.getUsage().getSessionUsage();
    const costData = {
      session_cost: usage.totalCostUsd,
      llm_turns: usage.llmTurns,
      model_turns: usage.modelTurns,
      model_cost: usage.modelCost,
    };
    stderr.write(`MARVIN_COST:${JSON.stringify(costData)}\n`);
  } catch {
    // Ignore cost tracking errors
  }

  await session.destroy();
  return exitCode;
}
