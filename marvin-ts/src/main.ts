import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { CliArgs, StreamCallbacks, Message, ProviderConfig } from './types.js';
import type { UI } from './ui/shared.js';
import { PlainUI } from './ui/plain.js';
import { runNonInteractive } from './non-interactive.js';
import { SessionManager } from './session.js';
import { ToolRegistry } from './tools/registry.js';
import { registerAllTools } from './tools/register-all.js';
import { ProfileManager } from './profiles/manager.js';
import { OpenAICompatProvider } from './llm/openai.js';
import { OllamaProvider } from './llm/ollama.js';
import { CopilotProvider } from './llm/copilot.js';

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

function resolveProviderConfig(args: CliArgs): ProviderConfig {
  const providerName = args.provider ?? process.env['MARVIN_PROVIDER'] ?? 'ollama';
  const defaults: Record<string, { model: string; baseUrl?: string }> = {
    ollama:        { model: 'qwen3-coder:30b', baseUrl: 'http://localhost:11434' },
    copilot:       { model: 'claude-haiku-4.5' },
    openai:        { model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1' },
    groq:          { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
    gemini:        { model: 'gemini-3-pro-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    'openai-compat': { model: 'default' },
  };
  const d = defaults[providerName] ?? defaults['ollama'];
  return {
    provider: providerName as ProviderConfig['provider'],
    model: process.env['MARVIN_MODEL'] ?? d.model,
    apiKey: process.env['MARVIN_API_KEY'] ?? process.env['OPENAI_API_KEY'],
    baseUrl: process.env['MARVIN_BASE_URL'] ?? d.baseUrl,
    timeoutMs: 300_000,
    maxToolRounds: 15,
  };
}

function createProvider(config: ProviderConfig) {
  if (config.provider === 'ollama') return new OllamaProvider(config);
  if (config.provider === 'copilot') return new CopilotProvider(config);
  return new OpenAICompatProvider(config);
}

function createSession(args: CliArgs) {
  const providerConfig = resolveProviderConfig(args);
  const provider = createProvider(providerConfig);

  const profileManager = new ProfileManager();
  const profile = profileManager.load('default');

  const registry = new ToolRegistry();
  const usage = { getSessionUsage: () => ({ totalCostUsd: 0, llmTurns: 0, modelTurns: {}, modelCost: {}, toolCallCounts: {} }) };

  const session = new SessionManager({
    provider,
    providerConfig,
    profile,
    registry,
    codingMode: false,
    workingDir: args.workingDir ?? process.cwd(),
    nonInteractive: args.nonInteractive,
    persistDir: profile.profileDir,
  });

  registerAllTools(registry, {
    getUsage: () => session.getUsage().getSessionUsage(),
  });

  return { session, profile, providerConfig };
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
    let prompt = args.prompt ?? args.inlinePrompt;
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

    const { session } = createSession(args);
    const exitCode = await runNonInteractive({
      prompt,
      session,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exit(exitCode);
    return;
  }

  // --- Interactive mode ---
  showSplash();

  const { session, profile, providerConfig } = createSession(args);
  const ui: UI = new PlainUI({
    provider: providerConfig.provider,
    model: providerConfig.model,
    profile: profile.name,
  });
  await ui.start();

  const slashCtx: SlashCommandContext = {
    session,
    ui,
  };

  // Handle inline prompt (positional argument)
  if (args.inlinePrompt) {
    const callbacks = makeStreamCallbacks(ui);
    ui.beginStream();
    try {
      await session.submit(args.inlinePrompt, callbacks);
    } catch {
      // error already reported via callbacks.onError
    }
  }

  // Signal handling — register BEFORE the REPL so Ctrl+C works during conversation
  const cleanup = () => {
    session.destroy().catch(() => {});
    ui.destroy();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // REPL loop
  while (true) {
    const input = await ui.promptInput();
    if (input === 'quit') break;
    if (!input) continue;

    if (handleSlashCommand(input, slashCtx)) {
      if (input.trim() === 'quit' || input.trim() === 'exit') break;
      continue;
    }

    const callbacks = makeStreamCallbacks(ui);
    ui.beginStream();
    try {
      await session.submit(input, callbacks);
    } catch {
      // error already reported via callbacks.onError
    }
  }

  await session.destroy();
  ui.destroy();
}