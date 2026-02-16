/**
 * CLI Argument Parser
 * Handles all Marvin CLI flags per MARVIN_API_SPEC.md
 */

import { Command } from 'commander';
import { CliArgs, LLMProvider } from './types.js';

const program = new Command();

program
  .name('marvin')
  .description('Marvin - A multi-tool CLI assistant powered by LLMs')
  .version('1.0.0')
  .option('--non-interactive', 'Enable single-shot non-interactive mode')
  .option('--working-dir <path>', 'Set working directory for coding operations')
  .option('--design-first', 'Trigger design-first TDD pipeline')
  .option('--prompt <text>', 'The user prompt (for non-interactive mode)')
  .option('--ntfy <topic>', 'Push notification topic for pipeline alerts')
  .option('--provider <name>', 'LLM provider: copilot, gemini, groq, ollama, openai')
  .option('--model <model>', 'Override model to use')
  .option('--plain', 'Use plain terminal UI (no curses)')
  .option('--curses', 'Use curses TUI (default in interactive mode)')
  .argument('[prompt]', 'Optional inline prompt (single-shot mode)')
  .allowUnknownOption();

export function parseArgs(): CliArgs {
  program.parse();
  const opts = program.opts();
  const args = program.args;

  const result: CliArgs = {
    nonInteractive: opts.nonInteractive,
    workingDir: opts.workingDir,
    designFirst: opts.designFirst,
    prompt: opts.prompt,
    ntfy: opts.ntfy,
    provider: opts.provider,
    model: opts.model,
    plain: opts.plain,
    curses: opts.curses,
  };

  // Handle inline prompt (single-shot mode like "marvin 'find pizza'")
  if (args.length > 0 && !result.prompt) {
    result.prompt = args.join(' ');
  }

  return result;
}

export function showHelp(): void {
  program.help();
}
