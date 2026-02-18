import type {
  SessionState,
  ProviderConfig,
  Provider,
  Message,
  StreamCallbacks,
  ChatResult,
  UserProfile,
  ToolContext,
} from './types.js';
import { ContextBudgetManager } from './context.js';
import { UsageTracker } from './usage.js';
import { ToolRegistry } from './tools/registry.js';
import { runToolLoop } from './llm/router.js';
import { buildSystemMessage } from './system-prompt.js';
import { appendChatLog } from './history.js';

export interface SessionManagerConfig {
  provider: Provider;
  providerConfig: ProviderConfig;
  profile: UserProfile;
  registry: ToolRegistry;
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

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.state = {
      busy: false,
      messages: [],
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

  getContextBudget(): ContextBudgetManager {
    return this.contextBudget;
  }

  async submit(prompt: string, callbacks?: StreamCallbacks): Promise<ChatResult> {
    if (this.state.busy) {
      throw new Error('Session is busy. Wait for the current request to complete.');
    }

    this.state.busy = true;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
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

      // Get OpenAI function definitions
      const tools = this.registry.getOpenAISchemas(
        this.state.codingMode ? undefined : 'always',
      );

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

  toggleShellMode(): boolean {
    this.state.shellMode = !this.state.shellMode;
    return this.state.shellMode;
  }

  abort(): void {
    this.state.abortController?.abort();
  }

  async destroy(): Promise<void> {
    this.abort();
    this.usage.save();
    this.provider.destroy();
  }
}
