# Marvin CLI — Interface Reference

> **Purpose**: Authoritative reference for the Marvin CLI's external interface.
> Describes every invocation mode, I/O contract, environment variable, tool,
> exit code, and state boundary.  Language-agnostic — useful whether your
> integrator is written in TypeScript, Go, Rust, or anything else.
>
> **Audience**: Any developer building software that spawns, wraps, or
> orchestrates the Marvin CLI.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Invocation Modes](#2-invocation-modes)
3. [Non-Interactive Mode — The Integration Contract](#3-non-interactive-mode--the-integration-contract)
4. [Design-First Pipeline](#4-design-first-pipeline)
5. [State Boundaries](#5-state-boundaries)
6. [Conversation History Format](#6-conversation-history-format)
7. [User Profile System](#7-user-profile-system)
8. [Stdout Streaming Format](#8-stdout-streaming-format)
9. [Stderr Output Format](#9-stderr-output-format)
10. [Tool Calling Behavior](#10-tool-calling-behavior)
11. [Interactive Slash Commands](#11-interactive-slash-commands)
12. [Environment Variables](#12-environment-variables)
13. [Complete Tool Catalog](#13-complete-tool-catalog)
14. [Exit Codes](#14-exit-codes)
15. [Integration Notes](#15-integration-notes)

---

## 1. Architecture Overview

Marvin is a single-process CLI assistant with ~90 local tools, multiple LLM
provider back-ends, a user profile system, persistent conversation history, and
a multi-phase coding-agent pipeline.  It runs locally — no containers, no cloud
deployment.

```
┌───────────────────────────────────────────────────┐
│                    Marvin CLI                      │
│                                                   │
│  ┌────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │  Profile    │  │   Chat    │  │   Tools      │  │
│  │  System     │  │   Log     │  │  (~90 local  │  │
│  │            │  │           │  │   & web)     │  │
│  └────────────┘  └───────────┘  └──────────────┘  │
│  ┌────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ Preferences│  │  Notes    │  │  LLM Router  │  │
│  │  (YAML)    │  │ ~/Notes   │  │ Copilot/Gem/ │  │
│  │            │  │           │  │ Groq/Ollama  │  │
│  └────────────┘  └───────────┘  └──────────────┘  │
└───────────────────────────────────────────────────┘
```

**Key principle**: Marvin is *stateful* in interactive mode (conversation
history, preferences, alarms, session context persist across prompts) and
*stateless* in non-interactive mode (one prompt in, one response out, process
exits).  An integrator that needs multi-turn conversation must manage history
externally and inject it into each `--prompt` invocation.

---

## 2. Invocation Modes

### 2.1 Interactive (Default)

```bash
python app.py              # curses TUI (default)
python app.py --plain      # readline-based plain terminal
python app.py --curses     # explicitly request curses
python app.py --provider gemini   # override LLM provider
```

Full-featured mode.  Loads chat history, preferences, saved places.  Maintains
conversation across prompts.  Supports slash commands, shell mode, voice input.

### 2.2 Single-Shot (Inline Prompt)

```bash
python app.py "What's the weather in Tokyo?"
```

Runs one prompt through the interactive UI, displays the response, then returns
to the prompt loop.

### 2.3 Non-Interactive (Sub-Agent / Integration)

```bash
python app.py --non-interactive --prompt "What's the weather?"
python app.py --non-interactive --prompt "Build me a web app" --working-dir /path/to/project
python app.py --non-interactive --prompt "..." --ntfy my-topic
```

Executes one prompt, streams the response to stdout, emits cost data to stderr,
then exits.  See §3.

### 2.4 Design-First Pipeline

```bash
python app.py --non-interactive --design-first --prompt "Build a chat web UI" --working-dir /path
```

Bypasses the LLM conversation loop entirely. Creates a ticket and launches a
multi-phase TDD pipeline (spec → UX → architecture → tests → implementation →
debug → E2E → QA).  See §4.

### 2.5 Wrapper Script

A `marvin` executable shell script is provided in the project root. This is the
**correct** way to invoke Marvin from your server code — it handles the virtual
environment and working directory automatically:

```bash
./marvin                    # interactive mode
./marvin --plain            # interactive, plain terminal
./marvin --non-interactive --prompt "..."   # non-interactive
```

Your server MUST check for this script first when resolving how to spawn Marvin.
Resolution order:
1. `./marvin` executable in the project root (preferred)
2. `python app.py` if `app.py` exists in the project root
3. `node dist/app.js` if it exists (Node.js reimplementation)

The wrapper script handles `uv run`, virtual environments, and correct working
directory. Do NOT hardcode `python app.py` — always check for the `marvin`
script first.

---

This is the primary integration surface.

### 3.1 CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--non-interactive` | Yes | Enables single-shot mode |
| `--prompt TEXT` | Yes* | The user's message |
| `--prompt-file PATH` | Yes* | Read prompt from a file (avoids E2BIG for large prompts) |
| `--working-dir PATH` | No | Sets coding working directory |
| `--design-first` | No | Triggers design-first TDD pipeline (§4) |
| `--ntfy TOPIC` | No | Push notification topic for pipeline alerts |

*One of `--prompt` or `--prompt-file` is required.

### 3.2 What Non-Interactive Mode Does

- Loads user preferences from the active profile
- Builds the full system message (personality, tool instructions, coding rules)
- Loads all ~90 tools; auto-approves every tool call (no user confirmation)
- Embeds compact conversation history into the system message (last 20 entries,
  each truncated to 200 chars) — enough for topic awareness, not full context
- Loads `.marvin/spec.md`, `.marvin/design.md`, `.marvin/ux.md` if present in
  the working directory
- Streams response tokens to stdout in real-time
- Runs the tool loop (up to 50 rounds; always in coding mode)
- Emits cost data to stderr on exit

### 3.3 What Non-Interactive Mode Does NOT Do

- Does NOT seed full conversation history into the LLM message array
- Does NOT persist the conversation to disk
- Does NOT display usage summaries
- Does NOT handle slash commands
- Does NOT support multi-turn conversation within a single invocation

### 3.4 Providing Conversation Context

The compact history embedded in the system message is truncated to 200 chars per
entry — too short for follow-ups like *"tell me more about that second option."*
For proper conversational flow, the integrator should prepend recent messages to
the `--prompt` value:

```
Previous conversation (for context):
  User: Find pizza near me
  Marvin: I found 3 pizza places nearby…
  User: What about the second one?

Current message:
Can you show me the menu?
```

Pass the assembled text as a single `--prompt` argument.  Include the last ≤20
messages.

### 3.5 Subprocess Lifecycle (Language-Agnostic)

1. Build the prompt string (history + current message).
2. Spawn `python app.py --non-interactive --prompt "<PROMPT>"` as a child
   process with separate stdout and stderr pipes.
3. Read stdout incrementally — each chunk is a fragment of the response (see §8).
   **Strip the trailing `\n`** from each read or you will get doubled newlines.
4. When the process exits, read stderr and parse the `MARVIN_COST:` line (see §9).
5. Store the user message and Marvin's assembled response in your own persistent
   store for future context injection.

### 3.6 Read-Only Mode

Set `MARVIN_READONLY=1` in the subprocess environment to strip all write tools
(`create_file`, `apply_patch`, `file_apply_patch`, `git_commit`,
`git_checkout`, `run_command`).  Used internally for review agents; useful any
time you need a read-only analysis pass.

---

## 4. Design-First Pipeline

Triggered by `--design-first`.  Runs a multi-phase, checkpoint-resumable TDD
pipeline.  Each phase writes artifacts under `.marvin/` in the working directory.

### 4.1 Phase Ordering

```
1a  → 1a_review → 1b → 1b_review → 2a → 2b → 3 → 4a → 4b → 4c → 5
```

Completed phases are recorded in `.marvin/pipeline_state`.  Re-running the same
command resumes from the first incomplete phase.

### 4.2 Phase Descriptions

| Phase | Name | Description |
|-------|------|-------------|
| **1a** | Spec + UX | *Sequential*, not parallel.  First a spec agent writes `.marvin/spec.md`, then a UX agent reads the spec and writes `.marvin/ux.md`. |
| **1a_review** | Spec/UX Review | A read-only reviewer (high-tier model) checks spec and UX docs against upstream references.  Up to 2 review rounds with automated fix cycles. |
| **1b** | Architecture + Test Plan | Writes `.marvin/design.md` — file structure, data models, API routes, dependency list, exhaustive test plan. |
| **1b_review** | Design Review | Read-only review of `design.md` against spec and upstream docs. |
| **2a** | Functional Tests (TDD) | Parallel agents write failing unit tests from the test plan. |
| **2b** | Integration Tests (TDD) | Agent writes failing integration/E2E test stubs. |
| **3** | Implementation | Parallel agents implement the codebase to pass the tests.  Followed by a code review pass. |
| **4a** | Debug Loop | Runs tests in a loop; on failure, dispatches a fix agent.  TDD-aware: fixes implementation, not tests (unless the test itself is wrong).  Configurable via `MARVIN_DEBUG_ROUNDS` (default 50). |
| **4b** | E2E Smoke Test | Starts the application, makes real HTTP requests, verifies end-to-end behavior.  Configurable via `MARVIN_E2E_ROUNDS` (default 10). |
| **4c** | Frontend Validation | Fetches served JS/CSS/HTML assets, runs `node --check` on JavaScript, validates all asset URLs return 200, checks inline code escaping.  Catches bugs that backend tests miss (e.g. broken regex in served JS).  Configurable via `MARVIN_FE_ROUNDS` (default 10). |
| **5** | Adversarial QA | Parallel read-only QA agents try to break the app (security, data integrity, edge cases).  Findings are dispatched to a fixer agent.  Configurable via `MARVIN_QA_ROUNDS` (default 3). |

After phases 2a, 2b, 3, and 4a, an automated **code review** pass runs using
the high-tier model in read-only mode.

### 4.3 Model Tiers

The pipeline uses six model tiers, each configurable via environment variable:

| Tier | Env Var | Default | Used For |
|------|---------|---------|----------|
| High | `MARVIN_CODE_MODEL_HIGH` | `claude-opus-4.6` | Code reviews, QA (read-only), plan review |
| Low | `MARVIN_CODE_MODEL_LOW` | `gpt-5.3-codex` | Implementation, review fixes |
| Plan | `MARVIN_CODE_MODEL_PLAN` | `gpt-5.2` | Debugging, QA fixes |
| Plan Gen | `MARVIN_CODE_MODEL_PLAN_GEN` | `gemini-3-pro-preview` | Spec, UX, architecture generation |
| Test Writer | `MARVIN_CODE_MODEL_TEST_WRITER` | `gemini-3-pro-preview` | TDD test writing (unit + integration) |
| Aux Reviewer | `MARVIN_CODE_MODEL_AUX_REVIEWER` | `gpt-5.2` | Additional spec reviewers (parallel) |

### 4.4 Ticket System (`tk`)

The pipeline uses an external `tk` CLI for ticket tracking.  On launch, Marvin
creates an epic ticket and tracks sub-tasks through it.  Sub-agents can create
child tickets with `tk create`, mark progress with `tk start`/`tk close`, and
query dependencies with `tk blocked`.  The `.tickets/` directory is protected —
file tools reject direct edits; agents must use the `tk` tool.

### 4.5 Pipeline Notifications

When `--ntfy TOPIC` is provided, phase transitions and results are pushed to
the given [ntfy.sh](https://ntfy.sh) topic.  Useful for monitoring long-running
pipelines from a phone or dashboard.

---

## 5. State Boundaries

### What Marvin Manages (Do NOT Replicate)

| State | Location | Description |
|-------|----------|-------------|
| User preferences | `~/.config/local-finder/profiles/{name}/preferences.yaml` | Dietary, spice, cuisines, budget, transport |
| Saved places | `~/.config/local-finder/profiles/{name}/saved_places.json` | Bookmarked locations |
| Active profile | `~/.config/local-finder/last_profile` | Which profile is active |
| Alarms | In-memory + `at` daemon | Timer/alarm scheduling |
| OAuth tokens | `~/.config/local-finder/profiles/{name}/tokens.json` | Spotify, Google Calendar |
| Notes | `~/Notes/` | Auto-saved knowledge base |
| Pipeline state | `.marvin/pipeline_state` (in working dir) | Checkpoint for design-first pipeline |
| Tool state | Various | Working directory, ntfy subscriptions, etc. |

### What the Integrator Must Manage

| State | Description |
|-------|-------------|
| Conversation history | Messages exchanged in the current conversation |
| Conversation list | All conversations the user has had (your persistent store) |
| Conversation metadata | Titles, timestamps, active conversation tracking |

### What the Integrator Should NOT Do

- Do NOT manage Marvin's `chat_log.json` — that's for interactive mode only
- Do NOT try to set Marvin's active profile — it reads `last_profile` itself
- Do NOT mock or fake any Marvin tool — all tools run locally
- Do NOT parse Marvin's stdout for structured data — it's free-form text
  (except for `MARVIN_COST:` on stderr)

---

## 6. Conversation History Format

### Marvin's Internal Format (`chat_log.json`)

```json
[
    {"role": "you", "text": "Find pizza near me", "time": "14:30"},
    {"role": "assistant", "text": "I found 3 pizza places nearby...", "time": "14:30"}
]
```

Note: `role` values are `"you"`, `"assistant"`, or `"system"` — not the
standard OpenAI `"user"` / `"assistant"`.

### How Interactive Mode Uses History

On startup, the last 20 entries are loaded as LLM user/assistant messages,
giving Marvin context continuity across sessions.  This does NOT happen in
non-interactive mode.

The integrator should replicate this by including history in the `--prompt`
text (see §3.4).

---

## 7. User Profile System

### Profile Directory Structure

```
~/.config/local-finder/
├── last_profile          # Text file containing the active profile name
├── usage.json            # Lifetime cost tracking
└── profiles/
    ├── main/
    │   ├── preferences.yaml
    │   ├── saved_places.json
    │   ├── chat_log.json
    │   ├── history           # readline input history
    │   └── tokens.json       # OAuth tokens
    └── alex/
        └── ...
```

### Preferences (`preferences.yaml`)

```yaml
dietary: [vegetarian]
spice_tolerance: medium
favorite_cuisines: [italian, japanese]
avoid_cuisines: [fast-food]
budget: moderate
max_distance_km: 10
transport: car
notes: "Allergic to shellfish"
```

Marvin reads this on every prompt and injects it into the system message.  The
integrator does NOT need to pass preferences — Marvin loads them automatically.

### Profile Switching

Marvin has a `switch_profile` tool.  When the user says "I'm Alex", Marvin
calls it and switches all state files.  The integrator should let this happen
transparently.

---

## 8. Stdout Streaming Format

In non-interactive mode, stdout is a raw stream of text tokens — NOT structured
data.

```
Here             ← chunk 1
 are three       ← chunk 2
 pizza places    ← chunk 3
 near you:       ← chunk 4
\n               ← chunk 5 (literal newline in response)
1. Tony's...     ← chunk 6
```

**Key behaviors:**

- Tokens arrive as fast as the LLM generates them
- Each read may contain partial words, full sentences, or just whitespace
- Newlines within the response are part of the content (responses are often
  multi-line with markdown formatting)
- There is NO structured framing (no JSON, no SSE, no length prefixes)
- The stream ends when the process exits
- **Strip trailing `\n`** from each read or output will have doubled newlines

**Tool-call markers**: When Marvin calls tools internally, tool names appear on
stdout as `  🔧 tool1, tool2, tool3` before each tool-execution round.  These
can be detected by the `🔧` prefix and optionally converted to "thinking"
indicators in the UI.

---

## 9. Stderr Output Format

Stderr contains two categories of output:

### 9.1 Debug/Log Messages

Informational messages may appear during execution.  Safe to ignore or log.

### 9.2 Cost Data (Final Line)

The last meaningful line of stderr (on both success and error) is:

```
MARVIN_COST:{"session_cost": 0.12, "llm_turns": 3, "model_turns": {"gpt-5.2": 2, "claude-opus-4.6": 1}, "model_cost": {"gpt-5.2": 0.08, "claude-opus-4.6": 0.04}}
```

**Parsing**: scan stderr lines for the prefix `MARVIN_COST:` and JSON-decode
everything after it.

| Field | Type | Description |
|-------|------|-------------|
| `session_cost` | float | Total USD for this invocation |
| `llm_turns` | int | Total LLM roundtrips |
| `model_turns` | dict[string, int] | Roundtrips per model |
| `model_cost` | dict[string, float] | USD per model |

---

## 10. Tool Calling Behavior

From the integrator's perspective, tool calling is **invisible**.  The
integrator sends a prompt; Marvin handles tool selection, execution, and
response synthesis internally.  The integrator receives only the final textual
response on stdout.

**Internal flow:**

1. LLM receives prompt + system message + tool definitions
2. LLM decides to call 0 or more tools
3. Marvin executes the tools locally (web search, file I/O, API calls, etc.)
4. Tool results are fed back to the LLM
5. Steps 2–4 repeat for up to 50 rounds (non-interactive always uses coding
   mode).  When using the Copilot SDK path, round limits are managed by the SDK.
6. The final response streams to stdout

**Implications for integrators:**

- Long pauses in stdout are normal — tools are executing
- Some responses take 30+ seconds (web scraping, code execution, multi-tool
  chains)
- The integrator should show a "thinking" or "working" indicator during pauses
- Set a generous timeout (≥ 300s for coding mode; hours for `--design-first`)

### Path Security

All file-manipulation tools (`create_file`, `read_file`, `apply_patch`,
`append_file`, `code_grep`, `tree`, etc.) enforce path security:

- **Absolute paths are rejected** — all paths must be relative to the working
  directory.
- **Path traversal (`..`) is rejected** if the resolved path escapes the
  working directory.
- **`.tickets/` is protected** — direct edits are rejected; agents must use the
  `tk` tool.

### `apply_patch` Formats

The primary `apply_patch` tool uses search-and-replace semantics:

| Parameter | Description |
|-----------|-------------|
| `path` | Relative path to file |
| `old_str` | Exact string to find (must match exactly one location) |
| `new_str` | Replacement string (empty string = delete) |

When an LLM sends a Codex-style `*** Begin Patch` diff as the arguments,
Marvin detects it and routes it through a Codex patch applier automatically.
The integrator does not need to handle this — it is transparent.

A separate `file_apply_patch` tool (restricted to `~/Notes/`) supports
unified-diff hunks and simple `REPLACE`/`INSERT`/`DELETE` commands.

---

## 11. Interactive Slash Commands

These commands are available **only** in interactive mode.  They are NOT
available in non-interactive mode and the integrator should NOT pass them as
prompts.

| Command | Description |
|---------|-------------|
| `!shell` / `!sh` | Toggle shell mode (commands execute as bash) |
| `!code` | Toggle coding mode |
| `!voice` | Toggle continuous voice input mode |
| `!v [N]` | One-shot voice recording (N seconds, default 5) |
| `!blender` | Check Blender MCP connection status |
| `!pro PROMPT` | Force Copilot SDK for one query |
| `!COMMAND` | Execute COMMAND as a shell command |
| `preferences` | Open `preferences.yaml` in editor |
| `profiles` | List available profiles |
| `usage` | Show cost summary |
| `saved` | List saved places |
| `quit` / `exit` | Exit application |

> **Note**: Non-interactive mode always runs with coding mode enabled and
> auto-approves all tool calls.

---

## 12. Environment Variables

### Provider Selection

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `copilot` | LLM back-end: `copilot`, `gemini`, `groq`, `ollama`, `openai` |

Can also be set via the `--provider` CLI flag in interactive mode.

### Model Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_MODEL` | *(none)* | Override model for non-interactive mode |
| `MARVIN_CODE_MODEL_HIGH` | `claude-opus-4.6` | High tier: code review, QA, plan review |
| `MARVIN_CODE_MODEL_LOW` | `gpt-5.3-codex` | Low tier: implementation, review fixes |
| `MARVIN_CODE_MODEL_PLAN` | `gpt-5.2` | Plan tier: debugging, QA fixes |
| `MARVIN_CODE_MODEL_PLAN_GEN` | `gemini-3-pro-preview` | Plan gen tier: spec, UX, architecture |
| `MARVIN_CODE_MODEL_TEST_WRITER` | `gemini-3-pro-preview` | Test writer tier: TDD test writing |
| `MARVIN_CODE_MODEL_AUX_REVIEWER` | `gpt-5.2` | Aux reviewer: parallel spec reviewers |

### Provider API Keys

| Variable | Fallback | Provider |
|----------|----------|----------|
| `GROQ_API_KEY` | `~/.ssh/GROQ_API_KEY` | Groq |
| `GEMINI_API_KEY` | `~/.ssh/GEMINI_API_KEY` | Gemini |
| `OPENAI_COMPAT_API_KEY` | *(none)* | OpenAI-compatible endpoints |

### Provider-Specific Models & URLs

| Variable | Default | Provider |
|----------|---------|----------|
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Gemini |
| `OLLAMA_MODEL` | `qwen3-coder:30b` | Ollama |
| `OPENAI_COMPAT_MODEL` | `qwen/qwen3-32b` | OpenRouter/etc. |
| `OPENAI_COMPAT_URL` | `https://openrouter.ai/api/v1/chat/completions` | API endpoint |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |

### Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_DEPTH` | `0` | Sub-agent recursion depth |
| `MARVIN_DEBUG_ROUNDS` | `50` | Max debug loop iterations (Phase 4a) |
| `MARVIN_E2E_ROUNDS` | `10` | Max E2E smoke-test iterations (Phase 4b) |
| `MARVIN_FE_ROUNDS` | `10` | Max frontend validation iterations (Phase 4c) |
| `MARVIN_QA_ROUNDS` | `3` | Max adversarial QA iterations (Phase 5) |
| `MARVIN_READONLY` | *(unset)* | Set to `1` to strip write tools |
| `MARVIN_WRITABLE_FILES` | *(unset)* | Comma-separated relative paths; restricts file writes to only those paths. Also strips `run_command`, `git_commit`, `git_checkout`, `write_note`, `install_packages`, `launch_agent`, `launch_research_agent` |
| `MARVIN_SUBAGENT_LOG` | *(none)* | Path for JSONL tool-call logging |
| `WHISPER_MODEL` | `whisper-large-v3` | Groq Whisper model for speech-to-text |
| `EDITOR` | `nano` | Editor for opening preferences |

### External Service Keys

| Variable | Description |
|----------|-------------|
| `GOOGLE_PLACES_API_KEY` | Google Places (falls back to OpenStreetMap) |
| `GNEWS_API_KEY` | GNews for news search |
| `NEWSAPI_KEY` | NewsAPI.org for news |
| `OMDB_API_KEY` | OMDB for movie details |
| `RAWG_API_KEY` | RAWG for game details |
| `STEAM_API_KEY` | Steam Web API |
| `BLENDER_MCP_HOST` | Blender MCP server host (default `127.0.0.1`) |
| `BLENDER_MCP_PORT` | Blender MCP server port (default `9876`) |

---

## 13. Complete Tool Catalog

Marvin has ~90 tools organized into categories.  The integrator does NOT need to
know about these — Marvin handles all tool calling internally.  This list is for
reference only.

### Location & Places
- `get_my_location` — IP geolocation
- `places_text_search(query, location?)` — Search for places
- `places_nearby_search(lat, lng, radius, type)` — Search near coordinates
- `save_place(name, data)` / `remove_place(name)` / `list_places()` — Bookmarks

### Travel & Directions
- `estimate_travel_time(origin, destination, mode?)`
- `estimate_traffic_adjusted_time(origin, dest)`
- `get_directions(origin, destination, mode?)`

### Web & Search
- `web_search(query)` — DuckDuckGo
- `search_news(query)` — GNews / NewsAPI
- `scrape_page(url)` — Fetch & extract content
- `browse_web(url)` — Render with Lynx

### Knowledge & Research
- `search_papers(query)` — Semantic Scholar
- `search_arxiv(query)` — arXiv
- `wiki_search(query)` / `wiki_summary(title)` / `wiki_full(title)` / `wiki_grep(pattern)`
- `stack_search(query, site?)` / `stack_answers(question_id, site?)`

### Entertainment
- `search_movies(query)` / `get_movie_details(imdb_id)` — OMDB
- `search_games(query)` / `get_game_details(id)` — RAWG
- `steam_search` / `steam_app_details` / `steam_featured` / `steam_player_stats` / `steam_user_games` / `steam_user_summary`
- `recipe_search(query, search_type?)` / `recipe_lookup(id)` — TheMealDB
- `music_search(query, type)` / `music_lookup(mbid, type)` — MusicBrainz

### Spotify
- `spotify_auth()` / `spotify_search(query, type)` / `spotify_create_playlist(name, description?)` / `spotify_add_tracks(playlist_id, track_uris)`

### Coding & Files
- `set_working_dir(path)` / `get_working_dir()`
- `create_file(path, content)` — Create new file (fails if exists)
- `append_file(path, content)` — Append to existing file
- `read_file(path, start_line?, end_line?)` — Read file (or line range)
- `apply_patch(path, old_str, new_str)` — Search-and-replace edit
- `file_apply_patch(path, patch)` — Multi-hunk patch (Notes only)
- `code_grep(pattern, glob?, context_lines?, max_results?)` — Ripgrep search
- `tree(path?, depth?)` — Directory tree
- `run_command(command)` — Execute shell command
- `install_packages(packages, manager?)` — Install packages

### Git
- `git_status()` / `git_diff(staged?, path?)` / `git_commit(message, add_all?)` / `git_log(n?)` / `git_checkout(ref)`

### GitHub
- `github_search(query)` / `github_clone(url)` / `github_read_file(repo, path)` / `github_grep(pattern, path?)`

### Notes & Calendar
- `write_note(filename, content)` / `read_note(filename)` / `notes_mkdir(dirname)` / `notes_ls(path?)`
- `calendar_add_event(...)` / `calendar_delete_event(event_id)` / `calendar_view(date?)` / `calendar_list_upcoming(days?)`

### Notifications & Alarms
- `set_alarm(seconds, message?)` / `list_alarms()` / `cancel_alarm(alarm_id)`
- `generate_ntfy_topic()` / `ntfy_subscribe(topic)` / `ntfy_unsubscribe(topic)` / `ntfy_publish(topic, message, title?)` / `ntfy_list()`

### Profile & Session
- `switch_profile(name)` / `update_preferences(text)` / `compact_history()` / `search_history_backups()` / `get_usage()` / `exit_app()`

### Utilities
- `weather_forecast(location?)` — Open-Meteo
- `convert_units(value, from_unit, to_unit)` / `dictionary_lookup(word)` / `translate_text(text, target_lang, source_lang?)`
- `timer_start(name?)` / `timer_check(name?)` / `timer_stop(name?)`
- `system_info()` / `read_rss(url)` / `download_file(url, filename?)` / `yt_dlp_download(url, audio_only?)`
- `bookmark_save` / `bookmark_list` / `bookmark_search`

### Blender (MCP)
- `blender_get_scene` / `blender_get_object` / `blender_create_object` / `blender_modify_object` / `blender_delete_object` / `blender_set_material` / `blender_execute_code` / `blender_screenshot`

### Agent Dispatch & Tickets
- `launch_agent(ticket_id, prompt, model?, working_dir?, design_first?, tdd?)` — Spawn sub-agent
- `tk(args)` — Run the `tk` ticket CLI (create, start, close, show, ls, dep, add-note, blocked, dep-tree)
- `create_ticket(title, type?, priority?, parent?)` — Create a task ticket (wrapper around `tk create`)
- `ticket_add_dep(ticket_id, depends_on)` / `ticket_start(ticket_id)` / `ticket_close(ticket_id)` / `ticket_add_note(ticket_id, note)` / `ticket_show(ticket_id)` / `ticket_list()` / `ticket_dep_tree()`

---

## 14. Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — prompt executed, response streamed |
| `1` | Error — missing `--prompt`, runtime exception, or LLM failure |

---

## 15. Integration Notes

### 15.1 Subprocess Architecture

The recommended integration pattern is:

```
Your Application  ←→  Your Server  ←→  Marvin subprocess
                      (any language)   (python app.py --non-interactive)
                         │
                         ├── Persistent Store (conversations, messages)
                         ├── Streaming transport to client (SSE, WebSocket, etc.)
                         └── Manages conversation history
```

**The integrator's job:**
1. Store conversations and messages in its own persistent store
2. On each user message, build a prompt with the last ≤20 messages as context
3. Spawn `python app.py --non-interactive --prompt ...` as a subprocess
4. Stream stdout to the client via whatever transport fits your stack
5. Parse `MARVIN_COST:` from stderr and store it
6. Handle conversation CRUD (create, rename, delete, list)

**The integrator does NOT:**
- Manage Marvin's profile, preferences, or saved places
- Parse or intercept tool calls
- Handle slash commands (those are interactive-only)
- Maintain LLM state — Marvin's process exits after each message

### 15.2 Subprocess Lifecycle

```
Integrator receives user message
  │
  ├─ Load last ≤20 messages from conversation
  ├─ Build prompt: history + current message
  ├─ Spawn: python app.py --non-interactive --prompt "$PROMPT"
  │
  ├─ Stream stdout → client (strip trailing \n from each chunk)
  ├─ Wait for process exit
  ├─ Read stderr → parse MARVIN_COST: line
  │
  ├─ Save user message to persistent store
  ├─ Save Marvin's response to persistent store
  └─ Return to idle
```

### 15.3 Timeout Guidance

| Mode | Suggested Timeout |
|------|-------------------|
| Regular prompt | ≥ 300 seconds |
| `--design-first` | Hours (full TDD pipeline) |

### 15.4 Conversation Title Generation

After the first exchange, generate a title by:
- Truncating the first user message to ~60 characters, or
- Asking the LLM to summarize, or
- Using a simple heuristic (first sentence, stripped of punctuation)

### 15.5 Coding Mode via Integration

Non-interactive mode always runs with coding mode enabled, so all coding tools
are available.  To use the design-first pipeline:

```bash
python app.py --non-interactive --design-first --working-dir /path/to/project --prompt "Build a REST API for a todo app"
```

This may run for hours.  The integrator should set appropriate timeouts or
stream progress via the `--ntfy` mechanism.

---

## Appendix A: File Paths Reference

| Path | Description |
|------|-------------|
| `~/.config/local-finder/` | Base config directory |
| `~/.config/local-finder/last_profile` | Active profile name |
| `~/.config/local-finder/usage.json` | Lifetime cost tracking |
| `~/.config/local-finder/profiles/{name}/` | Per-profile directory |
| `~/.config/local-finder/profiles/{name}/preferences.yaml` | User preferences |
| `~/.config/local-finder/profiles/{name}/saved_places.json` | Saved places |
| `~/.config/local-finder/profiles/{name}/chat_log.json` | Conversation history |
| `~/.config/local-finder/profiles/{name}/tokens.json` | OAuth tokens |
| `~/.config/local-finder/profiles/{name}/history` | Input history |
| `~/Notes/` | Auto-saved notes directory |
| `.marvin/spec.md` | Product specification (in working dir) |
| `.marvin/ux.md` | UX design document (in working dir) |
| `.marvin/design.md` | Architecture & test plan (in working dir) |
| `.marvin/pipeline_state` | Pipeline checkpoint (in working dir) |
| `.marvin/upstream/` | Upstream reference docs copied for sub-agents |
| `.marvin-instructions` | Project-specific instructions (in working dir) |
| `.marvin/instructions.md` | Alternative project instructions location |
| `~/.marvin/instructions/{path}.md` | Global per-project instructions |
| `.tickets/` | Ticket system data (managed by `tk`, not editable directly) |

## Appendix B: System Context Injection

Every prompt — interactive or non-interactive — automatically includes:

1. **Personality & rules**: Marvin's identity, behavioral constraints
2. **User preferences**: Dietary, spice, cuisines, budget from YAML
3. **Active profile name**: e.g. "Active profile: main"
4. **Saved places**: All bookmarked locations (so the LLM can resolve "near home")
5. **Compact conversation history**: Last 20 chat log entries (truncated to
   200 chars each).  Present in both interactive and non-interactive modes.
6. **Coding mode instructions** (when coding): Working directory, tool rules
7. **Project instructions** (when `.marvin-instructions`, `.marvin/instructions.md`,
   or `~/.marvin/instructions/{path}.md` exists)
8. **Spec & design docs** (when `.marvin/spec.md` or `.marvin/design.md` exists
   in the working directory)

In addition to compact history (#5), interactive mode also seeds the last 20
chat log entries as full user/assistant messages in the LLM conversation.  This
does NOT happen in non-interactive mode — the integrator should include full
recent messages in the `--prompt` for proper conversational flow.

The integrator does NOT need to provide any of the above context — Marvin builds
it internally.  The integrator only needs to provide conversation history and
the current message.
