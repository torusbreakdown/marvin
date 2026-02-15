# Marvin CLI — Interface & Integration Specification

> **Purpose**: This document is the authoritative reference for any software that
> integrates with Marvin (app.py). It describes every interaction mode, every
> input/output contract, every piece of state Marvin manages, and how an
> integrator (like a web bridge) must behave to replicate the full interactive
> experience.
>
> **Audience**: LLM coding agents building bridges, web UIs, API wrappers, or
> any other consumer of the Marvin CLI.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Invocation Modes](#2-invocation-modes)
3. [Non-Interactive Mode — The Bridge Contract](#3-non-interactive-mode--the-bridge-contract)
4. [State Management — What Marvin Handles vs What the Bridge Handles](#4-state-management)
5. [Conversation History Format](#5-conversation-history-format)
6. [User Profile System](#6-user-profile-system)
7. [Stdout Streaming Format](#7-stdout-streaming-format)
8. [Stderr Output Format](#8-stderr-output-format)
9. [Tool Calling Behavior](#9-tool-calling-behavior)
10. [Interactive Commands & Slash Commands](#10-interactive-commands)
11. [Environment Variables](#11-environment-variables)
12. [Complete Tool Catalog](#12-complete-tool-catalog)
13. [Exit Codes](#13-exit-codes)
14. [Integration Patterns](#14-integration-patterns)

---

## 1. Architecture Overview

Marvin is a single-file Python CLI assistant (`app.py`) with 70+ tools, multiple
LLM provider backends, a user profile system, persistent conversation history,
and a coding agent pipeline. It runs locally — no cloud deployment, no Docker.

```
┌─────────────────────────────────────────────────┐
│                    Marvin CLI                    │
│                                                 │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Profile   │  │   Chat   │  │    Tools     │  │
│  │  System    │  │   Log    │  │  (70+ local  │  │
│  │            │  │          │  │   & web)     │  │
│  └───────────┘  └──────────┘  └──────────────┘  │
│  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Preferences│  │  Notes   │  │  LLM Router  │  │
│  │  (YAML)   │  │ ~/Notes  │  │ Copilot/Gem/ │  │
│  │           │  │          │  │ Groq/Ollama  │  │
│  └───────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

**Key principle**: Marvin is a *stateful local assistant*. In interactive mode,
it maintains conversation history, user preferences, saved places, alarms, and
session context across prompts. Any integration that wants to replicate the
interactive experience must either (a) let Marvin manage its own state files, or
(b) provide equivalent context in each invocation.

---

## 2. Invocation Modes

### 2.1 Interactive (Default)

```bash
python app.py              # curses TUI (default)
python app.py --plain      # readline-based plain text
python app.py --curses     # explicitly curses
```

Full-featured mode. Loads chat history, preferences, saved places. Maintains
conversation across prompts. Has slash commands, shell mode, voice mode.

### 2.2 Non-Interactive (Single-Shot)

```bash
python app.py --non-interactive --prompt "What's the weather?"
python app.py --non-interactive --prompt "Build me a web app" --working-dir /path/to/project
python app.py --non-interactive --prompt "..." --design-first --ntfy my-topic
```

Executes one prompt, streams the response to stdout, emits cost data to stderr,
and exits. **This mode is stateless by default** — it does NOT load conversation
history from disk. It DOES load:
- User preferences (from the active profile)
- System message (personality, tool instructions, coding rules)
- Spec/design docs (if `--working-dir` points to a project with `.marvin/` files)
- All tools

### 2.3 Design-First Pipeline

```bash
python app.py --non-interactive --design-first --prompt "Build a chat web UI" --working-dir /path
```

Bypasses the LLM conversation entirely. Creates a ticket, then launches a
multi-phase TDD pipeline (spec → architecture → tests → implementation → debug).

---

## 3. Non-Interactive Mode — The Bridge Contract

This is the most important section for web UI / bridge integrators.

### 3.1 Input

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--non-interactive` | Yes | Enables single-shot mode |
| `--prompt TEXT` | Yes | The user's message |
| `--working-dir PATH` | No | Sets coding working directory |
| `--design-first` | No | Triggers TDD pipeline instead of chat |
| `--ntfy TOPIC` | No | Push notification topic for alerts |

### 3.2 What Non-Interactive Mode Does NOT Do

- ❌ Does NOT load conversation history from `chat_log.json`
- ❌ Does NOT persist the conversation to `chat_log.json`
- ❌ Does NOT display usage summaries
- ❌ Does NOT handle slash commands (`!code`, `!shell`, etc.)
- ❌ Does NOT support multi-turn conversation within a single invocation

### 3.3 What Non-Interactive Mode DOES Do

- ✅ Loads user preferences from the active profile
- ✅ Builds the full system message (personality, tool instructions, coding rules)
- ✅ Loads all 70+ tools
- ✅ Auto-approves all tool calls (no user confirmation prompts)
- ✅ Streams response tokens to stdout in real-time
- ✅ Runs the tool loop (always 50 rounds — non-interactive is always coding mode)
- ✅ Emits cost data to stderr on exit
- ✅ Loads `.marvin/spec.md` and `.marvin/design.md` if present in working-dir

### 3.4 The Bridge's Responsibility

**Because non-interactive mode is stateless, the bridge MUST provide conversation
context in the prompt itself.** Marvin's interactive mode loads the last 20 chat
log entries into the conversation. The bridge must do the equivalent:

```python
# Bridge builds the prompt with history context
prompt = ""
if conversation_history:
    prompt += "CONVERSATION HISTORY (most recent messages):\n"
    for msg in conversation_history[-20:]:
        role = "User" if msg["role"] == "user" else "Marvin"
        prompt += f"{role}: {msg['text']}\n"
    prompt += "\n---\nCURRENT MESSAGE:\n"
prompt += user_message
```

**Why not just pass the raw message?** Without history, Marvin has no context
about what was discussed previously. It can't follow up on earlier topics,
remember user corrections, or maintain conversational coherence. The interactive
mode seeds 20 messages of history into each LLM call — the bridge must replicate
this.

### 3.5 Subprocess Invocation Pattern

```python
import asyncio
import subprocess

async def send_to_marvin(user_message: str, history: list[dict]) -> AsyncIterator[str]:
    # Build prompt with conversation context
    prompt_parts = []
    if history:
        prompt_parts.append("Previous conversation (for context):")
        for msg in history[-20:]:
            speaker = "User" if msg["role"] == "user" else "Marvin"
            prompt_parts.append(f"  {speaker}: {msg['text']}")
        prompt_parts.append("")
        prompt_parts.append("Current message:")
    prompt_parts.append(user_message)
    full_prompt = "\n".join(prompt_parts)

    proc = await asyncio.create_subprocess_exec(
        "python", "/path/to/app.py",
        "--non-interactive",
        "--prompt", full_prompt,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Stream stdout token by token
    async for chunk in proc.stdout:
        token = chunk.decode("utf-8").rstrip("\n")  # IMPORTANT: strip trailing newline
        yield token

    # Parse cost from stderr
    stderr = (await proc.stderr.read()).decode("utf-8")
    for line in stderr.splitlines():
        if line.startswith("MARVIN_COST:"):
            cost_data = json.loads(line[len("MARVIN_COST:"):])
```

> **⚠️ CRITICAL**: `async for chunk in proc.stdout` yields lines that include a
> trailing `\n`. You MUST strip it with `.rstrip("\n")` or you will get corrupted
> output with doubled newlines in every token.

---

## 4. State Management

### What Marvin Manages Internally (Do NOT Replicate)

| State | Location | Description |
|-------|----------|-------------|
| User preferences | `~/.config/local-finder/profiles/{name}/preferences.yaml` | Dietary, spice, cuisines, budget, transport |
| Saved places | `~/.config/local-finder/profiles/{name}/saved_places.json` | Bookmarked locations |
| Active profile | `~/.config/local-finder/last_profile` | Which profile is active |
| Alarms | In-memory + `at` daemon | Timer/alarm scheduling |
| OAuth tokens | `~/.config/local-finder/profiles/{name}/tokens.json` | Spotify, Google Calendar |
| Notes | `~/Notes/` | Auto-saved knowledge base |
| Tool state | Various | Working directory, ntfy subscriptions, etc. |

### What the Bridge Must Manage

| State | Description | How |
|-------|-------------|-----|
| **Conversation history** | What was said in this conversation | Store messages, pass last 20 in the prompt |
| **Conversation list** | All conversations the user has had | SQLite or similar persistent store |
| **Conversation titles** | Human-readable names for conversations | Generate from first message or let user rename |
| **Active conversation** | Which conversation is currently shown | Session/UI state |
| **Theme preference** | Dark/light mode | `localStorage` or user settings |

### What the Bridge Should NOT Do

- ❌ Do NOT manage Marvin's chat_log.json — that's for interactive mode only
- ❌ Do NOT try to set Marvin's active profile — it reads `last_profile` itself
- ❌ Do NOT mock or fake any Marvin tool — all tools work locally
- ❌ Do NOT parse Marvin's stdout for structured data — it's free-form text
  (except for `MARVIN_COST:` on stderr)

---

## 5. Conversation History Format

### Marvin's Internal Format (chat_log.json)

```json
[
    {"role": "you", "text": "Find pizza near me", "time": "14:30"},
    {"role": "assistant", "text": "I found 3 pizza places nearby...", "time": "14:30"},
    {"role": "you", "text": "What about the second one?", "time": "14:31"},
    {"role": "assistant", "text": "Tony's Pizza is located at...", "time": "14:31"}
]
```

Note: `role` values are `"you"`, `"assistant"`, or `"system"` — NOT the standard
OpenAI `"user"` / `"assistant"`. The bridge can use whatever format it wants
internally; just map to `User:` / `Marvin:` labels when building the prompt for
non-interactive mode.

### How Interactive Mode Uses History

On startup, the last 20 entries are loaded into the LLM conversation as
`{"role": "user", "content": text}` and `{"role": "assistant", "content": text}`
messages. This gives Marvin context continuity across sessions.

The bridge must replicate this by including history in the `--prompt` text.

---

## 6. User Profile System

### Profile Structure

```
~/.config/local-finder/
├── last_profile          # Text file: "main"
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

### Preferences (preferences.yaml)

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

Marvin reads this on every prompt and includes it in the system message.
The bridge does NOT need to pass preferences — Marvin loads them automatically.

### Profile Switching

Marvin has a `switch_profile` tool. When the user says "I'm Alex", Marvin calls
it and switches all state files. The bridge should just let this happen — the
tool handles everything.

---

## 7. Stdout Streaming Format

In non-interactive mode, stdout is a raw stream of text tokens — NOT structured
data. Each line from `process.stdout` is a chunk of the response.

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
- Each read from `process.stdout` may contain partial words, full sentences, or
  just whitespace
- Newlines within the response are part of the content (Marvin's responses are
  often multi-line with markdown formatting)
- There is NO structured framing (no JSON, no SSE, no length prefixes)
- The stream ends when the process exits

**Tool call output**: When Marvin calls tools internally, only the final
synthesized response appears on stdout. The tool call details (names, arguments,
results) are NOT emitted to stdout — they're internal to the LLM conversation.
The bridge will see tools firing as a pause in token output (the LLM stops
streaming while tools execute, then resumes with the response).

---

## 8. Stderr Output Format

Stderr contains two types of output:

### 8.1 Debug/Log Messages

These may appear during execution. They are informational and can be ignored or
logged.

### 8.2 Cost Data (Final Line)

The last line of stderr (always, on both success and error) is:

```
MARVIN_COST:{"session_cost": 0.12, "llm_turns": 3, "model_turns": {"gpt-5.2": 2, "claude-opus-4.6": 1}, "model_cost": {"gpt-5.2": 0.08, "claude-opus-4.6": 0.04}}
```

**Parsing:**

```python
for line in stderr.splitlines():
    if line.startswith("MARVIN_COST:"):
        cost = json.loads(line[len("MARVIN_COST:"):])
        # cost["session_cost"]  → float, total USD
        # cost["llm_turns"]     → int, total LLM roundtrips
        # cost["model_turns"]   → dict[str, int], turns per model
        # cost["model_cost"]    → dict[str, float], USD per model
```

---

## 9. Tool Calling Behavior

From the bridge's perspective, tool calling is **invisible**. The bridge sends a
prompt, and Marvin handles tool selection, execution, and response synthesis
internally. The bridge receives only the final textual response.

**What happens internally:**
1. LLM receives the prompt + system message + tool definitions
2. LLM decides to call 0 or more tools
3. Marvin executes the tools locally (web search, file I/O, API calls, etc.)
4. Tool results are fed back to the LLM
5. LLM generates the next response (possibly calling more tools)
6. Steps 2-5 repeat for up to 50 rounds (non-interactive always uses coding mode).
   When using the Copilot SDK path, round limits are managed by the SDK itself.
7. The final response streams to stdout

**Implications for the bridge:**
- Long pauses in stdout are normal — tools are executing
- Some responses take 30+ seconds (web scraping, code execution, multi-tool chains)
- The bridge should show a "thinking" or "working" indicator during pauses
- There is no way to know WHICH tools are being called from the bridge's
  perspective (stdout is just the response text)
- The bridge should set a generous timeout (≥ 300s for coding mode)

---

## 10. Interactive Commands

These commands are available only in interactive mode (plain or curses). They are
NOT available in non-interactive mode and the bridge should NOT try to pass them
as prompts.

| Command | Description |
|---------|-------------|
| `!shell` | Toggle shell mode (commands execute as bash, not sent to LLM) |
| `!code` | Toggle coding mode (more tool rounds, higher context cap) |
| `!voice` | Toggle continuous voice input mode |
| `!v [N]` | One-shot voice recording (N seconds, default 5) |
| `!blender` | Check Blender MCP connection status |
| `!pro PROMPT` | Force Copilot SDK for one query |
| `preferences` | Open preferences.yaml in editor |
| `profiles` | List available profiles |
| `usage` | Show cost summary |
| `saved` | List saved places |
| `quit` / `exit` | Exit application |

**Bridge equivalent**: If the bridge wants to support coding mode, it should set
`MARVIN_DEPTH` and related env vars, or simply always run in coding mode (which
`_run_non_interactive` does by default — it sets `_coding_mode = True`).

> **Note**: Non-interactive mode always runs with coding mode enabled and
> auto-approves all tool calls. This is by design — sub-agents and bridges need
> full tool access without user confirmation.

---

## 11. Environment Variables

### Provider Selection

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `copilot` | LLM backend: `copilot`, `gemini`, `groq`, `ollama`, `openai` |

### Model Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MARVIN_MODEL` | (none) | Override model for non-interactive mode |
| `MARVIN_CODE_MODEL_HIGH` | `claude-opus-4.6` | Complex tasks (code review, QA, Q&A) |
| `MARVIN_CODE_MODEL_LOW` | `gpt-5.3-codex` | Simple tasks (tests, impl, debug) |
| `MARVIN_CODE_MODEL_PLAN` | (falls back to HIGH) | Planning tasks (spec, architecture) |

### Provider API Keys

| Variable | Fallback | Provider |
|----------|----------|----------|
| `GROQ_API_KEY` | `~/.ssh/GROQ_API_KEY` | Groq |
| `GEMINI_API_KEY` | `~/.ssh/GEMINI_API_KEY` | Gemini |
| `OPENAI_COMPAT_API_KEY` | (none) | OpenAI-compatible endpoints |

### Provider Models

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
| `MARVIN_DEBUG_ROUNDS` | `50` | Max debug loop iterations |
| `MARVIN_E2E_ROUNDS` | `10` | Max end-to-end test iterations |
| `MARVIN_QA_ROUNDS` | `3` | Max QA fix iterations |
| `MARVIN_SUBAGENT_LOG` | (none) | Path for JSONL tool call logging |

### External Service Keys

| Variable | Description |
|----------|-------------|
| `GOOGLE_PLACES_API_KEY` | Google Places (falls back to OpenStreetMap) |
| `GNEWS_API_KEY` | GNews for news search |
| `NEWSAPI_KEY` | NewsAPI.org for news |
| `OMDB_API_KEY` | OMDB for movie details |
| `RAWG_API_KEY` | RAWG for game details |
| `STEAM_API_KEY` | Steam Web API |
| `BLENDER_MCP_HOST` | Blender MCP server host (default: 127.0.0.1) |
| `BLENDER_MCP_PORT` | Blender MCP server port (default: 9876) |

---

## 12. Complete Tool Catalog

Marvin has 70+ tools organized into categories. The bridge does NOT need to know
about these — Marvin handles all tool calling internally. This list is for
reference only.

### Location & Places
- `get_my_location` — Get user's current location via IP geolocation
- `setup_google_auth()` — Set up Google Places/Calendar OAuth
- `places_text_search(query, location?)` — Search for places by name/type
- `places_nearby_search(lat, lng, radius, type)` — Search near coordinates
- `save_place(name, data)` — Bookmark a place
- `remove_place(name)` — Remove a bookmark
- `list_places()` — List all bookmarked places

### Travel & Directions
- `estimate_travel_time(origin, destination, mode?)` — Travel time estimate
- `estimate_traffic_adjusted_time(origin, dest)` — Traffic-aware estimate
- `get_directions(origin, destination, mode?)` — Turn-by-turn directions

### Web & Search
- `web_search(query)` — DuckDuckGo web search
- `search_news(query)` — News search (GNews/NewsAPI)
- `scrape_page(url)` — Fetch and extract page content
- `browse_web(url)` — Render page with Lynx browser

### Knowledge & Research
- `search_papers(query)` — Semantic Scholar search
- `search_arxiv(query)` — arXiv paper search
- `wiki_search(query)` — Wikipedia search
- `wiki_summary(title)` — Wikipedia article summary
- `wiki_full(title)` — Save full Wikipedia article to disk
- `wiki_grep(pattern)` — Search within saved Wikipedia articles
- `stack_search(query, site?)` — Stack Exchange search
- `stack_answers(question_id, site?)` — Get Stack Exchange answers

### Entertainment
- `search_movies(query)` — OMDB movie search
- `get_movie_details(imdb_id)` — Movie details
- `search_games(query)` — RAWG game search
- `get_game_details(id)` — Game details
- `steam_search/app_details/featured/player_stats/user_games/user_summary` — Steam
- `recipe_search(query, search_type?)` — TheMealDB recipe search
- `recipe_lookup(id)` — Full recipe details
- `music_search(query, type)` — MusicBrainz search
- `music_lookup(mbid, type)` — MusicBrainz details

### Spotify
- `spotify_auth()` — Initiate Spotify OAuth
- `spotify_search(query, type)` — Search Spotify catalog
- `spotify_create_playlist(name, description?)` — Create playlist
- `spotify_add_tracks(playlist_id, track_uris)` — Add tracks

### Coding & Files
- `set_working_dir(path)` — Set working directory
- `get_working_dir()` — Get current working directory
- `create_file(path, content)` — Create a new file
- `read_file(path)` — Read file contents
- `apply_patch(path, old_str, new_str)` — Search-replace edit
- `file_read_lines(path, start, end)` — Read specific lines
- `file_apply_patch(path, patches)` — Multi-hunk patch
- `code_grep(pattern, path?, glob?)` — Ripgrep search
- `tree(path?, depth?)` — Directory tree
- `run_command(command)` — Execute shell command
- `install_packages(packages, manager?)` — Install packages

### Git
- `git_status()` — Repository status
- `git_diff(path?)` — Show changes
- `git_commit(message, files?)` — Commit changes
- `git_log(n?)` — Recent commits
- `git_checkout(ref)` — Checkout branch/file

### GitHub
- `github_search(query)` — Search GitHub repos
- `github_clone(url)` — Clone a repository
- `github_read_file(repo, path)` — Read file from cloned repo
- `github_grep(pattern, path?)` — Search cloned repos

### Notes & Calendar
- `write_note(filename, content)` — Save note to ~/Notes
- `read_note(filename)` — Read a note
- `notes_mkdir(dirname)` — Create notes subdirectory
- `notes_ls(path?)` — List notes
- `calendar_add_event(title, start, end?, description?)` — Add calendar event
- `calendar_delete_event(event_id)` — Delete event
- `calendar_view(date?)` — View day's events
- `calendar_list_upcoming(days?)` — List upcoming events

### Notifications & Alarms
- `set_alarm(seconds, message?)` — Set a timer/alarm
- `list_alarms()` — List active alarms
- `cancel_alarm(alarm_id)` — Cancel an alarm
- `generate_ntfy_topic()` — Generate random ntfy topic
- `ntfy_subscribe(topic)` — Subscribe to push notifications
- `ntfy_unsubscribe(topic)` — Unsubscribe
- `ntfy_publish(topic, message, title?)` — Send push notification
- `ntfy_list()` — List subscribed topics

### Profile & Session
- `switch_profile(name)` — Switch user profile
- `update_preferences(text)` — Update preferences YAML
- `compact_history()` — Summarize old messages to save tokens
- `search_history_backups()` — Find chat log backups
- `get_usage()` — Session & lifetime cost summary
- `exit_app()` — Exit Marvin

### Utilities
- `weather_forecast(location?)` — Open-Meteo weather
- `convert_units(value, from_unit, to_unit)` — Unit conversion
- `dictionary_lookup(word)` — Dictionary definition
- `translate_text(text, target_lang, source_lang?)` — Translation
- `timer_start(name?)` — Start a stopwatch
- `timer_check(name?)` — Check elapsed time
- `timer_stop(name?)` — Stop and report time
- `system_info()` — System information
- `read_rss(url)` — Read RSS feed
- `download_file(url, filename?)` — Download a file
- `bookmark_save/list/search` — URL bookmarks
- `yt_dlp_download(url, audio_only?)` — Download media via yt-dlp

### Blender (MCP)
- `blender_get_scene/get_object/create_object/modify_object/delete_object`
- `blender_set_material/execute_code/screenshot`

### Agent Dispatch
- `launch_agent(ticket_id, prompt, model?, working_dir?, design_first?, tdd?)` — Spawn sub-agent

---

## 13. Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — prompt executed, response streamed |
| `1` | Error — missing `--prompt`, runtime exception, or LLM failure |

---

## 14. Integration Patterns

### 14.1 Web Chat Bridge (Recommended Architecture)

```
Browser  ←→  FastAPI Server  ←→  Marvin subprocess
              (bridge.py)         (app.py --non-interactive)
                 │
                 ├── SQLite (conversations, messages)
                 ├── SSE streaming to browser
                 └── Manages conversation history
```

**The bridge's job:**
1. Store conversations and messages in its own database
2. On each user message, build a prompt with the last 20 messages as context
3. Spawn `app.py --non-interactive --prompt ...` as a subprocess
4. Stream stdout to the browser via SSE
5. Parse `MARVIN_COST:` from stderr and store it
6. Handle conversation CRUD (create, rename, delete, list)

**The bridge does NOT:**
- Manage Marvin's profile, preferences, or saved places
- Parse or intercept tool calls
- Handle slash commands (those are interactive-only)
- Maintain LLM state — Marvin's process exits after each message

### 14.2 Subprocess Lifecycle

```
Bridge receives user message
  │
  ├─ Load last 20 messages from conversation
  ├─ Build prompt: history + current message
  ├─ Spawn: python app.py --non-interactive --prompt "$PROMPT"
  │
  ├─ Stream stdout → SSE to browser (strip trailing \n from each chunk!)
  ├─ Wait for process exit
  ├─ Read stderr → parse MARVIN_COST: line
  │
  ├─ Save user message to DB
  ├─ Save Marvin's response to DB
  └─ Return to idle
```

### 14.3 SSE Event Format (Bridge → Browser)

The bridge should translate Marvin's raw stdout into structured SSE events:

```
data: {"type": "token", "content": "Here are"}

data: {"type": "token", "content": " three pizza"}

data: {"type": "token", "content": " places near you:"}

data: {"type": "done"}
```

Optionally, the bridge can detect tool activity by monitoring for pauses:

```
data: {"type": "thinking"}         ← after 2s of no tokens
data: {"type": "token", "content": "I found..."}  ← tokens resume
```

### 14.4 Error Handling

```
data: {"type": "error", "message": "Marvin process exited with code 1"}
```

If the subprocess crashes or times out, send an error event and close the SSE
connection.

### 14.5 Conversation Title Generation

After the first exchange in a conversation, the bridge can generate a title by:
- Truncating the first user message to 60 characters
- Or asking the LLM to generate a title (separate non-interactive call)
- Or using a simple heuristic (first sentence, stripped of punctuation)

### 14.6 Coding Mode via Bridge

Non-interactive mode always runs with `_coding_mode = True`, so all coding tools
are available. To use the design-first pipeline via the bridge:

```python
proc = await asyncio.create_subprocess_exec(
    "python", "app.py",
    "--non-interactive",
    "--design-first",
    "--working-dir", "/path/to/project",
    "--prompt", "Build a REST API for a todo app",
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)
```

This will run for potentially hours (the full TDD pipeline). The bridge should
set appropriate timeouts or stream progress.

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

## Appendix B: Marvin's System Context

Every prompt — interactive or non-interactive — includes this context automatically:

1. **Personality & rules** (always): "You are Marvin, a helpful local-business
   and general-purpose assistant..."
2. **User preferences** (always): Dietary, spice, cuisines, budget from YAML
3. **Active profile name** (always): "Active profile: main"
4. **Saved places** (always): All bookmarked locations with labels, addresses,
   and coordinates — so the LLM can resolve references like "near home"
5. **Coding mode instructions** (when coding): Working directory, tool rules,
   auto-notes behavior
6. **Project instructions** (when working-dir has `.marvin-instructions` or
   `.marvin/instructions.md`): Project-specific rules
7. **Spec & design docs** (when working-dir has `.marvin/spec.md` or
   `.marvin/design.md`): Full product spec and architecture

**Note on conversation history seeding**: In interactive mode (non-Copilot
providers), the last 20 chat log entries are loaded into the LLM conversation
for context continuity. This does NOT happen in non-interactive mode or when
using the Copilot SDK provider — the bridge must supply its own history.

The bridge does NOT need to provide any of the above context — Marvin builds it
internally. The bridge only needs to provide conversation history and the current
message.
