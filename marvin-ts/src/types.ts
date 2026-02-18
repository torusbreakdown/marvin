import { z, ZodObject, ZodRawShape } from 'zod';

// === Tool System ===

export type ToolCategory = 'coding' | 'readonly' | 'always';
export type AppMode = 'surf' | 'coding' | 'lockin';

export interface ToolDef {
  name: string;
  description: string;
  schema: ZodObject<any>;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
  category: ToolCategory;
  requiresConfirmation?: boolean;
}

export interface ToolContext {
  workingDir: string | null;
  codingMode: boolean;
  nonInteractive: boolean;
  profileDir: string;
  confirmCommand?: (command: string) => Promise<boolean>;
  profile: UserProfile;
}

export interface OpenAIFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

// === Messages ===

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// === Provider ===

export interface ProviderConfig {
  provider: 'copilot' | 'gemini' | 'groq' | 'openai' | 'ollama' | 'openai-compat' | 'llama-server';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  maxToolRounds: number;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallStart: (toolNames: string[]) => void;
  onComplete: (message: Message) => void;
  onError: (error: Error) => void;
}

export interface ChatResult {
  message: Message;
  usage: { inputTokens: number; outputTokens: number };
}

// === Provider Interface ===

export interface ChatOptions {
  tools?: OpenAIFunctionDef[];
  stream?: boolean;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  destroy(): void;
}

// === Session ===

export interface SessionState {
  busy: boolean;
  messages: Message[];
  mode: AppMode;
  codingMode: boolean;
  shellMode: boolean;
  workingDir: string | null;
  provider: ProviderConfig;
  nonInteractive: boolean;
  ntfyTopic: string | null;
  abortController: AbortController | null;
  done: PromiseWithResolvers<void>;
}

// === User Profile ===

export interface UserProfile {
  name: string;
  profileDir: string;
  preferences: {
    dietary?: string[];
    budget?: string;
    distance_unit?: 'miles' | 'kilometers';
    cuisines?: string[];
    [key: string]: unknown;
  };
  savedPlaces: SavedPlace[];
  chatLog: ChatLogEntry[];
  ntfySubscriptions: NtfySubscription[];
  oauthTokens: Record<string, unknown>;
  inputHistory: string[];
}

export interface SavedPlace {
  label: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  notes?: string;
}

export interface ChatLogEntry {
  role: 'you' | 'assistant' | 'system';
  text: string;
  time: string;
}

export interface NtfySubscription {
  topic: string;
  lastMessageId?: string;
}

// === Context Budget ===

export interface ContextBudget {
  warnThreshold: number;
  compactThreshold: number;
  hardLimit: number;
  currentTokens: number;
}

// === Usage / Cost ===

export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface SessionUsage {
  totalCostUsd: number;
  llmTurns: number;
  modelTurns: Record<string, number>;
  modelCost: Record<string, number>;
  toolCallCounts: Record<string, number>;
}

// === UI ===

export interface StatusBarData {
  providerEmoji: string;
  model: string;
  profileName: string;
  messageCount: number;
  costUsd: number;
  totalTokens: number;
  codingMode: boolean;
  shellMode: boolean;
  mode: AppMode;
}

export interface CliArgs {
  provider?: string;
  plain: boolean;
  nonInteractive: boolean;
  mode?: AppMode;
  codingMode?: boolean;
  prompt?: string;
  workingDir?: string;
  ntfy?: string;
  inlinePrompt?: string;
}
