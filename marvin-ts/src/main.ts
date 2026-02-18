import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { CliArgs, StreamCallbacks, Message } from './types.js';
import type { UI } from './ui/shared.js';
import { PlainUI } from './ui/plain.js';
import { runNonInteractive } from './non-interactive.js';

export function parseCliArgs(argv?: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      provider:          { type: 'string' },
      plain:             { type: 'boolean', default: false },
      curses:            { type: 'boolean', default: false },
      'non-interactive': { type: 'boolean', default: false },
      prompt:            { type: 'string' },
      'working-dir':     { type: 'string' },
      ntfy:              { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  return {
    provider: values.provider,
    plain: values.plain ?? false,
    nonInteractive: values['non-interactive'] ?? false,
    prompt: values.prompt,
    workingDir: values['working-dir'],
    ntfy: values.ntfy,
    inlinePrompt: positionals[0],
  };
}

// Known slash commands
const KNOWN_BANG_COMMANDS = new Set(['!code', '!shell', '!sh', '!voice', '!v', '!blender', '!pro']);
const KEYWORD_COMMANDS = new Set(['quit', 'exit', 'preferences', 'profiles', 'usage', 'saved']);

export interface SlashCommandContext {
  session: {
    toggleCodingMode: () => boolean;
    toggleShellMode: () => boolean;
    getUsage: () => { summary: () => string };
    getState: () => { codingMode: boolean; shellMode: boolean };
  };
  ui: UI;
}

/**
 * Handle slash commands. Returns true if the input was a slash command (consumed).
 */
export function handleSlashCommand(input: string, ctx: SlashCommandContext): boolean {
  const trimmed = input.trim();

  if (trimmed === 'quit' || trimmed === 'exit') {
    return true; // caller should handle exit
  }

  if (trimmed === '!code') {
    const on = ctx.session.toggleCodingMode();
    ctx.ui.displaySystem(on ? 'Coding mode ON 🔧' : 'Coding mode OFF');
    return true;
  }

  if (trimmed === '!shell' || trimmed === '!sh') {
    const on = ctx.session.toggleShellMode();
    ctx.ui.displaySystem(on ? 'Shell mode ON 🐚' : 'Shell mode OFF');
    return true;
  }

  if (trimmed === 'preferences') {
    const editor = process.env['EDITOR'] || 'nano';
    ctx.ui.displaySystem(`Opening preferences in ${editor}...`);
    return true;
  }

  if (trimmed === 'profiles') {
    ctx.ui.displaySystem('Listing profiles...');
    return true;
  }

  if (trimmed === 'usage') {
    const summary = ctx.session.getUsage().summary();
    ctx.ui.displaySystem(summary);
    return true;
  }

  if (trimmed === 'saved') {
    ctx.ui.displaySystem('Listing saved places...');
    return true;
  }

  // Generic shell escape: !COMMAND
  if (trimmed.startsWith('!') && !KNOWN_BANG_COMMANDS.has(trimmed.split(/\s/)[0])) {
    const cmd = trimmed.slice(1);
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
      ctx.ui.displaySystem(output);
    } catch (err) {
      ctx.ui.displayError(`Shell command failed: ${(err as Error).message}`);
    }
    return true;
  }

  return false;
}

function makeStreamCallbacks(ui: UI): StreamCallbacks {
  return {
    onDelta: (text: string) => ui.streamDelta(text),
    onToolCallStart: (names: string[]) => ui.displayToolCall(names),
    onComplete: (_msg: Message) => ui.endStream(),
    onError: (err: Error) => ui.displayError(err.message),
  };
}

function showSplash(): void {
  const splashPath = join(import.meta.dirname ?? '.', '..', 'assets', 'splash.txt');
  try {
    if (existsSync(splashPath)) {
      const splash = readFileSync(splashPath, 'utf-8');
      process.stdout.write(splash + '\n');
    }
  } catch {
    // Splash is optional
  }
}

export async function main(): Promise<void> {
  const args = parseCliArgs();

  // --- Non-interactive mode ---
  if (args.nonInteractive) {
    let prompt = args.prompt;
    if (!prompt) {
      if (process.stdin.isTTY) {
        process.stderr.write('Error: --non-interactive requires --prompt or piped stdin\n');
        process.exit(1);
      }
      prompt = readFileSync(0, 'utf-8').trim();
      if (!prompt) {
        process.stderr.write('Error: empty input on stdin\n');
        process.exit(1);
      }
    }

    // In a real implementation, we'd create a SessionManager here.
    // For now, this shows the structure.
    process.stderr.write('Error: session bootstrap not yet implemented\n');
    process.exit(1);
    return;
  }

  // --- Interactive mode ---
  showSplash();

  // Signal handling
  const cleanup = () => {
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

