import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { CliArgs, StreamCallbacks, Message, ProviderConfig, AppMode } from './types.js';
import type { UI } from './ui/shared.js';
import { PlainUI } from './ui/plain.js';
import { CursesUI } from './ui/curses.js';
import { runNonInteractive } from './non-interactive.js';
import { SessionManager } from './session.js';
import { ToolRegistry } from './tools/registry.js';
import { registerAllTools } from './tools/register-all.js';
import { ProfileManager } from './profiles/manager.js';
import { OpenAICompatProvider } from './llm/openai.js';
import { OllamaProvider } from './llm/ollama.js';
import { CopilotProvider } from './llm/copilot.js';
import { LlamaServerProvider } from './llm/llama-server.js';

export function parseCliArgs(argv?: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      provider:          { type: 'string' },
      plain:             { type: 'boolean', default: false },
      curses:            { type: 'boolean', default: false },
      'non-interactive': { type: 'boolean', default: false },
      'coding-mode':     { type: 'boolean', default: false },
      mode:              { type: 'string' },
      prompt:            { type: 'string' },
      'working-dir':     { type: 'string' },
      ntfy:              { type: 'string' },
      help:              { type: 'boolean', short: 'h', default: false },
      version:           { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    process.stdout.write(
      `Usage: marvin [options] [prompt]\n\n` +
      `Options:\n` +
      `  --provider <name>    LLM provider (ollama, copilot, openai, groq, gemini, openai-compat, llama-server)\n` +
      `  --mode <mode>        Tool mode: surf (default), coding, lockin\n` +
      `  --plain              Force plain readline UI\n` +
      `  --curses             Force curses TUI\n` +
      `  --non-interactive    Non-interactive mode (requires --prompt or piped stdin)\n` +
      `  --coding-mode        Enable coding tools (auto-enabled with --working-dir)\n` +
      `  --prompt <text>      Prompt text (non-interactive or single-shot)\n` +
      `  --working-dir <dir>  Set working directory (implies --coding-mode)\n` +
      `  --ntfy <topic>       Subscribe to ntfy topic\n` +
      `  -h, --help           Show this help\n` +
      `  -v, --version        Show version\n` +
      `\nSlash commands (interactive):\n` +
      `  !code         Toggle coding mode\n` +
      `  !mode         Show/switch mode (!mode surf|coding|lockin)\n` +
      `  !sh / !shell  Toggle shell mode (or !sh <cmd> to run a command)\n` +
      `  !model        Show current provider/model (!model <provider> [model] to switch)\n` +
      `  !<cmd>        Run shell command\n` +
      `  usage         Show session usage/cost\n` +
      `  quit / exit   Exit\n`,
    );
    process.exit(0);
  }

  if (values.version) {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname ?? '.', '..', 'package.json'), 'utf-8'));
    process.stdout.write(`marvin ${pkg.version ?? '0.1.0'}\n`);
    process.exit(0);
  }

  const modeArg = values.mode as string | undefined;
  const validModes: AppMode[] = ['surf', 'coding', 'lockin'];
  const codingMode = (values['coding-mode'] ?? false) || !!values['working-dir'];
  let mode: AppMode = 'surf';
  if (modeArg) {
    if (!validModes.includes(modeArg as AppMode)) {
      process.stderr.write(`Error: invalid mode '${modeArg}'. Valid modes: ${validModes.join(', ')}\n`);
      process.exit(1);
    }
    mode = modeArg as AppMode;
  } else if (codingMode) {
    mode = 'coding';
  }

  return {
    provider: values.provider,
    plain: values.plain ?? false,
    curses: values.curses ?? false,
    nonInteractive: values['non-interactive'] ?? false,
    mode,
    codingMode: mode === 'coding' || mode === 'lockin',
    prompt: values.prompt,
    workingDir: values['working-dir'],
    ntfy: values.ntfy,
    inlinePrompt: positionals[0],
  };
}

// Known slash commands
const KNOWN_BANG_COMMANDS = new Set(['!code', '!shell', '!sh', '!voice', '!v', '!blender', '!pro', '!model', '!mode']);
const KEYWORD_COMMANDS = new Set(['quit', 'exit', 'preferences', 'profiles', 'usage', 'saved']);

export interface SlashCommandContext {
  session: {
    toggleCodingMode: () => boolean;
    toggleShellMode: () => boolean;
    setMode: (mode: AppMode) => void;
    getMode: () => AppMode;
    getUsage: () => { summary: () => string };
    getState: () => { codingMode: boolean; shellMode: boolean; provider: ProviderConfig; mode: AppMode };
    switchProvider: (provider: ReturnType<typeof createProvider>, config: ProviderConfig) => void;
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

  // !mode — show or switch mode
  if (trimmed === '!mode' || trimmed.startsWith('!mode ')) {
    const arg = trimmed.slice(5).trim();
    if (!arg) {
      ctx.ui.displaySystem(`Mode: ${ctx.session.getMode()}`);
      return true;
    }
    const valid: AppMode[] = ['surf', 'coding', 'lockin'];
    if (!valid.includes(arg as AppMode)) {
      ctx.ui.displaySystem(`Invalid mode '${arg}'. Valid: ${valid.join(', ')}`);
      return true;
    }
    ctx.session.setMode(arg as AppMode);
    const emoji = arg === 'surf' ? '🏄' : arg === 'coding' ? '🔧' : '🔒';
    ctx.ui.displaySystem(`${emoji} Mode: ${arg}`);
    return true;
  }

  if (trimmed === '!shell' || trimmed === '!sh') {
    const on = ctx.session.toggleShellMode();
    ctx.ui.displaySystem(on ? 'Shell mode ON 🐚' : 'Shell mode OFF');
    return true;
  }

  // !sh <command> and !shell <command> — run command directly
  if (trimmed.startsWith('!sh ') || trimmed.startsWith('!shell ')) {
    const cmd = trimmed.startsWith('!sh ') ? trimmed.slice(4) : trimmed.slice(7);
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
      if (output) ctx.ui.displaySystem(output);
    } catch (err) {
      ctx.ui.displayError(`Shell command failed: ${(err as Error).message}`);
    }
    return true;
  }

  // !model — show or switch provider/model
  if (trimmed === '!model' || trimmed.startsWith('!model ')) {
    const args = trimmed.slice(6).trim();
    if (!args) {
      const st = ctx.session.getState();
      ctx.ui.displaySystem(`Provider: ${st.provider.provider}  Model: ${st.provider.model}  Base URL: ${st.provider.baseUrl ?? 'default'}`);
      return true;
    }
    const parts = args.split(/\s+/);
    const providerName = parts[0];
    const modelOverride = parts[1];
    try {
      const config = resolveProviderConfig({ provider: providerName } as CliArgs);
      if (modelOverride) config.model = modelOverride;
      const provider = createProvider(config);
      ctx.session.switchProvider(provider, config);
      ctx.ui.displaySystem(`Switched to ${config.provider} / ${config.model}`);
    } catch (err) {
      ctx.ui.displayError((err as Error).message);
    }
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
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) {
      ctx.ui.displayError('No command specified. Usage: !<command>');
      return true;
    }
    if (KNOWN_BANG_COMMANDS.has('!' + cmd.split(/\s/)[0])) {
      // Already handled above (e.g. !code, !voice) — if we get here it means
      // the command had args but the handler above only matched exact. Let the
      // LLM handle it as a regular message.
      return false;
    }
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
      if (output) ctx.ui.displaySystem(output);
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

function refreshStatus(ui: UI, session: SessionManager, providerConfig: ProviderConfig): void {
  const state = session.getState();
  const usage = session.getUsage().getSessionUsage();
  const profile = session.getProfile();
  ui.showStatus({
    providerEmoji: '🤖',
    model: providerConfig.model,
    profileName: profile.name,
    messageCount: state.messages.length,
    costUsd: usage.totalCostUsd,
    totalTokens: 0,
    codingMode: state.codingMode,
    shellMode: state.shellMode,
    mode: state.mode,
  });
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
    moonshot:       { model: 'kimi-k2.5', baseUrl: 'https://api.moonshot.ai/v1' },
    'llama-server':  { model: 'default', baseUrl: 'http://localhost:8080/v1' },
  };
  if (!(providerName in defaults)) {
    const valid = Object.keys(defaults).join(', ');
    throw new Error(`Unknown provider '${providerName}'. Valid providers: ${valid}`);
  }
  const d = defaults[providerName];
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
  if (config.provider === 'llama-server') return new LlamaServerProvider(config);
  return new OpenAICompatProvider(config);
}

function createSession(args: CliArgs, hooks?: { onProfileSwitch?: (name: string) => void }) {
  const providerConfig = resolveProviderConfig(args);
  const provider = createProvider(providerConfig);

  const profileManager = new ProfileManager();
  // Restore last active profile, fall back to 'default'
  const lastProfilePath = join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.config', 'local-finder', 'profiles', 'last_profile',
  );
  let profileName = 'default';
  try {
    if (existsSync(lastProfilePath)) {
      const saved = readFileSync(lastProfilePath, 'utf-8').trim();
      if (saved) profileName = saved;
    }
  } catch { /* ignore */ }
  const profile = profileManager.load(profileName);

  const registry = new ToolRegistry();

  const session = new SessionManager({
    provider,
    providerConfig,
    profile,
    registry,
    mode: args.mode ?? 'surf',
    codingMode: args.codingMode ?? false,
    workingDir: args.workingDir ?? process.cwd(),
    nonInteractive: args.nonInteractive,
    persistDir: profile.profileDir,
  });

  registerAllTools(registry, {
    getUsage: () => session.getUsage().getSessionUsage(),
    onProfileSwitch: hooks?.onProfileSwitch,
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

  // Validate --working-dir early
  if (args.workingDir && !existsSync(args.workingDir)) {
    process.stderr.write(`Error: working directory does not exist: ${args.workingDir}\n`);
    process.exit(1);
  }

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
  // Use a mutable ref so the profile-switch callback can reach the UI
  let uiRef: UI | null = null;
  const { session, profile, providerConfig } = createSession(args, {
    onProfileSwitch: (name) => uiRef?.showStatus({ profileName: name }),
  });
  const useCurses = args.curses || (!args.plain && process.stdin.isTTY && process.stdout.isTTY);
  const uiOpts = {
    provider: providerConfig.provider,
    model: providerConfig.model,
    profile: profile.name,
  };
  const ui: UI = useCurses ? new CursesUI(uiOpts) : new PlainUI(uiOpts);
  uiRef = ui;

  if (!useCurses) showSplash();
  await ui.start();
  refreshStatus(ui, session, providerConfig);

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
    refreshStatus(ui, session, providerConfig);
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
    let input: string;
    try {
      input = await ui.promptInput();
    } catch {
      // readline closed (e.g., piped stdin exhausted) — exit gracefully
      break;
    }
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
    refreshStatus(ui, session, providerConfig);
  }

  await session.destroy();
  ui.destroy();
}

// Bootstrap: call main() when this file is run directly
main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});