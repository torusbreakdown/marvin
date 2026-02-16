import type { Logger } from "pino";
import OpenAI from "openai";
import type { CompletionRequest, LlmProvider } from "../index";

export class OpenAIProvider implements LlmProvider {
  private readonly client?: OpenAI;

  constructor(private readonly log: Logger) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    if (!this.client) throw new Error("OPENAI_API_KEY is not set");

    const stream = await this.client.chat.completions.create({
      model: req.model || process.env.OPENAI_MODEL || "gpt-4.1",
      stream: true,
      messages: req.messages as any,
    });

    for await (const evt of stream as any) {
      const delta = evt?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) yield delta;
    }
  }
}
