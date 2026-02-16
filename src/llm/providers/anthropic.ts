import type { Logger } from "pino";
import Anthropic from "@anthropic-ai/sdk";
import type { CompletionRequest, LlmProvider } from "../index";

export class AnthropicProvider implements LlmProvider {
  private readonly client?: Anthropic;

  constructor(private readonly log: Logger) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) this.client = new Anthropic({ apiKey });
  }

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const messages = req.messages;
    const model = req.model;
    if (!this.client) throw new Error("ANTHROPIC_API_KEY is not set");

    // Streaming API shapes vary across SDK versions; for now, do a non-streaming
    // call and yield it in chunks to preserve stdout streaming contract.
    const system = messages.find((m) => m.role === "system")?.content || "";
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");

    const resp: any = await this.client.messages.create({
      model: model || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = String(resp?.content?.[0]?.text ?? "");
    for (let i = 0; i < text.length; i += 32) {
      yield text.slice(i, i + 32);
    }
  }
}
