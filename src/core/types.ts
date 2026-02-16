export type Role = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: string;
};

export type ProviderName = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'copilot' | 'groq' | 'kimi' | 'openai_compat';

export type MarvinArgs = {
  nonInteractive: boolean;
  prompt?: string;
  workingDir?: string;
  designFirst: boolean;
  ntfy?: string;
  plain: boolean;
  curses: boolean;
  provider?: ProviderName;
  /** Override model for non-interactive mode (maps to MARVIN_MODEL). */
  model?: string;
  /** Additional model tier overrides (e.g. high=..., low=...) */
  modelArgs: string[];
  positionalPrompt?: string;
};
