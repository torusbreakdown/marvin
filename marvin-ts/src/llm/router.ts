import type { Message, ChatResult, Provider, ChatOptions, OpenAIFunctionDef } from '../types.js';
import { estimateTokens } from '../context.js';

type ToolFunc = (args: Record<string, unknown>) => Promise<string>;

/**
 * Validate tool_call/result pairing: ensure every tool result references a
 * tool_call_id present in a preceding assistant message's tool_calls, and
 * every assistant tool_call has a matching tool result after it.
 * Removes orphaned messages to prevent API 400 errors.
 */
function repairToolPairs(messages: Message[]): Message[] {
  // Pass 1: collect all tool_call IDs from assistant messages
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callIds.add(tc.id);
      }
    }
  }

  // Pass 2: collect all tool_call_ids from tool result messages
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      resultIds.add(m.tool_call_id);
    }
  }

  // Pass 3: filter — drop orphaned tool results and strip dangling tool_calls
  const result: Message[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id && !callIds.has(m.tool_call_id)) {
      continue; // orphaned tool result
    }
    if (m.tool_calls?.length) {
      const validCalls = m.tool_calls.filter(tc => resultIds.has(tc.id));
      if (validCalls.length === 0) {
        // All tool_calls are dangling — emit as plain assistant message
        result.push({ ...m, tool_calls: undefined });
      } else if (validCalls.length < m.tool_calls.length) {
        result.push({ ...m, tool_calls: validCalls });
      } else {
        result.push(m);
      }
      continue;
    }
    result.push(m);
  }
  return result;
}

export interface RunToolLoopOptions {
  prompt: string;
  toolFuncs: Record<string, ToolFunc>;
  systemMessage: string;
  provider: Provider;
  history?: Message[];
  maxRounds?: number;
  tools?: OpenAIFunctionDef[];
  signal?: AbortSignal;
  onToolCall?: (toolNames: string[]) => void;
  onDelta?: (text: string) => void;
  /** Called when context is near full. Should compact messages in-place and return the new array. */
  onCompact?: (messages: Message[]) => Promise<Message[]>;
  /** Token threshold at which to trigger compaction (default: 100000) */
  compactThreshold?: number;
}

export async function runToolLoop(options: RunToolLoopOptions): Promise<ChatResult> {
  const {
    prompt,
    toolFuncs,
    systemMessage,
    provider,
    history = [],
    maxRounds = 10,
    signal,
    onToolCall,
    onDelta,
    onCompact,
    compactThreshold = 100_000,
  } = options;

  const tools = options.tools;

  // Build messages array: system + history + user prompt
  let messages: Message[] = [
    { role: 'system', content: systemMessage },
    ...history,
    { role: 'user', content: prompt },
  ];

  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;

  while (rounds < maxRounds) {
    signal?.throwIfAborted();
    rounds++;

    // Check if context needs compaction before sending to LLM
    if (onCompact && estimateTokens(messages) > compactThreshold) {
      messages = await onCompact(messages);
    }

    // Ensure no orphaned tool results (can happen after compaction)
    messages = repairToolPairs(messages);

    const chatOptions: ChatOptions = {
      tools,
      stream: false,
      signal,
    };

    const result = await provider.chat(messages, chatOptions);
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;

    const msg = result.message;

    // No tool calls → final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Emit content as delta for streaming UI
      if (msg.content && onDelta) {
        onDelta(msg.content);
      }
      return { message: msg, usage: totalUsage };
    }

    // Execute tool calls in parallel
    const toolNames = msg.tool_calls.map(tc => tc.function.name);
    onToolCall?.(toolNames);

    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        const result = await executeToolCall(tc.function.name, tc.function.arguments, toolFuncs);
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        };
      }),
    );

    // Append assistant message (with tool_calls) + tool results
    messages.push(msg, ...toolResults);
  }

  // Max rounds reached — final call with no tools to get a text response
  const finalResult = await provider.chat(messages, { tools: undefined, stream: true, signal, onDelta });
  totalUsage.inputTokens += finalResult.usage.inputTokens;
  totalUsage.outputTokens += finalResult.usage.outputTokens;
  return { message: finalResult.message, usage: totalUsage };
}

/**
 * Execute a tool call with proper argument deserialization.
 * Handles SHARP_EDGES §1: string args, Codex patch format, parse errors.
 */
async function executeToolCall(
  toolName: string,
  rawArgs: string,
  toolFuncs: Record<string, ToolFunc>,
): Promise<string> {
  // Check for unknown tool
  if (!toolFuncs[toolName]) {
    return `Unknown tool: ${toolName}`;
  }

  // Deserialize arguments
  let args: Record<string, unknown>;
  try {
    args = deserializeArgs(toolName, rawArgs);
  } catch (err) {
    return `Error parsing arguments for ${toolName}: ${(err as Error).message}. Expected valid JSON object, e.g. {"param": "value"}`;
  }

  // Execute the tool
  try {
    return await toolFuncs[toolName](args);
  } catch (err) {
    return `Error executing ${toolName}: ${(err as Error).message}`;
  }
}

/**
 * Deserialize tool call arguments per SHARP_EDGES §1.
 * - If string, try JSON.parse
 * - If result is string again (double-stringified), try JSON.parse again
 * - Detect Codex "*** Begin Patch" format → wrap as { patch: content }
 */
function deserializeArgs(toolName: string, raw: string): Record<string, unknown> {
  // Detect Codex patch format
  if (raw.trimStart().startsWith('*** Begin Patch') || raw.trimStart().startsWith('*** Update File')) {
    return { patch: raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON: ${raw.slice(0, 200)}`);
  }

  // Handle double-stringified case
  if (typeof parsed === 'string') {
    try {
      const inner = JSON.parse(parsed);
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
    } catch {
      // Not a double-stringified JSON — fall through
    }
    throw new Error(`Expected JSON object, got string: ${(parsed as string).slice(0, 200)}`);
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error(`Expected JSON object, got ${typeof parsed}`);
}
