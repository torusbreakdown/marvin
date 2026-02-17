# Marvin Architecture & Design

> **Purpose**: This document details Marvin's internal structure, agentic edge
> cases, and design decisions. It is the architectural complement to
> [MARVIN_SPEC.md](./MARVIN_SPEC.md) (behavioral contracts),
> [MARVIN_API_SPEC.md](./MARVIN_API_SPEC.md) (integration/IO contracts), and
> [TOOLS.md](./TOOLS.md) (tool schemas).
>
> **Audience**: Developers reimplementing Marvin, particularly in Node.js.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────┐
│                  Marvin CLI                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │Interactive│  │Non-Inter │  │Pipeline/Code │   │
│  │Mode (TUI)│  │Mode      │  │Mode          │   │
│  └──────────┘  └──────────┘  └──────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │           LLM Provider Layer              │   │
│  │  OpenAI │ Anthropic │ Gemini │ Ollama     │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │           Tool Registry (~115 tools)      │   │
│  └───────────────────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │     State: Conversations, Notes, Config   │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Marvin is a single-process CLI assistant. There is no cloud deployment, no
Docker — it runs locally and manages all state on disk. The Python reference
implementation is a single ~11K-line file (`app.py`). The Node.js port should
decompose this into modules (see §7).

### 1.1 Data Flow

```
User Input (TUI / --prompt / stdin)
    │
    ▼
System Message Assembly
  ├── Personality & rules
  ├── User preferences (YAML)
  ├── Saved places (JSON)
  ├── Compact history (last 20 entries, 200 chars each)
  ├── Coding instructions (if coding mode)
  ├── Project instructions (.marvin-instructions / .marvin/instructions.md)
  └── Spec & design docs (.marvin/spec.md, .marvin/design.md)
    │
    ▼
LLM Provider (selected by --provider or LLM_PROVIDER env)
    │
    ▼
Tool Call Loop (up to 50 rounds in non-interactive; SDK-managed in Copilot)
  ├── LLM emits tool calls
  ├── Dispatcher deserializes arguments (with string-fixup, see §3.3)
  ├── Tool executes locally (web, filesystem, git, API, etc.)
  ├── Result returned to LLM
  └── Repeat until LLM emits text-only response or round limit
    │
    ▼
Response streamed to stdout (non-interactive) or TUI (interactive)
    │
    ▼
Cost data emitted to stderr as MARVIN_COST:{json}
```

---

## 2. LLM Provider Layer

### 2.1 Multi-Provider Support

| Provider     | Models                                | Auth                          |
|-------------|---------------------------------------|-------------------------------|
| Copilot SDK | GPT-5.x, Codex, Claude (via GitHub)  | `gh auth login`               |
| OpenAI      | GPT-5.x, Codex                       | `OPENAI_COMPAT_API_KEY`       |
| Anthropic   | Claude Opus, Sonnet                   | Via Copilot SDK               |
| Google      | Gemini 3 Pro                          | `GEMINI_API_KEY`              |
| Groq        | Llama 3.3 70B                         | `GROQ_API_KEY`                |
| Ollama      | Any local model (Qwen, Llama, etc.)   | Local, no key needed          |

### 2.2 Provider Abstraction

All providers are normalized to a unified message format (OpenAI-style):

```typescript
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
```

Each provider has its own adapter that:
1. Converts unified messages → provider-native format
2. Converts tool schemas → provider-native function-calling format
3. Parses streaming chunks back into unified `Message` objects
4. Handles provider-specific quirks (Gemini's different tool response format,
   Ollama's local streaming, etc.)

### 2.3 Cost Tracking

Cost tracking is per-provider, per-model, per-session:

```typescript
interface CostTracker {
  session: {
    turns: Record<string, number>;   // model → turn count
    cost: Record<string, number>;    // model → USD
    total_cost: number;
  };
  lifetime: {
    turns: Record<string, number>;
    cost: Record<string, number>;
    total_cost: number;
  };
}
```

**Cost multipliers**: Opus-tier models are ~3× more expensive per request than
standard models. The tracker applies per-model pricing to estimate costs.

**Reporting**: The `get_usage` tool exposes session and lifetime costs. In
non-interactive mode, costs are emitted to stderr on exit as
`MARVIN_COST:{json}`.

---

## 3. Tool System Architecture

### 3.1 Tool Definition

In the Python implementation, tools are defined via a `@define_tool` decorator
with Pydantic parameter models:

```python
@define_tool(description="Create a new file with the given content.")
async def create_file(params: CreateFileParams) -> str:
    ...
```

For Node.js, the equivalent pattern is:

```typescript
defineTool({
  name: "create_file",
  description: "Create a new file with the given content.",
  parameters: CreateFileParamsSchema,  // Zod schema
  handler: async (params: CreateFileParams): Promise<string> => { ... },
});
```

Key constraints:
- Every tool is an async function returning a string
- Parameter schemas are auto-generated from the model class (Pydantic → JSON
  Schema in Python; Zod → JSON Schema in Node.js)
- The string return value is always fed back to the LLM as the tool result

### 3.2 Tool Call Dispatch

Two code paths exist depending on the LLM provider:

1. **SDK path** (Copilot SDK): The SDK handles tool call deserialization and
   dispatch. A wrapper intercepts the call to apply the string-args fixup
   (§3.3) before Pydantic/Zod validation runs.

2. **Non-SDK path** (direct LLM API calls to Gemini, Groq, Ollama, OpenAI):
   A custom `execTool()` function:
   - Receives the tool name and raw arguments from the LLM response
   - Looks up the tool in the registry
   - Parses JSON arguments
   - Constructs the parameter object
   - Calls the handler
   - Returns the result string

### 3.3 Tool Call Argument Fixup (Critical)

This is one of the most important implementation details. LLMs sometimes send
tool call arguments in unexpected formats:

| Format                  | Frequency  | Example                                   |
|------------------------|------------|-------------------------------------------|
| Correct JSON object    | ~90%       | `{"path": "src/main.ts", "content": "..."}` |
| JSON string            | ~8%        | `'{"path": "src/main.ts", "content": "..."}'` |
| Unified-diff format    | ~2%        | `"*** Begin Patch\n*** Update File..."` |

The `defineTool` wrapper MUST patch every tool's handler to:

1. Check if `arguments` is a string (instead of a parsed object)
2. Try `JSON.parse()` — if the result is a dict/object, use it
3. If `JSON.parse()` fails (e.g., unified-diff format), return a **helpful**
   error message explaining the expected parameter schema
4. Never return opaque errors like `"Invoking this tool produced an error."` —
   the LLM cannot recover from opaque errors

```typescript
function wrapToolHandler(tool: ToolDef): ToolDef {
  const original = tool.handler;
  return {
    ...tool,
    handler: async (args: unknown) => {
      if (typeof args === "string") {
        try {
          const parsed = JSON.parse(args);
          if (typeof parsed === "object" && parsed !== null) {
            args = parsed;
          }
        } catch {
          return `Error: Arguments must be a JSON object, not a string. ` +
                 `Expected format: ${JSON.stringify(tool.parameterNames)}`;
        }
      }
      return original(args);
    },
  };
}
```

### 3.4 Tool Subsets

Not all tools are available in all contexts:

| Context                    | Tools available                           | Count  |
|---------------------------|-------------------------------------------|--------|
| Interactive mode          | ALL tools                                 | ~115   |
| Coding sub-agents         | Coding tools only (file ops, git, grep, tree, run_command, tk, install_packages) | ~20 |
| Readonly review agents    | Coding tools minus writes (no create_file, apply_patch, run_command, git_commit) | ~12 |
| Non-interactive (bridge)  | ALL tools (coding mode always enabled)    | ~115   |

### 3.5 Tool Categories

```
Location & Geo     │ get_my_location, setup_google_auth
Places & Travel     │ places_text_search, places_nearby_search, estimate_travel_time,
                    │ estimate_traffic_adjusted_time, get_directions
Web & Search        │ web_search, search_news, scrape_page, browse_web
Academic            │ search_papers, search_arxiv
Entertainment       │ search_movies, get_movie_details, search_games, get_game_details,
                    │ steam_*, recipe_*, music_*, spotify_*
Knowledge           │ wiki_search, wiki_summary, wiki_full, wiki_grep,
                    │ stack_search, stack_answers
Coding — Files      │ create_file, append_file, apply_patch, read_file, code_grep, tree
Coding — Git        │ git_status, git_diff, git_commit, git_log, git_checkout
Coding — Shell      │ run_command, install_packages, set_working_dir, get_working_dir
Coding — Agents     │ launch_agent, tk (ticket system)
GitHub              │ github_search, github_clone, github_read_file, github_grep
Notes               │ write_note, read_note, notes_mkdir, notes_ls
Calendar            │ calendar_add_event, calendar_delete_event, calendar_view,
                    │ calendar_list_upcoming
Notifications       │ set_alarm, list_alarms, cancel_alarm, generate_ntfy_topic,
                    │ ntfy_subscribe, ntfy_unsubscribe, ntfy_publish, ntfy_list
Profiles            │ switch_profile, update_preferences
Utilities           │ weather_forecast, convert_units, dictionary_lookup, translate_text,
                    │ timer_start, timer_check, timer_stop, system_info, read_rss,
                    │ download_file, bookmark_*, yt_dlp_download
Session             │ get_usage, exit_app, compact_history, search_history_backups
Blender (MCP)       │ blender_get_scene, blender_get_object, blender_create_object,
                    │ blender_modify_object, blender_delete_object, blender_set_material,
                    │ blender_execute_code, blender_screenshot
File Editing        │ file_read_lines, file_apply_patch (non-coding ~/Notes only)
Tickets (non-code)  │ create_ticket, ticket_add_dep, ticket_start, ticket_close,
                    │ ticket_add_note, ticket_show, ticket_list, ticket_dep_tree
```

---

## 4. Coding Pipeline Architecture

### 4.1 Pipeline Orchestrator

The pipeline is a single-threaded async orchestrator running in the parent
Marvin process. It manages:

- Phase progression through the state machine
- State persistence to `.marvin/pipeline_state`
- Sub-agent spawning as child processes
- Retry loops for document generation
- Review/fix cycles

The orchestrator is triggered by `--non-interactive --design-first --working-dir PATH`.

### 4.2 Phase State Machine

```
1a ──→ 1a_review ──→ 1b ──→ 1b_review ──→ 2a ──→ 2b ──→ 3 ──→ 4a ──→ 4b ──→ 5
│                                                                                │
│  Spec + UX        Design              Tests        Impl    Debug    QA        │
│  (parallel)       (sequential)        (TDD red)           (green)             │
```

**State persistence**: `.marvin/pipeline_state` contains a single string
(e.g., `"2a"`). The orchestrator reads this on startup to determine which
phases to skip.

**Anti-downgrade invariant**: `save_state(phase)` compares the requested phase
against the current persisted state using an index lookup. If the persisted
state is later, the write is a no-op. This prevents completed work from being
redone after a crash, because `save_state` is called unconditionally — even
from skipped phases.

**Fresh reads**: `phase_done(phase)` MUST read from disk on every call. The
initial implementation cached the state at startup, which went stale after
`save_state()` wrote updates during execution.

### 4.3 Sub-Agent Spawning

```
Parent Marvin Process (orchestrator)
├── Sub-agent: Spec Writer      (plan-tier, writes .marvin/spec.md)
├── Sub-agent: UX Writer        (plan-tier, writes .marvin/ux.md)
│       ↑ These two run in PARALLEL (phase 1a)
├── Sub-agent: Spec Reviewer ×3 (opus + 2× aux, READONLY, adversarial R1)
├── Sub-agent: Spec Fixer       (codex-tier, applies review fixes)
│       ↑ Review/fix loop up to 4 rounds (phase 1a_review)
│       ↑ R1 is adversarial (must find issues), R2+ can pass
│       ↑ Findings saved to .marvin/review-history-{doc}.md
├── Sub-agent: Architecture     (plan-tier, writes .marvin/design.md)
├── Sub-agent: Design Reviewer  (opus-tier, READONLY)
├── Sub-agent: Design Fixer     (codex-tier, applies review fixes)
│       ↑ Review/fix loop up to 4 rounds (phase 1b_review)
├── Sub-agent: Test Writer      (codex-tier, writes tests/)
│       ↑ Phases 2a (functional) and 2b (integration/E2E)
├── Sub-agent: Implementer      (codex-tier, writes src/)
│       ↑ Phase 3
├── Sub-agent: Debug Loop       (plan-tier, runs tests, fixes code)
│       ↑ Phase 4a (up to 50 rounds), 4b (up to 10 rounds)
└── Sub-agent: QA Reviewer      (opus-tier, READONLY)
        ↑ Phase 5 (adversarial security/perf/edge review)
```

Each sub-agent is a **full Marvin instance** launched as a child process:

```bash
python app.py \
  --non-interactive \
  --working-dir /project \
  --model $TIER_MODEL \
  --prompt-file /path/to/prompt.txt
```

With these environment variables set by the parent:

| Variable              | Value                                  |
|-----------------------|----------------------------------------|
| `MARVIN_DEPTH`        | Parent's depth + 1                     |
| `MARVIN_MODEL`        | Model for this tier (codex/opus/plan)  |
| `MARVIN_TICKET`       | Parent ticket ID                       |
| `MARVIN_READONLY`     | `"1"` for review agents, unset otherwise |
| `MARVIN_WRITABLE_FILES` | Comma-separated paths for fixer agents (e.g. `.marvin/spec.md`) |
| `MARVIN_SUBAGENT_LOG` | Path to JSONL log file                 |

### 4.4 Sub-Agent Communication

There is **no direct IPC** between sub-agents. Communication happens
exclusively through the filesystem:

1. **Agent A** writes `spec.md` using `create_file` / `append_file`
2. **Parent** verifies the file exists and is ≥1000 bytes
3. **Parent** builds a prompt for Agent B that includes a summary of `spec.md`
4. **Agent B** reads the files it needs via `read_file`

The parent passes project context to each sub-agent via the `--prompt` flag,
which includes the output of `_project_context()`:

- Project name and working directory
- First 2000 chars of `spec.md` (overview + user stories)
- First 1500 chars of `design.md` (architecture summary)
- File tree listing
- No-mock policy statement
- Instructions for ticket creation

### 4.5 Document Generation Retry Loop

After each document-writing agent finishes, the orchestrator verifies:

1. The output file **exists** on disk
2. The file is **≥1000 bytes**

If either check fails:
- Delete any garbage file (may be a tiny planning-notes stub)
- Retry the agent (up to 3 attempts)
- Abort the pipeline if all retries fail

**Why size checks matter**: Agents sometimes dump chain-of-thought to stdout
instead of calling `create_file`. If the orchestrator captures stdout and
writes it to a file, the result passes existence checks but contains planning
notes instead of real content. The ≥1000 byte threshold catches both missing
files and empty/stub files.

### 4.6 Review/Fix Loops

After document phases (1a, 1b), a review cycle runs:

```
┌─────────────────┐     ┌─────────────────┐
│ Spec Conformance │────→│   Fix Agent     │
│ Reviewer (opus)  │     │   (codex)       │
│ READONLY         │     │   Applies fixes │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───── Re-review ◄──────┘
              (max 2–3 rounds)
```

The reviewer is a **readonly** agent — write tools are blocked. Its findings
are compiled into a fix prompt for the fixer agent.

### 4.7 Model Tiers

```
Tier     Default Model          Used For                          Cost
────     ─────────────          ────────                          ────
codex    gpt-5.3-codex          Tests, implementation, fixes      1×
plan     gpt-5.2                Spec/design generation, debug     1×
opus     claude-opus-4.6        Code reviews, adversarial QA      3×
```

Environment variable overrides:
- `MARVIN_CODE_MODEL_LOW` → codex tier
- `MARVIN_CODE_MODEL_HIGH` → opus tier
- `MARVIN_CODE_MODEL_PLAN` → plan tier (falls back to HIGH if unset)

---

## 5. State Management

### 5.1 Pipeline State

- **File**: `.marvin/pipeline_state`
- **Content**: Phase string (e.g., `"2a"`)
- **Anti-downgrade**: `save_state()` compares phase indices; refuses to go
  backward
- **Read-from-disk**: `phase_done()` always reads fresh (no in-memory caching)

### 5.2 Conversation State (Interactive Mode)

- **File**: `~/.config/local-finder/profiles/{name}/chat_log.json`
- **Format**: Array of `{role, text, time}` objects
- **Role values**: `"you"`, `"assistant"`, `"system"` (NOT OpenAI-standard
  `"user"` / `"assistant"`)
- **Seeding**: Last 20 entries loaded into LLM message array on startup
- **Compaction**: `compact_history` tool summarizes old messages to save tokens

### 5.3 Configuration State

```
~/.config/local-finder/
├── last_profile              # Active profile name (plain text)
└── profiles/
    ├── main/
    │   ├── preferences.yaml  # Dietary, spice, cuisines, budget, transport
    │   ├── saved_places.json # Bookmarked locations with coords
    │   ├── chat_log.json     # Conversation history
    │   ├── history           # Readline input history
    │   └── tokens.json       # OAuth tokens (Spotify, Google)
    └── {other_profile}/
        └── ...
```

### 5.4 Project State (Coding Mode)

```
{working-dir}/
├── .marvin/
│   ├── pipeline_state      # Current phase string
│   ├── spec.md             # Product specification
│   ├── ux.md               # UX design document
│   ├── design.md           # Architecture & test plan
│   ├── notes/              # Agent notes (coding mode only)
│   ├── instructions.md     # Project-specific instructions
│   └── upstream/           # Read-only reference docs from parent
│       ├── MARVIN_SPEC.md
│       ├── MARVIN_API_SPEC.md
│       ├── MARVIN_DESIGN.md
│       ├── TOOLS.md
│       ├── SHARP_EDGES.md
│       └── README.md
├── .marvin-instructions    # Alt location for project instructions
├── .tickets/               # Ticket system storage (managed by `tk`)
├── src/                    # Implementation (written by agents)
└── tests/                  # Tests (written before implementation)
```

### 5.5 Notes Redirection

The `write_note` tool has mode-dependent behavior:

| Mode        | Notes directory                | Rationale                                     |
|-------------|-------------------------------|-----------------------------------------------|
| Interactive | `~/Notes/`                     | User's personal knowledge base                |
| Coding      | `.marvin/notes/` (in project) | Prevents agents from caching knowledge across runs |

If coding agents write to `~/Notes/`, they can persist implementation details
across pipeline runs, defeating the purpose of isolated agent execution.

---

## 6. Agentic Edge Cases

These are hard-learned lessons from the Python implementation. Every one of
these has caused real failures in production.

### 6.1 LLM Output Garbage

**Problem**: Agents sometimes write chain-of-thought planning text to stdout
instead of using `create_file`. They also sometimes create tiny files
(<100 bytes) containing planning notes instead of real content.

**Solution**: Retry loops check file **existence** AND **size** (≥1000 bytes).
Never auto-capture stdout and write it to a file.

### 6.2 Tool Call Format Variance

**Problem**: Different models send tool call arguments in different formats:

| Model family       | Behavior                                           |
|-------------------|----------------------------------------------------|
| OpenAI GPT-5.x    | Usually correct JSON objects                       |
| OpenAI Codex      | Sometimes sends args as JSON strings               |
| Codex (apply_patch)| Sometimes uses unified-diff format instead of 3-param schema |
| Codex (apply_patch)| Sometimes uses `"*** Begin Patch"` format          |
| Gemini             | Tool call responses arrive in a different structure |

**Solution**: The `defineTool` wrapper (§3.3) deserializes strings and returns
helpful errors for non-JSON input. Every validation error includes the correct
usage with examples.

### 6.3 Agent Wandering (Path Escapes)

**Problem**: Agents try to access files outside their working directory:
- Using absolute paths from error messages (e.g., `/home/kmd/project/file.py`)
- Using `../` to escape the sandbox
- Trying to read Marvin's own source code

**Solution**: Strict path sandboxing:
1. Reject absolute paths with a clear error
2. Reject `..` path traversal
3. Include the working directory AND a directory tree listing in the error
   message so the agent can orient itself

### 6.4 Ticket Gaming

**Problem**: Without enforcement, agents write one-liner tickets like "implement
stuff" and skip immediately to coding. This produces low-quality work with no
traceability.

**Solution**: The FIRST `tk create` call is **intentionally rejected**. This
forces the agent to write a thorough description with acceptance criteria on the
retry. Readonly agents are exempt (they don't write files).

### 6.5 Review False Positives in TDD

**Problem**: During test-writing phases (2a, 2b), the spec conformance reviewer
sees tests that import modules that don't exist yet. It flags these as
"missing module" findings.

**Reality**: This is CORRECT TDD behavior — tests define the interface before
the implementation exists. Missing implementations are NOT findings during
test phases.

**Solution**: The reviewer prompt includes explicit TDD-awareness when the
current phase is test-only. The prompt states: "Missing implementations are
expected. Tests that import non-existent modules are defining the interface,
not broken."

### 6.6 State Machine Corruption

**Problem**: Two bugs in the state machine:

1. **Unconditional `save_state()`**: Phases call `save_state()` even when
   skipped. Without anti-downgrade protection, resuming after a crash re-does
   completed work because the skipped phase overwrites the state with an
   earlier value.

2. **Cached `phase_done()`**: The initial implementation read state once at
   startup and cached it. After `save_state()` writes during execution, the
   cached value is stale and `phase_done()` returns wrong results.

**Solution**:
- `save_state(phase)` compares against persisted state — no-op if current state
  is later
- `phase_done(phase)` reads from disk on every call — never cached

### 6.7 Streaming Timeout on Large Tool Arguments

**Problem**: The LLM streams tool call arguments token by token. When a tool
argument contains large content (e.g., a 20KB file in `create_file`), streaming
can take 10+ minutes or time out entirely.

**Solution**: The `append_file` tool exists specifically for this. Agents are
instructed to:
1. Write the first 2000–4000 words with `create_file`
2. Continue with `append_file` for remaining sections

This keeps each tool call's argument payload small enough to stream reliably.

### 6.8 GIT_DIR Environment Contamination

**Problem**: When the parent Marvin process has `GIT_DIR` set in its
environment, sub-agents inherit it. This causes ALL git commands in the
sub-agent to operate on the **wrong repository** (the parent's repo instead of
the project's repo).

**Solution**: Before spawning sub-agents, either:
- Unset `GIT_DIR` from the child's environment
- Explicitly validate that `.git` exists in the working directory
- Use `--git-dir=.git` per git command

### 6.9 Model Cost Runaway

**Problem**: Opus-tier models are 3× more expensive per request. Debug loops
can run up to 50 rounds. An unconstrained pipeline with opus everywhere can
cost 100× more than expected.

**Solution**:
- Use cheap models (codex) for bulk work (tests, implementation, debug)
- Reserve opus for reviews and adversarial QA only
- Track costs per-provider with the `CostTracker`
- Expose costs via `get_usage` tool and stderr `MARVIN_COST:` output
- Environment variables for round limits: `MARVIN_DEBUG_ROUNDS` (default 50),
  `MARVIN_E2E_ROUNDS` (default 10), `MARVIN_QA_ROUNDS` (default 3)

### 6.10 File Read Context Overflow

**Problem**: Agents read entire large files (>10KB) into the LLM context
window. This degrades LLM performance — the model loses focus, produces lower-
quality outputs, and may truncate its response.

**Solution**: If `read_file` is called on a file >10KB without
`start_line`/`end_line`, the read is rejected with:
- The total line count of the file
- Examples of how to use line ranges

### 6.11 Notes Directory as Cross-Run Memory

**Problem**: Agents in coding mode write to `~/Notes/`, persisting
implementation knowledge across pipeline runs. On the next run, they "cheat"
by reading their old notes, defeating isolated agent execution.

**Solution**: In coding mode, `write_note` redirects to `.marvin/notes/`
inside the project directory. This keeps notes scoped to the current project
and run.

### 6.12 Stdout-to-File Fallback Trap

**Problem**: A natural instinct is to capture agent stdout and write it to a
file when the agent fails to call `create_file`. But agents sometimes dump
chain-of-thought planning text to stdout. The captured file passes size checks
but contains garbage.

**Solution**: Agents MUST use the `create_file` tool explicitly. No
stdout-to-file fallback. Ever.

### 6.13 Context Budget Management

**Problem**: Sub-agents can exhaust their context window reading large files,
leaving no room for output. Different providers have different limits
(Copilot SDK ≈ 128K tokens, Kimi K2.5 ≈ 228K tokens).

**Solution**: Two independent budget systems ensure agents stay within limits:

#### A. Tool-loop budget (non-SDK providers only)
1. **Warning at 180K tokens**: Inject warning into tool results
2. **Compaction at 200K tokens**: Dump full context to
   `.marvin/logs/context-backup-{ts}.jsonl`, replace with system message +
   compact summary + last 8 messages
3. **read_file gating**: If result would push context past warning threshold,
   truncate and tell agent to use smaller ranges

#### B. read_file session budget (all providers, including Copilot SDK)
The `read_file` tool itself tracks cumulative characters returned per session:
- **`_READ_BUDGET_WARN` = 200K chars** (~50K tokens): Warning injected into
  results, reads approaching limit are truncated to fit
- **`_READ_BUDGET_MAX` = 300K chars** (~75K tokens): Hard block — content is
  dumped to `.marvin/memories/dump-{filename}.txt` and an error returned
  directing the agent to read in smaller ranges
- This guard works inside the Copilot SDK's tool loop where the tool-loop
  budget (A) cannot operate, since the SDK drives its own conversation

After compaction, the deterministic memory indexer extracts keywords, file references,
and findings from the backup and writes them to `.marvin/memories/INDEX.md` for
cross-agent recovery.

### 6.14 Review History and Multi-Reviewer Rounds

**Problem**: Spec reviewers rubber-stamp documents without finding real issues,
especially when the model knows the "pass" keyword. Fixers cheat by writing
themselves a clean review and declaring "REVIEW PASSED".

**Solution**:
- **All rounds use 4 parallel reviewers**: Main plan-tier reviewer + 2 aux-tier
  reviewers + 1 quality reviewer. All 4 run every round.
- **Round 1 is adversarial**: Reviewers are told the doc is NEVER perfect and
  must end with `REVIEW_FAILED`. The pass keyword is not mentioned in the R1
  prompt so the model cannot accidentally (or deliberately) use it.
- **Rounds 2+ can pass**: Reviewers check if fixer addressed prior issues.
  A reviewer returning `SPEC_VERIFIED` (or equivalent clean keywords) is
  dropped from subsequent rounds. Review passes only when ALL remaining
  reviewers are satisfied.
- **Clean reviews filtered**: Reviews containing only `SPEC_VERIFIED` / clean
  keywords are omitted from fixer input — fixer sees only actionable issues.
- **Git checkpoints**: `git add -A && git commit` runs before each review round
  and after each fixer round, with descriptive messages. R2+ reviewer prompts
  include the `git diff` of the fixer's changes for accountability.
- **Hardened fixer prompts**: Fixers use a strict `DOCUMENT EDITOR` role:
  read the file → apply patches → stop. No analysis, no self-review, no
  grading, no summary. Must fix ALL cited issues in a single pass.
- **All findings collated**: Every round's output is appended to
  `.marvin/review-history-{doc}.md`. Both reviewers and fixers see prior rounds.
- **Empty output crashes the pipeline**: If all reviewers return empty
  output, the pipeline aborts with `RuntimeError` rather than silently passing.

### 6.15 Write Restrictions for Design-Phase Agents

**Problem**: Fixer agents (spec fixer, UX fixer, design fixer) had full write
access and would create implementation files instead of just fixing docs.

**Solution**: `MARVIN_WRITABLE_FILES` env var restricts which files an agent can
write to (comma-separated relative paths). Additionally, these agents have
`run_command`, `git_commit`, `git_checkout`, `write_note`, `install_packages`,
`launch_agent`, and `launch_research_agent` stripped from their tool set.

Agents with `MARVIN_WRITABLE_FILES` set also bypass the ticket gate — they do
not need to create a ticket before writing, since they are restricted to specific
doc files and cannot cause side effects.

---

## 7. Module Structure (Recommended for Node.js)

The Python implementation is a single ~11K-line file. For Node.js, decompose
into focused modules:

```
src/
├── index.ts              # CLI entry point, arg parsing
├── modes/
│   ├── interactive.ts    # TUI mode (curses-like terminal UI)
│   ├── non-interactive.ts # Subprocess/pipeline mode
│   └── pipeline.ts       # TDD pipeline orchestrator
├── providers/
│   ├── index.ts          # Provider abstraction, unified message types
│   ├── copilot.ts        # Copilot SDK adapter
│   ├── openai.ts         # OpenAI-compatible API adapter
│   ├── anthropic.ts      # Anthropic (via Copilot SDK or direct)
│   ├── gemini.ts         # Google Gemini adapter
│   ├── groq.ts           # Groq adapter
│   └── ollama.ts         # Ollama local adapter
├── tools/
│   ├── registry.ts       # Tool registration, dispatch, string-args fixup
│   ├── coding/           # create_file, append_file, apply_patch, read_file,
│   │                     # code_grep, tree, run_command, git_*, install_packages
│   ├── web/              # web_search, search_news, scrape_page, browse_web
│   ├── knowledge/        # wiki_*, stack_*, search_papers, search_arxiv
│   ├── media/            # movies, games, steam, recipes, music, spotify
│   ├── location/         # places, directions, weather, geolocation
│   ├── productivity/     # notes, calendar, alarms, timers, bookmarks
│   ├── github/           # github_search, github_clone, github_read_file, github_grep
│   ├── blender/          # Blender MCP tools
│   └── system/           # get_usage, exit_app, system_info, profile tools
├── pipeline/
│   ├── state.ts          # Phase state machine (anti-downgrade, fresh reads)
│   ├── agents.ts         # Sub-agent spawning, env var setup, retry loops
│   ├── review.ts         # Review/fix loop orchestration
│   └── context.ts        # Project context injection (_project_context)
├── state/
│   ├── conversations.ts  # Chat log persistence (JSON)
│   ├── config.ts         # Profiles, preferences (YAML)
│   ├── places.ts         # Saved places (JSON)
│   └── tickets.ts        # Ticket system (tk CLI wrapper or native impl)
└── utils/
    ├── costs.ts          # Cost tracking per-provider, per-model
    ├── logging.ts        # Tool call JSONL logging for sub-agents
    ├── paths.ts          # Path security (sandbox enforcement, traversal rejection)
    └── streaming.ts      # Stdout streaming, SSE helpers
```

### 7.1 Key Design Decisions for the Port

1. **Zod for validation**: Use Zod schemas instead of Pydantic. The
   `defineTool` helper should accept a Zod schema and auto-generate JSON Schema
   for the LLM.

2. **Single async runtime**: Use Node.js native `async/await` throughout. No
   worker threads needed — the pipeline is inherently sequential (except phase
   1a's parallel agents, which are child processes).

3. **Child process spawning**: Use `child_process.spawn()` for sub-agents. Set
   `env` explicitly (don't inherit parent's `GIT_DIR`).

4. **SQLite for conversations**: The Python version uses JSON files. For
   Node.js, consider SQLite via `better-sqlite3` for better concurrent access
   and query support.

5. **Streaming**: Use Node.js streams for stdout/stderr. The Copilot SDK likely
   provides its own streaming interface — adapt it to the unified format.

---

## 8. Testing Strategy

### 8.1 No-Mock Policy

All tests MUST use real implementations, not mocks. This is enforced in every
sub-agent prompt.

**Prohibited**:
- `jest.mock()`, `sinon.stub()`, `vi.mock()`, or any test double
- Any test that replaces real behavior with fake behavior

**Required alternatives**:
- In-memory SQLite for database tests
- `supertest` for API tests (real HTTP, no mocking)
- Real file I/O against temp directories (`os.tmpdir()`)
- Integration tests talk to real (local) services

**Rationale**: Mocks hide bugs. Tests with mocks prove the mock works, not the
code. Real implementations catch integration failures, schema mismatches, and
behavioral regressions.

### 8.2 Test Layers

| Layer       | What it tests                              | Framework       |
|------------|---------------------------------------------|-----------------|
| Unit        | Individual tools (real implementations)    | Vitest or Jest  |
| Integration | Pipeline phases, provider adapters         | Vitest or Jest  |
| E2E         | Full Marvin subprocess: send prompt, verify output | Vitest + child_process |
| Cross-compat| Same prompts against Python and Node.js versions, compare outputs | Custom harness |

### 8.3 Testing Pipeline Phases

Each pipeline phase should have tests that:
1. Spawn a sub-agent with a known prompt
2. Verify the expected output file exists and has the right structure
3. Verify state progression (`.marvin/pipeline_state` updated correctly)
4. Verify anti-downgrade protection works

### 8.4 Testing Tool Dispatch

- Test the string-args fixup with all known malformed input formats
- Test path sandboxing with absolute paths, `..` traversal, `.tickets/` access
- Test the 10KB file read guard
- Test ticket gating (first rejection, exempt readonly agents)

---

## 9. Security Model

### 9.1 Path Sandboxing

All file operations in coding mode enforce strict boundaries:

1. **Absolute paths rejected** — all paths must be relative to the working
   directory
2. **Path traversal (`..`) rejected** — cannot escape the working directory
3. **`.tickets/` directory blocked** — must use the `tk` tool instead
4. **Error messages include** the working directory AND a project tree listing

### 9.2 Depth Bounding

`MARVIN_DEPTH` is incremented on each sub-agent spawn. Implementations should
enforce a maximum depth to prevent infinite recursion (suggested: depth 5).

### 9.3 Tool Gating

- Write tools gated on ticket creation (§6.4)
- Readonly agents have write tools blocked entirely
- Non-interactive mode auto-approves all tool calls (no user confirmation)
- Interactive mode shows tool names before execution

### 9.4 API Key Security

- API keys read from environment variables or fallback files (`~/.ssh/KEY_NAME`)
- Keys are never logged, persisted to chat history, or included in sub-agent
  prompts
- OAuth tokens stored in profile directory (`tokens.json`)

---

## 10. Design Invariants

These properties MUST hold at all times:

1. **State never downgrades** — `save_state(phase)` is a no-op if the
   persisted state is later than `phase`
2. **Phase reads are never cached** — `phase_done()` always reads from disk
3. **Agents cannot write without a ticket** — write tools are gated on
   `tk create` (except readonly agents)
4. **Paths cannot escape the sandbox** — absolute paths and `..` are rejected
5. **No stdout-to-file fallback** — agents must use `create_file` explicitly
6. **No mocks in tests** — all tests use real implementations
7. **Sub-agent depth is bounded** — `MARVIN_DEPTH` incremented on each spawn
8. **`GIT_DIR` is unset in sub-agents** — prevents operating on wrong repo
9. **Large file reads are bounded** — files >10KB require line ranges
10. **Tool errors are actionable** — never return opaque error messages
11. **Cost tracking is per-provider** — every LLM call records model and cost
12. **Document generation is verified** — files must exist and be ≥1000 bytes
