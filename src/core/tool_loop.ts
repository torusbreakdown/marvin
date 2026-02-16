import type { LlmProvider } from "../llm";
import type { ChatMessage } from "./types";
import type { ToolRunner, ToolCall } from "../tools/registry";
import { tryParseToolCalls } from "../tools/registry";

export type ToolLoopCallbacks = {
  onLlmTurn?: () => void;
  onToolRound?: (toolNames: string[]) => void;
  onTextChunk?: (chunk: string) => void;
};

export async function runToolLoop(params: {
  provider: LlmProvider;
  model: string;
  maxRounds: number;
  messages: ChatMessage[];
  tools: ToolRunner;
  callbacks?: ToolLoopCallbacks;
}): Promise<{ text: string; rounds: number }> {
  const { provider, model, maxRounds, tools } = params;
  const callbacks = params.callbacks ?? {};

  const messages: ChatMessage[] = [...params.messages];

  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    callbacks.onLlmTurn?.();

    // Stream, but buffer if the first non-whitespace char suggests a JSON tool call.
    let buf = "";
    let streamingToStdout = false;
    let sawNonWs = false;

    for await (const chunk of provider.stream({ messages, model })) {
      if (streamingToStdout) {
        finalText += chunk;
        callbacks.onTextChunk?.(chunk);
        continue;
      }

      buf += chunk;

      if (!sawNonWs) {
        const m = buf.match(/\S/);
        if (m) {
          sawNonWs = true;
          const first = buf.slice(m.index ?? 0).trimStart()[0] ?? "";
          if (first !== "{" && first !== "[") {
            streamingToStdout = true;
            finalText += buf;
            callbacks.onTextChunk?.(buf);
            buf = "";
          }
        }
      }
    }

    if (streamingToStdout) {
      return { text: finalText, rounds: round + 1 };
    }

    // Tool-call path: we buffered the entire response.
    const calls = parseToolCallsLenient(buf);
    if (calls.length === 0) {
      // Not actually tool JSON; treat as final text.
      finalText += buf;
      callbacks.onTextChunk?.(buf);
      return { text: finalText, rounds: round + 1 };
    }

    callbacks.onToolRound?.(calls.map((c) => c.name));

    const results: { name: string; result: unknown }[] = [];
    for (const call of calls) {
      const res = await tools.execute(call.name, call.arguments);
      results.push({ name: call.name, result: res });
    }

    messages.push({ role: "assistant", content: buf });
    messages.push({ role: "user", content: formatToolResults(results) });
  }

  return { text: finalText, rounds: maxRounds };
}

function parseToolCallsLenient(text: string): ToolCall[] {
  const trimmed = stripCodeFences(text).trim();
  return tryParseToolCalls(trimmed);
}

function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return (m[1] ?? "").trim();
  return t;
}

function formatToolResults(results: { name: string; result: unknown }[]): string {
  const lines: string[] = [];
  lines.push("TOOL_RESULTS:");
  for (const r of results) {
    lines.push(`- ${r.name}:`);
    if (typeof r.result === "string") {
      lines.push(r.result);
    } else {
      try {
        lines.push(JSON.stringify(r.result, null, 2));
      } catch {
        lines.push(String(r.result));
      }
    }
    lines.push("---");
  }

  lines.push(
    "Now continue. If you need more tools, respond with ONLY JSON tool calls; otherwise respond with the final answer.",
  );

  return lines.join("\n");
}
