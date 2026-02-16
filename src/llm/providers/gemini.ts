import type { Logger } from "pino";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CompletionRequest, LlmProvider } from "../index";

export class GeminiProvider implements LlmProvider {
  private readonly client?: GoogleGenerativeAI;

  constructor(private readonly log: Logger) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) this.client = new GoogleGenerativeAI(apiKey);
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const messages = req.messages;
    const model = req.model;
    if (!this.client) throw new Error("GEMINI_API_KEY is not set");

    const m = this.client.getGenerativeModel({ model: model || process.env.GEMINI_MODEL || "gemini-3-pro-preview" });

    const prompt = messages.map((x) => `${x.role.toUpperCase()}: ${x.content}`).join("\n\n");
    const res = await m.generateContentStream(prompt as any);

    for await (const chunk of res.stream as any) {
      const text = chunk?.text?.();
      if (typeof text === "string" && text.length) yield text;
    }
  }
}
