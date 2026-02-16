import type { Logger } from "pino";
import type { LlmProvider, CompletionRequest } from "../index";

export class OllamaProvider implements LlmProvider {
  constructor(private readonly log: Logger) {}

  async *stream(req: CompletionRequest): AsyncIterable<string> {
    const messages = req.messages;
    const model = req.model;
    const baseUrl = process.env.OLLAMA_URL || "http://localhost:11434";
    const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;

    const body = {
      model: model || process.env.OLLAMA_MODEL || "llama4:maverick",
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      this.log.error({ status: resp.status, text }, "ollama request failed");
      throw new Error(`Ollama request failed (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const json = JSON.parse(line);
        const content = json?.message?.content;
        if (typeof content === "string" && content.length) yield content;
        if (json?.done) return;
      }
    }
  }
}
