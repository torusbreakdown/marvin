# Marvin — Architecture & Design

> **Version**: 1.0 (TypeScript rewrite)
> **Scope**: Interactive assistant + non-interactive sub-agent mode.
> The `--design-first` TDD pipeline is **explicitly out of scope**.

---

## 1. System Architecture

### 1.1 High-Level Components

```
User Input (CLI args / TUI / stdin)
        │
        ▼
┌── main.ts ──────────────────────────────────────────┐
│   CLI arg parsing, mode detection                    │
│   Dispatches to interactive or non-interactive path  │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
  ui/curses.ts    ui/plain.ts     non-interactive
  (blessed TUI)   (readline)      (raw stdout)
        │              │                  │
        └──────────────┼──────────────────┘
                       │
                       ▼
┌── session.ts ───────────────────────────────────────┐
│   SessionManager                                     │
│   - Provider selection & initialization              │
│   - Profile loading                                  │
│   - ntfy polling hook (every message submission)     │
│   - Coding mode state                                │
│   - busy/done lifecycle                              │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌── system-prompt.ts ─────────────────────────────────┐
│   Builds system message fresh on every request       │
│   Personality, prefs, saved places, compact history  │
│   Coding instructions, .marvin-instructions          │
│   Spec/design docs if present                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌── llm/router.ts ────────────────────────────────────┐
│   runToolLoop()                                      │
│   - Dispatches to provider (copilot.ts or openai.ts) │
│   - Intercepts tool calls, executes via registry     │
│   - Feeds results back to LLM                        │
│   - Enforces round limits (10 interactive, 50 coding)│
│   - Context budget checks via context.ts             │
│   - Streaming deltas to UI callback                  │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   llm/copilot.ts  llm/openai.ts  llm/ollama.ts
   (Copilot SDK)   (OpenAI-compat) (Ollama local)
                       │
                       ▼
┌── tools/registry.ts ────────────────────────────────┐
│   Tool registration, Zod→JSON Schema conversion      │
│   Argument fixup (string→JSON.parse)                 │
│   Dispatch to tool handlers                          │
│   Parallel execution of tool calls                   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌── tools/*.ts ───────────────────────────────────────┐
│   ~115 tools across 25+ categories                   │
│   Each tool: Zod schema + async handler → string     │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
┌── State Layer ──────────────────────────────────────┐
│   profiles/manager.ts  — Profile load/save/switch    │
│   history.ts           — Chat log persistence        │
│   usage.ts             — Cost tracking               │
│   context.ts           — Token budget management     │
└─────────────────────────────────────────────────────┘
```

### 1.2 Data Flow: Request Lifecycle

1. **User submits message** (TUI input, `--prompt` flag, or stdin)
2. **Session manager** sets `busy = true`, clears `done` event
3. **ntfy polling hook** checks subscribed topics, injects notifications as system messages
4. **System prompt builder** assembles the system message:
   - Personality/rules
   - User preferences from YAML
   - Saved places with coordinates
   - Compact history (last 20 entries, 200 chars each)
   - Coding mode instructions + `.marvin-instructions` (if coding)
   - `.marvin/spec.md`, `.marvin/design.md` (if present in working dir)
   - Background job status
5. **LLM router** dispatches to the selected provider:
   - Copilot SDK path → `copilot.ts`
   - All others → `openai.ts` (OpenAI-compatible endpoint)
   - Ollama → `ollama.ts` (local, no API key)
6. **Tool loop** (up to N rounds):
   - LLM returns tool calls → router extracts them
   - Registry dispatches each tool call (parallel within a round)
   - Tool results fed back as tool-role messages
   - Context budget checked after each round
   - If budget exceeded → compact mid-conversation
   - Repeat until LLM returns text-only or round limit reached
7. **Response streamed** to UI via `onDelta` callback
8. **Cleanup** in `finally` block: `busy = false`, `done` event set
9. **History appended** to `chat_log.json` (interactive only)
10. **Cost data** recorded (and emitted to stderr in non-interactive mode)

### 1.3 Process Model

- **Single Node.js process**, `async/await` throughout
- No worker threads needed — all I/O is async (HTTP, filesystem, child processes)
- Child processes spawned only for:
  - `run_command` tool (shell execution via `child_process.spawn`)
  - Background code review (`review_codebase` spawns a background marvin process)
  - Non-interactive sub-agent invocations by external callers
- Event loop is never blocked — long-running tools use async operations

---

## 2. Module Design

### 2.1 `src/main.ts` — Entry Point

**Exports**: `main()` (default entry point)

**Dependencies**: `session.ts`, `ui/curses.ts`, `ui/plain.ts`, `profiles/manager.ts`

**Responsibilities**:
- Parse CLI arguments: `--non-interactive`, `--prompt`, `--working-dir`, `--provider`, `--plain`, `--curses`, `--ntfy`, `--model`
- Detect operating mode (interactive vs non-interactive vs single-shot)
- Initialize the SessionManager
- Dispatch to appropriate UI (curses TUI, plain readline, or non-interactive raw stdout)
- Handle top-level errors and exit codes (0 = success, 1 = error)

**Key logic**:
```typescript
const args = parseArgs(process.argv.slice(2));

if (args.nonInteractive) {
  const prompt = args.prompt || await readStdin();
  if (!prompt) { process.stderr.write("Error: --prompt required\n"); process.exit(1); }
  await runNonInteractive(session, prompt);
} else if (args.prompt) {
  // Single-shot: launch interactive, auto-submit prompt
  await runInteractive(session, { initialPrompt: args.prompt, ui: args.plain ? 'plain' : 'curses' });
} else {
  await runInteractive(session, { ui: args.plain ? 'plain' : 'curses' });
}
```

### 2.2 `src/session.ts` — Session Manager

**Exports**: `SessionManager` class

**Dependencies**: `llm/router.ts`, `profiles/manager.ts`, `system-prompt.ts`, `history.ts`, `usage.ts`, `context.ts`, `tools/registry.ts`, `tools/ntfy.ts`

**Responsibilities**:
- Hold all session-level state (provider, profile, coding mode, working dir, busy/done)
- Coordinate message submission: build system prompt → run tool loop → stream response
- ntfy polling hook: on every message submission, check subscribed topics
- Profile switching: reload preferences, saved places, rebuild SDK session
- Coding mode toggle: adjust tool set, timeout, notes directory
- Non-interactive mode: always coding mode, auto-approve commands, 50-round limit
- Background job tracking (code review processes)
- `busy`/`done` lifecycle management with `finally` block guarantee

**Key types**:
```typescript
interface SessionConfig {
  provider: ProviderName;
  model?: string;
  workingDir?: string;
  codingMode: boolean;
  nonInteractive: boolean;
  ntfyTopic?: string;
  readonly: boolean;
  subagentLog?: string;
}

type SessionStatus = 'idle' | 'busy' | 'error';

class SessionManager {
  private status: SessionStatus = 'idle';
  private profile: UserProfile;
  private provider: LLMProvider;
  private codingMode: boolean;
  private workingDir: string | null;
  private backgroundJobs: Map<string, ChildProcess>;

  async submitMessage(text: string, onDelta: (chunk: string) => void): Promise<void>;
  async switchProfile(name: string): Promise<void>;
  toggleCodingMode(): void;
  getUsage(): UsageRecord;
}
```

### 2.3 `src/llm/router.ts` — Tool Loop & Provider Dispatch

**Exports**: `runToolLoop()`, `streamChat()`

**Dependencies**: `llm/copilot.ts`, `llm/openai.ts`, `llm/ollama.ts`, `tools/registry.ts`, `context.ts`, `usage.ts`

**Responsibilities**:
- `runToolLoop()`: the core agent loop
  - Send messages + tools to the LLM provider
  - Parse response for tool calls
  - Execute tool calls via registry (parallel within a round)
  - Feed results back, repeat
  - Enforce round limits: 10 (interactive), 50 (coding/non-interactive)
  - After max rounds, request one final text-only completion (no tools)
  - Emit `🔧 tool1, tool2` markers to the streaming callback
  - Check context budget after each round via `context.ts`
- Provider fallback: if non-Copilot provider fails, fall back to Copilot SDK
- Cost tracking: record input/output tokens per call via `usage.ts`
- Streaming: pipe deltas from provider to the UI callback

**Key types**:
```typescript
interface ToolLoopOptions {
  messages: Message[];
  tools: ToolDef[];
  provider: LLMProvider;
  maxRounds: number;
  onDelta: (chunk: string) => void;
  onToolCall: (names: string[]) => void;
  contextManager: ContextManager;
  usageTracker: UsageTracker;
}

async function runToolLoop(options: ToolLoopOptions): Promise<Message>;
```

### 2.4 `src/llm/openai.ts` — OpenAI-Compatible Provider

**Exports**: `OpenAIProvider` class implementing `LLMProvider`

**Dependencies**: `openai` npm package

**Responsibilities**:
- Shared code path for Gemini, Groq, OpenAI, and OpenAI-compat providers
- Construct the correct base URL and headers per provider
- Stream chat completions via the OpenAI SDK with `stream: true`
- Parse streaming chunks for content deltas and tool calls
- Handle provider-specific quirks:
  - Gemini: tool call response format differences
  - Groq: fast inference, standard OpenAI format
  - OpenAI-compat: configurable endpoint URL
- API key resolution with fallback to `~/.ssh/` files
- Rate limit handling: detect 429, wait, retry

**Key types**:
```typescript
interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: ProviderName;
}

class OpenAIProvider implements LLMProvider {
  async chat(messages: Message[], tools: ToolDef[], onDelta: (chunk: string) => void): Promise<LLMResponse>;
}
```

### 2.5 `src/llm/copilot.ts` — Copilot SDK Provider

**Exports**: `CopilotProvider` class implementing `LLMProvider`

**Dependencies**: `@anthropic-ai/sdk` or `@github/copilot-sdk` (whichever is the actual package)

**Responsibilities**:
- Manage Copilot SDK session lifecycle
- **Single listener per session**: register `on_delta`, `on_message`, `on_idle` handlers ONCE at session creation, not per request
- **Timeout recovery**: 180s normal, 900s coding mode
  - On timeout: destroy session, set `done`, clear `busy`, null the session reference
  - Next request creates a fresh session transparently
  - User sees: `⚠️ Response timed out after {n}s. Rebuilding session.`
- **Session rebuild on profile switch**: destroy old session, create new one with updated system message
- Tool call interception via SDK hooks
- Streaming via `on_delta` callback
- The SDK manages its own tool loop internally (unlike the manual loop in openai.ts)

**Critical implementation details**:
```typescript
class CopilotProvider implements LLMProvider {
  private session: CopilotSession | null = null;
  private listenerRegistered = false;

  private async ensureSession(): Promise<CopilotSession> {
    if (!this.session) {
      this.session = await createCopilotSession(this.config);
      this.registerListeners(); // ONCE per session
    }
    return this.session;
  }

  private registerListeners(): void {
    if (this.listenerRegistered) return;
    this.session!.on('delta', this.handleDelta);
    this.session!.on('message', this.handleMessage);
    this.session!.on('idle', this.handleIdle);
    this.listenerRegistered = true;
  }

  async destroySession(): Promise<void> {
    if (this.session) {
      this.session.destroy();
      this.session = null;
      this.listenerRegistered = false;
    }
  }
}
```

### 2.6 `src/llm/ollama.ts` — Ollama Local Provider

**Exports**: `OllamaProvider` class implementing `LLMProvider`

**Dependencies**: `ollama` npm package (or raw HTTP to Ollama API)

**Responsibilities**:
- Connect to local Ollama server (default `http://localhost:11434`)
- Stream chat completions
- Handle tool calls (Ollama supports OpenAI-compatible tool calling)
- Model override via `OLLAMA_MODEL` env var (default `qwen3-coder:30b`)
- No API key needed

### 2.7 `src/tools/registry.ts` — Tool Registry

**Exports**: `ToolRegistry` class, `defineTool()` helper, `ToolDef` type

**Dependencies**: `zod`, `zod-to-json-schema`

**Responsibilities**:
- Register tools with name, description, Zod parameter schema, and async handler
- Auto-convert Zod schemas to OpenAI-format JSON Schema for LLM tool definitions
- **Argument fixup wrapper**: every tool handler is wrapped to:
  1. Check if `arguments` is a string → try `JSON.parse()`
  2. If parse fails → return helpful error with expected format
  3. Validate parsed args against Zod schema
  4. On validation failure → return actionable error with field names and examples
- Tool dispatch: look up tool by name, execute handler, return result string
- Parallel execution: execute multiple tool calls from a single LLM response concurrently via `Promise.all()`
- Tool subsetting: filter tools by mode (interactive, coding, readonly)
- Timeout enforcement per tool call (default 60s for shell, 30s for web, etc.)
- `apply_patch` special handling: detect `*** Begin Patch` Codex format and route accordingly

**Key types**:
```typescript
interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType<any>;
  handler: (args: any) => Promise<string>;
  codingOnly?: boolean;
  writeOp?: boolean;  // stripped when MARVIN_READONLY=1
}

class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(tool: ToolDef): void;
  getAll(mode: ToolMode): ToolDef[];
  getSchemas(mode: ToolMode): OpenAIToolSchema[];
  async execute(name: string, args: unknown): Promise<string>;
  async executeParallel(calls: ToolCall[]): Promise<ToolResult[]>;
}
```

**Zod→JSON Schema conversion**:
```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';

function toolToOpenAISchema(tool: ToolDef): OpenAIToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters, { target: 'openAi' }),
    },
  };
}
```

### 2.8 Tool Categories

Each tool file exports an array of `ToolDef` objects. Below is the complete list.

#### `src/tools/location.ts`
**Tools**: `get_my_location`, `places_text_search`, `places_nearby_search`, `setup_google_auth`
**Dependencies**: CoreLocation (macOS) or GeoClue (Linux) via child process, Google Places API or OSM fallback
**Key detail**: `get_my_location` tries platform-specific location services first, falls back to IP geolocation

#### `src/tools/places.ts`
**Tools**: `save_place`, `remove_place`, `list_places`
**Dependencies**: `profiles/manager.ts` (reads/writes `saved_places.json`)

#### `src/tools/travel.ts`
**Tools**: `estimate_travel_time`, `get_directions`, `estimate_traffic_adjusted_time`
**Dependencies**: OSRM routing API (free, no key), Open-Meteo for weather adjustment

#### `src/tools/weather.ts`
**Tools**: `weather_forecast`
**Dependencies**: Open-Meteo API (free, no API key)

#### `src/tools/web.ts`
**Tools**: `web_search`, `search_news`, `browse_web`, `scrape_page`
**Dependencies**: DuckDuckGo (no key), GNews (`GNEWS_API_KEY`), NewsAPI (`NEWSAPI_KEY`), Lynx (text browser), Selenium + Firefox for `scrape_page`

#### `src/tools/media.ts`
**Tools**: `search_movies`, `get_movie_details`, `search_games`, `get_game_details`
**Dependencies**: OMDB (`OMDB_API_KEY`, falls back to DDG), RAWG (`RAWG_API_KEY`, falls back to DDG)

#### `src/tools/steam.ts`
**Tools**: `steam_search`, `steam_app_details`, `steam_featured`, `steam_player_stats`, `steam_user_games`, `steam_user_summary`
**Dependencies**: Steam Web API (some tools need `STEAM_API_KEY`, search/details/featured do not)

#### `src/tools/music.ts`
**Tools**: `music_search`, `music_lookup`
**Dependencies**: MusicBrainz API (free, no key)

#### `src/tools/recipes.ts`
**Tools**: `recipe_search`, `recipe_lookup`
**Dependencies**: TheMealDB API (free, no key)

#### `src/tools/notes.ts`
**Tools**: `write_note`, `read_note`, `notes_ls`, `notes_mkdir`, `search_notes`
**Dependencies**: Filesystem
**Key detail**: Notes directory is `~/Notes/` in interactive mode, `.marvin/notes/` in coding mode

#### `src/tools/files.ts` (Coding Mode Only)
**Tools**: `read_file`, `create_file`, `append_file`, `apply_patch`
**Dependencies**: Filesystem
**Key details**:
- All paths relative to working directory
- Path sandboxing: reject absolute paths, `..`, `.tickets/`
- `read_file` 10KB guard: reject without `start_line`/`end_line`
- `apply_patch`: detect Codex `*** Begin Patch` format automatically
- `create_file` fails if file exists (use `apply_patch` to edit)
- Error messages include working dir + directory tree listing
- `writeOp: true` — stripped when `MARVIN_READONLY=1`

#### `src/tools/files-notes.ts` (Non-Coding Mode)
**Tools**: `file_read_lines`, `file_apply_patch`
**Dependencies**: Filesystem
**Key detail**: Restricted to `~/Notes/` directory only. `file_apply_patch` supports unified-diff hunks and REPLACE/INSERT/DELETE commands.

#### `src/tools/coding.ts`
**Tools**: `set_working_dir`, `get_working_dir`, `code_grep`, `tree`, `review_codebase`, `review_status`
**Dependencies**: `ripgrep` CLI for `code_grep`, filesystem for `tree`
**Key details**:
- `tree` respects `.gitignore` by default
- `review_codebase` spawns a background marvin process (`child_process.spawn` with detached)
- `review_status` checks if background review is still running

#### `src/tools/git.ts`
**Tools**: `git_status`, `git_diff`, `git_commit`, `git_log`, `git_blame`, `git_branch`, `git_checkout`
**Dependencies**: `git` CLI via `child_process.execFile`
**Key details**:
- **Always unset `GIT_DIR`** before operations (parent contamination prevention)
- `git_commit` and `git_checkout` are `writeOp: true`
- `git_commit` stages all by default (`add_all: true`)

#### `src/tools/shell.ts`
**Tools**: `run_command`
**Dependencies**: `child_process.spawn`
**Key details**:
- Interactive mode: requires user confirmation (callback to UI)
- Non-interactive mode: auto-approved
- `timeout` parameter (default 60s)
- `writeOp: true`

#### `src/tools/github.ts`
**Tools**: `github_search`, `github_clone`, `github_read_file`, `github_grep`
**Dependencies**: `gh` CLI
**Key detail**: Clones to `~/github-clones/<owner>/<repo>`

#### `src/tools/calendar.ts`
**Tools**: `calendar_add_event`, `calendar_delete_event`, `calendar_view`, `calendar_list_upcoming`
**Dependencies**: `.ics` file handling, cron for reminders
**Key detail**: Auto-schedules cron reminders (1h and 30m before) via desktop notification and ntfy.sh

#### `src/tools/wiki.ts`
**Tools**: `wiki_search`, `wiki_summary`, `wiki_full`, `wiki_grep`
**Dependencies**: Wikipedia API
**Key detail**: `wiki_full` saves to disk, does NOT return content in context. Use `wiki_grep` to search saved articles.

#### `src/tools/academic.ts`
**Tools**: `search_papers`, `search_arxiv`
**Dependencies**: Semantic Scholar API, arXiv API (both free, no key)

#### `src/tools/system.ts`
**Tools**: `exit_app`, `system_info`, `get_usage`
**Dependencies**: `os` module, `usage.ts`

#### `src/tools/alarms.ts`
**Tools**: `set_alarm`, `list_alarms`, `cancel_alarm`
**Dependencies**: cron, `notify-send` (Linux), ntfy.sh

#### `src/tools/timers.ts`
**Tools**: `timer_start`, `timer_check`, `timer_stop`
**Dependencies**: In-memory timer state (Map of timer name → start time + duration)

#### `src/tools/ntfy.ts`
**Tools**: `generate_ntfy_topic`, `ntfy_subscribe`, `ntfy_unsubscribe`, `ntfy_publish`, `ntfy_list`
**Dependencies**: ntfy.sh HTTP API
**Key detail**: Also exports `pollSubscriptions()` — called by session manager on every message submission (NOT a tool call, a session-level hook)

#### `src/tools/spotify.ts`
**Tools**: `spotify_auth`, `spotify_search`, `spotify_create_playlist`, `spotify_add_tracks`
**Dependencies**: Spotify Web API, OAuth flow with local callback server

#### `src/tools/maps.ts`
**Tools**: `osm_search`, `overpass_query`
**Dependencies**: OpenStreetMap Nominatim, Overpass API

#### `src/tools/stack.ts`
**Tools**: `stack_search`, `stack_answers`
**Dependencies**: Stack Exchange API (free, no key)

#### `src/tools/tickets.ts`
**Tools**: `create_ticket`, `ticket_start`, `ticket_close`, `ticket_add_note`, `ticket_show`, `ticket_list`, `ticket_dep_tree`, `ticket_add_dep`
**Dependencies**: `tk` CLI (or native implementation wrapping `.tickets/` directory)
**Key detail**: These are the non-coding-mode personal task tracking tools. The coding-mode `tk` tool (which wraps the `tk` CLI with first-rejection gating) is **excluded** from scope.

#### `src/tools/bookmarks.ts`
**Tools**: `bookmark_save`, `bookmark_list`, `bookmark_search`
**Dependencies**: JSON file storage in profile directory

#### `src/tools/downloads.ts`
**Tools**: `download_file`, `yt_dlp_download`
**Dependencies**: HTTP, `yt-dlp` CLI
**Key detail**: Downloads to `~/Downloads/`

#### `src/tools/utilities.ts`
**Tools**: `convert_units`, `dictionary_lookup`, `translate_text`, `read_rss`
**Dependencies**: Frankfurter API (currency), dictionaryapi.dev, MyMemory translation API, RSS/Atom parsing

### 2.9 `src/ui/curses.ts` — Blessed TUI

**Exports**: `CursesUI` class

**Dependencies**: `blessed` (or `neo-blessed`), `session.ts`

**Responsibilities**:
- Full-terminal interface: status bar, scrollable chat area, input box
- Status bar: provider emoji, model name, profile, message count, usage, mode flags
- Chat area: colored messages (cyan=you, green=assistant, yellow=system, magenta=tools)
- Streaming: character-by-character rendering of assistant responses
- Tool call display: `🔧 tool1, tool2` lines with elapsed time for long tools
- Input handling: readline-style editing, history (up/down), paste (newline stripping)
- Keyboard shortcuts: PgUp/PgDn scroll, Ctrl+C cancel, Ctrl+Q/Ctrl+D quit
- Slash command interception before LLM dispatch
- Shell mode prompt: `$ ` instead of `> `
- Shell command confirmation flow for coding mode
- Auto-scroll to bottom on new messages; stop if user scrolled up

### 2.10 `src/ui/plain.ts` — Plain Readline UI

**Exports**: `PlainUI` class

**Dependencies**: Node.js `readline`, `session.ts`

**Responsibilities**:
- Linear output to stdout (no cursor positioning)
- Streaming tokens printed inline
- Tool calls: `  🔧 tool1, tool2` before response
- `readline` interface with history support (shared history file with curses)
- System messages: `[System] message text`
- ANSI colors when stdout is TTY, omitted when piped
- All slash commands work identically to curses
- Feature parity with curses (different presentation, same functionality)

### 2.11 `src/profiles/manager.ts` — Profile Manager

**Exports**: `ProfileManager` class, `UserProfile` type

**Dependencies**: `js-yaml`, filesystem

**Responsibilities**:
- Load/save profiles from `~/.config/local-finder/profiles/{name}/`
- Track active profile in `~/.config/local-finder/last_profile`
- Load preferences from `preferences.yaml`
- Load/save `saved_places.json`, `tokens.json`, `ntfy_subscriptions.json`
- Create new profiles with defaults
- Switch profiles: update last_profile, reload all state

**Key types**:
```typescript
interface UserProfile {
  name: string;
  preferences: UserPreferences;
  savedPlaces: SavedPlace[];
  chatLogPath: string;
  historyPath: string;
  tokensPath: string;
  ntfySubscriptions: NtfySubscription[];
}

interface UserPreferences {
  dietary: string[];
  spice_tolerance: string;
  favorite_cuisines: string[];
  avoid_cuisines: string[];
  has_car: boolean;
  max_distance_km: number;
  budget: string;
  accessibility: string;
  notes: string;
}

interface SavedPlace {
  label: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  lat: number;
  lng: number;
  notes: string;
}
```

### 2.12 `src/profiles/prefs.ts` — Preferences

**Exports**: `loadPreferences()`, `savePreferences()`, `updatePreference()`

**Dependencies**: `js-yaml`, filesystem

**Responsibilities**:
- Read/write `preferences.yaml`
- `update_preferences` tool handler: set/add/remove preference values

### 2.13 `src/history.ts` — Chat History

**Exports**: `ChatHistory` class

**Dependencies**: filesystem

**Responsibilities**:
- Load/save `chat_log.json`
- Append new entries with role, text, time
- **Role values**: `"you"`, `"assistant"`, `"system"` (NOT OpenAI standard)
- Seed last 20 entries as LLM messages (interactive mode only)
- Compact history: summarize older messages, keep last 8 recent
- Backup before compaction to `.marvin/logs/context-backup-{ts}.jsonl`
- `search_history_backups`: search through compacted/dropped history

**Key types**:
```typescript
interface ChatLogEntry {
  role: 'you' | 'assistant' | 'system';
  text: string;
  time: string;  // HH:MM format
}

class ChatHistory {
  async load(profilePath: string): Promise<ChatLogEntry[]>;
  async append(entry: ChatLogEntry): Promise<void>;
  async save(): Promise<void>;
  seedMessages(entries: ChatLogEntry[]): Message[];  // Convert to LLM format
  async compact(targetTokens: number): Promise<void>;
  async searchBackups(query: string): Promise<ChatLogEntry[]>;
}
```

### 2.14 `src/usage.ts` — Cost Tracking

**Exports**: `UsageTracker` class

**Dependencies**: filesystem

**Responsibilities**:
- Track per-provider, per-model input/output token counts
- Track per-tool call counts
- Estimate costs using per-model pricing tables
- Session costs and lifetime costs
- Lifetime stats persisted to `~/.config/local-finder/usage.json`
- `get_usage` tool returns session + optional lifetime stats
- Non-interactive mode: emit `MARVIN_COST:{json}` to stderr on exit

**Key types**:
```typescript
interface UsageRecord {
  session_cost: number;
  llm_turns: number;
  model_turns: Record<string, number>;
  model_cost: Record<string, number>;
  input_tokens: Record<string, number>;
  output_tokens: Record<string, number>;
  tool_calls: Record<string, number>;
}

class UsageTracker {
  recordLLMCall(model: string, inputTokens: number, outputTokens: number): void;
  recordToolCall(toolName: string): void;
  getSessionUsage(): UsageRecord;
  getLifetimeUsage(): UsageRecord;
  async persistLifetime(): Promise<void>;
  emitCostToStderr(): void;  // MARVIN_COST:{json}
}
```

### 2.15 `src/system-prompt.ts` — System Message Builder

**Exports**: `buildSystemMessage()`

**Dependencies**: `profiles/manager.ts`, `history.ts`, `context.ts`

**Responsibilities**:
- Assemble the complete system message, built fresh on every request
- Sections:
  1. Personality & rules ("You are Marvin, a helpful local-business and general-purpose assistant...")
  2. User preferences from YAML
  3. Active profile name
  4. Saved places with labels, addresses, coordinates
  5. Compact conversation history (last 20 entries, 200 chars each)
  6. Coding mode instructions (when `--working-dir` is set)
  7. Background job status (if any running)
  8. `.marvin-instructions` / `.marvin/instructions.md` / `~/.marvin/instructions/<path>.md`
  9. `.marvin/spec.md`, `.marvin/ux.md`, `.marvin/design.md` if present in working dir

**Key signature**:
```typescript
function buildSystemMessage(params: {
  profile: UserProfile;
  history: ChatLogEntry[];
  codingMode: boolean;
  workingDir: string | null;
  backgroundJobs: Map<string, { status: string }>;
}): string;
```

### 2.16 `src/context.ts` — Context Budget Manager

**Exports**: `ContextManager` class

**Dependencies**: `tiktoken` (or equivalent token counter)

**Responsibilities**:
- Track current context size in tokens
- Three thresholds:
  - **Warn** (180,000 tokens): append budget warning to tool results
  - **Compact** (200,000 tokens): trigger mid-conversation compaction
  - **Hard limit** (226,000 tokens): reject large file reads
- `read_file` budget gate: if adding result would push past warn, truncate to fit
- Compaction: summarize middle messages, keep first (system) and last 8 messages
- Backup context to `.marvin/logs/context-backup-{ts}.jsonl` before compaction
- Transparent to tools — the router calls context checks, not individual tools

**Key types**:
```typescript
interface ContextBudget {
  warnThreshold: number;   // 180_000
  compactThreshold: number; // 200_000
  hardLimit: number;        // 226_000
}

class ContextManager {
  countTokens(messages: Message[]): number;
  checkBudget(messages: Message[]): 'ok' | 'warn' | 'compact' | 'reject';
  async compactMessages(messages: Message[]): Promise<Message[]>;
  truncateToolResult(result: string, availableTokens: number): string;
}
```

---

## 3. Key Interfaces & Types

All core types are defined here. Tool modules, providers, and the session manager all depend on these.

### 3.1 Message Types (LLM Conversation)

```typescript
// Internal LLM message format (OpenAI-style)
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCall {
  id: string;           // Unique ID for this tool call (provider-generated)
  type: 'function';
  function: {
    name: string;       // Tool name, e.g. "web_search"
    arguments: string;  // JSON string of arguments
  };
}

interface ToolResult {
  tool_call_id: string;
  content: string;      // String result from tool execution
}
```

### 3.2 Tool Definition

```typescript
import { z } from 'zod';

interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType<any>;
  handler: (args: any, context: ToolContext) => Promise<string>;
  codingOnly?: boolean;    // Only available in coding mode
  writeOp?: boolean;       // Stripped when MARVIN_READONLY=1
  interactiveOnly?: boolean; // Not available in non-interactive mode
}

interface ToolContext {
  workingDir: string | null;
  codingMode: boolean;
  nonInteractive: boolean;
  profile: UserProfile;
  confirmCommand?: (command: string) => Promise<boolean>; // UI callback
}

// OpenAI-format tool schema for LLM
interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema from Zod
  };
}
```

### 3.3 Provider Interface

```typescript
type ProviderName = 'copilot' | 'gemini' | 'groq' | 'openai' | 'ollama' | 'openai-compat';

interface ProviderConfig {
  name: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeout: number;        // 180s normal, 900s coding mode
}

interface LLMResponse {
  content: string | null;
  tool_calls: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  model: string;
  finish_reason: 'stop' | 'tool_calls' | 'length';
}

interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;

  chat(
    messages: Message[],
    tools: OpenAIToolSchema[],
    onDelta: (chunk: string) => void,
  ): Promise<LLMResponse>;

  destroy(): Promise<void>;
}
```

### 3.4 Provider Configuration Table

```typescript
const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; baseUrl?: string; envKey?: string; envFallback?: string }> = {
  copilot:       { model: 'claude-haiku-4.5' },
  gemini:        { model: 'gemini-3-pro-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', envKey: 'GEMINI_API_KEY', envFallback: '~/.ssh/GEMINI_API_KEY' },
  groq:          { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', envFallback: '~/.ssh/GROQ_API_KEY' },
  openai:        { model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
  ollama:        { model: 'qwen3-coder:30b', baseUrl: 'http://localhost:11434' },
  'openai-compat': { model: 'qwen/qwen3-32b', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENAI_COMPAT_API_KEY' },
};
```

### 3.5 Session State

```typescript
interface SessionState {
  status: 'idle' | 'busy' | 'error';
  provider: LLMProvider;
  profile: UserProfile;
  codingMode: boolean;
  shellMode: boolean;
  workingDir: string | null;
  nonInteractive: boolean;
  readonly: boolean;
  messages: Message[];        // Current conversation (LLM format)
  backgroundJobs: Map<string, BackgroundJob>;
  ntfySubscriptions: NtfySubscription[];
}

interface BackgroundJob {
  id: string;
  type: 'code_review';
  pid: number;
  startTime: Date;
  status: 'running' | 'completed' | 'failed';
  result?: string;
}
```

### 3.6 User Profile

```typescript
interface UserProfile {
  name: string;
  profileDir: string;       // ~/.config/local-finder/profiles/{name}/
  preferences: UserPreferences;
  savedPlaces: SavedPlace[];
  ntfySubscriptions: NtfySubscription[];
}

interface UserPreferences {
  dietary: string[];
  spice_tolerance: string;
  favorite_cuisines: string[];
  avoid_cuisines: string[];
  has_car: boolean;
  max_distance_km: number;
  budget: string;
  accessibility: string;
  notes: string;
}

interface SavedPlace {
  label: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  lat: number;
  lng: number;
  notes: string;
}

interface NtfySubscription {
  topic: string;
  label: string;
  subscribedAt: string;  // ISO timestamp
  lastChecked?: string;  // ISO timestamp
}
```

### 3.7 Usage Record

```typescript
interface UsageRecord {
  session_cost: number;                    // Total USD for this session
  llm_turns: number;                       // Total LLM roundtrips
  model_turns: Record<string, number>;     // model → turn count
  model_cost: Record<string, number>;      // model → USD
  input_tokens: Record<string, number>;    // model → input token count
  output_tokens: Record<string, number>;   // model → output token count
  tool_calls: Record<string, number>;      // tool name → call count
}

// Emitted to stderr as MARVIN_COST:{json} in non-interactive mode
interface MarvinCostOutput {
  session_cost: number;
  llm_turns: number;
  model_turns: Record<string, number>;
  model_cost: Record<string, number>;
}
```

### 3.8 Chat Log Entry (Disk Format)

```typescript
// Stored in chat_log.json — NOT the same as LLM Message format
interface ChatLogEntry {
  role: 'you' | 'assistant' | 'system';  // NOT OpenAI standard
  text: string;
  time: string;  // "HH:MM" format
}
```

### 3.9 Shared UI Types

```typescript
interface UIMessage {
  role: 'you' | 'assistant' | 'system';
  text: string;
  time: string;
  toolNames?: string[];  // Tools called in this response
}

interface UICallbacks {
  onDelta: (chunk: string) => void;
  onToolCall: (names: string[]) => void;
  onSystemMessage: (text: string) => void;
  onError: (error: string) => void;
  confirmCommand: (command: string) => Promise<boolean>;
  onStreamStart: () => void;
  onStreamEnd: () => void;
}
```

---

## 4. Tool System Design

### 4.1 Registration

Tools are registered at startup by importing all tool modules and calling `registry.register()`:

```typescript
// src/tools/index.ts
import { ToolRegistry } from './registry';
import { locationTools } from './location';
import { placesTools } from './places';
import { webTools } from './web';
// ... all other tool modules

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    ...locationTools,
    ...placesTools,
    ...webTools,
    // ... all tool arrays
  ]) {
    registry.register(tool);
  }
  return registry;
}
```

### 4.2 Zod → OpenAI Schema Conversion

Every tool defines its parameters as a Zod schema. The registry converts these to OpenAI-format JSON Schema:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Example tool definition
const WebSearchParams = z.object({
  query: z.string().describe('The search query'),
  max_results: z.number().int().min(1).max(20).default(5).describe('Maximum results'),
  time_filter: z.enum(['', 'd', 'w', 'm', 'y']).default('').describe('Time filter'),
});

const webSearchTool: ToolDef = {
  name: 'web_search',
  description: 'Search the web using DuckDuckGo...',
  parameters: WebSearchParams,
  handler: async (args) => { /* ... */ },
};

// Conversion (done by registry)
const schema = zodToJsonSchema(WebSearchParams, { target: 'openAi' });
// → { type: 'object', properties: { query: { type: 'string' }, ... }, required: ['query'] }
```

### 4.3 Argument Validation & Fixup

The registry wraps every tool handler with argument fixup logic:

```typescript
async function executeWithFixup(tool: ToolDef, rawArgs: unknown): Promise<string> {
  let args = rawArgs;

  // Step 1: String fixup
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed;
      }
    } catch {
      // Check for Codex patch format
      if (tool.name === 'apply_patch' && typeof args === 'string' && args.includes('*** Begin Patch')) {
        return await handleCodexPatch(args);
      }
      return `Error: Arguments must be a JSON object, not a raw string.\n` +
             `Expected format: ${JSON.stringify(Object.fromEntries(
               Object.entries(tool.parameters.shape || {}).map(([k, v]) => [k, typeof v])
             ))}\n` +
             `Received: ${(args as string).substring(0, 200)}`;
    }
  }

  // Step 2: Zod validation
  const result = tool.parameters.safeParse(args);
  if (!result.success) {
    const errors = result.error.issues.map(i =>
      `  - ${i.path.join('.')}: ${i.message}`
    ).join('\n');
    return `Validation error for ${tool.name}:\n${errors}\n\n` +
           `Expected parameters:\n${describeSchema(tool.parameters)}`;
  }

  // Step 3: Execute
  return await tool.handler(result.data);
}
```

### 4.4 Parallel Execution

When the LLM returns multiple tool calls in a single response, they are executed in parallel:

```typescript
async function executeParallel(calls: ToolCall[]): Promise<ToolResult[]> {
  const results = await Promise.all(
    calls.map(async (call) => {
      const result = await registry.execute(call.function.name, JSON.parse(call.function.arguments));
      return { tool_call_id: call.id, content: result };
    })
  );
  return results;
}
```

### 4.5 Timeout

Each tool category has a default timeout. The `run_command` tool also accepts a user-specified timeout:

```typescript
async function executeWithTimeout(tool: ToolDef, args: any, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await tool.handler(args, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return `Tool ${tool.name} timed out after ${timeoutMs / 1000}s`;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

### 4.6 Path Sandboxing

All file tools in coding mode enforce path security:

```typescript
function validatePath(inputPath: string, workingDir: string): string {
  // Reject absolute paths
  if (path.isAbsolute(inputPath)) {
    throw new PathSecurityError(
      `Absolute paths not allowed. Working dir: ${workingDir}\n` +
      `Use relative paths like 'src/main.ts'\n\n` +
      `Project structure:\n${getTreeListing(workingDir)}`
    );
  }

  // Reject .. traversal
  const resolved = path.resolve(workingDir, inputPath);
  if (!resolved.startsWith(workingDir)) {
    throw new PathSecurityError(
      `Path traversal not allowed: ${inputPath}\n` +
      `Working dir: ${workingDir}\n\n` +
      `Project structure:\n${getTreeListing(workingDir)}`
    );
  }

  // Reject .tickets/ access
  if (inputPath.startsWith('.tickets/') || inputPath === '.tickets') {
    throw new PathSecurityError(
      'Direct access to .tickets/ is not allowed. Use the ticket tools instead.'
    );
  }

  return resolved;
}
```

### 4.7 Context Budget Management (File Reads)

The `read_file` tool integrates with the context budget:

```typescript
async function readFileHandler(args: ReadFileArgs, context: ToolContext): Promise<string> {
  const filePath = validatePath(args.path, context.workingDir!);
  const stats = await fs.stat(filePath);

  // 10KB guard
  if (stats.size > 10_240 && !args.start_line && !args.end_line) {
    const lineCount = (await fs.readFile(filePath, 'utf8')).split('\n').length;
    return `File is ${(stats.size / 1024).toFixed(1)}KB (${lineCount} lines) — too large to read entirely.\n` +
           `Use start_line and end_line to read a section:\n` +
           `  read_file({path: "${args.path}", start_line: 1, end_line: 50})\n` +
           `Total lines: ${lineCount}`;
  }

  let content: string;
  if (args.start_line || args.end_line) {
    const lines = (await fs.readFile(filePath, 'utf8')).split('\n');
    const start = (args.start_line || 1) - 1;
    const end = args.end_line || lines.length;
    content = lines.slice(start, end)
      .map((line, i) => `${start + i + 1}. ${line}`)
      .join('\n');
  } else {
    content = await fs.readFile(filePath, 'utf8');
  }

  // Budget gate: truncate if would exceed warn threshold
  const tokenCount = estimateTokens(content);
  const available = context.contextManager.availableTokens();
  if (tokenCount > available) {
    content = context.contextManager.truncateToolResult(content, available);
    content += `\n\n[Truncated to fit context budget. ${tokenCount} tokens → ${available} tokens]`;
  }

  return content;
}
```

### 4.8 Tool Mode Filtering

```typescript
type ToolMode = 'interactive' | 'coding' | 'readonly' | 'non-interactive';

function getToolsForMode(registry: ToolRegistry, mode: ToolMode): ToolDef[] {
  let tools = registry.getAll();

  if (mode === 'readonly') {
    tools = tools.filter(t => !t.writeOp);
  }

  if (mode === 'interactive' || mode === 'non-interactive') {
    // All tools available in both modes
    // Non-interactive always has coding mode enabled
  }

  // Note: coding-only tools are always included when codingMode is true
  // The session manager sets codingMode=true for non-interactive mode

  return tools;
}
```

---

## 5. Provider Architecture

### 5.1 Provider Interface

All providers implement the `LLMProvider` interface:

```typescript
interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;

  chat(
    messages: Message[],
    tools: OpenAIToolSchema[],
    onDelta: (chunk: string) => void,
  ): Promise<LLMResponse>;

  destroy(): Promise<void>;
}
```

### 5.2 Streaming

All providers stream responses:

- **OpenAI-compat path** (Gemini, Groq, OpenAI, OpenAI-compat): Use the OpenAI SDK with `stream: true`. Parse `ChatCompletionChunk` objects. Content deltas are forwarded to `onDelta`. Tool call deltas are accumulated until complete.

- **Copilot SDK path**: The SDK provides its own streaming interface via event callbacks (`on_delta`, `on_message`, `on_idle`). These are adapted to the `onDelta` callback.

- **Ollama**: Uses the Ollama API's streaming endpoint. Chunks are parsed and forwarded to `onDelta`.

### 5.3 Copilot SDK Lifecycle

The Copilot SDK requires careful lifecycle management:

```
Session Creation
      │
      ▼
Register Listeners ONCE ─────────────────┐
  on_delta: forward to UI                 │
  on_message: mark response complete      │  Listeners persist
  on_idle: session ready for next prompt   │  for session lifetime
      │                                    │
      ▼                                    │
Send Message ←────────────────────────────┘
      │
      ├── Success: response streamed
      │
      ├── Timeout (180s/900s):
      │     destroy session
      │     null session reference
      │     clear busy, set done
      │     next request → fresh session
      │
      └── Error:
            log error
            fall back to retry or alternate provider
```

**Critical rules**:
1. Listener registered **once per session**, not per request (duplicate listeners cause duplicate responses)
2. On timeout: **destroy + null** the session (not just reset). Next request gets a fresh session.
3. Session rebuild is transparent to the user except for a system message
4. Profile switch requires session destroy + rebuild (new system message)

### 5.4 OpenAI-Compatible Shared Path

Gemini, Groq, OpenAI, and OpenAI-compat all use the same `OpenAIProvider` class with different configurations:

```typescript
function createProvider(name: ProviderName): LLMProvider {
  if (name === 'copilot') return new CopilotProvider(config);
  if (name === 'ollama') return new OllamaProvider(config);

  // All others use OpenAI-compat path
  const defaults = PROVIDER_DEFAULTS[name];
  const apiKey = resolveApiKey(defaults.envKey, defaults.envFallback);
  const model = process.env[`${name.toUpperCase()}_MODEL`] || defaults.model;
  const baseUrl = process.env[`${name.toUpperCase()}_URL`] || defaults.baseUrl;

  return new OpenAIProvider({
    apiKey,
    baseUrl: baseUrl!,
    model,
    providerName: name,
  });
}
```

### 5.5 API Key Resolution

```typescript
function resolveApiKey(envVar?: string, fallbackPath?: string): string | undefined {
  if (!envVar) return undefined;
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  if (fallbackPath) {
    const expanded = fallbackPath.replace('~', os.homedir());
    try {
      return fs.readFileSync(expanded, 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
```

### 5.6 Fallback Chain

When a non-Copilot provider fails, the router falls back to Copilot SDK:

```typescript
async function chatWithFallback(
  primary: LLMProvider,
  messages: Message[],
  tools: OpenAIToolSchema[],
  onDelta: (chunk: string) => void,
  onSystemMessage: (msg: string) => void,
): Promise<LLMResponse> {
  try {
    return await primary.chat(messages, tools, onDelta);
  } catch (err) {
    if (primary.name === 'copilot') throw err; // No fallback from copilot

    onSystemMessage(`⚠️ ${primary.name} error: ${err.message} — falling back to Copilot SDK`);
    const copilot = new CopilotProvider(copilotConfig);
    return await copilot.chat(messages, tools, onDelta);
  }
}
```

### 5.7 Rate Limit Handling

```typescript
async function chatWithRetry(
  provider: LLMProvider,
  messages: Message[],
  tools: OpenAIToolSchema[],
  onDelta: (chunk: string) => void,
  onSystemMessage: (msg: string) => void,
  maxRetries = 2,
): Promise<LLMResponse> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat(messages, tools, onDelta);
    } catch (err) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        const waitSeconds = parseRetryAfter(err) || (attempt + 1) * 30;
        onSystemMessage(`⚠️ Rate limited by ${provider.name}. Waiting ${waitSeconds}s...`);
        await sleep(waitSeconds * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}
```

---

## 6. State Management

### 6.1 Session State (Runtime)

Session state is held in the `SessionManager` and is ephemeral per process:

| State | Type | Lifetime | Description |
|-------|------|----------|-------------|
| `status` | `'idle' \| 'busy' \| 'error'` | Request | Set to `busy` on submit, cleared in `finally` |
| `messages` | `Message[]` | Session | LLM conversation (grows with each turn) |
| `codingMode` | `boolean` | Session | Toggled by `!code`, always `true` in non-interactive |
| `shellMode` | `boolean` | Session | Toggled by `!shell` |
| `workingDir` | `string \| null` | Session | Set by `--working-dir` or `set_working_dir` tool |
| `provider` | `LLMProvider` | Session | Current LLM provider instance |
| `backgroundJobs` | `Map<string, BackgroundJob>` | Session | Running code review processes |
| `timers` | `Map<string, Timer>` | Session | Active countdown/stopwatch timers |

**`busy`/`done` lifecycle invariant**: These are ALWAYS cleaned up in a `finally` block. Never in a conditional. This prevents permanent stalls.

```typescript
async submitMessage(text: string, callbacks: UICallbacks): Promise<void> {
  if (this.status === 'busy') {
    // Buffer the message for after current response finishes
    this.pendingMessage = text;
    return;
  }

  this.status = 'busy';
  callbacks.onStreamStart();

  try {
    // 1. ntfy polling
    const notifications = await pollNtfySubscriptions(this.profile.ntfySubscriptions);
    for (const n of notifications) {
      callbacks.onSystemMessage(`🔔 ${n}`);
    }

    // 2. Build system message
    const systemMsg = buildSystemMessage({
      profile: this.profile,
      history: this.chatHistory.entries,
      codingMode: this.codingMode,
      workingDir: this.workingDir,
      backgroundJobs: this.backgroundJobs,
    });

    // 3. Assemble messages
    this.messages[0] = { role: 'system', content: systemMsg };
    this.messages.push({ role: 'user', content: text });

    // 4. Run tool loop
    const response = await runToolLoop({
      messages: this.messages,
      tools: this.registry.getSchemas(this.getToolMode()),
      provider: this.provider,
      maxRounds: this.codingMode ? 50 : 10,
      onDelta: callbacks.onDelta,
      onToolCall: callbacks.onToolCall,
      contextManager: this.contextManager,
      usageTracker: this.usageTracker,
    });

    // 5. Append response
    this.messages.push(response);

    // 6. Persist to history (interactive only)
    if (!this.nonInteractive) {
      await this.chatHistory.append({ role: 'you', text, time: now() });
      await this.chatHistory.append({ role: 'assistant', text: response.content || '', time: now() });
    }
  } catch (err) {
    callbacks.onError(err instanceof Error ? err.message : String(err));
  } finally {
    // ALWAYS clean up — this is the stall prevention invariant
    this.status = 'idle';
    callbacks.onStreamEnd();
  }
}
```

### 6.2 Profile State (Persistent)

Profile state is on disk and survives across sessions:

```
~/.config/local-finder/
├── last_profile              # Plain text: "main"
├── usage.json                # Lifetime cost tracking
└── profiles/
    └── {name}/
        ├── preferences.yaml  # User preferences
        ├── saved_places.json # Bookmarked locations
        ├── chat_log.json     # Conversation history
        ├── history           # Input history (readline)
        ├── tokens.json       # OAuth tokens (Spotify, Google)
        └── ntfy_subscriptions.json
```

**Loading order** at startup:
1. Read `last_profile` → get active profile name
2. Load `preferences.yaml` → `UserPreferences`
3. Load `saved_places.json` → `SavedPlace[]`
4. Load `ntfy_subscriptions.json` → `NtfySubscription[]`
5. Load `chat_log.json` → `ChatLogEntry[]`
6. Seed last 20 chat entries as LLM messages (interactive only)
7. Load `usage.json` → lifetime costs

### 6.3 Coding Mode State

When coding mode is active (via `!code` or `--working-dir` or non-interactive):

| State | Value |
|-------|-------|
| `codingMode` | `true` |
| Tool set | All tools (coding tools included) |
| SDK timeout | 900s (instead of 180s) |
| Notes directory | `.marvin/notes/` (in project, not `~/Notes/`) |
| Shell confirmation | Required in interactive, auto-approved in non-interactive |
| Tool loop rounds | 50 (non-interactive), 10 (interactive) |
| System prompt | Includes working dir, project instructions, spec/design docs |

### 6.4 Background Jobs

Background code review is the only background job type:

```typescript
interface BackgroundJob {
  id: string;
  type: 'code_review';
  pid: number;
  process: ChildProcess;
  startTime: Date;
  status: 'running' | 'completed' | 'failed';
  result?: string;
}
```

- `review_codebase` tool spawns a background marvin process:
  ```bash
  marvin --non-interactive --prompt "Review this codebase..." --working-dir /path
  ```
- The spawned process is detached (`stdio: 'pipe'`, `detached: true`)
- `review_status` tool checks if the process is still running and returns stdout so far
- Background job status is included in the system prompt so the LLM knows about running reviews

### 6.5 Context Budget

Context budget is tracked per conversation:

```typescript
class ContextManager {
  private readonly WARN = 180_000;
  private readonly COMPACT = 200_000;
  private readonly HARD_LIMIT = 226_000;

  checkBudget(messages: Message[]): 'ok' | 'warn' | 'compact' | 'reject' {
    const tokens = this.countTokens(messages);
    if (tokens >= this.HARD_LIMIT) return 'reject';
    if (tokens >= this.COMPACT) return 'compact';
    if (tokens >= this.WARN) return 'warn';
    return 'ok';
  }

  availableTokens(): number {
    return this.WARN - this.currentTokenCount;
  }

  async compactMessages(messages: Message[]): Promise<Message[]> {
    // 1. Backup to .marvin/logs/context-backup-{timestamp}.jsonl
    await this.backupContext(messages);

    // 2. Keep: system message (first) + last 8 messages
    const system = messages[0];
    const recent = messages.slice(-8);
    const middle = messages.slice(1, -8);

    // 3. Summarize middle messages into a single system message
    const summary = await this.summarizeMessages(middle);

    return [
      system,
      { role: 'system', content: `[Compacted history summary]\n${summary}` },
      ...recent,
    ];
  }
}
```

---

## 7. Error Handling Strategy

### 7.1 Provider Fallback

```
Non-Copilot Provider Error
    │
    ├── Rate limit (429)?
    │     → Wait retry-after seconds, retry (max 2 retries)
    │     → If still failing: fall back to Copilot SDK
    │
    ├── Auth error (401/403)?
    │     → System message: "Check API key"
    │     → Fall back to Copilot SDK
    │
    ├── Network error?
    │     → Fall back to Copilot SDK
    │
    └── Copilot SDK error?
          → No fallback. Return error to user.
```

Fallback is automatic. The user sees a yellow system message and the prompt is retried with Copilot SDK. The user does not need to re-type anything.

### 7.2 SDK Timeout → Destroy + Rebuild

```typescript
private async withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new TimeoutError(`Response timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

// In CopilotProvider:
async chat(messages, tools, onDelta): Promise<LLMResponse> {
  const session = await this.ensureSession();
  const timeoutMs = this.codingMode ? 900_000 : 180_000;

  try {
    return await this.withTimeout(
      this.sendToSession(session, messages, tools, onDelta),
      timeoutMs,
      () => {
        // On timeout: destroy and null the session
        this.destroySession();
      },
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Session already destroyed in onTimeout callback
      // Next call to ensureSession() will create a fresh one
      throw err; // Let the router handle retry/fallback
    }
    throw err;
  }
}
```

### 7.3 Actionable Tool Errors

Every tool error MUST be actionable. Never return opaque messages.

**Bad**: `"Invoking this tool produced an error."`
**Good**: `"File not found: src/main.ts\nWorking dir: /home/user/project\nAvailable files:\n  src/\n    app.ts\n    index.ts\n  package.json"`

Error message template for file tools:
```typescript
function fileNotFoundError(path: string, workingDir: string): string {
  const tree = getTreeListing(workingDir, { maxDepth: 2 });
  return `File not found: ${path}\n` +
         `Working directory: ${workingDir}\n\n` +
         `Available files:\n${tree}`;
}
```

### 7.4 Argument Deserialization

Handled by the registry wrapper (§4.3). Three cases:
1. **Valid JSON object** → use directly
2. **JSON string** → `JSON.parse()`, use if object
3. **Non-JSON string** (diff format, etc.) → helpful error with expected schema

### 7.5 Context Overflow Compaction

When context hits 200K tokens:
1. Backup all messages to `.marvin/logs/context-backup-{ts}.jsonl`
2. Keep system message + last 8 messages
3. Summarize dropped middle messages
4. Insert summary as system message
5. Continue conversation with reduced context

The user sees:
```
🔄 Compacting conversation history...
── Context compacted. Older messages summarized. ──
```

Chat area is NOT cleared — all messages remain visible for scrolling.

---

## 8. Testing Strategy

### 8.1 No-Mocks Policy

**Prohibited**:
- `jest.mock()`, `vi.mock()`, `sinon.stub()`, or any test double
- Any code that replaces real behavior with fake behavior

**Required alternatives**:
- In-memory SQLite for database tests (if applicable)
- Real HTTP requests (use real free APIs or local test servers)
- Real filesystem via `os.tmpdir()` temp directories
- Integration tests talk to real local services
- For provider tests: use real provider with small prompts, or skip if no API key

### 8.2 Test Framework

Use **Vitest** (fast, TypeScript-native, ESM support).

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,  // Tools may be slow (web, shell)
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
```

### 8.3 Test Categories

| Category | What | How |
|----------|------|-----|
| Tool unit tests | Each tool handler | Real implementation, temp dirs for files |
| Registry tests | Zod conversion, fixup, dispatch | Real tools, validate schema output |
| Provider tests | API call, streaming, error handling | Real API calls (skip if no key) |
| Context tests | Token counting, compaction | Real messages, verify token counts |
| History tests | Load/save/compact/search | Real filesystem (temp dir) |
| Profile tests | Load/save/switch | Real filesystem (temp dir) |
| Integration tests | Full message submission pipeline | SessionManager with real tools |
| E2E tests | Full marvin process | `child_process.spawn`, verify stdout |

### 8.4 Test Data

- Tool tests use real free APIs (DuckDuckGo, Wikipedia, Open-Meteo, etc.)
- File tests create real files in temp directories
- Git tests create real git repos in temp directories
- Provider tests use real API keys if available, otherwise skip

### 8.5 Testing Tool Dispatch Edge Cases

```typescript
// String args fixup
test('handles JSON string arguments', async () => {
  const result = await registry.execute('web_search', '{"query": "test"}');
  expect(result).toContain('test');
});

// Validation errors are actionable
test('returns helpful validation errors', async () => {
  const result = await registry.execute('web_search', {});
  expect(result).toContain('query');
  expect(result).toContain('required');
});

// Path sandboxing
test('rejects absolute paths', async () => {
  const result = await registry.execute('read_file', { path: '/etc/passwd' });
  expect(result).toContain('Absolute paths not allowed');
});

// 10KB guard
test('rejects large file reads without line range', async () => {
  // Create a 15KB file
  const result = await registry.execute('read_file', { path: 'large.txt' });
  expect(result).toContain('start_line');
  expect(result).toContain('end_line');
});
```

---

## 9. Dependencies

### 9.1 Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `openai` | `^4.x` | OpenAI-compatible API client (used by Gemini, Groq, OpenAI, OpenAI-compat) |
| `zod` | `^3.x` | Runtime type validation for tool parameters |
| `zod-to-json-schema` | `^3.x` | Convert Zod schemas to JSON Schema for LLM tool definitions |
| `blessed` | `^0.1.x` | Terminal TUI framework (curses-like) for the interactive UI |
| `js-yaml` | `^4.x` | Parse/write YAML for `preferences.yaml` |
| `tiktoken` | `^1.x` | Token counting for context budget management |

### 9.2 Optional Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `ollama` | `^0.5.x` | Ollama API client (only needed for Ollama provider) |
| `@anthropic-ai/sdk` | `^0.x` | Copilot SDK (for the default Copilot provider) |
| `selenium-webdriver` | `^4.x` | Headless Firefox for `scrape_page` tool (optional, degrades gracefully) |

### 9.3 Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | `^5.x` | TypeScript compiler |
| `vitest` | `^3.x` | Test framework |
| `tsx` | `^4.x` | TypeScript execution for development (`tsx src/main.ts`) |
| `@types/node` | `^22.x` | Node.js type definitions |
| `@types/blessed` | `^0.1.x` | Blessed type definitions |
| `@types/js-yaml` | `^4.x` | js-yaml type definitions |

### 9.4 System Dependencies (Not npm)

| Tool | Purpose |
|------|---------|
| `git` | Git operations (`git_status`, `git_diff`, etc.) |
| `gh` | GitHub CLI (`github_search`, `github_clone`, etc.) |
| `rg` (ripgrep) | Code search (`code_grep` tool) |
| `lynx` | Text-mode web browser (`browse_web` tool) |
| `notify-send` | Desktop notifications (alarms, calendar reminders) |
| `yt-dlp` | Video/audio download (`yt_dlp_download` tool) |
| `geckodriver` + Firefox | Headless browser for `scrape_page` (optional) |

### 9.5 Why These Choices

- **`openai` SDK** over raw `fetch`: Handles streaming, retries, error parsing. All non-Copilot providers speak OpenAI-compatible protocol.
- **`zod`** over raw JSON Schema: Type inference at compile time, runtime validation, auto-conversion to JSON Schema.
- **`blessed`** over raw ANSI: Provides widgets (box, input, scrollable list), mouse support, cross-terminal compatibility.
- **`tiktoken`** over heuristics: Accurate token counting is critical for context budget management. The 4-chars-per-token heuristic is too imprecise at 200K+ tokens.
- **`vitest`** over jest: Better TypeScript/ESM support, faster, compatible API.

---

## 10. Migration Path

### 10.1 Side-by-Side Operation

The Python (`app.py`) and TypeScript (`marvin-ts/`) implementations can run side by side:

- Both read from the same profile directory (`~/.config/local-finder/profiles/`)
- Both use the same `chat_log.json` format (role: `"you"`/`"assistant"`/`"system"`)
- Both use the same `preferences.yaml` format
- Both use the same `saved_places.json` format
- Both read the same environment variables for API keys and provider config

### 10.2 Wrapper Script Resolution

The `marvin` wrapper script resolves the implementation:

```bash
#!/bin/bash
if [ -f "dist/main.js" ]; then
  exec node dist/main.js "$@"
elif [ -f "app.py" ]; then
  exec python app.py "$@"
fi
```

### 10.3 Config/State Compatibility

| State File | Format | Compatible? | Notes |
|------------|--------|-------------|-------|
| `chat_log.json` | JSON array of `{role, text, time}` | ✅ Yes | Same format in both implementations |
| `preferences.yaml` | YAML | ✅ Yes | Same schema |
| `saved_places.json` | JSON array of place objects | ✅ Yes | Same schema |
| `last_profile` | Plain text | ✅ Yes | Just a profile name |
| `usage.json` | JSON | ✅ Yes | Same schema |
| `tokens.json` | JSON | ✅ Yes | OAuth tokens, same format |
| `ntfy_subscriptions.json` | JSON | ✅ Yes | Same schema |
| `history` | Readline history file | ✅ Yes | One line per entry |

### 10.4 Feature Parity Checklist

Before decommissioning the Python version, verify:

1. ✅ All ~115 tools work (test each category)
2. ✅ All 6 providers work (Copilot, Gemini, Groq, OpenAI, Ollama, OpenAI-compat)
3. ✅ Interactive mode: curses TUI + plain readline
4. ✅ Non-interactive mode: raw stdout streaming + MARVIN_COST stderr
5. ✅ Coding mode: file ops, git, shell, path sandboxing
6. ✅ Context budget: warn, compact, hard limit
7. ✅ Profile switching mid-conversation
8. ✅ All slash commands
9. ✅ ntfy polling on message submission
10. ✅ Background code review (review_codebase / review_status)
11. ✅ `.marvin-instructions` loading
12. ✅ Cost tracking and `get_usage`
13. ✅ `MARVIN_READONLY` mode
14. ✅ `MARVIN_SUBAGENT_LOG` JSONL logging

### 10.5 Deferred Features (Not in v1)

These features exist in the Python implementation but are NOT included in the TypeScript v1:

| Feature | Reason | Alternative |
|---------|--------|-------------|
| `--design-first` TDD pipeline | Broken, overly complex | Use Copilot CLI directly |
| `launch_agent` tool | Pipeline-only | Use Copilot CLI |
| `tk` tool (coding-mode) | Pipeline ticket gating | Non-coding `create_ticket` tools retained |
| `install_packages` tool | Python/uv specific | `run_command` is sufficient |
| `MARVIN_DEPTH` / `MARVIN_TICKET` | Pipeline env vars | Not needed without pipeline |
| Pipeline model tier env vars | Pipeline-only | `MARVIN_CODE_MODEL_LOW`/`HIGH` retained |
| Voice input (`!voice`, `!v`) | Requires Groq Whisper | Low priority for v1 |
| Blender MCP bridge | Niche use case | Add when needed |

---

## Appendix A: Environment Variables Reference

### Provider & Model

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `copilot` | Active provider |
| `MARVIN_MODEL` | *(none)* | Override model for non-interactive |
| `MARVIN_CHAT_MODEL` | *(none)* | Chat model for Copilot SDK |
| `MARVIN_CODE_MODEL_HIGH` | `claude-opus-4.6` | High tier (code review, QA) |
| `MARVIN_CODE_MODEL_LOW` | `gpt-5.3-codex` | Low tier (implementation) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model override |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Gemini model override |
| `OLLAMA_MODEL` | `qwen3-coder:30b` | Ollama model override |
| `OPENAI_COMPAT_MODEL` | `qwen/qwen3-32b` | OpenRouter/etc. model |
| `OPENAI_COMPAT_URL` | `https://openrouter.ai/api/v1/chat/completions` | API endpoint |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |

### API Keys

| Variable | Fallback | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | `~/.ssh/GEMINI_API_KEY` | Gemini |
| `GROQ_API_KEY` | `~/.ssh/GROQ_API_KEY` | Groq |
| `OPENAI_API_KEY` | *(none)* | OpenAI |
| `OPENAI_COMPAT_API_KEY` | *(none)* | OpenAI-compatible |
| `GOOGLE_PLACES_API_KEY` | *(none)* | Google Places (falls back to OSM) |
| `GNEWS_API_KEY` | *(none)* | GNews news search |
| `NEWSAPI_KEY` | *(none)* | NewsAPI.org |
| `STEAM_API_KEY` | *(none)* | Steam Web API |
| `OMDB_API_KEY` | *(none)* | OMDB movies |
| `RAWG_API_KEY` | *(none)* | RAWG games |

### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_READONLY` | *(unset)* | `"1"` = strip write tools |
| `MARVIN_SUBAGENT_LOG` | *(none)* | JSONL tool call audit log path |
| `EDITOR` | `nano` | Editor for preferences |

---

## Appendix B: Complete Tool Registry

All ~115 tools organized by module, with their `codingOnly` and `writeOp` flags:

| Module | Tool | codingOnly | writeOp |
|--------|------|-----------|---------|
| location | `get_my_location` | | |
| location | `places_text_search` | | |
| location | `places_nearby_search` | | |
| location | `setup_google_auth` | | |
| places | `save_place` | | |
| places | `remove_place` | | |
| places | `list_places` | | |
| travel | `estimate_travel_time` | | |
| travel | `get_directions` | | |
| travel | `estimate_traffic_adjusted_time` | | |
| weather | `weather_forecast` | | |
| web | `web_search` | | |
| web | `search_news` | | |
| web | `browse_web` | | |
| web | `scrape_page` | | |
| media | `search_movies` | | |
| media | `get_movie_details` | | |
| media | `search_games` | | |
| media | `get_game_details` | | |
| steam | `steam_search` | | |
| steam | `steam_app_details` | | |
| steam | `steam_featured` | | |
| steam | `steam_player_stats` | | |
| steam | `steam_user_games` | | |
| steam | `steam_user_summary` | | |
| music | `music_search` | | |
| music | `music_lookup` | | |
| recipes | `recipe_search` | | |
| recipes | `recipe_lookup` | | |
| notes | `write_note` | | |
| notes | `read_note` | | |
| notes | `notes_ls` | | |
| notes | `notes_mkdir` | | |
| notes | `search_notes` | | |
| files | `read_file` | ✅ | |
| files | `create_file` | ✅ | ✅ |
| files | `append_file` | ✅ | ✅ |
| files | `apply_patch` | ✅ | ✅ |
| files-notes | `file_read_lines` | | |
| files-notes | `file_apply_patch` | | ✅ |
| coding | `set_working_dir` | ✅ | |
| coding | `get_working_dir` | ✅ | |
| coding | `code_grep` | ✅ | |
| coding | `tree` | ✅ | |
| coding | `review_codebase` | ✅ | |
| coding | `review_status` | ✅ | |
| git | `git_status` | ✅ | |
| git | `git_diff` | ✅ | |
| git | `git_commit` | ✅ | ✅ |
| git | `git_log` | ✅ | |
| git | `git_blame` | ✅ | |
| git | `git_branch` | ✅ | |
| git | `git_checkout` | ✅ | ✅ |
| shell | `run_command` | ✅ | ✅ |
| github | `github_search` | | |
| github | `github_clone` | | |
| github | `github_read_file` | | |
| github | `github_grep` | | |
| calendar | `calendar_add_event` | | |
| calendar | `calendar_delete_event` | | |
| calendar | `calendar_view` | | |
| calendar | `calendar_list_upcoming` | | |
| wiki | `wiki_search` | | |
| wiki | `wiki_summary` | | |
| wiki | `wiki_full` | | |
| wiki | `wiki_grep` | | |
| academic | `search_papers` | | |
| academic | `search_arxiv` | | |
| system | `exit_app` | | |
| system | `system_info` | | |
| system | `get_usage` | | |
| alarms | `set_alarm` | | |
| alarms | `list_alarms` | | |
| alarms | `cancel_alarm` | | |
| timers | `timer_start` | | |
| timers | `timer_check` | | |
| timers | `timer_stop` | | |
| ntfy | `generate_ntfy_topic` | | |
| ntfy | `ntfy_subscribe` | | |
| ntfy | `ntfy_unsubscribe` | | |
| ntfy | `ntfy_publish` | | |
| ntfy | `ntfy_list` | | |
| spotify | `spotify_auth` | | |
| spotify | `spotify_search` | | |
| spotify | `spotify_create_playlist` | | |
| spotify | `spotify_add_tracks` | | |
| maps | `osm_search` | | |
| maps | `overpass_query` | | |
| stack | `stack_search` | | |
| stack | `stack_answers` | | |
| tickets | `create_ticket` | | |
| tickets | `ticket_start` | | |
| tickets | `ticket_close` | | |
| tickets | `ticket_add_note` | | |
| tickets | `ticket_show` | | |
| tickets | `ticket_list` | | |
| tickets | `ticket_dep_tree` | | |
| tickets | `ticket_add_dep` | | |
| bookmarks | `bookmark_save` | | |
| bookmarks | `bookmark_list` | | |
| bookmarks | `bookmark_search` | | |
| downloads | `download_file` | | |
| downloads | `yt_dlp_download` | | |
| utilities | `convert_units` | | |
| utilities | `dictionary_lookup` | | |
| utilities | `translate_text` | | |
| utilities | `read_rss` | | |
| history | `compact_history` | | |
| history | `search_history_backups` | | |
| profiles | `switch_profile` | | |
| profiles | `update_preferences` | | |

---

## Appendix C: Non-Interactive Stdout Protocol

For integrators calling Marvin as a subprocess:

```
STDOUT:
  Raw text tokens (free-form, not structured)
  Tool markers: "  🔧 tool1, tool2\n" (detect by 🔧 prefix)
  Strip trailing \n from each read to avoid doubled newlines

STDERR:
  Debug/log messages (safe to ignore)
  Last meaningful line: MARVIN_COST:{"session_cost":0.0023,"llm_turns":3,...}

EXIT CODES:
  0 = success
  1 = error (missing --prompt, runtime exception, LLM failure)
```

---

## Appendix D: Design Invariants Checklist

These properties MUST hold at all times. Violating any one of these is a bug.

1. **`busy`/`done` cleanup in `finally`** — never in conditionals
2. **SDK listener registered once per session** — never per request
3. **Context never downgrades** — compaction backup is append-only
4. **Tool errors are always actionable** — never opaque
5. **Paths cannot escape the working directory** — absolute paths and `..` rejected
6. **Files >10KB require line ranges** — enforced by `read_file`
7. **No mocks in tests** — all real implementations
8. **`GIT_DIR` unset before all git operations** — prevents parent contamination
9. **Notes redirect in coding mode** — `.marvin/notes/`, not `~/Notes/`
10. **Chat log uses `"you"` role** — not OpenAI `"user"`
11. **Cost tracking is per-provider, per-model** — every LLM call recorded
12. **ntfy polling is session-level** — on every message submission, not a tool call
13. **Non-interactive always coding mode** — auto-approves commands, 50-round limit
14. **API key fallbacks checked** — env var first, then `~/.ssh/` file
