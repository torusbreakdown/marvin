import path from 'node:path';
import type { MarvinArgs, ProviderName } from './types';

export type RuntimeConfig = {
  provider: ProviderName;
  model: string;
  workingDir: string;
  readonly: boolean;
  maxToolRounds: number;
};

export function resolveWorkingDir(cliWorkingDir?: string): string {
  return path.resolve(cliWorkingDir || process.cwd());
}

export function resolveProvider(cliProvider?: ProviderName): ProviderName {
  const p = (cliProvider || (process.env.LLM_PROVIDER as ProviderName) || 'copilot') as ProviderName;
  return p;
}

export function resolveModel(provider: ProviderName, cliModel?: string): string {
  if (cliModel) return cliModel;
  if (process.env.MARVIN_MODEL) return process.env.MARVIN_MODEL;

  switch (provider) {
    case 'gemini':
      return process.env.GEMINI_MODEL || 'gemini-3-pro-preview';
    case 'ollama':
      return process.env.OLLAMA_MODEL || 'llama4:maverick';
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-4.1';
    default:
      return process.env.OPENAI_MODEL || 'gpt-4.1';
  }
}

export function resolveConfig(args: MarvinArgs): RuntimeConfig {
  const provider = resolveProvider(args.provider);
  const model = resolveModel(provider, args.model);
  const workingDir = resolveWorkingDir(args.workingDir);
  const readonly = process.env.MARVIN_READONLY === '1';
  const maxToolRounds = Number(process.env.MARVIN_TOOL_ROUNDS || 50);
  return { provider, model, workingDir, readonly, maxToolRounds };
}
