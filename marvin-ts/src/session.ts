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
import { ContextBudgetManager, compactContext } from './context.js';
import { UsageTracker } from './usage.js';
import { ToolRegistry } from './tools/registry.js';
import { runToolLoop } from './llm/router.js';
import { buildSystemMessage } from './system-prompt.js';
import { appendChatLog, popChatLogEntries, loadChatLog } from './history.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 'always'-category tools that are useful in coding mode as reference/research aids.
const CODING_REFERENCE_TOOLS = new Set([
  'web_search', 'search_news', 'browse_web', 'scrape_page',
  'stack_search', 'stack_answers',
  'wiki_search', 'wiki_summary', 'wiki_full', 'wiki_grep',
  'search_papers', 'search_arxiv',
  'github_clone', 'github_read_file', 'github_grep',
  'system_info', 'get_usage', 'exit_app',
]);

// Tools EXCLUDED from surf mode (no file I/O, no shell, no blender).
const SURF_EXCLUDE = new Set([
  'blender_get_scene', 'blender_get_object', 'blender_create_object',
  'blender_modify_object', 'blender_delete_object', 'blender_set_material',
  'blender_execute_code', 'blender_screenshot',
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
      // Check context budget before starting
      const budgetStatus = this.contextBudget.checkBudget(this.state.messages);
      if (budgetStatus === 'compact' || budgetStatus === 'reject') {
        // Pre-compact using naive method to make room for the tool loop's LLM compaction
        this.state.messages = compactContext(
          [{ role: 'system', content: '' }, ...this.state.messages],
          join(this.profile.profileDir, 'logs'),
        ).slice(1); // remove placeholder system msg
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
          const result = await this.registry.executeTool(tool.name, args, toolCtx);
          // Debug log tool calls and results
          try {
            const logDir = this.profile.profileDir;
            mkdirSync(logDir, { recursive: true });
            const entry = {
              ts: new Date().toISOString(),
              tool: tool.name,
              args,
              resultLength: result.length,
              resultPreview: result.slice(0, 500),
            };
            appendFileSync(join(logDir, 'tool-calls.jsonl'), JSON.stringify(entry) + '\n');
          } catch { /* ignore logging errors */ }
          return result;
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
        compactThreshold: 100_000,
        onCompact: async (messages) => this.compactMessages(messages),
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

  /**
   * Remove the last single message from LLM context and persistent chat log.
   * Returns the role of the removed message, or null if nothing to remove.
   */
  undoLast(): string | null {
    const msgs = this.state.messages;
    if (msgs.length > 0) {
      const last = msgs.pop()!;
      popChatLogEntries(this.profile.profileDir, 1);
      return last.role;
    }
    // No in-memory messages, but still try the persistent chat log
    const log = loadChatLog(this.profile.profileDir);
    if (log.length === 0) return null;
    const last = log[log.length - 1];
    popChatLogEntries(this.profile.profileDir, 1);
    return last.role === 'you' ? 'user' : last.role;
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

  /**
   * LLM-powered context compaction.
   * Keeps system message + recent messages, asks the LLM to summarize the rest.
   */
  private async compactMessages(messages: Message[]): Promise<Message[]> {
    const systemMsg = messages[0];

    // Determine how many recent messages to preserve (up to 10 or 32k tokens)
    let recentCount = 0;
    let recentTokens = 0;
    for (let i = messages.length - 1; i > 0; i--) {
      const msgTokens = Math.ceil(JSON.stringify(messages[i]).length / 4);
      if (recentCount >= 10 || recentTokens + msgTokens > 32_000) break;
      recentCount++;
      recentTokens += msgTokens;
    }
    if (recentCount === 0) recentCount = 1;

    // Expand the boundary so we don't split tool_call/tool_result pairs.
    // Walk backwards from the split point: if the first "older" message is a
    // tool result, include it (and its siblings) in "recent" until we reach
    // a non-tool message.
    let splitIdx = messages.length - recentCount;
    while (splitIdx > 1 && messages[splitIdx].role === 'tool') {
      splitIdx--;
    }
    // If we landed on an assistant with tool_calls, include it too
    if (splitIdx > 1 && messages[splitIdx].tool_calls?.length) {
      splitIdx--;
    }

    const recentMessages = messages.slice(splitIdx);
    const olderMessages = messages.slice(1, splitIdx);

    if (olderMessages.length === 0) return messages; // nothing to compact

    // Strip tool_calls and tool results from older messages for summarization
    const olderText = olderMessages
      .filter(m => m.content && m.role !== 'tool')
      .map(m => {
        const role = m.role;
        const content = m.content!.slice(0, 300);
        return `[${role}]: ${content}`;
      })
      .join('\n');

    // Ask LLM to summarize
    try {
      const compactResult = await this.provider.chat([
        { role: 'system', content: 'You are a context compactor. Summarize the following conversation history into a concise summary that preserves all important facts, decisions, tool results, and user preferences. Be thorough but brief. Output only the summary, no preamble.' },
        { role: 'user', content: `Summarize this conversation history (${olderMessages.length} messages):\n\n${olderText.slice(0, 50_000)}` },
      ], { stream: false });

      const summary = compactResult.message.content || '[Compaction failed — no summary generated]';

      const summaryMsg: Message = {
        role: 'system',
        content: `[Context compacted. ${olderMessages.length} older messages summarized below.]\n\n${summary}`,
      };

      // Also compact the in-memory session messages
      this.state.messages = [summaryMsg];

      return [systemMsg, summaryMsg, ...recentMessages];
    } catch {
      // If LLM compaction fails, fall back to naive compaction
      return compactContext(messages, join(this.profile.profileDir, 'logs'));
    }
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
