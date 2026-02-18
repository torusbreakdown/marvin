# Marvin — Architecture & Design

> **Version**: 1.0 (TypeScript rewrite)
> **Scope**: Interactive assistant + non-interactive sub-agent mode.
> The `--design-first` TDD pipeline is **explicitly out of scope**.

---

## 1. System Architecture

### 1.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        main.ts                                  │
│                  (arg parsing, bootstrap)                        │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     session.ts                                   │
│          SessionManager — orchestrator                           │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐     │
│  │ profiles/ │  │ system-      │  │ history.ts             │     │
│  │ manager   │  │ prompt.ts    │  │ (load/save/compact)    │     │
│  └──────────┘  └──────────────┘  └────────────────────────┘     │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    llm/router.ts                                 │
│             runToolLoop — provider-agnostic                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ llm/copilot  │  │ llm/openai   │  │ llm/ollama       │       │
│  │ (SDK)        │  │ (compat)     │  │ (local)          │       │
│  └──────────────┘  └──────────────┘  └──────────────────┘       │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  tools/registry.ts                               │
│         Zod schemas → OpenAI function format                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐        │
│  │web.ts  │ │files.ts│ │git.ts  │ │shell.ts│ │ ...    │        │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘        │
└──────────┬──────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    context.ts                                    │
│         Token budget tracking & compaction                       │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      UI Layer                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ ui/curses.ts │  │ ui/plain.ts  │  │ stdout (non-int) │       │
│  │ (blessed)    │  │ (readline)   │  │ (raw tokens)     │       │
│  └──────────────┘  └──────────────┘  └──────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow

1. **User input** → UI layer captures text, passes to `SessionManager.submit()`
2. **SessionManager** → checks ntfy subscriptions, builds system prompt, dispatches to `llm/router.ts`
3. **Router** → selects provider, calls `chat()` with streaming, enters tool loop
4. **Tool loop** → LLM response contains `tool_calls` → `registry.execute()` runs them → results fed back → loop continues until LLM responds with text only (or max rounds reached)
5. **Streaming deltas** → piped through `onDelta` callback to UI layer for character-by-character display
6. **Completion** → final message appended to history, `busy = false`, `done` event set in `finally` block

### 1.3 Separation of Concerns

The architecture enforces strict boundaries between layers:

- **UI layer** (`ui/curses.ts`, `ui/plain.ts`) knows nothing about LLM providers,
  tool schemas, or session state. It implements the `UI` interface and receives
  data through callbacks. You can swap `blessed` for `ink` (or any other TUI
  library) by writing a new `UI` implementation — no other module changes.

- **SessionManager** is the orchestrator — it owns state transitions (`busy`/`done`)
  and coordinates between UI, router, profile, and context budget. It does NOT
  contain tool loop logic (that's in `router.ts`) or provider-specific code
  (that's in the provider classes).

- **Router** (`llm/router.ts`) owns the tool loop and provider dispatch. It is
  provider-agnostic — it receives a `Provider` interface and calls `.chat()`.
  The router does NOT know about profiles, UI, or session state.

- **Tool registry** is self-contained. Tools register themselves; the registry
  converts schemas and executes handlers. It does NOT import session, UI, or
  provider modules.

**Dependency rule**: `UI → SessionManager → Router → Provider` and
`UI → SessionManager → Registry`. No reverse dependencies. No circular imports.
The UI never calls the router directly; the router never touches the UI.

### 1.4 Process Model

Marvin runs as a **single Node.js process** with cooperative async (no threads).
All I/O — HTTP requests, file operations, subprocess execution — uses
`async/await` on Node's event loop. This means:

- Tool calls within a single LLM round execute in parallel via `Promise.all()`
- The UI remains responsive during tool execution (event loop not blocked)
- Long-running tools (shell commands) spawn child processes via `child_process.execFile` but the main loop `await`s them
- There is exactly one `SessionManager` instance per process

### 1.5 Concurrency Model

**User input during streaming**: The UI checks `state.busy` before dispatching
to `SessionManager.submit()`. If `busy === true`, keystrokes are buffered in
the input box but not submitted. When the current response completes
(`busy = false`), the user can press Enter to submit the buffered input.
There is no queue of pending submissions — at most one prompt is in flight.

**Parallel tool calls modifying the same file**: Tools within a single LLM
round run via `Promise.all()`. If the LLM requests two `apply_patch` calls on
the same file in one round, they race. This is an LLM error, not an
application error — the second patch may fail because `old_str` no longer
matches. The tool returns an actionable error and the LLM retries. No file
locking is used (per SHARP_EDGES.md §15).

**Notification polling**: `pollSubscriptions()` runs at the start of
`submit()`, before any LLM call. It is not concurrent with streaming. If
notifications arrive during a response, they are not polled until the next
`submit()` call — they do not interrupt streaming.

---

## 2. Key TypeScript Interfaces

These interfaces define the contracts between modules. All are exported from a single `src/types.ts` file — the authoritative source for cross-module types. No module defines its own cross-boundary types.

```typescript
// src/types.ts

import { z, ZodObject, ZodRawShape } from 'zod';

// === Tool System ===

/**
 * Non-generic base type used by the registry to store tools internally.
 * The generic in registerTool<T>() is for type-safe handler args at call sites
 * only — once registered, tools are stored as ToolDef (no generic param).
 */
interface ToolDef {
  name: string;
  description: string;
  schema: ZodObject<any>;
  handler: (args: any, ctx: ToolContext) => Promise<string>;
  category: 'coding' | 'readonly' | 'always';
  /** If true, handler calls ctx.confirmCommand() before executing (e.g., run_command). */
  requiresConfirmation?: boolean;
}

/**
 * Context injected into every tool handler at execution time by router.ts.
 * This breaks circular deps: tools NEVER import session.ts or ui/*.
 * SessionManager constructs this object and passes it through the router.
 */
interface ToolContext {
  workingDir: string | null;
  codingMode: boolean;
  nonInteractive: boolean;
  profileDir: string;
  /** Request user confirmation. Returns true=confirmed, false=declined.
   *  In non-interactive mode or when not provided, treated as always-confirmed.
   *  Wired by SessionManager to UI.promptConfirm(). */
  confirmCommand?: (command: string) => Promise<boolean>;
  /** The active user profile (for tools that read/write profile data). */
  profile: UserProfile;
}

/** OpenAI function-calling format, generated from Tool.schema by the registry. */
interface OpenAIFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

// === Messages ===

/**
 * Role values match OpenAI API format for wire compatibility.
 * IMPORTANT: These are NOT the same as ChatLogEntry roles ('you'/'assistant'/'system').
 * ChatLogEntry uses 'you' where Message uses 'user'. Conversion in system-prompt.ts.
 */
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A message in the LLM conversation array. Follows OpenAI chat completions wire format.
 *
 * Field usage by role:
 * - system:    content = system prompt string. No other fields.
 * - user:      content = user's text. No other fields.
 * - assistant: content = response text (null when tool_calls is present and no text accompanies it).
 *              tool_calls = array of tool calls the LLM wants to make.
 * - tool:      content = tool result string. tool_call_id REQUIRED (references ToolCall.id).
 *              name = the tool's name (required by some providers).
 */
interface Message {
  role: MessageRole;
  content: string | null;
  /** Only on 'assistant' messages when the LLM wants to call tools. */
  tool_calls?: ToolCall[];
  /** Only on 'tool' messages. Must match the ToolCall.id this result responds to. */
  tool_call_id?: string;
  /** Only on 'tool' messages. The tool's name. */
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded — always a string on the wire
  };
}

// === Provider ===

interface ProviderConfig {
  provider: 'copilot' | 'gemini' | 'groq' | 'openai' | 'ollama' | 'openai-compat';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Timeout in ms. 180_000 normal, 900_000 coding mode. */
  timeoutMs: number;
  /** Max tool loop rounds. 10 interactive, 50 non-interactive/coding. */
  maxToolRounds: number;
}

/** Callback interface for streaming responses. */
interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCallStart: (toolNames: string[]) => void;
  onComplete: (message: Message) => void;
  onError: (error: Error) => void;
}

/** Result from a single provider chat call. */
interface ChatResult {
  message: Message;
  usage: { inputTokens: number; outputTokens: number };
}

// === Session ===

interface SessionState {
  busy: boolean;
  messages: Message[];
  codingMode: boolean;
  shellMode: boolean;
  workingDir: string | null;
  provider: ProviderConfig;
  /** Whether running in non-interactive mode (--non-interactive). */
  nonInteractive: boolean;
  /** ntfy topic for completion notification (--ntfy flag). null if not set. */
  ntfyTopic: string | null;
  /** AbortController for the current provider request. Used by cancel(). null when idle. */
  abortController: AbortController | null;
  /** Set when done event should fire. Always cleared in finally. */
  done: PromiseWithResolvers<void>;
}

// === User Profile ===

interface UserProfile {
  name: string;
  /** Absolute path to profile dir: ~/.config/local-finder/profiles/{name}/ */
  profileDir: string;
  preferences: {
    dietary?: string[];
    budget?: string;
    distance_unit?: 'miles' | 'kilometers';
    cuisines?: string[];
    [key: string]: unknown;
  };
  savedPlaces: SavedPlace[];
  chatLog: ChatLogEntry[];
  ntfySubscriptions: NtfySubscription[];
  oauthTokens: Record<string, unknown>;
  /** Readline/input history lines, loaded from profiles/{name}/history file. */
  inputHistory: string[];
}

interface SavedPlace {
  label: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  notes?: string;
}

/**
 * On-disk chat log entry (chat_log.json). Role mapping to Message:
 *   'you' → 'user',  'assistant' → 'assistant',  'system' → 'system'
 */
interface ChatLogEntry {
  role: 'you' | 'assistant' | 'system';
  text: string;
  time: string; // ISO 8601
}

interface NtfySubscription {
  topic: string;
  lastMessageId?: string;
}

// === Context Budget ===

interface ContextBudget {
  warnThreshold: number;   // 180_000 tokens
  compactThreshold: number; // 200_000 tokens
  hardLimit: number;        // 226_000 tokens
  currentTokens: number;
}

// === Usage / Cost ===

interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
}

interface SessionUsage {
  totalCostUsd: number;
  llmTurns: number;
  modelTurns: Record<string, number>;
  modelCost: Record<string, number>;
  toolCallCounts: Record<string, number>;
}

// === UI ===

/** Data for the status bar. Passed to UI.showStatus(). */
interface StatusBarData {
  providerEmoji: string;  // '🤖' | '💎' | '⚡' | '🦙' | '🔮'
  model: string;
  profileName: string;
  messageCount: number;
  costUsd: number;
  totalTokens: number;
  codingMode: boolean;
  shellMode: boolean;
}

// === CLI ===

/** Parsed CLI arguments from main.ts (via node:util parseArgs). */
interface CliArgs {
  provider?: string;
  plain: boolean;
  nonInteractive: boolean;
  prompt?: string;
  workingDir?: string;
  ntfy?: string;
  /** Bare positional argument: marvin "question" */
  inlinePrompt?: string;
}
```

---

## 3. Module Responsibilities

### `src/main.ts`
**Exports**: `main()` (entry point)
**Depends on**: `session.ts`, `ui/curses.ts`, `ui/plain.ts`, `profiles/manager.ts`

Parses CLI arguments (`--provider`, `--plain`, `--curses`, `--non-interactive`, `--prompt`, `--working-dir`, `--ntfy`). Creates `SessionManager`, selects UI mode, and starts the event loop.

**Single-shot mode** (spec §2.2): When a bare positional argument is provided (e.g., `marvin "What's the weather?"`), `main.ts` treats it as an inline prompt: launches the interactive UI, submits the prompt immediately, then returns to the prompt loop. This is distinct from `--non-interactive --prompt`.

**Non-interactive mode**: Reads prompt from `--prompt` flag or **stdin** (if `--prompt` is not provided). Calls `session.submit()` once, streams raw text tokens to stdout (stripping trailing `\n` from each chunk to avoid doubled newlines), emits `MARVIN_COST:{json}` to stderr, and exits with code `0` on success or `1` on error (missing `--prompt`/stdin, runtime exception, or LLM failure).

**`--ntfy` flag**: When provided, passes the ntfy topic to `SessionManager` for pipeline progress notifications (pushed to ntfy.sh on phase transitions).

**Slash command dispatch**: In interactive mode, before sending user input to the LLM, `main.ts` (or the UI layer) checks for slash command prefixes. The dispatch logic is:
1. Check if input starts with `!` — if so, match against known commands (`!code`, `!shell`/`!sh`, `!voice`, `!v`, `!blender`, `!pro`)
2. If no known `!` command matches, treat `!COMMAND` as a generic shell escape — execute `COMMAND` via `child_process` and display output as a system message
3. Check if input matches keyword commands (`quit`/`exit`, `preferences`, `profiles`, `usage`, `saved`)
4. If none match, send to LLM as a regular prompt
5. Slash commands are **not** dispatched in non-interactive mode

**Concrete entry point implementation**:

```typescript
// src/main.ts
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      provider:          { type: 'string' },
      plain:             { type: 'boolean', default: false },
      curses:            { type: 'boolean', default: false },
      'non-interactive': { type: 'boolean', default: false },
      prompt:            { type: 'string' },
      'working-dir':     { type: 'string' },
      ntfy:              { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  const args: CliArgs = {
    provider: values.provider,
    plain: values.plain ?? false,
    nonInteractive: values['non-interactive'] ?? false,
    prompt: values.prompt,
    workingDir: values['working-dir'],
    ntfy: values.ntfy,
    inlinePrompt: positionals[0],
  };

  // --- Non-interactive mode ---
  if (args.nonInteractive) {
    // Read prompt from --prompt flag or stdin
    let prompt = args.prompt;
    if (!prompt) {
      if (process.stdin.isTTY) {
        process.stderr.write('Error: --non-interactive requires --prompt or piped stdin\n');
        process.exit(1);
      }
      prompt = readFileSync(0, 'utf-8').trim(); // fd 0 = stdin
      if (!prompt) {
        process.stderr.write('Error: empty input on stdin\n');
        process.exit(1);
      }
    }
    await runNonInteractive(args, prompt);
    return;
  }

  // --- Interactive mode ---
  const profile = await loadOrCreateProfile();
  const providerConfig = resolveProvider(args);
  const ui = args.plain ? new PlainUI() : new CursesUI();
  const session = new SessionManager({ provider: providerConfig, profile, ui, ... });

  await ui.start();

  // Single-shot inline prompt: submit immediately, then enter prompt loop
  if (args.inlinePrompt) {
    await session.submit(args.inlinePrompt, makeStreamCallbacks(ui));
  }

  // Interactive prompt loop
  while (true) {
    const input = await ui.promptInput();
    if (!input) continue; // empty/whitespace-only → ignore

    // Slash command dispatch (§3 main.ts slash commands above)
    if (handleSlashCommand(input, session, ui)) continue;

    // Shell mode: execute as bash command
    if (session.getState().shellMode) {
      const output = await execShellCommand(input);
      ui.displaySystem(output);
      continue;
    }

    await session.submit(input, makeStreamCallbacks(ui));
  }
}

/** Non-interactive mode: one prompt in, one response out, exit. */
async function runNonInteractive(args: CliArgs, prompt: string): Promise<void> {
  const profile = await loadOrCreateProfile();
  const providerConfig = resolveProvider(args);
  providerConfig.maxToolRounds = 50;
  if (args.workingDir) providerConfig.timeoutMs = 900_000;

  const session = new SessionManager({
    provider: providerConfig, profile,
    ui: null, // no UI in non-interactive mode
    codingMode: true,
    workingDir: args.workingDir ?? process.cwd(),
    nonInteractive: true,
  });

  const callbacks: StreamCallbacks = {
    onDelta: (text) => {
      // Strip trailing \n to avoid doubled newlines (spec §7)
      const cleaned = text.endsWith('\n') ? text.slice(0, -1) : text;
      if (cleaned) process.stdout.write(cleaned);
    },
    onToolCallStart: (names) => {
      process.stdout.write(`  🔧 ${names.join(', ')}\n`);
    },
    onComplete: () => {},
    onError: (err) => { process.stderr.write(`Error: ${err.message}\n`); },
  };

  try {
    await session.submit(prompt, callbacks);
    process.stdout.write('\n'); // ensure final newline
  } finally {
    // Always emit cost data to stderr (spec §10)
    const usage = session.getUsage();
    process.stderr.write(`MARVIN_COST:${JSON.stringify(usage)}\n`);
    await session.destroy();
    process.exit(0);
  }
}
```

### `src/session.ts`
**Exports**: `SessionManager` class
**Depends on**: `llm/router.ts`, `tools/registry.ts`, `context.ts`, `history.ts`, `system-prompt.ts`, `profiles/manager.ts`, `usage.ts`, `ntfy.ts`

The central orchestrator. Holds `SessionState`, manages the `busy`/`done` lifecycle, dispatches prompts to the router, handles provider fallback, and runs the ntfy polling hook before each submission. Exposes `submit(text: string, callbacks: StreamCallbacks): Promise<void>` as the primary API. All `busy = false` and `done.resolve()` calls happen in a `finally` block — never conditionally.

**Notification polling** (UX §12): On every `submit()` call, before dispatching to the LLM, `SessionManager` calls `pollSubscriptions(profile)` from `ntfy.ts` with a **2-second timeout** (`AbortSignal.timeout(2000)`). If ntfy.sh is slow or unreachable, polling silently fails and the prompt proceeds without delay. Any new notifications are injected as system messages (`🔔 ...`) before the LLM response. Notifications arriving during streaming are **queued** and displayed after the current response completes — never interleaved with streaming output.

**Cancellation** (UX §10.5): `SessionManager` exposes a `cancel()` method. When Ctrl+C is pressed during streaming, the UI calls `cancel()`, which:
1. Calls `state.abortController?.abort()` — this aborts the in-flight `fetch()` in the provider (OpenAI-compat) or the SDK request (Copilot)
2. For running tool child processes: the AbortSignal is passed to `execFile` via `{ signal }` option, which sends SIGTERM to the child process
3. Keeps any partial response already streamed in the chat area
4. Appends a `[Cancelled]` marker to the message
5. The `finally` block in `submit()` handles `busy = false` / `done.resolve()` as always

```typescript
// In SessionManager
async submit(text: string, callbacks: StreamCallbacks): Promise<void> {
  this.state.busy = true;
  this.state.done = Promise.withResolvers<void>();
  this.state.abortController = new AbortController();
  try {
    // Poll notifications (2s timeout, never blocks)
    const notifications = await pollSubscriptions(this.profile, this.state.abortController.signal)
      .catch(() => [] as string[]);
    for (const n of notifications) this.ui?.displaySystem(`🔔 ${n}`);

    // Build messages, dispatch to router
    const systemMsg = await buildSystemMessage(this.profile, this.state, this.contextBudget);
    this.state.messages[0] = { role: 'system', content: systemMsg };
    this.state.messages.push({ role: 'user', content: text });
    // ... history cap enforcement ...
    const result = await runToolLoop(
      this.state.messages, this.provider, this.registry, callbacks,
      this.contextBudget, this.buildToolContext(), this.state.abortController.signal,
    );
    // ... append to history, update usage ...
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      callbacks.onDelta('\n[Cancelled]');
      return; // User cancelled — not an error
    }
    // ... provider fallback logic (§5.4) ...
    throw err;
  } finally {
    this.state.busy = false;
    this.state.abortController = null;
    this.state.done.resolve();
  }
}

cancel(): void {
  this.state.abortController?.abort();
}
```

### `src/context.ts`
**Exports**: `ContextBudgetManager` class
**Depends on**: `history.ts` (for compaction)

Tracks token count of the current message array. Called by `router.ts` before appending tool results to check budget. At 180K tokens, appends a budget warning string to tool results. At 200K tokens, triggers compaction: backs up the full message array to `.marvin/logs/context-backup-{ts}.jsonl`, then replaces middle messages with a summary, keeping the last 8 messages intact. At 226K tokens (hard limit), rejects large file reads entirely.

**Token estimation**: Uses `JSON.stringify(messages).length / 4` as a fast estimator (1 token ≈ 4 UTF-8 bytes). This consistently overestimates by ~20-30% versus real tokenizers (because JSON escaping and structural characters inflate the count), which is acceptable — overestimation triggers compaction slightly early, which is safer than underestimation causing context overflow. Exact counts from provider `usage` responses are used to calibrate the estimate after each LLM turn via `updateActual()`.

**Tool result truncation**: Before appending any tool result to messages, the router checks the estimated token count. If a single tool result would push context past the warn threshold, the result is truncated to `(remainingBudget * 4)` characters with a trailer: `"\n[Result truncated — {N} chars omitted due to context budget.]"`. This prevents a single large `read_file` or `web_search` result from blowing the context. The truncation happens in `router.ts`, not in the tool handler — tools return their full result and the router decides what fits.

**`read_file` budget gate** (spec §8): Specifically for `read_file`, if adding the file content would push context past the warn threshold (180K), the result is truncated to fit. If zero room remains (at or above hard limit 226K), `read_file` returns an error with the file's line count and instructions to use `start_line`/`end_line` or call `compact_history`.

### `src/llm/router.ts`
**Exports**: `runToolLoop(messages, provider, tools, callbacks, contextBudget, toolContext, signal): Promise<ChatResult>`
**Depends on**: `llm/copilot.ts`, `llm/openai.ts`, `llm/ollama.ts`, `tools/registry.ts`, `context.ts`

The provider-agnostic tool loop. Calls the selected provider's `chat()` method. If the response contains `tool_calls`, executes them via `registry.execute()` (parallel within a round via `Promise.all()`), appends tool results as `role: 'tool'` messages, and loops. Continues until the LLM returns a response with no tool calls, or `maxToolRounds` is reached. On max rounds, makes one final streaming call with no tools to get a text response. Handles rate-limit retries (HTTP 429) with exponential backoff.

**Complete implementation**:

```typescript
async function runToolLoop(
  messages: Message[],
  provider: Provider,
  registry: ToolRegistry,
  callbacks: StreamCallbacks,
  contextBudget: ContextBudgetManager,
  toolContext: ToolContext,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const tools = registry.getTools(toolContext.codingMode ? 'coding' : 'interactive');
  let totalUsage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;
  const maxRounds = toolContext.nonInteractive ? 50 : 10;

  while (rounds < maxRounds) {
    signal?.throwIfAborted();
    rounds++;

    // Call provider with retry for rate limits
    const result = await callWithRetry(
      () => provider.chat(messages, tools, callbacks, signal),
      3, // max retries for 429
    );
    totalUsage.inputTokens += result.usage.inputTokens;
    totalUsage.outputTokens += result.usage.outputTokens;
    contextBudget.updateActual(result.usage);

    const msg = result.message;

    // No tool calls → final response, we're done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      callbacks.onComplete(msg);
      return { message: msg, usage: totalUsage };
    }

    // Execute tool calls in parallel
    callbacks.onToolCallStart(msg.tool_calls.map(tc => tc.function.name));
    const toolResults = await Promise.all(
      msg.tool_calls.map(async (tc) => {
        let result = await registry.execute(tc, toolContext);
        // Context budget: truncate large results (§3 context.ts)
        const budgetAction = contextBudget.checkBudget(messages);
        if (budgetAction === 'warn' || budgetAction === 'compact') {
          result = contextBudget.truncateResult(result);
        }
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        };
      })
    );

    // Append assistant message (with tool_calls) + tool results
    messages.push(msg, ...toolResults);

    // Check if compaction needed after adding tool results
    const budgetCheck = contextBudget.checkBudget(messages);
    if (budgetCheck === 'compact') {
      messages = await contextBudget.compact(messages);
    }
  }

  // Max rounds reached — one final call with no tools to get a text response
  const finalResult = await provider.chat(messages, [], callbacks, signal);
  totalUsage.inputTokens += finalResult.usage.inputTokens;
  totalUsage.outputTokens += finalResult.usage.outputTokens;
  callbacks.onComplete(finalResult.message);
  return { message: finalResult.message, usage: totalUsage };
}

/** Retry with exponential backoff for HTTP 429 (rate limit). */
async function callWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const isRateLimit = lastError.message.includes('429') ||
                          lastError.message.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt === maxRetries) throw lastError;
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError!;
}
```

### `src/llm/copilot.ts`
**Exports**: `CopilotProvider` class implementing `Provider` interface
**Depends on**: `@github/copilot-sdk`

Wraps the Copilot SDK. Creates a single session with a single event listener registered at construction — never re-registered per request. On timeout (configurable, default 180s / 900s coding), destroys the session, sets it to `null`, and rebuilds on next `chat()` call. The `chat()` method returns a `Promise<ChatResult>` that resolves when the SDK fires `on_message` / `on_idle`. Streaming deltas forwarded via `onDelta` callback. Tool calls extracted from the SDK response and returned in OpenAI-compat format for uniform processing by `router.ts`.

**Model selection**: The Copilot SDK model is selected via `MARVIN_CHAT_MODEL` env var (spec §12). If `MARVIN_MODEL` is set (non-interactive mode override), it takes precedence. Default model: `claude-haiku-4.5`.

### `src/llm/openai.ts`
**Exports**: `OpenAICompatProvider` class implementing `Provider` interface
**Depends on**: `openai` npm package (or raw `fetch`)

Shared provider for Gemini, Groq, OpenAI, and OpenRouter. Configured with `baseUrl` and `apiKey`. Makes streaming `POST` to `/chat/completions` with `stream: true`. Parses SSE deltas, accumulates tool call arguments across chunks (they arrive incrementally), and returns the complete `ChatResult` when the stream ends. Handles the `arguments-as-string` sharp edge: if `arguments` arrives as a string, it's kept as-is (it's always a string on the wire); parsing happens in `registry.execute()`.

**SSE streaming parser** — the critical complexity here is assembling tool call arguments that arrive across multiple SSE chunks:

```typescript
async chat(messages: Message[], tools: OpenAIFunctionDef[], callbacks: StreamCallbacks, signal?: AbortSignal): Promise<ChatResult> {
  const response = await fetch(`${this.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  // Parse SSE stream
  let contentParts: string[] = [];
  // Tool calls accumulator: index → { id, name, argumentChunks[] }
  const toolCallAccum = new Map<number, { id: string; name: string; args: string[] }>();
  let usage = { inputTokens: 0, outputTokens: 0 };

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop()!; // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Content delta
      if (delta.content) {
        contentParts.push(delta.content);
        callbacks.onDelta(delta.content);
      }

      // Tool call deltas — arrive incrementally across multiple chunks
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, { id: tc.id ?? '', name: '', args: [] });
          }
          const accum = toolCallAccum.get(idx)!;
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name += tc.function.name;
          if (tc.function?.arguments) accum.args.push(tc.function.arguments);
        }
      }

      // Usage (provided in the final chunk by most providers)
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
  }

  // Assemble final message
  const toolCalls: ToolCall[] = [...toolCallAccum.entries()]
    .sort(([a], [b]) => a - b)
    .map(([_, tc]) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args.join('') },
    }));

  const message: Message = {
    role: 'assistant',
    content: contentParts.length > 0 ? contentParts.join('') : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return { message, usage };
}
```

**API key resolution**: Each provider reads its key from the environment with an optional file fallback:
```typescript
function resolveApiKey(envVar: string, fileFallback?: string): string | undefined {
  const key = process.env[envVar];
  if (key) return key;
  if (fileFallback) {
    try { return readFileSync(fileFallback, 'utf-8').trim(); } catch { /* no fallback file */ }
  }
  return undefined;
}
// Usage: resolveApiKey('GROQ_API_KEY', join(homedir(), '.ssh', 'GROQ_API_KEY'))
```

### `src/llm/ollama.ts`
**Exports**: `OllamaProvider` class implementing `Provider` interface
**Depends on**: (raw `fetch` to Ollama REST API)

Ollama uses its own REST API format (`/api/chat`), not the OpenAI-compat endpoint. Translates between Ollama's message format and the internal `Message` type. Supports streaming and tool calling (Ollama added function calling support). Falls back to `OpenAICompatProvider` if the Ollama server exposes an OpenAI-compat endpoint (some versions do).

**Connection error handling**: On `ECONNREFUSED` (Ollama not running), returns an actionable error: `"Cannot connect to Ollama at {url}. Is Ollama running? Start with: ollama serve"`. This is caught by the provider fallback chain (§5.4) and triggers Copilot SDK fallback.

### `src/tools/registry.ts`
**Exports**: `ToolRegistry` class, `registerTool()`, `getTools()`, `execute()`, `ToolContext` type
**Depends on**: `zod`, `zod-to-json-schema`

Central tool registry. Each tool file calls `registerTool()` at import time with a name, description, Zod schema, handler function, and category. `getTools(mode)` returns `OpenAIFunctionDef[]` filtered by mode (coding, readonly, all). `execute(toolCall)` does: (1) find tool by name, (2) parse `arguments` string with `JSON.parse()` — if parse fails, return actionable error with expected format, (3) validate parsed args against Zod schema — if validation fails, return Zod error formatted with field names and expected types, (4) call handler, (5) return result string. Never throws — always returns a string (success or error message) so the LLM can recover.

### `src/tools/files.ts`
**Exports**: (registers `read_file`, `create_file`, `append_file`, `apply_patch` tools)
**Depends on**: `tools/registry.ts`, `fs/promises`

Coding-mode file operations. All paths resolved relative to `SessionState.workingDir`. `apply_patch` accepts the standard 3-param schema (`path`, `old_str`, `new_str`) and also detects Codex `*** Begin Patch` format in the arguments string, parsing it into individual patch operations.

**Path security** — shared by all file tools:

```typescript
import { resolve, relative, isAbsolute } from 'path';

function validatePath(inputPath: string, workingDir: string): string {
  // Reject absolute paths
  if (isAbsolute(inputPath)) {
    throw new PathSecurityError(
      `Absolute paths not allowed. Working dir: ${workingDir}. Use relative paths.`
    );
  }

  // Resolve and check for traversal
  const resolved = resolve(workingDir, inputPath);
  const rel = relative(workingDir, resolved);

  // If relative path starts with '..' or is absolute, it escapes the sandbox
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathSecurityError(
      `Path '${inputPath}' escapes working directory. Working dir: ${workingDir}.`
    );
  }

  // Block .tickets/ directory
  if (rel.startsWith('.tickets')) {
    throw new PathSecurityError(`Access to .tickets/ is not allowed.`);
  }

  return resolved;
}

class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}
```

When path validation fails, the tool returns an error that includes the working directory and a directory listing (from the `tree` tool logic, top-level files/dirs only) so the LLM can correct its path.

**10KB file guard** for `read_file`:

```typescript
// If file is >10KB and no line range specified, reject with guidance
const stats = await stat(resolvedPath);
if (stats.size > 10_240 && !args.start_line && !args.end_line) {
  const lineCount = (await readFile(resolvedPath, 'utf-8')).split('\n').length;
  return `Error: File '${args.path}' is ${lineCount} lines (${(stats.size / 1024).toFixed(1)}KB). ` +
         `Use start_line/end_line to read a section: ` +
         `read_file({ path: '${args.path}', start_line: 1, end_line: 100 })`;
}
```

**File permission errors**: If `readFile`/`writeFile` throws `EACCES`, return: `"Error: Permission denied reading '${path}'. Check file permissions."`. If `ENOENT`, return: `"Error: File not found: '${path}'. Working dir: ${workingDir}. Use tree to list available files."`

**Codex `*** Begin Patch` format**: Some LLMs (Codex-series) emit patches in a multi-file diff format instead of the `{path, old_str, new_str}` schema. Detection and parsing:

```typescript
function isCodexPatchFormat(args: string): boolean {
  return args.includes('*** Begin Patch');
}

/**
 * Parse Codex patch format into individual patch operations.
 * Format:
 *   *** Begin Patch
 *   *** Update File: src/main.ts
 *   <<<<<<< SEARCH
 *   const x = 1;
 *   =======
 *   const x = 2;
 *   >>>>>>> REPLACE
 *   *** End Patch
 */
function parseCodexPatch(raw: string): Array<{ path: string; oldStr: string; newStr: string }> {
  const patches: Array<{ path: string; oldStr: string; newStr: string }> = [];
  const lines = raw.split('\n');
  let currentFile = '';
  let inSearch = false, inReplace = false;
  let searchLines: string[] = [], replaceLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('*** Update File: ') || line.startsWith('*** Add File: ')) {
      currentFile = line.replace(/^\*\*\* (Update|Add) File: /, '').trim();
    } else if (line.startsWith('<<<<<<< SEARCH')) {
      inSearch = true; searchLines = [];
    } else if (line === '=======') {
      inSearch = false; inReplace = true; replaceLines = [];
    } else if (line.startsWith('>>>>>>> REPLACE')) {
      inReplace = false;
      patches.push({ path: currentFile, oldStr: searchLines.join('\n'), newStr: replaceLines.join('\n') });
    } else if (inSearch) {
      searchLines.push(line);
    } else if (inReplace) {
      replaceLines.push(line);
    }
  }
  return patches;
}
```

### `src/tools/files-notes.ts`
**Exports**: (registers `file_read_lines`, `file_apply_patch` tools)
**Depends on**: `tools/registry.ts`, `fs/promises`

Non-coding-mode file tools restricted to `~/Notes/` directory only. Same read-lines and patch semantics as `files.ts` but with a hardcoded path prefix. Path security enforced identically — rejects escaping `~/Notes/`.

### `src/tools/shell.ts`
**Exports**: (registers `run_command` tool)
**Depends on**: `tools/registry.ts`, `child_process`

Executes shell commands via `execFile('/bin/bash', ['-c', command])` with a configurable timeout (default 60s). In interactive coding mode, the handler calls `ctx.confirmCommand(command)` — a callback provided via `ToolContext` that the `SessionManager` wires to the UI's `promptConfirm()` method. This avoids the tool importing any UI module. In non-interactive mode, `confirmCommand` is not set (or always returns `true`), so commands auto-execute. Returns stdout + stderr combined, truncated to 50KB.

**Timeout and cancellation**: The `timeout` parameter is passed to `execFile` options. The AbortSignal from the session is also passed via `{ signal }`, so Ctrl+C during a long-running command sends SIGTERM to the child process. If the command times out, returns: `"Error: Command timed out after {N}s. Consider increasing timeout or breaking into smaller steps."`. Output truncation: if stdout+stderr exceeds 50KB, truncate and append `"\n[Output truncated — {N} bytes omitted]"`.

### `src/tools/git.ts`
**Exports**: (registers `git_status`, `git_diff`, `git_log`, `git_commit`, `git_checkout`, `git_blame`, `git_branch`)
**Depends on**: `tools/registry.ts`, `child_process`

All git commands run with `GIT_DIR` explicitly deleted from `process.env` before execution (per SHARP_EDGES.md §6). Commands execute in `SessionState.workingDir`. `git_commit` and `git_checkout` are write operations — excluded when `MARVIN_READONLY=1`.

### `src/tools/web.ts`
**Exports**: (registers `web_search`, `search_news`, `browse_web`, `scrape_page`)
**Depends on**: `tools/registry.ts`, `node-fetch` or built-in `fetch`

`web_search` calls DuckDuckGo HTML search and parses results. `search_news` aggregates GNews + NewsAPI + DDG News with deduplication by URL. `browse_web` fetches a URL and pipes through `lynx -dump` for text rendering. `scrape_page` uses Selenium + headless Firefox for JS-rendered pages — **this dependency is optional**: `selenium-webdriver` is a `peerDependency` (not a hard dependency), and the tool checks for its availability at call time with a dynamic `import()`. If not installed, returns: `"scrape_page requires selenium-webdriver and Firefox. Install with: npm install selenium-webdriver. Use browse_web for non-JS pages."`.

**DuckDuckGo web_search implementation**:

```typescript
async function duckduckgoSearch(query: string, maxResults: number = 10): Promise<Array<{ title: string; url: string; snippet: string }>> {
  // DDG HTML search — no API key, no rate limit
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Marvin/1.0)' },
  });
  const html = await response.text();

  // Parse results from HTML (DDG uses .result class with .result__a and .result__snippet)
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // Simple regex extraction — robust enough for DDG's stable HTML structure
  const resultRegex = /class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1];
    // DDG wraps URLs in a redirect: //duckduckgo.com/l/?uddg=ENCODED_URL
    const actualUrl = rawUrl.includes('uddg=')
      ? decodeURIComponent(rawUrl.split('uddg=')[1]?.split('&')[0] ?? rawUrl)
      : rawUrl;
    results.push({
      title: match[2].trim(),
      url: actualUrl,
      snippet: match[3].replace(/<[^>]*>/g, '').trim(),
    });
  }
  return results;
}
```

**Per-tool HTTP timeout**: All `fetch()` calls in tool handlers use `AbortSignal.timeout(30_000)` (30 seconds) to prevent hanging on unresponsive APIs. On timeout, return an actionable error: `"Error: {api_name} request timed out after 30s. Try again or use an alternative."`. This is independent of the session-level AbortController (which handles Ctrl+C cancellation).

### `src/tools/notes.ts`
**Exports**: (registers `write_note`, `read_note`, `notes_ls`, `notes_mkdir`, `search_notes`)
**Depends on**: `tools/registry.ts`, `fs/promises`

Notes stored in `~/Notes/` (interactive) or `.marvin/notes/` (coding mode). The coding-mode redirect is determined from `ctx.codingMode` in the `ToolContext` — the handler checks this at call time, not via a global. `search_notes` does recursive grep through note files.

### `src/tools/coding.ts`
**Exports**: (registers `set_working_dir`, `get_working_dir`, `code_grep`, `tree`, `review_codebase`, `review_status`)
**Depends on**: `tools/registry.ts`, `child_process`

`code_grep` wraps `ripgrep` (`rg`). `tree` lists directory contents respecting `.gitignore`. `review_codebase` spawns a background Marvin process (`marvin --non-interactive --prompt "review..."`) and returns immediately with a job ID. `review_status` checks if the background review is complete.

**Background job management**: Background jobs (from `review_codebase`) are
tracked in a module-level `Map<string, { process: ChildProcess; startTime: number }>`.
The system prompt includes active job IDs so the LLM can check status. Jobs
are cleaned up on process exit. There is no limit on concurrent background
jobs — this is acceptable because `review_codebase` is a coding-mode-only
tool used infrequently. If abuse becomes an issue, add a cap of 3 concurrent
jobs.

### `src/tools/tk.ts`
**Exports**: (registers `tk` tool)
**Depends on**: `tools/registry.ts`, `child_process`

Wraps the external `tk` CLI for ticket management in coding mode. Accepts a single `args` string parameter that is passed directly to `tk` as shell arguments. Supports: `create`, `start`, `close`, `add-note`, `show`, `ls`, `blocked`, `dep-tree`.

**Ticket gating** (SHARP_EDGES §8): Write tools (`create_file`, `append_file`, `apply_patch`, `run_command`, `git_commit`) are blocked until the agent creates a ticket via `tk create`. The gating check is in `registry.execute()` — a module-level `hasTicket: boolean` flag is set to `true` when `tk create` succeeds. Before executing any write tool, `execute()` checks this flag and returns an error if no ticket exists: `"Error: You must create a ticket with 'tk create' before writing files. Create a ticket describing your task first."`. Readonly agents (`MARVIN_READONLY=1`) are exempt.

**First-rejection rule** (SHARP_EDGES §8): The **first** `tk create` call is intentionally rejected with a message: `"Ticket description is too brief. Please provide a thorough description with acceptance criteria, then try again."`. A module-level `firstCreateAttempted: boolean` flag tracks this. This forces agents to write substantive ticket descriptions on the retry — without this, agents write vague one-liner tickets.

### `src/tools/agents.ts`
**Exports**: (registers `launch_agent` tool)
**Depends on**: `tools/registry.ts`, `child_process`

Spawns a sub-agent as a child `marvin --non-interactive` process. Requires `ticket_id` (from `tk`) and `prompt` parameters. The `model` parameter (`auto`/`codex`/`opus`) is resolved to a concrete model name using the model tier env vars.

**Sub-agent environment variables** (SHARP_EDGES §12): When spawning a sub-agent, the following env vars are set:
- `MARVIN_DEPTH`: Current depth + 1 (prevents infinite nesting; implementations should enforce a max depth, e.g., 5)
- `MARVIN_MODEL`: The resolved model for this agent
- `MARVIN_TICKET`: The parent ticket ID — the sub-agent must create a child ticket (via `--parent`) before writing files
- `MARVIN_READONLY`: `"1"` for review-only agents (blocks write tools)
- `MARVIN_SUBAGENT_LOG`: Path to JSONL file for tool call auditing (each entry: `{ ts, tool, args, result, elapsed_ms }`, args truncated to 200 chars, results to 400 chars)
- `GIT_DIR` is explicitly **deleted** from the child's environment (SHARP_EDGES §6)

**stdout-to-file prohibition** (SHARP_EDGES §14): The `launch_agent` handler does NOT capture stdout and write it to a file. Agents must use `create_file` explicitly — capturing stdout would produce garbage files containing chain-of-thought planning notes instead of real content.

**File locking policy** (SHARP_EDGES §15): No file locking between sub-agents. Write agents run sequentially; only readonly reviewers run in parallel. File locking was tried and caused deadlocks.

### `src/tools/location.ts`
**Exports**: (registers `get_my_location`, `places_text_search`, `places_nearby_search`)
**Depends on**: `tools/registry.ts`, `child_process` (for `CoreLocation`/`GeoClue`), `fetch`

`get_my_location` tries platform-native geolocation first (CoreLocation on macOS via a swift snippet, GeoClue on Linux via D-Bus), falling back to IP geolocation via a free API. `places_text_search` uses Google Places API if `GOOGLE_PLACES_API_KEY` is set, otherwise falls back to Nominatim (OpenStreetMap).

### `src/tools/places.ts`
**Exports**: (registers `save_place`, `remove_place`, `list_places`, `setup_google_auth`)
**Depends on**: `tools/registry.ts`, `profiles/manager.ts`

CRUD operations on `UserProfile.savedPlaces`. Persisted to `saved_places.json` in the active profile directory.

### `src/tools/travel.ts`
**Exports**: (registers `estimate_travel_time`, `get_directions`, `traffic_adjusted_time`)
**Depends on**: `tools/registry.ts`, `fetch`

Uses OSRM (Open Source Routing Machine) public API for routing. `traffic_adjusted_time` applies heuristic multipliers based on time-of-day and weather conditions.

### `src/tools/weather.ts`
**Exports**: (registers `weather_forecast`)
**Depends on**: `tools/registry.ts`, `fetch`

Calls Open-Meteo free API. No API key required. Returns current conditions + multi-day forecast with temperature, precipitation, wind, sunrise/sunset.

### `src/tools/media.ts`
**Exports**: (registers `search_movies`, `get_movie_details`, `search_games`, `get_game_details`)
**Depends on**: `tools/registry.ts`, `fetch`

Movies via OMDB (requires `OMDB_API_KEY`, DDG fallback). Games via RAWG (requires `RAWG_API_KEY`, DDG fallback).

### `src/tools/steam.ts`
**Exports**: (registers `steam_search`, `steam_app_details`, `steam_featured`, `steam_player_stats`, `steam_user_games`, `steam_user_summary`)
**Depends on**: `tools/registry.ts`, `fetch`

Steam Web API and Steam store API. User-specific endpoints require `STEAM_API_KEY`.

### `src/tools/music.ts`
**Exports**: (registers `music_search`, `music_lookup`)
**Depends on**: `tools/registry.ts`, `fetch`

MusicBrainz API. Rate-limited to 1 request/second per their API terms. Uses a simple queue/delay.

### `src/tools/recipes.ts`
**Exports**: (registers `recipe_search`, `recipe_lookup`)
**Depends on**: `tools/registry.ts`, `fetch`

TheMealDB free API.

### `src/tools/calendar.ts`
**Exports**: (registers `calendar_add_event`, `calendar_delete_event`, `calendar_view`, `calendar_list_upcoming`)
**Depends on**: `tools/registry.ts`, `fs/promises`, `child_process`

Events stored as `.ics` files. `calendar_add_event` generates an ICS file and schedules cron-based reminders (1h and 30m before) that fire `notify-send` and ntfy.sh notifications. Platform detection for macOS vs Linux notification mechanisms.

### `src/tools/wiki.ts`
**Exports**: (registers `wiki_search`, `wiki_summary`, `wiki_full`, `wiki_grep`)
**Depends on**: `tools/registry.ts`, `fetch`, `fs/promises`

Wikipedia API. `wiki_full` saves the full article to disk and returns the file path — does NOT return article content in the tool result (would blow context budget). `wiki_grep` searches within a previously saved article file.

### `src/tools/academic.ts`
**Exports**: (registers `search_papers`, `search_arxiv`)
**Depends on**: `tools/registry.ts`, `fetch`

Semantic Scholar API and arXiv API.

### `src/tools/system.ts`
**Exports**: (registers `exit_app`, `system_info`, `get_usage`)
**Depends on**: `tools/registry.ts`, `os`, `usage.ts`

`exit_app` calls `process.exit(0)`. `system_info` returns OS, CPU, memory, disk, uptime, battery. `get_usage` delegates to `usage.ts` for session + lifetime stats.

### `src/tools/alarms.ts`
**Exports**: (registers `set_alarm`, `list_alarms`, `cancel_alarm`)
**Depends on**: `tools/registry.ts`, `child_process`

Cron-based alarms. `set_alarm` creates a cron entry that fires `notify-send` and optionally publishes to ntfy.sh.

### `src/tools/timers.ts`
**Exports**: (registers `timer_start`, `timer_check`, `timer_stop`)
**Depends on**: `tools/registry.ts`

In-memory timers (not persisted). Each timer is a `{ name, startTime, duration?, type: 'countdown' | 'stopwatch' }` stored in a module-level `Map`.

### `src/tools/ntfy.ts`
**Exports**: (registers `generate_ntfy_topic`, `ntfy_subscribe`, `ntfy_unsubscribe`, `ntfy_publish`, `ntfy_list`), `pollSubscriptions(profile): Promise<string[]>`
**Depends on**: `tools/registry.ts`, `fetch`, `profiles/manager.ts`

The `pollSubscriptions()` function is NOT a tool — it's called by `session.ts` on every message submission. It checks all subscribed ntfy.sh topics for new messages since `lastMessageId`, updates the ID, and returns any new notification strings. These are injected as system messages before the LLM dispatch.

### `src/tools/spotify.ts`
**Exports**: (registers `spotify_auth`, `spotify_search`, `spotify_create_playlist`, `spotify_add_tracks`)
**Depends on**: `tools/registry.ts`, `fetch`, `http` (for OAuth callback server)

`spotify_auth` starts a local HTTP server for the OAuth callback flow, returns the authorization URL for the user to open. Tokens stored in profile's `tokens.json`.

### `src/tools/maps.ts`
**Exports**: (registers `osm_search`, `overpass_query`)
**Depends on**: `tools/registry.ts`, `fetch`

OpenStreetMap Nominatim search and Overpass API for complex geographic queries.

### `src/tools/stack.ts`
**Exports**: (registers `stack_search`, `stack_answers`)
**Depends on**: `tools/registry.ts`, `fetch`

Stack Exchange API. Searches across SO, ServerFault, AskUbuntu, Unix.

### `src/tools/tickets.ts`
**Exports**: (registers `create_ticket`, `ticket_start`, `ticket_close`, `ticket_add_note`, `ticket_show`, `ticket_list`, `ticket_dep_tree`, `ticket_add_dep`)
**Depends on**: `tools/registry.ts`, `fs/promises`

Non-coding-mode personal task tracking. Tickets stored as JSON files in `~/.config/local-finder/tickets/`. These are NOT the pipeline `tk` tool — they are simple CRUD wrappers for personal use.

### `src/tools/bookmarks.ts`
**Exports**: (registers `bookmark_save`, `bookmark_list`, `bookmark_search`)
**Depends on**: `tools/registry.ts`, `fs/promises`

Bookmarks stored as JSON in `~/.config/local-finder/bookmarks.json`.

### `src/tools/downloads.ts`
**Exports**: (registers `download_file`, `yt_dlp_download`)
**Depends on**: `tools/registry.ts`, `fetch`, `child_process`

`download_file` streams a URL to `~/Downloads/`. `yt_dlp_download` shells out to `yt-dlp` (must be installed).

### `src/tools/utilities.ts`
**Exports**: (registers `convert_units`, `dictionary_lookup`, `translate_text`, `read_rss`)
**Depends on**: `tools/registry.ts`, `fetch`

`convert_units` handles physical units locally and currency via Frankfurter API. `dictionary_lookup` uses dictionaryapi.dev. `translate_text` uses MyMemory API. `read_rss` parses RSS/Atom XML.

### `src/tools/github.ts`
**Exports**: (registers `github_search`, `github_clone`, `github_read_file`, `github_grep`)
**Depends on**: `tools/registry.ts`, `child_process`

Uses the `gh` CLI for GitHub API access. `github_clone` clones to `~/github-clones/<owner>/<repo>`. Read/grep tools operate on cloned repos.

### `src/tools/blender.ts`
**Exports**: (registers `blender_get_scene`, `blender_get_object`, `blender_create_object`, `blender_modify_object`, `blender_delete_object`, `blender_set_material`, `blender_execute_code`, `blender_screenshot`)
**Depends on**: `tools/registry.ts`, `fetch`

Connects to Blender via MCP server at `BLENDER_MCP_HOST:BLENDER_MCP_PORT` (defaults `127.0.0.1:9876`). All 8 tools send JSON-RPC requests to the MCP server. `blender_execute_code` sends arbitrary Python to Blender's `bpy` context. `blender_screenshot` captures viewport as base64. Connection status is checked by the `!blender` slash command.

### `src/tools/packages.ts`
**Exports**: (registers `install_packages`)
**Depends on**: `tools/registry.ts`, `child_process`

Installs packages via `uv` into the project's virtual environment. Accepts a list of package names and an optional `dev` flag for dev dependencies. Runs `uv add [--dev] <packages>` in the working directory. Coding-mode-only tool.

### `src/voice.ts`
**Exports**: `startContinuousVoice()`, `recordOneShot(seconds: number)`, `stopVoice()`
**Depends on**: `child_process`, `fetch`

Voice input module for `!voice` (continuous) and `!v [N]` (one-shot) commands. Records audio from the microphone via `arecord` (Linux) or `sox` (macOS). Continuous mode uses silence detection to segment recordings. Audio is transcribed via Groq Whisper API (model configurable via `WHISPER_MODEL` env var, default `whisper-large-v3`). Transcribed text is automatically submitted as a user message via `SessionManager.submit()`.

### `src/ui/curses.ts`
**Exports**: `CursesUI` class implementing `UI` interface
**Depends on**: `blessed` (or `neo-blessed`), `ui/shared.ts`

Full-terminal TUI with status bar, scrollable chat area, and input box. Registers keyboard shortcuts (PgUp/PgDn, Ctrl+C, Ctrl+Q, etc.). Implements `StreamCallbacks` to render streaming deltas character-by-character. Shows tool call lines (`🔧 tool1, tool2`) with elapsed time for long-running tools. Auto-scrolls to bottom unless user has manually scrolled up.

**Input handling** (UX §13): Single-line input box. Pasted newlines are stripped (replaced with spaces). Input >10,000 characters triggers a soft warning (`⚠️ Input is very long`). Empty/whitespace-only input is ignored (no message sent). While `busy=true`, keypresses are buffered and submitted after the current response finishes.

### `src/ui/plain.ts`
**Exports**: `PlainUI` class implementing `UI` interface
**Depends on**: `readline`, `ui/shared.ts`

Readline-based plain terminal UI. Prints messages linearly to stdout. Tool calls shown as `  🔧 tool1, tool2`. Streaming tokens printed inline. Uses ANSI colors when stdout is a TTY, omits them when piped. Feature parity with curses mode — all slash commands, shell mode, coding mode work identically.

### `src/ui/shared.ts`
**Exports**: `UI` interface, `formatMessage()`, `formatToolCall()`, message type definitions
**Depends on**: (none)

Shared types and formatting utilities used by both UI implementations. Defines the `UI` interface that both `CursesUI` and `PlainUI` implement:

```typescript
interface UI {
  start(): Promise<void>;
  displayMessage(role: string, text: string): void;
  displaySystem(text: string): void;
  displayToolCall(toolNames: string[]): void;
  beginStream(): void;
  streamDelta(text: string): void;
  endStream(): void;
  promptInput(): Promise<string>;
  promptConfirm(command: string): Promise<boolean>;
  showStatus(status: StatusBarData): void;
  destroy(): void;
}
```

### `src/profiles/manager.ts`
**Exports**: `ProfileManager` class, `loadProfile()`, `saveProfile()`, `switchProfile()`, `listProfiles()`
**Depends on**: `fs/promises`, `yaml`

Manages `~/.config/local-finder/profiles/` directory. Loads and saves all profile artifacts: `preferences.yaml`, `saved_places.json`, `chat_log.json`, `tokens.json` (OAuth), `ntfy_subscriptions.json`, and `history` (readline input history). Creates new profile directories with default preferences when switching to a non-existent profile. Tracks last active profile in `~/.config/local-finder/last_profile`.

### `src/profiles/prefs.ts`
**Exports**: `loadPreferences()`, `savePreferences()`, `updatePreference()`
**Depends on**: `yaml`, `fs/promises`

YAML-based user preferences. Loads from `prefs.yaml` in the active profile directory.

### `src/history.ts`
**Exports**: `loadChatLog()`, `saveChatLog()`, `appendChatLog()`, `compactHistory()`, `searchHistoryBackups()`
**Depends on**: `fs/promises`

Chat log stored as `chat_log.json` — array of `ChatLogEntry` objects with `role` (`"you"`, `"assistant"`, `"system"`), `text`, and `time`. Note: chat log role values are NOT the same as OpenAI message roles — they use `"you"` instead of `"user"`. Conversion happens in `system-prompt.ts` when seeding history into the LLM message array. `compactHistory()` is both a tool (callable by the LLM) and an infrastructure function (called by `context.ts` during automatic compaction).

### `src/usage.ts`
**Exports**: `UsageTracker` class
**Depends on**: `fs/promises`

Tracks per-turn token counts and costs. Session totals held in memory. Lifetime totals persisted to `~/.config/local-finder/usage.json` and updated on each turn. Provides `getSessionUsage(): SessionUsage` for the `get_usage` tool and `emitCostLine()` for non-interactive stderr output.

### `src/system-prompt.ts`
**Exports**: `buildSystemMessage(profile, state, contextBudget): string`, `seedHistoryMessages(chatLog, limit): Message[]`
**Depends on**: `profiles/manager.ts`, `history.ts`, `context.ts`, `fs/promises`

Builds the system prompt fresh on every request. Concatenates: personality/rules, user preferences, active profile name, saved places, compact history (last 20 entries truncated to 200 chars each), coding mode instructions (if active), background job status, `.marvin-instructions` / `.marvin/instructions.md` / `~/.marvin/instructions/<path>.md` contents (global per-project instructions keyed by working directory path), and `.marvin/spec.md` / `.marvin/ux.md` / `.marvin/design.md` if present in working dir. Order matters — most important context first, optional project docs last (they get dropped first during compaction).

**History seeding** — converts on-disk chat log roles to OpenAI message roles and seeds the conversation:

```typescript
/**
 * Convert ChatLogEntry[] to Message[] for LLM context seeding.
 * Called by SessionManager at session start (interactive mode only).
 * Non-interactive mode does NOT seed full history — only compact history in system prompt.
 */
function seedHistoryMessages(chatLog: ChatLogEntry[], limit: number = 20): Message[] {
  // Take last N entries
  const recent = chatLog.slice(-limit);
  return recent
    .filter(entry => entry.role !== 'system') // don't inject system messages as user/assistant
    .map(entry => ({
      role: (entry.role === 'you' ? 'user' : entry.role) as MessageRole,
      content: entry.text,
    }));
}

/**
 * Generate compact history string for the system prompt.
 * Included in system prompt for ALL modes (interactive + non-interactive).
 */
function compactHistoryString(chatLog: ChatLogEntry[], limit: number = 20): string {
  const recent = chatLog.slice(-limit);
  if (recent.length === 0) return '';
  const lines = recent.map(e => {
    const prefix = e.role === 'you' ? 'User' : e.role === 'assistant' ? 'Asst' : 'Sys';
    const truncated = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return `${prefix}: ${truncated}`;
  });
  return `\n\nRecent conversation:\n${lines.join('\n')}`;
}
```

---

## 4. Tool System

### 4.0 Extensibility Checklist

Adding a new tool requires exactly **2 steps**:

1. **Create one file** (`src/tools/my-tool.ts`) that calls `registerTool()`
   with a name, description, Zod schema, handler, and category.
2. **Import it in `main.ts`** (a single `import './tools/my-tool.js';` line)
   so the side-effect registration runs at startup.

No changes to the registry, router, session, UI, or types. The tool is
automatically available to the LLM, with the correct JSON Schema, gated by
category.

**Bootstrap import sequence** in `main.ts` — these side-effect imports must
run before `SessionManager` construction so all tools are registered:

```typescript
// src/main.ts — tool registration imports (order doesn't matter, but group for clarity)
import './tools/web.js';
import './tools/files.js';
import './tools/files-notes.js';
import './tools/shell.js';
import './tools/git.js';
import './tools/notes.js';
import './tools/coding.js';
import './tools/location.js';
import './tools/places.js';
import './tools/travel.js';
import './tools/weather.js';
import './tools/media.js';
import './tools/steam.js';
import './tools/music.js';
import './tools/recipes.js';
import './tools/calendar.js';
import './tools/wiki.js';
import './tools/academic.js';
import './tools/system.js';
import './tools/alarms.js';
import './tools/timers.js';
import './tools/ntfy.js';
import './tools/spotify.js';
import './tools/maps.js';
import './tools/stack.js';
import './tools/tickets.js';
import './tools/bookmarks.js';
import './tools/downloads.js';
import './tools/utilities.js';
import './tools/github.js';
```

Adding a new **provider** requires:

1. Create `src/llm/my-provider.ts` implementing the `Provider` interface.
2. Add a case to the provider factory in `main.ts` that maps the provider
   name to the new class.

Adding a new **UI mode** requires:

1. Create `src/ui/my-ui.ts` implementing the `UI` interface.
2. Add a case to the UI factory in `main.ts`.

If adding any of these requires touching more than 2 files, the design has
a coupling problem.

### 4.1 Registration

Each tool file registers its tools at module import time by calling `registerTool()` from `tools/registry.ts`. The registry is populated during application bootstrap — `main.ts` imports all tool files, which triggers registration as a side effect.

```typescript
// Example: tools/weather.ts
import { registerTool } from './registry.js';
import { z } from 'zod';

registerTool({
  name: 'weather_forecast',
  description: 'Get current weather and multi-day forecast for a location.',
  category: 'always',
  schema: z.object({
    location: z.string().describe('City name or "lat,lng" coordinates'),
    days: z.number().optional().default(3).describe('Number of forecast days (1-7)'),
  }),
  handler: async (args, _ctx) => {
    // ctx is available for tools that need workingDir, codingMode, etc.
    // weather doesn't need it, but the signature is uniform.
    // ... implementation
    return JSON.stringify(forecast);
  },
});
```

### 4.2 Zod-to-OpenAI Schema Conversion

The registry uses `zod-to-json-schema` to convert each tool's Zod schema into JSON Schema, then wraps it in the OpenAI function-calling format:

```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';

function toOpenAIFunction(tool: Tool): OpenAIFunctionDef {
  const jsonSchema = zodToJsonSchema(tool.schema, { target: 'openAi' });
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: jsonSchema.properties ?? {},
        required: jsonSchema.required ?? [],
      },
    },
  };
}
```

The `{ target: 'openAi' }` option strips incompatible JSON Schema keywords that OpenAI rejects. This conversion happens once at startup, and the resulting `OpenAIFunctionDef[]` array is cached.

### 4.3 Tool Gating

`getTools(mode)` filters tools by category:

| Mode | Included Categories |
|------|-------------------|
| `'interactive'` | `'always'` |
| `'coding'` | `'always'` + `'coding'` |
| `'readonly'` | `'always'` + `'coding'` minus write tools |

Write tools excluded in readonly mode: `create_file`, `append_file`, `apply_patch`, `file_apply_patch`, `git_commit`, `git_checkout`, `run_command`.

### 4.4 Argument Validation (SHARP_EDGES.md compliance)

The `execute(toolCall: ToolCall)` function handles LLM argument quirks:

```typescript
async function execute(toolCall: ToolCall, ctx: ToolContext): Promise<string> {
  const tool = registry.get(toolCall.function.name);
  if (!tool) {
    return `Error: Unknown tool "${toolCall.function.name}". Available tools: ${[...registry.keys()].join(', ')}`;
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(toolCall.function.arguments);
  } catch {
    // Sharp edge #1: arguments may be non-JSON (e.g., Codex diff format)
    return `Error: Invalid JSON in tool arguments. Expected format: ${describeSchema(tool.schema)}. ` +
           `Received: ${toolCall.function.arguments.slice(0, 200)}...`;
  }

  // Sharp edge #1: arguments may be a JSON string wrapping another JSON string
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      return `Error: Tool arguments must be a JSON object. Expected: ${describeSchema(tool.schema)}`;
    }
  }

  // Zod validation — sharp edge #2: transparent errors
  const result = tool.schema.safeParse(rawArgs);
  if (!result.success) {
    const issues = result.error.issues.map(
      i => `  - ${i.path.join('.')}: ${i.message} (expected ${i.expected ?? 'valid value'})`
    ).join('\n');
    return `Error: Invalid arguments for "${tool.name}":\n${issues}\n\nExpected schema:\n${describeSchema(tool.schema)}`;
  }

  try {
    return await tool.handler(result.data, ctx);
  } catch (err) {
    return `Error executing "${tool.name}": ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

Key invariant: `execute()` **never throws**. It always returns a string — either the tool's result or an actionable error message. This ensures the LLM always gets feedback and can attempt recovery.

### 4.5 Parallel Execution

When the LLM returns multiple `tool_calls` in a single response, they are executed in parallel:

```typescript
// In router.ts runToolLoop
const toolResults = await Promise.all(
  message.tool_calls.map(async (tc) => ({
    role: 'tool' as const,
    tool_call_id: tc.id,
    content: await registry.execute(tc, toolContext),
  }))
);
messages.push(message, ...toolResults);
```

The `onToolCallStart` callback fires once per round with all tool names, so the UI shows them on a single `🔧` line.

---

## 5. Provider Architecture

### 5.1 Provider Interface

All providers implement this interface:

```typescript
interface Provider {
  readonly name: string;
  readonly model: string;

  chat(
    messages: Message[],
    tools: OpenAIFunctionDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatResult>;

  destroy(): void;
}
```

**Provider factory** — `resolveProvider()` in `main.ts` maps CLI args + env vars to a concrete provider:

```typescript
function resolveProvider(args: CliArgs): ProviderConfig {
  const name = args.provider ?? process.env.LLM_PROVIDER ?? 'copilot';
  const defaults: Record<string, () => ProviderConfig> = {
    copilot:       () => ({ provider: 'copilot', model: process.env.MARVIN_CHAT_MODEL ?? 'claude-haiku-4.5', timeoutMs: 180_000, maxToolRounds: 10 }),
    gemini:        () => ({ provider: 'gemini', model: process.env.GEMINI_MODEL ?? 'gemini-3-pro-preview', apiKey: resolveApiKey('GEMINI_API_KEY', '~/.ssh/GEMINI_API_KEY'), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', timeoutMs: 180_000, maxToolRounds: 10 }),
    groq:          () => ({ provider: 'groq', model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile', apiKey: resolveApiKey('GROQ_API_KEY', '~/.ssh/GROQ_API_KEY'), baseUrl: 'https://api.groq.com/openai/v1', timeoutMs: 180_000, maxToolRounds: 10 }),
    openai:        () => ({ provider: 'openai', model: 'gpt-5.1', apiKey: process.env.OPENAI_API_KEY, baseUrl: 'https://api.openai.com/v1', timeoutMs: 180_000, maxToolRounds: 10 }),
    ollama:        () => ({ provider: 'ollama', model: process.env.OLLAMA_MODEL ?? 'qwen3-coder:30b', baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434', timeoutMs: 180_000, maxToolRounds: 10 }),
    'openai-compat': () => ({ provider: 'openai-compat', model: process.env.OPENAI_COMPAT_MODEL ?? 'qwen/qwen3-32b', apiKey: process.env.OPENAI_COMPAT_API_KEY, baseUrl: process.env.OPENAI_COMPAT_URL ?? 'https://openrouter.ai/api/v1', timeoutMs: 180_000, maxToolRounds: 10 }),
  };
  const factory = defaults[name];
  if (!factory) {
    console.error(`Unknown provider: ${name}. Available: ${Object.keys(defaults).join(', ')}`);
    process.exit(1);
  }
  const config = factory();
  // Non-interactive model override
  if (process.env.MARVIN_MODEL) config.model = process.env.MARVIN_MODEL;
  return config;
}
```

### 5.2 Shared OpenAI-Compatible Path

`OpenAICompatProvider` handles Gemini, Groq, OpenAI, and OpenRouter with the same code. Configuration differences are limited to `baseUrl`, `apiKey`, and `model`:

| Provider | Base URL | API Key Env Var |
|----------|----------|-----------------|
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENAI_COMPAT_API_KEY` |

The streaming SSE parser handles incremental tool call argument assembly: each delta may contain a partial `arguments` string for a tool call. The provider accumulates these into a complete JSON string before returning the `ChatResult`.

**API key fallbacks** (spec §3): `GROQ_API_KEY` and `GEMINI_API_KEY` fall back to reading from `~/.ssh/GROQ_API_KEY` and `~/.ssh/GEMINI_API_KEY` respectively if the environment variable is not set. The provider factory reads `fs.readFileSync(path, 'utf-8').trim()` from the fallback path.

**Model-specific quirks** (SHARP_EDGES §11):
- **Gemini**: Tool call responses may arrive in a slightly different structure than OpenAI/Anthropic. The SSE parser must handle both formats — test tool calling with all providers.
- **OpenAI Codex models**: Tend to send tool arguments as strings (handled by double-parse in `registry.execute()`). Also sometimes use diff-format (`*** Begin Patch`) for `apply_patch` instead of the 3-param schema — handled by auto-detection in `files.ts`.
- **Claude Opus**: Expensive. Reserved for code reviews and adversarial QA via `MARVIN_CODE_MODEL_HIGH`, not for bulk implementation.
- **Cost tracking**: Each provider has different per-token pricing. `UsageTracker` tracks costs per-provider and per-model to catch runaway costs.

### 5.2.1 Streaming Backpressure

Streaming backpressure is **not an issue** for this architecture. LLM APIs
deliver tokens at ~50-100 tokens/second — far slower than terminal rendering
speed. The `onDelta` callback synchronously appends characters to the UI
buffer and returns immediately. There is no scenario where the LLM produces
tokens faster than the UI can consume them.

The one concern is **large tool results** being sent to the LLM: a tool might
return 50KB of text that gets serialized into the messages array. This is
handled by the router's result truncation (see §3 `context.ts`) — not by
streaming backpressure, but by budget gating before the result enters the
message array.

### 5.3 Copilot SDK Lifecycle

The Copilot SDK (`@github/copilot-sdk`) has a unique lifecycle that differs from REST APIs:

1. **Session creation**: One `CopilotSession` created at startup. A single event listener is registered for `delta`, `message`, and `idle` events — **never re-registered per request**.

2. **Request flow**: `chat()` calls `session.send(messages, tools)`. Deltas arrive via the `delta` event. When `message` fires, the complete response is available. When `idle` fires, the session is ready for the next request.

3. **Timeout handling**: A `setTimeout` fires after `timeoutMs`. On timeout:
   ```typescript
   async function handleTimeout(): Promise<void> {
     if (this.session) {
       this.session.destroy();
       this.session = null;
     }
     // Session will be rebuilt on next chat() call
   }
   ```
   The session is destroyed and set to `null`. The next `chat()` call detects `session === null` and creates a fresh session. The caller (`session.ts`) sees the timeout as a rejected promise and shows `⚠️ Response timed out after {n}s. Rebuilding session.` to the user.

4. **Single listener invariant**: The Python implementation had a bug where event listeners were registered on every request, causing duplicate handler invocations and session stalls. The TypeScript implementation registers listeners exactly once in the constructor. If the session is destroyed and rebuilt, listeners are registered in the `createSession()` factory method — not in `chat()`.

5. **`busy` / `done` cleanup**: The `SessionManager` wraps every `chat()` call:
   ```typescript
   async submit(text: string, callbacks: StreamCallbacks): Promise<void> {
     this.state.busy = true;
     this.state.done = Promise.withResolvers<void>();
     try {
       // ... build messages, dispatch to router ...
       const result = await runToolLoop(messages, this.provider, tools, callbacks);
       // ... append to history, update usage ...
     } finally {
       this.state.busy = false;
       this.state.done.resolve();
     }
   }
   ```
   The `finally` block guarantees cleanup regardless of success, error, or timeout. This prevents the permanent-stall bug from the Python implementation.

### 5.4 Fallback Chain

When a non-Copilot provider fails (network error, auth error, 5xx), the `SessionManager` catches the error and retries with the Copilot SDK:

```typescript
async submit(text: string, callbacks: StreamCallbacks): Promise<void> {
  // ... setup ...
  try {
    await this.dispatchToProvider(messages, tools, callbacks);
  } catch (err) {
    if (this.state.provider.provider !== 'copilot' && this.copilotAvailable) {
      callbacks.onError(err as Error);
      this.ui.displaySystem(
        `⚠️ ${this.state.provider.provider} error: ${(err as Error).message} — falling back to Copilot SDK`
      );
      this.state.provider = this.copilotConfig;
      await this.dispatchToProvider(messages, tools, callbacks);
    } else {
      throw err;
    }
  } finally {
    this.state.busy = false;
    this.state.done.resolve();
  }
}
```

Fallback only activates once — if the Copilot SDK also fails, the error propagates to the UI as a system error message. Rate limit errors (HTTP 429) are retried with exponential backoff within the provider, not via fallback.

---

## 6. Session & State

### 6.1 SessionManager Class Design

```typescript
class SessionManager {
  private state: SessionState;
  private profile: UserProfile;
  private provider: Provider;
  private copilotProvider: Provider | null;
  private registry: ToolRegistry;
  private contextBudget: ContextBudgetManager;
  private usage: UsageTracker;
  private ui: UI;

  constructor(config: {
    provider: ProviderConfig;
    profile: UserProfile;
    ui: UI;
    codingMode: boolean;
    workingDir: string | null;
    nonInteractive: boolean;
  });

  /** Primary API — called by the UI when user submits a message. */
  async submit(text: string, callbacks: StreamCallbacks): Promise<void>;

  /** Switch the active profile mid-session. */
  async switchProfile(name: string): Promise<void>;

  /** Toggle coding mode on/off. */
  toggleCodingMode(): void;

  /** Toggle shell mode on/off. */
  toggleShellMode(): void;

  /** Get current session state (for status bar). */
  getState(): Readonly<SessionState>;

  /** Clean shutdown. */
  async destroy(): Promise<void>;
}
```

### 6.2 Busy/Done Lifecycle

The `busy` flag and `done` promise form a simple state machine:

```
IDLE ──submit()──▶ BUSY ──finally──▶ IDLE
                     │
                     ├── success: response streamed, history appended
                     ├── error: error displayed, prompt retried (fallback) or abandoned
                     └── timeout: session rebuilt, error displayed
```

**Invariants**:
- `busy = true` only inside `submit()`, set before any async work
- `busy = false` only in the `finally` block of `submit()`
- `done.resolve()` only in the `finally` block of `submit()`
- No code path sets `busy = false` conditionally
- The UI checks `busy` before accepting new input — if `busy`, keystrokes are buffered

### 6.3 Conversation History Cap

Messages in `SessionState.messages` are capped to prevent unbounded growth:

| Mode | Message Cap | Tool Loop Rounds |
|------|------------|-----------------|
| Interactive | 40 messages | 10 rounds (managed by provider/SDK) |
| Non-interactive / Coding | 100 messages | 50 rounds |

When the cap is reached, the oldest messages (after the system message) are dropped. This is distinct from context budget compaction — the cap is a hard limit on array length, while compaction operates on token count.

### 6.4 Context Budget Compaction

`ContextBudgetManager` tracks token usage and triggers compaction:

```typescript
class ContextBudgetManager {
  private currentTokens: number = 0;

  /** Called after each message is added. Returns action needed. */
  checkBudget(messages: Message[]): 'ok' | 'warn' | 'compact' | 'reject';

  /** Estimate tokens for a message array. Uses JSON.stringify(messages).length / 4. */
  estimateTokens(messages: Message[]): number;

  /** Update with actual token counts from provider usage response. */
  updateActual(usage: { inputTokens: number }): void;

  /** Perform compaction: summarize middle messages, keep last 8. */
  async compact(messages: Message[]): Promise<Message[]>;

  /** Append a budget warning to a tool result string. */
  appendWarning(result: string): string;
}
```

Compaction algorithm:
1. Back up full message array to `.marvin/logs/context-backup-{ts}.jsonl`
2. Keep message[0] (system prompt) and the last 8 messages
3. Replace everything in between with a single `role: 'system'` message containing a summary: `"[Context compacted. {N} messages summarized. Earlier conversation covered: {topic list}]"`
4. The topic list is generated by scanning the dropped messages for user queries (first 100 chars of each `role: 'user'` message)
5. Reset `currentTokens` estimate based on the new array

**Concrete implementation**:

```typescript
async compact(messages: Message[]): Promise<Message[]> {
  // 1. Back up to JSONL
  const backupDir = join(process.cwd(), '.marvin', 'logs');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `context-backup-${Date.now()}.jsonl`);
  const lines = messages.map(m => JSON.stringify(m)).join('\n');
  await writeFile(backupPath, lines + '\n');

  // 2. Split: keep system prompt + last 8 messages
  const systemMsg = messages[0]; // always role: 'system'
  const keepCount = 8;
  const keptMessages = messages.slice(-keepCount);
  const droppedMessages = messages.slice(1, -keepCount);

  // 3. Generate topic list from dropped user messages
  const topics = droppedMessages
    .filter(m => m.role === 'user' && m.content)
    .map(m => m.content!.slice(0, 100).replace(/\n/g, ' '))
    .slice(0, 15); // cap at 15 topics to keep summary small
  const topicList = topics.length > 0 ? topics.join('; ') : 'various topics';

  const summaryMsg: Message = {
    role: 'system',
    content: `[Context compacted. ${droppedMessages.length} messages summarized. Earlier conversation covered: ${topicList}]`,
  };

  // 4. Reassemble: system prompt + summary + kept messages
  const compacted = [systemMsg, summaryMsg, ...keptMessages];

  // 5. Reset token estimate
  this.currentTokens = this.estimateTokens(JSON.stringify(compacted));

  return compacted;
}
```

### 6.5 Non-Interactive I/O Contract

**Stdout streaming format** (spec §7, API §8): In non-interactive mode, stdout is a raw stream of text tokens — NOT structured data. No JSON, no SSE, no length prefixes. Each read may contain partial words, full sentences, or whitespace. **Strip trailing `\n`** from each chunk written to stdout to avoid doubled newlines (the LLM generates its own newlines as content).

**Tool-call markers**: When tools are dispatched, tool names appear on stdout as `  🔧 tool1, tool2, tool3` (two leading spaces + wrench emoji) before each tool-execution round. Integrators can detect these by the `🔧` prefix and convert to "thinking" indicators.

**Stderr cost data** (spec §10, API §9): On process exit (both success and error), the last meaningful stderr line is `MARVIN_COST:{json}`. Fields: `session_cost` (float, USD), `llm_turns` (int), `model_turns` (dict of model→count), `model_cost` (dict of model→USD).

**Exit codes** (spec §13, API §14):
| Code | Meaning |
|------|---------|
| `0` | Success — prompt executed, response streamed |
| `1` | Error — missing `--prompt`, runtime exception, or LLM failure |

### 6.6 Large File Streaming Timeout Mitigation

**SHARP_EDGES §3**: When the LLM streams tool call arguments token-by-token, arguments >15KB (e.g., writing an entire file via `create_file`) can take 10+ minutes or time out entirely. The `append_file` tool exists specifically for this. Agents are instructed (in the system prompt) to write large files in sections: `create_file` for the first 2000–4000 words, then `append_file` for remaining sections.

---

## 7. Error Handling

### 7.1 Provider Fallback

When a provider call fails:

| Error Type | Action |
|-----------|--------|
| Network error (ECONNREFUSED, DNS, timeout) | Fall back to Copilot SDK, display system warning |
| Auth error (401, 403) | Fall back to Copilot SDK, display "Check API key" warning |
| Server error (500, 502, 503) | Fall back to Copilot SDK, display system warning |
| Rate limit (429) | Exponential backoff (1s, 2s, 4s), retry up to 3 times within provider, then fall back |
| Copilot SDK failure | No further fallback — display error, return to idle |

Fallback is automatic and transparent to the user. The original prompt is retried with the fallback provider — the user does not re-type anything.

### 7.2 SDK Timeout Recovery

```typescript
// In CopilotProvider
private timeoutId: ReturnType<typeof setTimeout> | null = null;

async chat(messages, tools, callbacks): Promise<ChatResult> {
  if (!this.session) {
    this.session = await this.createSession();
  }

  return new Promise((resolve, reject) => {
    this.timeoutId = setTimeout(() => {
      this.session?.destroy();
      this.session = null;
      this.timeoutId = null;
      reject(new Error(`Copilot SDK timed out after ${this.config.timeoutMs / 1000}s`));
    }, this.config.timeoutMs);

    // ... register response handling that clears timeout and resolves ...
  });
}
```

The `SessionManager` catches the timeout error, displays `⚠️ Response timed out after {n}s. Rebuilding session.` as a system message, and the next `submit()` call creates a fresh SDK session automatically. No manual intervention required.

### 7.3 Actionable Tool Errors

Every tool error returned to the LLM must be actionable. The error message must tell the LLM what went wrong and how to fix it:

| Error | Bad (opaque) | Good (actionable) |
|-------|-------------|-------------------|
| Missing field | `"Validation error"` | `"Missing required field 'path'. Usage: read_file({ path: 'src/main.ts', start_line: 1, end_line: 50 })"` |
| File too large | `"File too large"` | `"File 'data.json' is 15,232 lines (47KB). Use start_line/end_line to read a section: read_file({ path: 'data.json', start_line: 1, end_line: 100 })"` |
| Path escape | `"Invalid path"` | `"Absolute paths not allowed. Working dir: /home/user/project. Use relative paths. Directory contents:\n  src/\n  package.json\n  tsconfig.json"` |
| Unknown tool | `"Error"` | `"Unknown tool 'search_web'. Did you mean 'web_search'? Available: web_search, search_news, browse_web"` |

### 7.4 Context Overflow

When a tool result would push context past the hard limit (226K tokens):

1. For `read_file`: return an error with the file's line count and instructions to use line ranges
2. For other tools: truncate the result to fit within the remaining budget and append `"\n[Result truncated — {N} chars omitted due to context budget. Use more specific queries.]"`
3. If zero budget remains: return `"Error: Context budget exhausted (226K tokens). Call compact_history to free space, or start a new session."`

### 7.5 Per-Tool Execution Errors

Individual tool handlers can fail in tool-specific ways. All errors are caught by `execute()` (§4.4) and returned as actionable strings — they never crash the tool loop.

| Tool | Error | Response |
|------|-------|----------|
| `web_search`, `browse_web` | Network timeout (30s) | `"Error: DuckDuckGo request timed out after 30s. Try again or rephrase query."` |
| `browse_web` | `lynx` not installed | `"Error: lynx is not installed. Install with: sudo apt install lynx"` |
| `code_grep` | `rg` not installed | `"Error: ripgrep (rg) is not installed. Install with: sudo apt install ripgrep"` |
| `read_file` | File not found | `"Error: File not found: 'path'. Working dir: /path. Files:\n  src/\n  package.json"` |
| `read_file` | Permission denied | `"Error: Permission denied reading 'path'. Check file permissions."` |
| `create_file` | File already exists | `"Error: File already exists: 'path'. Use apply_patch to modify existing files."` |
| `apply_patch` | `old_str` not found | `"Error: old_str not found in 'path'. File content may have changed. Re-read the file."` |
| `run_command` | Command timeout | `"Error: Command timed out after {N}s. Consider breaking into smaller steps."` |
| `run_command` | Non-zero exit | Returns stdout+stderr with exit code. Not treated as a tool error — the LLM decides what to do. |
| `github_*` | `gh` not installed | `"Error: GitHub CLI (gh) is not installed. Install from: https://cli.github.com/"` |
| `yt_dlp_download` | `yt-dlp` not installed | `"Error: yt-dlp is not installed. Install with: pip install yt-dlp"` |
| `scrape_page` | Selenium not installed | `"Error: scrape_page requires selenium-webdriver. Use browse_web for non-JS pages."` |
| Any tool | Unexpected exception | `"Error executing '{name}': {error.message}"` (catch-all in execute()) |

---

## 8. Dependencies

### 8.1 npm Packages

```json
{
  "type": "module",
  "dependencies": {
    "@github/copilot-sdk": "^1.0",
    "zod": "^3.23",
    "zod-to-json-schema": "^3.23",
    "neo-blessed": "^0.1.81",
    "yaml": "^2.4",
    "chalk": "^5.3"
  },
  "peerDependencies": {
    "selenium-webdriver": "^4.0"
  },
  "peerDependenciesMeta": {
    "selenium-webdriver": { "optional": true }
  },
  "devDependencies": {
    "typescript": "^5.5",
    "vitest": "^2.0",
    "@types/node": "^22",
    "@types/blessed": "^0.1"
  }
}
```

**IMPORTANT: ESM configuration**. `chalk` v5+ is ESM-only. The project MUST use ESM:
- `"type": "module"` in package.json
- `"module": "nodenext"` and `"moduleResolution": "nodenext"` in tsconfig.json
- All local imports use `.js` extension: `import { foo } from './bar.js'` (TypeScript compiles `.ts` → `.js` but import paths must reference the output)
- `vitest` works natively with ESM (no configuration needed)

**Dependency rationale**:

| Package | Why | Alternatives Considered |
|---------|-----|------------------------|
| `@github/copilot-sdk` | Primary LLM provider. Required for Copilot integration. | — |
| `zod` | Runtime schema validation for all tool arguments. `safeParse()` never throws, TypeScript-first, excellent ecosystem. | `joi` (no TS inference), `yup` (less ecosystem support for JSON Schema conversion) |
| `zod-to-json-schema` | Converts Zod schemas to JSON Schema for OpenAI function-calling format. Avoids maintaining two schema definitions. | Manual conversion (error-prone for 115 tools) |
| `neo-blessed` | Terminal TUI library for the curses interface. Drop-in fork of `blessed` (unmaintained since 2017) with active maintenance. Handles raw terminal I/O, scroll regions, and mouse events. | `ink` (React-based, elegant but heavy runtime for a CLI; would require React as a dependency and JSX compilation. Consider migrating to `ink` in v2 if the blessed model proves limiting.) |
| `yaml` | Parse/stringify `prefs.yaml` files. The `yaml` package handles YAML 1.2 spec correctly. | `js-yaml` (YAML 1.1 only) |
| `chalk` | Terminal color output for plain mode. Auto-detects TTY and strips colors when piped. | `kleur` (smaller but less ecosystem support) |
| `vitest` | Test runner. Fast, TypeScript-native, compatible with Node.js ESM. | `jest` (slower, ESM support weaker) |

**CLI argument parsing**: Use `parseArgs` from `node:util` (built-in since Node 18.3). Marvin's CLI is simple enough that no external package (`commander`, `yargs`) is needed. `parseArgs` handles `--provider`, `--plain`, `--non-interactive`, `--prompt`, `--working-dir`, `--ntfy` with zero dependencies.

### 8.1.1 TypeScript Configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Node.js version requirement**: Node.js 18.3+ (for `parseArgs`, native `fetch`, `Promise.withResolvers`). `Promise.withResolvers` requires Node 22+ — for Node 18-21, use the polyfill pattern:
```typescript
function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
```

### 8.2 System Dependencies

These are NOT npm packages — they must be installed on the system:

| Tool | Used By | Required? |
|------|---------|----------|
| `rg` (ripgrep) | `code_grep` | Yes (coding mode) |
| `lynx` | `browse_web` | Yes (web browsing) |
| `gh` | `github_*` tools | Yes (GitHub tools) |
| `yt-dlp` | `yt_dlp_download` | No (graceful error if missing) |
| `geckodriver` + Firefox | `scrape_page` | No (graceful error if missing) |
| `notify-send` | Alarms, calendar reminders | No (Linux only, silent skip on macOS) |

### 8.3 External APIs (No SDK Needed)

These APIs are called directly via `fetch()` — no npm packages required:

- Open-Meteo (weather) — free, no key
- OSRM (routing) — free, no key
- DuckDuckGo (search) — free, no key
- Wikipedia (articles) — free, no key
- MusicBrainz (music) — free, no key, rate-limited
- TheMealDB (recipes) — free, no key
- Semantic Scholar (papers) — free, no key
- arXiv (papers) — free, no key
- Stack Exchange (Q&A) — free, no key (with rate limit)
- Frankfurter (currency) — free, no key
- dictionaryapi.dev (dictionary) — free, no key
- MyMemory (translation) — free, no key
- Nominatim/Overpass (OpenStreetMap) — free, no key
- ntfy.sh (push notifications) — free, no key
- OMDB, RAWG, GNews, NewsAPI, Google Places, Steam — require API keys

### 8.4 Environment Variable Reference

All environment variables consumed by Marvin, cross-referenced with spec §12 and API §12. `main.ts` reads these during bootstrap and passes them as typed config to downstream modules.

**Provider Selection**

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `copilot` | Active provider (`copilot`/`gemini`/`groq`/`ollama`/`openai`/`openai-compat`) |

**Model Configuration**

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_MODEL` | *(none)* | Override model for non-interactive mode |
| `MARVIN_CHAT_MODEL` | *(none)* | Chat model for Copilot SDK |
| `MARVIN_CODE_MODEL_HIGH` | `claude-opus-4.6` | High tier: code review, QA, plan review |
| `MARVIN_CODE_MODEL_LOW` | `gpt-5.3-codex` | Low tier: implementation, review fixes |
| `MARVIN_CODE_MODEL_PLAN` | `gpt-5.2` | Plan tier: debugging, QA fixes |
| `MARVIN_CODE_MODEL_PLAN_GEN` | `gemini-3-pro-preview` | Plan gen tier: spec, UX, architecture |
| `MARVIN_CODE_MODEL_TEST_WRITER` | `gemini-3-pro-preview` | Test writer tier: TDD test writing |
| `MARVIN_CODE_MODEL_AUX_REVIEWER` | `gpt-5.2` | Aux reviewer: parallel spec reviewers |

**Provider API Keys**

| Variable | Fallback | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | `~/.ssh/GEMINI_API_KEY` | Gemini API key |
| `GROQ_API_KEY` | `~/.ssh/GROQ_API_KEY` | Groq API key |
| `OPENAI_API_KEY` | *(none)* | OpenAI API key |
| `OPENAI_COMPAT_API_KEY` | *(none)* | OpenAI-compatible endpoint API key |

**Provider-Specific Models & URLs**

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model override |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Gemini model override |
| `OLLAMA_MODEL` | `qwen3-coder:30b` | Ollama model override |
| `OPENAI_COMPAT_MODEL` | `qwen/qwen3-32b` | OpenRouter/etc. model |
| `OPENAI_COMPAT_URL` | `https://openrouter.ai/api/v1/chat/completions` | API endpoint URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |

**External Service Keys**

| Variable | Description |
|----------|-------------|
| `GOOGLE_PLACES_API_KEY` | Google Places API key (falls back to OSM) |
| `GNEWS_API_KEY` | GNews for news search |
| `NEWSAPI_KEY` | NewsAPI.org for news |
| `STEAM_API_KEY` | Steam Web API key |
| `OMDB_API_KEY` | OMDB movie API key |
| `RAWG_API_KEY` | RAWG game API key |

**Behavior**

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_DEPTH` | `0` | Sub-agent nesting depth (auto-incremented) |
| `MARVIN_READONLY` | *(unset)* | `"1"` = read-only agent (no write tools) |
| `MARVIN_SUBAGENT_LOG` | *(none)* | Path for tool call audit JSONL |
| `MARVIN_TICKET` | *(none)* | Parent ticket ID for sub-agents |
| `MARVIN_DEBUG_ROUNDS` | `50` | Max debug loop iterations (Phase 4a) |
| `MARVIN_E2E_ROUNDS` | `10` | Max E2E smoke-test iterations (Phase 4b) |
| `MARVIN_FE_ROUNDS` | `10` | Max frontend validation iterations (Phase 4c) |
| `MARVIN_QA_ROUNDS` | `3` | Max adversarial QA iterations (Phase 5) |
| `WHISPER_MODEL` | `whisper-large-v3` | Groq Whisper model for speech-to-text |
| `EDITOR` | `nano` | Editor for opening preferences |

**Blender MCP**

| Variable | Default | Description |
|----------|---------|-------------|
| `BLENDER_MCP_HOST` | `127.0.0.1` | Blender MCP server host |
| `BLENDER_MCP_PORT` | `9876` | Blender MCP server port |

---

## 9. Testing

### 9.1 Philosophy

**No mocks. No stubs. No `jest.mock()`. No `sinon`.** All tests use real implementations.

This is a deliberate constraint from REFACTOR_PLAN.md §Key Decisions #4. The rationale: mocks test that your code calls the mock correctly, not that your code works correctly. For a tool-heavy application like Marvin, mock-based tests would just verify argument passing and miss real integration issues (API format changes, serialization bugs, path handling).

### 9.2 Testability by Design

The `ToolContext` pattern (§2) is critical for testability without mocks:

- **Tool handlers** receive all context via `ToolContext` — no module-level
  globals, no `SessionState` singletons. Tests construct a `ToolContext` with
  a temp directory and pass it directly.
- **Providers** implement the `Provider` interface — the router doesn't care
  if it's talking to a real API or a local HTTP replay server.
- **UI** implements the `UI` interface — `SessionManager` tests can use a
  minimal stub (NOT a mock — a real object implementing the interface that
  collects output in an array).
- **Context budget** operates on a `Message[]` array — pass it synthetic
  messages, check the return value.

No module in the system reads from `process.env` at call time except `main.ts`
(which reads env vars during bootstrap and passes them as config). This means
tests never need to manipulate `process.env`.

### 9.3 Test Categories

| Category | What | How |
|----------|------|-----|
| **Unit** | Pure logic: Zod schema validation, path security, token estimation, argument parsing | Direct function calls. No I/O. Fast. |
| **Integration** | Tool registration, schema conversion, tool execution pipeline | Register real tools with real Zod schemas, execute with crafted inputs. File tools use a temp directory. |
| **Provider** | OpenAI-compat streaming parser, SSE delta accumulation, tool call assembly | Tests against recorded HTTP responses (real responses saved as fixtures, replayed via a local HTTP server — NOT mocked `fetch`). |
| **E2E** | Full `submit()` → tool loop → response cycle | Requires a running LLM (Ollama with a small model, or a test API key). Skipped in CI if no provider available. |

### 9.4 Test Infrastructure

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000, // tools may be slow
  },
});
```

**File tools test pattern** — uses real filesystem with `ToolContext`, not mocks:

```typescript
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

let testDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'marvin-test-'));
  ctx = { workingDir: testDir, codingMode: true, profileDir: testDir };
});

afterEach(async () => {
  await rm(testDir, { recursive: true });
});

test('create_file creates a file', async () => {
  const result = await execute({
    id: 'call_1',
    type: 'function',
    function: { name: 'create_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'world' }) },
  }, ctx);

  expect(result).toContain('Created');
  const content = await readFile(join(testDir, 'hello.txt'), 'utf-8');
  expect(content).toBe('world');
});

test('read_file rejects absolute paths', async () => {
  const result = await execute({
    id: 'call_2',
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: '/etc/passwd' }) },
  }, ctx);

  expect(result).toContain('Absolute paths not allowed');
  expect(result).toContain(testDir); // shows working dir
});
```

**Provider test pattern** — uses a local HTTP server replaying recorded responses:

```typescript
import { createServer } from 'http';

let server: ReturnType<typeof createServer>;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    // Replay recorded SSE response
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of recordedChunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

test('parses streaming tool calls', async () => {
  const provider = new OpenAICompatProvider({
    baseUrl: `http://localhost:${port}/v1`,
    apiKey: 'test',
    model: 'test-model',
    timeoutMs: 5000,
    maxToolRounds: 1,
  });

  const result = await provider.chat(messages, tools, callbacks);
  expect(result.message.tool_calls).toHaveLength(2);
  expect(result.message.tool_calls![0].function.name).toBe('web_search');
});
```

### 9.5 What NOT to Test

- Individual external API responses (they change; test the parsing, not the fetching)
- UI rendering details (blessed layout is hard to test; test the data flow to the UI interface)
- Exact LLM output (non-deterministic; test that tool calls are dispatched and results are fed back)

---

## 10. Invariants (Implementation Checklist)

These invariants must hold across the entire codebase. Violating any of them produces the bugs documented in SHARP_EDGES.md and the Python implementation's issue history.

1. **`busy` and `done` cleanup in `finally`** — never in `if`/`else` or `catch`
2. **SDK listener registered once** — in `createSession()`, not in `chat()`
3. **`execute()` never throws** — always returns a string
4. **Tool errors are actionable** — include expected format, working dir, or directory listing
5. **`GIT_DIR` unset** — before every `child_process` call in `git.ts`
6. **No absolute paths** — file tools reject them with an error showing working dir
7. **No `..` traversal** — file tools reject them
8. **10KB file guard** — `read_file` requires line ranges on large files
9. **`arguments` is always a string** — `JSON.parse()` before Zod validation
10. **Double-parse guard** — if `JSON.parse()` yields a string, parse again
11. **Copilot session rebuild on timeout** — destroy, null, rebuild on next call
12. **Chat log roles are `"you"` / `"assistant"` / `"system"`** — NOT OpenAI roles; convert in `system-prompt.ts`
13. **Notes redirect in coding mode** — `write_note` goes to `.marvin/notes/`, not `~/Notes/`
14. **Context backup before compaction** — append-only `.marvin/logs/context-backup-{ts}.jsonl`
15. **No mocks in tests** — real implementations, real filesystem, real HTTP servers
16. **Tool handlers receive `ToolContext`** — no module-level global state, no `SessionState` singletons in tool modules
17. **`process.env` read only in `main.ts`** — all other modules receive config as constructor/function arguments
18. **Tool result truncation in router** — tool handlers return full results; the router truncates to fit context budget
19. **No stdout-to-file** — agents must use `create_file` explicitly; never capture stdout as a fallback (SHARP_EDGES.md §14)
20. **Single submission in flight** — `SessionManager.submit()` is not re-entrant; the UI enforces this via `busy` flag
21. **Ticket gating for writes** — write tools blocked until `tk create` succeeds; first `tk create` intentionally rejected (SHARP_EDGES §8)
22. **`.tickets/` directory blocked** — file tools reject direct reads/writes to `.tickets/`; agents must use the `tk` tool (spec §4.15)
23. **SDK timeout values** — 180s normal, 900s coding mode (spec §11, UX §6.2)
24. **Sub-agent `GIT_DIR` stripped** — `GIT_DIR` deleted from child process env when spawning sub-agents (SHARP_EDGES §6)
25. **Sub-agent depth bounded** — `MARVIN_DEPTH` incremented on each spawn; max depth enforced (SHARP_EDGES §12)
26. **Strip trailing `\n`** — non-interactive stdout chunks stripped of trailing newline to prevent doubled newlines (spec §7)
27. **File locking not used** — sequential execution for writers, parallel for readonly reviewers only (SHARP_EDGES §15)
28. **`apply_patch` Codex format detection** — auto-detect `*** Begin Patch` format and route through Codex patch applier (spec §9)
