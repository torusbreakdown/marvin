import type { Logger } from "pino";
import type { ChatMessage } from "./types";
import type { LlmProvider } from "../llm";
import type { ToolRunner, ToolCall } from "../tools/registry";
import { tryParseToolCalls } from "../tools/registry";

export type AgentRunParams = {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  tools: ToolRunner;
  maxRounds?: number;
  log: Logger;
  /** Called for user-visible streaming tokens (final answer only). */
  onToken?: (chunk: string) => void;
  /** Called for user-visible markers like "  🔧 tool1, tool2" */
  onMarker?: (line: string) => void;
};

export type AgentRunResult = {
  text: string;
  llmTurns: number;
};

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const maxRounds = params.maxRounds ?? 50;

  let llmTurns = 0;
  for (let round = 0; round < maxRounds; round++) {
    llmTurns += 1;

    const resp = await streamAndClassify({
      provider: params.provider,
      model: params.model,
      messages: params.messages,
      onToken: params.onToken,
    });

    if (resp.kind === "final") {
      return { text: resp.text, llmTurns };
    }

    const toolNames = resp.calls.map((c) => c.name).join(", ");
    params.onMarker?.(`  🔧 ${toolNames}`);

    const results: Array<{ name: string; result: unknown }> = [];
    for (const call of resp.calls) {
      const result = await params.tools.execute(call.name, call.arguments);
      results.push({ name: call.name, result });
    }

    // Record what the model asked for, then provide results as the next user message.
    params.messages.push({ role: "assistant", content: resp.rawText });
    params.messages.push({ role: "user", content: formatToolResults(results) });
  }

  throw new Error(`Tool loop exceeded max rounds (${maxRounds})`);
}

async function streamAndClassify(params: {
  provider: LlmProvider;
  model: string;
  messages: ChatMessage[];
  onToken?: (chunk: string) => void;
}): Promise<
  | { kind: "final"; text: string }
  | { kind: "tool_calls"; calls: ToolCall[]; rawText: string }
> {
  let buf = "";
  let decided: "tool_calls" | "final" | null = null;
  let finalText = "";

  for await (const chunk of params.provider.stream({ messages: params.messages, model: params.model })) {
    buf += chunk;

    if (decided === "final") {
      finalText += chunk;
      params.onToken?.(chunk);
      continue;
    }

    const trimmedLeft = buf.trimStart();
    if (!trimmedLeft.length) continue;

    if (trimmedLeft.startsWith("```")) {
      const inner = stripCodeFencesIfComplete(trimmedLeft);
      if (!inner) continue;

      const calls = tryParseToolCalls(inner);
      if (calls.length) {
        decided = "tool_calls";
        return { kind: "tool_calls", calls, rawText: inner };
      }

      // Closed fence but not tool JSON => treat as final answer.
      decided = "final";
      finalText += buf;
      params.onToken?.(buf);
      buf = "";
      continue;
    }

    if (trimmedLeft.startsWith("{") || trimmedLeft.startsWith("[")) {
      const calls = tryParseToolCalls(trimmedLeft);
      if (calls.length) {
        decided = "tool_calls";
        return { kind: "tool_calls", calls, rawText: trimmedLeft };
      }
      continue;
    }

    // Not JSON-looking => treat as final answer.
    decided = "final";
    finalText += buf;
    params.onToken?.(buf);
    buf = "";
  }

  // Ended without making a determination; try a final parse if the output looks like a tool call.
  const tail = buf.trim();
  if (tail.startsWith("```")) {
    const inner = stripCodeFencesIfComplete(tail);
    if (inner) {
      const calls = tryParseToolCalls(inner);
      if (calls.length) return { kind: "tool_calls", calls, rawText: inner };
    }
  }

  if (tail.startsWith("{") || tail.startsWith("[")) {
    const calls = tryParseToolCalls(tail);
    if (calls.length) return { kind: "tool_calls", calls, rawText: tail };
  }

  if (buf.length) {
    finalText += buf;
    params.onToken?.(buf);
  }

  return { kind: "final", text: finalText };
}

function stripCodeFencesIfComplete(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("```")) return null;
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function formatToolResults(results: Array<{ name: string; result: unknown }>): string {
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
