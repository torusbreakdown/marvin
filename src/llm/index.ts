import type { Logger } from "pino";
import type { ChatMessage as CoreChatMessage } from "../core/types";
import { OpenAIProvider } from "./providers/openai";
import { OllamaProvider } from "./providers/ollama";
import { GeminiProvider } from "./providers/gemini";
import { AnthropicProvider } from "./providers/anthropic";

export type ChatMessage = CoreChatMessage;

export type CompletionRequest = {
  messages: ChatMessage[];
  model: string;
};

export interface LlmProvider {
  stream(req: CompletionRequest): AsyncIterable<string>;
}

export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

export function getProvider(name: string, log: Logger): LlmProvider {
  switch ((name || "").toLowerCase()) {
    case "openai":
      return new OpenAIProvider(log);
    case "anthropic":
      return new AnthropicProvider(log);
    case "gemini":
      return new GeminiProvider(log);
    case "ollama":
      return new OllamaProvider(log);
    case "copilot":
    default:
      // Spec default is copilot; this clean-room TS version falls back to OpenAI
      // if configured, otherwise Ollama.
      if (process.env.OPENAI_API_KEY) return new OpenAIProvider(log);
      return new OllamaProvider(log);
  }
}
