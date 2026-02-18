import type {
  SessionState,
  ProviderConfig,
  Provider,
  Message,
  StreamCallbacks,
  ChatResult,
  UserProfile,
  ToolContext,
  AppMode,
  OpenAIFunctionDef,
} from './types.js';
import { ContextBudgetManager } from './context.js';
import { UsageTracker } from './usage.js';
import { ToolRegistry } from './tools/registry.js';
import { runToolLoop } from './llm/router.js';
import { buildSystemMessage } from './system-prompt.js';
import { appendChatLog } from './history.js';

// 'always'-category tools that are useful in coding mode as reference/research aids.
const CODING_REFERENCE_TOOLS = new Set([
  'web_search', 'search_news', 'browse_web', 'scrape_page',
  'stack_search', 'stack_answers',
  'wiki_search', 'wiki_summary', 'wiki_full', 'wiki_grep',
  'search_papers', 'search_arxiv',
  'github_clone', 'github_read_file', 'github_grep',
  'system_info', 'get_usage', 'exit_app',
]);

// Tools EXCLUDED from surf mode (no file I/O, no shell, no blender, no downloads).
const SURF_EXCLUDE = new Set([
  'blender_get_scene', 'blender_get_object', 'blender_create_object',
  'blender_modify_object', 'blender_delete_object', 'blender_set_material',
  'blender_execute_code', 'blender_screenshot',
  'download_file', 'yt_dlp_download',
  'github_clone', 'wiki_full', 'wiki_grep',
]);

// Tools included in lockin mode: coding + focus/productivity, no entertainment.
const LOCKIN_EXTRAS = new Set([
  'blender_get_scene', 'blender_get_object', 'blender_create_object',
  'blender_modify_object', 'blender_delete_object', 'blender_set_material',
  'blender_execute_code', 'blender_screenshot',
  'calendar_list_upcoming', 'calendar_add_event', 'calendar_delete_event',
  'set_alarm', 'list_alarms', 'cancel_alarm',
  'timer_start', 'timer_check', 'timer_stop',
  'write_note', 'read_note', 'notes_ls', 'notes_mkdir', 'search_notes',
  'web_search', 'browse_web', 'scrape_page',
  'stack_search', 'stack_answers',
  'wiki_search', 'wiki_summary', 'wiki_full', 'wiki_grep',
  'search_papers', 'search_arxiv',
  'github_clone', 'github_read_file', 'github_grep',
  'download_file', 'yt_dlp_download',
  'system_info', 'get_usage', 'exit_app',
  'generate_ntfy_topic', 'ntfy_subscribe', 'ntfy_unsubscribe', 'ntfy_publish', 'ntfy_list',
]);

export interface SessionManagerConfig {
  provider: Provider;
  providerConfig: ProviderConfig;
  profile: UserProfile;
  registry: ToolRegistry;
  mode: AppMode;
  codingMode: boolean;
  workingDir: string | null;
  nonInteractive: boolean;
  persistDir: string;
}

export class SessionManager {
  private state: SessionState;
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private profile: UserProfile;
  private registry: ToolRegistry;
  private contextBudget: ContextBudgetManager;
  private usage: UsageTracker;

  constructor(config: SessionManagerConfig) {
    this.provider = config.provider;
    this.providerConfig = config.providerConfig;
    this.profile = config.profile;
    this.registry = config.registry;
    this.contextBudget = new ContextBudgetManager();
    this.usage = new UsageTracker(config.persistDir);
    this.usage.load();

    let resolve!: () => void, reject!: (err: any) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.state = {
      busy: false,
      messages: [],
      mode: config.mode,
      codingMode: config.codingMode,
      shellMode: false,
      workingDir: config.workingDir,
      provider: config.providerConfig,
      nonInteractive: config.nonInteractive,
      ntfyTopic: null,
      abortController: null,
      done: { promise, resolve, reject },
    };
  }

  getState(): Readonly<SessionState> {
    return this.state;
  }

  getUsage(): UsageTracker {
    return this.usage;
  }

  getProfile(): UserProfile {
    return this.profile;
  }

  getContextBudget(): ContextBudgetManager {
    return this.contextBudget;
  }

  async submit(prompt: string, callbacks?: StreamCallbacks): Promise<ChatResult> {
    if (this.state.busy) {
      throw new Error('Session is busy. Wait for the current request to complete.');
    }

    this.state.busy = true;
    let resolve!: () => void, reject!: (err: any) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.state.done = { promise, resolve, reject };
    this.state.abortController = new AbortController();

    try {
      // Check context budget
      const budgetStatus = this.contextBudget.checkBudget(this.state.messages);
      if (budgetStatus === 'compact') {
        this.state.messages = await this.contextBudget.compact(this.state.messages);
      } else if (budgetStatus === 'reject') {
        throw new Error('Context budget exceeded. Use compact_history to free space or start a new session.');
      }

      // Build system message
      const systemMessage = buildSystemMessage(this.profile, {
        codingMode: this.state.codingMode,
        mode: this.state.mode,
      });

      // Build tool context
      const toolCtx: ToolContext = {
        workingDir: this.state.workingDir,
        codingMode: this.state.codingMode,
        nonInteractive: this.state.nonInteractive,
        profileDir: this.profile.profileDir,
        profile: this.profile,
      };

      // Build toolFuncs from registry
      const toolFuncs: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};
      for (const tool of this.registry.getAll()) {
        toolFuncs[tool.name] = async (args: Record<string, unknown>) => {
          this.usage.recordToolCall(tool.name);
          return this.registry.executeTool(tool.name, args, toolCtx);
        };
      }

      // Get tool definitions for current mode.
      const tools = this.getToolsForMode();

      // Run tool loop
      const result = await runToolLoop({
        prompt,
        toolFuncs,
        systemMessage,
        provider: this.provider,
        history: this.state.messages,
        maxRounds: this.providerConfig.maxToolRounds,
        tools: tools.length > 0 ? tools : undefined,
        signal: this.state.abortController.signal,
        onToolCall: callbacks?.onToolCallStart,
        onDelta: callbacks?.onDelta,
      });

      // Update usage tracking
      this.usage.recordTurn(
        this.providerConfig.provider,
        this.providerConfig.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
      );
      this.contextBudget.updateActual(result.usage);

      // Append to conversation history
      this.state.messages.push(
        { role: 'user', content: prompt },
        result.message,
      );

      // Persist to chat log
      const now = new Date().toISOString();
      appendChatLog(this.profile.profileDir, { role: 'you', text: prompt, time: now });
      if (result.message.content) {
        appendChatLog(this.profile.profileDir, { role: 'assistant', text: result.message.content, time: now });
      }

      callbacks?.onComplete?.(result.message);

      return result;
    } catch (err) {
      callbacks?.onError?.(err as Error);
      throw err;
    } finally {
      this.state.busy = false;
      this.state.abortController = null;
      this.state.done.resolve();
    }
  }

  toggleCodingMode(): boolean {
    this.state.codingMode = !this.state.codingMode;
    return this.state.codingMode;
  }

  setMode(mode: AppMode): void {
    this.state.mode = mode;
    this.state.codingMode = mode === 'coding' || mode === 'lockin';
  }

  getMode(): AppMode {
    return this.state.mode;
  }

  private getToolsForMode(): OpenAIFunctionDef[] {
    const mode = this.state.mode;
    if (mode === 'coding') {
      return this.registry.getOpenAISchemasMulti({
        categories: ['coding'],
        names: CODING_REFERENCE_TOOLS,
      });
    }
    if (mode === 'lockin') {
      return this.registry.getOpenAISchemasMulti({
        categories: ['coding'],
        names: LOCKIN_EXTRAS,
      });
    }
    // surf mode (default): all 'always' tools minus excluded ones
    return this.registry.getOpenAISchemasExclude(SURF_EXCLUDE);
  }

  toggleShellMode(): boolean {
    this.state.shellMode = !this.state.shellMode;
    return this.state.shellMode;
  }

  abort(): void {
    this.state.abortController?.abort();
  }

  switchProvider(provider: Provider, config: ProviderConfig): void {
    this.provider.destroy();
    this.provider = provider;
    this.providerConfig = config;
    this.state.provider = config;
  }

  async destroy(): Promise<void> {
    this.abort();
    this.usage.save();
    this.provider.destroy();
  }
}
