# Marvin — Product Specification

> **Version**: 1.0 (TypeScript rewrite)  
> **Scope**: Interactive assistant + non-interactive sub-agent mode.  
> The `--design-first` TDD pipeline is **explicitly out of scope** — use Copilot CLI directly for that.

---

## 1. Overview

Marvin is a local CLI assistant with ~115 tools spanning web search, location,
news, media, notes, coding, calendar, and more. It runs as an interactive
terminal application or as a single-shot non-interactive subprocess.

**Core principle**: Marvin is stateful in interactive mode (conversation
history, preferences, saved places persist across prompts) and stateless in
non-interactive mode (one prompt in, one response out, process exits).

An integrator that needs multi-turn conversation must manage history externally
and inject it into each `--prompt` invocation.

---

## 2. Operating Modes

### 2.1 Interactive (Default)

```bash
marvin                    # curses TUI (default)
marvin --plain            # readline-based plain terminal
marvin --curses           # explicitly request curses
marvin --provider gemini  # override LLM provider
```

- Curses TUI with colored chat, scrolling, status bar, input history
- Loads conversation history from `chat_log.json` (last 20 entries seeded into LLM
  as full user/assistant messages)
- Loads user preferences, saved places, active profile
- All ~115 tools available
- Coding mode toggleable via `!code`
- Shell mode toggleable via `!shell` / `!sh`
- Voice input via `!voice` (continuous) or `!v [N]` (one-shot, N seconds)
- Slash commands: see §2.4

### 2.2 Single-Shot (Inline Prompt)

```bash
marvin "What's the weather in Tokyo?"
```

Runs one prompt through the interactive UI, displays the response, then returns
to the prompt loop. Equivalent to typing the message after launch.

### 2.3 Non-Interactive (Sub-Agent / Integration)

```bash
marvin --non-interactive --prompt "What's the weather?"
marvin --non-interactive --prompt "..." --working-dir /path/to/project
marvin --non-interactive --prompt "..." --ntfy my-topic
```

- Reads prompt from `--prompt` flag or stdin
- Streams response tokens to stdout (raw text, not structured)
- Tool-call markers appear on stdout as `  🔧 tool1, tool2, tool3` before each
  tool-execution round (can be detected by the `🔧` prefix for "thinking" UI)
- Emits cost data to stderr as `MARVIN_COST:{json}` on exit (see §9)
- Does NOT load conversation history into the LLM message array (only compact
  history in the system message — last 20 entries truncated to 200 chars each)
- Does NOT persist conversation to disk
- Always runs in coding mode (`_coding_mode = True`)
- Auto-approves all shell commands (no user confirmation)
- Tool loop up to 50 rounds
- Does NOT handle slash commands
- Does NOT implement `--design-first` (use Copilot CLI directly)

### 2.4 Slash Commands (Interactive Only)

Available only in interactive mode. NOT available in non-interactive mode —
integrators should NOT pass these as prompts.

| Command | Description |
|---------|-------------|
| `!shell` / `!sh` | Toggle shell mode (commands execute as bash) |
| `!code` | Toggle coding mode |
| `!voice` | Toggle continuous voice input mode |
| `!v [N]` | One-shot voice recording (N seconds, default 5) |
| `!blender` | Check Blender MCP connection status |
| `!pro PROMPT` | Force Copilot SDK for one query |
| `!COMMAND` | Execute COMMAND as a shell command |
| `preferences` | Open `preferences.yaml` in `$EDITOR` |
| `profiles` | List available profiles |
| `usage` | Show cost summary |
| `saved` | List saved places |
| `quit` / `exit` / Ctrl+D | Exit application |

---

## 3. LLM Providers

| Provider      | Env Var                | Default Model               |
|---------------|------------------------|-----------------------------|
| copilot       | (SDK auth)             | `claude-haiku-4.5`          |
| gemini        | `GEMINI_API_KEY`       | `gemini-3-pro-preview`      |
| groq          | `GROQ_API_KEY`         | `llama-3.3-70b-versatile`   |
| openai        | `OPENAI_API_KEY`       | `gpt-5.1`                   |
| ollama        | (local)                | `qwen3-coder:30b`           |
| openai-compat | `OPENAI_COMPAT_API_KEY`| `qwen/qwen3-32b`            |

All non-Copilot providers use the OpenAI-compatible chat completion API.

Provider selected via `LLM_PROVIDER` env var or `--provider` flag.

**Per-provider model overrides** (env vars):
- `GROQ_MODEL` — override Groq model (default: `llama-3.3-70b-versatile`)
- `GEMINI_MODEL` — override Gemini model (default: `gemini-3-pro-preview`)
- `OLLAMA_MODEL` — override Ollama model (default: `qwen3-coder:30b`)
- `OPENAI_COMPAT_MODEL` — override OpenAI-compatible model
- `OPENAI_COMPAT_URL` — OpenAI-compatible endpoint URL (default: `https://openrouter.ai/api/v1/chat/completions`)
- `OLLAMA_URL` — Ollama server URL (default: `http://localhost:11434`)

**API key fallbacks**: `GROQ_API_KEY` and `GEMINI_API_KEY` fall back to
reading from `~/.ssh/GROQ_API_KEY` and `~/.ssh/GEMINI_API_KEY` respectively.

The tool loop (`runToolLoop`) runs up to 50 rounds (coding mode) or 10 rounds
(interactive). After max rounds, a final streaming completion is requested.

---

## 4. Tool Categories

> **Tool gating**: In interactive mode, all ~115 tools are available. In coding
> mode (`!code` or `--non-interactive`), coding-specific tools (file ops, git,
> shell, tickets, agents) are added. When `MARVIN_READONLY=1`, write tools
> (`create_file`, `apply_patch`, `file_apply_patch`, `git_commit`,
> `git_checkout`, `run_command`) are stripped.

### 4.1 Location & Geolocation
- `get_my_location` — CoreLocation (macOS) or GeoClue (Linux) with IP fallback
- `places_text_search` — Google Places or OpenStreetMap fallback
- `places_nearby_search` — by coordinates + type
- `setup_google_auth` — enable Google Places API

### 4.2 Saved Places (Address Book)
- `save_place` — save a place with label, name, address, coordinates, notes
- `remove_place` — remove a saved place by label
- `list_places` — list all saved places

### 4.3 Travel & Directions
- `estimate_travel_time` — OSRM routing (driving/cycling/walking), free-flow
- `estimate_traffic_adjusted_time` — weather + time-of-day heuristic adjusted
- `get_directions` — turn-by-turn directions via OSRM with waypoint support

### 4.4 Weather
- `weather_forecast` — Open-Meteo current conditions + multi-day forecast
  (temperature, precipitation, wind, sunrise/sunset). Free, no API key.

### 4.5 Web Search & News
- `web_search` — DuckDuckGo, returns titles/URLs/snippets
- `search_news` — GNews + NewsAPI + DDG News, deduplicated
- `browse_web` — fetch + render page content via Lynx (text browser, no JS)
- `scrape_page` — Selenium + headless Firefox for JS-rendered pages

### 4.6 Wikipedia
- `wiki_search` — search Wikipedia
- `wiki_summary` — article intro/summary
- `wiki_full` — full article saved to disk (NOT returned in context)
- `wiki_grep` — search within a saved article

### 4.7 Academic & Research
- `search_papers` — Semantic Scholar
- `search_arxiv` — arXiv preprints

### 4.8 Stack Exchange
- `stack_search` — search SO/ServerFault/AskUbuntu/Unix
- `stack_answers` — fetch answer body

### 4.9 Movies & Entertainment
- `search_movies` — OMDB or DDG fallback
- `get_movie_details` — ratings, plot, director
- `search_games` — RAWG or DDG fallback
- `get_game_details` — reviews, platforms

### 4.10 Steam
- `steam_search` — search Steam store
- `steam_app_details` — full game info by app ID
- `steam_featured` — current featured games and deals
- `steam_player_stats` — player count + achievements
- `steam_user_games` — user's owned games (requires `STEAM_API_KEY`)
- `steam_user_summary` — user profile summary (requires `STEAM_API_KEY`)

### 4.11 Music & Spotify
- `music_search` — MusicBrainz (artist/album/song)
- `music_lookup` — discography, recordings by MBID
- `spotify_auth` — Spotify OAuth flow (opens callback server, returns login URL)
- `spotify_search` — search Spotify (track/artist/album/playlist)
- `spotify_create_playlist` — create playlist on user's account
- `spotify_add_tracks` — add tracks to playlist by search query

### 4.12 Recipes
- `recipe_search` — TheMealDB by name or ingredient
- `recipe_lookup` — full recipe with ingredients and instructions

### 4.13 Notes
- `write_note` — save to `~/Notes/` (interactive) or `.marvin/notes/` (coding)
- `read_note` — read a note from `~/Notes/`
- `notes_mkdir` — create subdirectory inside `~/Notes/`
- `notes_ls` — list files/dirs inside `~/Notes/`

### 4.14 File Utilities (Non-Coding Mode)
- `file_read_lines` — read lines with line numbers from `~/Notes/` files
- `file_apply_patch` — apply unified-diff or REPLACE/INSERT/DELETE commands
  to files in `~/Notes/`

### 4.15 Files & Coding (Coding Mode Only)
- `read_file` — with 10KB guard requiring line ranges on large files
- `create_file` — create new file (fails if exists)
- `append_file` — append to existing file (use for large files to avoid
  streaming timeout — write first 2000–4000 words with `create_file`, then
  continue with `append_file`)
- `apply_patch` — search-and-replace edit (`path`, `old_str`, `new_str`).
  Also detects and handles Codex `*** Begin Patch` format automatically.
- `set_working_dir` — set working directory for all file operations
- `get_working_dir` — get current working directory
- `code_grep` — ripgrep search with regex, glob filter, context lines
- `tree` — directory tree listing (respects `.gitignore` by default)
- `install_packages` — install packages via `uv` into project venv
- Path security: reject absolute paths, reject `..` traversal, block `.tickets/`
- Error messages must include working dir + directory tree listing

### 4.16 Shell
- `run_command` — requires user confirmation in interactive mode, auto-approved
  in non-interactive mode
- `timeout` parameter (default 60s)

### 4.17 Git
- `git_status` — show working directory status
- `git_diff` — show diff (optional: `staged`, `path`)
- `git_log` — recent commits (optional: `max_count`, `oneline`)
- `git_commit` — stage + commit (optional: `add_all`, acquires directory lock)
- `git_checkout` — checkout branch/commit/file (optional: `create_branch`,
  acquires directory lock)
- Unset `GIT_DIR` before all operations (parent contamination)

### 4.18 GitHub
- `github_search` — search GitHub repos/code/issues/commits/users via `gh` CLI
- `github_clone` — clone a repo to `~/github-clones/<owner>/<repo>`
- `github_read_file` — read a file from cloned repo
- `github_grep` — search within cloned repo

### 4.19 Calendar
- `calendar_add_event` — save event to `.ics` file
- `calendar_delete_event` — delete by UID or title
- `calendar_view` — month grid with events marked
- `calendar_list_upcoming` — upcoming events (default 7 days)
- macOS/Linux platform detection
- Auto-schedules cron reminders (1h and 30m before) via desktop notification
  and ntfy.sh

### 4.20 Alarms & Notifications
- `set_alarm`, `list_alarms`, `cancel_alarm` — cron-based
- `generate_ntfy_topic`, `ntfy_subscribe`, `ntfy_publish`, `ntfy_list`
- `ntfy_unsubscribe`

### 4.21 User & Session
- `switch_profile` — load another user profile
- `update_preferences` — save dietary/budget/location prefs to YAML
- `get_usage` — token counts and estimated costs
- `compact_history` — compact conversation history to target token budget
  (backs up original, compresses older messages, preserves recent)
- `search_history_backups` — search through compacted/dropped history
- `exit_app`

### 4.22 Tickets — Coding Mode (`tk` wrapper)
- `tk` — single tool wrapping the `tk` CLI. Accepts `args` string:
  - `create "title" -t epic --parent PARENT_ID`
  - `start TICKET_ID`, `close TICKET_ID`
  - `add-note TICKET_ID "note"`, `show TICKET_ID`
  - `ls --status=open`, `blocked`, `dep-tree TICKET_ID`
- Required before any file writes in non-interactive mode
- First `tk create` call is intentionally rejected (forces thorough description)

### 4.23 Tickets — Non-Coding Mode (Wrappers)
- `create_ticket` — create a task/bug/feature/epic/chore ticket
- `ticket_add_dep` — add dependency between tickets
- `ticket_start`, `ticket_close` — status transitions
- `ticket_add_note` — add timestamped note
- `ticket_show` — show full ticket details
- `ticket_list` — list tickets with optional status/tag filter
- `ticket_dep_tree` — show dependency tree

### 4.24 Sub-Agent Dispatch (Coding Mode)
- `launch_agent` — spawn sub-agent as child process with:
  - `ticket_id` (required) — from `tk`
  - `prompt` (required) — task description
  - `model` — `auto`/`codex`/`opus`
  - `working_dir`, `design_first`, `tdd` flags

### 4.25 Downloads
- `yt_dlp_download` — download video/audio from YouTube or other sites
  (requires `yt-dlp` installed)
- `download_file` — generic URL file download to `~/Downloads/`

### 4.26 Utilities
- `convert_units` — unit conversion (km↔mi, kg↔lbs, °C↔°F, etc.) and
  currency conversion via Frankfurter API
- `dictionary_lookup` — word definitions, pronunciation, synonyms
  (dictionaryapi.dev, free)
- `translate_text` — text translation via MyMemory API (free, ISO 639-1 codes)
- `timer_start` — start named countdown or stopwatch
- `timer_check` — check timer status (or all active timers)
- `timer_stop` — stop timer and report final time
- `system_info` — OS, CPU, memory, disk, uptime, battery
- `read_rss` — fetch and display RSS/Atom feed entries

### 4.27 Bookmarks
- `bookmark_save` — save URL with title, tags, notes
- `bookmark_list` — list bookmarks (optional tag filter)
- `bookmark_search` — search bookmarks by title/URL/notes/tags

### 4.28 Blender (MCP Integration)
- `blender_get_scene` — get current scene info
- `blender_get_object` — get object details (mesh, materials, transforms)
- `blender_create_object` — create primitive 3D object
- `blender_modify_object` — modify position/scale/rotation
- `blender_delete_object` — delete object by name
- `blender_set_material` — apply material/color (RGBA)
- `blender_execute_code` — execute arbitrary Python in Blender (bpy access)
- `blender_screenshot` — capture viewport screenshot
- Connects to Blender via MCP at `BLENDER_MCP_HOST:BLENDER_MCP_PORT`
  (default `127.0.0.1:9876`)

---

## 5. User Profile System

Profiles stored in `~/.config/local-finder/profiles/<name>/`:
- `chat_log.json` — conversation history (role, text, time)
  - **Role values**: `"you"`, `"assistant"`, `"system"` (NOT standard OpenAI
    `"user"` / `"assistant"`)
- `prefs.yaml` — preferences (dietary, budget, distance, cuisines, saved places)
- `saved_places.json` — bookmarked locations with labels, addresses, coordinates
- `tokens.json` — OAuth tokens (Spotify, Google Calendar)
- `history` — readline/input history
- `ntfy_subscriptions.json` — ntfy push notification subscriptions
- Last active profile stored in `~/.config/local-finder/last_profile`

**Conversation seeding**: On session start (non-copilot providers), last 20
chat log entries are loaded and injected as user/assistant messages.

**History cap**: Conversation capped at 40 messages (interactive) or 100
(coding mode) to avoid unbounded growth.

---

## 6. System Prompt

Built fresh on every request. Contains:
1. Personality/rules ("You are Marvin...")
2. User preferences from YAML
3. Active profile name
4. Saved places (with labels, addresses, coordinates)
5. Compact conversation history (last 20 entries, 200 chars each)
6. Coding mode instructions (when `--working-dir` is set)
7. Background job status (if any running)
8. `.marvin-instructions` / `.marvin/instructions.md` / `~/.marvin/instructions/<path>.md`
   if present in working dir
9. `.marvin/spec.md`, `.marvin/ux.md`, and `.marvin/design.md` if present in working dir

In interactive mode, the last 20 chat log entries are additionally seeded as
full user/assistant messages in the LLM conversation (beyond the compact
history in the system message). This does NOT happen in non-interactive mode.

---

## 7. Stdout Streaming Format

In non-interactive mode, stdout is a raw stream of text tokens — NOT structured
data.

**Key behaviors:**
- Tokens arrive as fast as the LLM generates them
- Each read may contain partial words, full sentences, or just whitespace
- Newlines within the response are part of the content
- There is NO structured framing (no JSON, no SSE, no length prefixes)
- The stream ends when the process exits
- **Strip trailing `\n`** from each read or output will have doubled newlines
- **Tool-call markers**: When Marvin calls tools, tool names appear on stdout as
  `  🔧 tool1, tool2, tool3` before each tool-execution round. Detect by the
  `🔧` prefix and optionally convert to "thinking" indicators in the UI.

---

## 8. Context Budget

| Threshold         | Tokens  | Action                                              |
|-------------------|---------|-----------------------------------------------------|
| Warn              | 180,000 | Append budget warning to tool results               |
| Compact           | 200,000 | Compact middle messages to summary, keep last 8     |
| Hard limit        | 226,000 | Reject large file reads                             |

Context backup saved to `.marvin/logs/context-backup-{ts}.jsonl` before compaction.

**`read_file` budget gate**: If adding a file result would push context past
warn threshold, truncate the result to fit. If no room at all, return error.

---

## 9. Tool Call Robustness

Per `SHARP_EDGES.md`:
- If `arguments` is a string, try `JSON.parse()` first
- If parse fails, return a **helpful** error with the expected format — never
  return opaque errors
- Validation failures must include actionable guidance with examples
- `apply_patch` must detect and handle Codex `*** Begin Patch` format

---

## 10. Cost Tracking

- Per-provider input/output token counts
- Per-tool call counts
- Turn-level recording
- `get_usage` tool surfaces session + lifetime stats
- Lifetime stats persisted to `~/.config/local-finder/usage.json`
- Non-interactive mode emits `MARVIN_COST:{json}` to stderr on exit

**`MARVIN_COST` JSON fields**:

| Field | Type | Description |
|-------|------|-------------|
| `session_cost` | float | Total USD for this invocation |
| `llm_turns` | int | Total LLM roundtrips |
| `model_turns` | dict[string, int] | Roundtrips per model |
| `model_cost` | dict[string, float] | USD per model |

**Parsing**: Scan stderr lines for the prefix `MARVIN_COST:` and JSON-decode
everything after it. The cost line is the last meaningful line of stderr on
both success and error.

---

## 11. Error Handling

- SDK timeout: destroy session, set `done` event, clear `busy` flag
- SDK session listener registered once per session (not per request)
- Provider errors fall back to Copilot SDK if available
- Tool errors always return actionable messages to the LLM
- Large file read guard: files >10KB require `start_line`/`end_line`

---

## 12. Configuration (Environment Variables)

### Provider Selection

| Variable                    | Description                                    |
|-----------------------------|------------------------------------------------|
| `LLM_PROVIDER`              | Active provider (copilot/gemini/groq/ollama/openai/openai-compat) |

### Model Configuration

| Variable                        | Default                | Description                                    |
|---------------------------------|------------------------|------------------------------------------------|
| `MARVIN_MODEL`                  | *(none)*               | Override model for non-interactive mode         |
| `MARVIN_CHAT_MODEL`             | *(none)*               | Chat model for Copilot SDK                     |
| `MARVIN_CODE_MODEL_HIGH`        | `claude-opus-4.6`      | High tier: code review, QA, plan review        |
| `MARVIN_CODE_MODEL_LOW`         | `gpt-5.3-codex`        | Low tier: implementation, review fixes         |
| `MARVIN_CODE_MODEL_PLAN`        | `gpt-5.2`              | Plan tier: debugging, QA fixes                 |
| `MARVIN_CODE_MODEL_PLAN_GEN`    | `gemini-3-pro-preview` | Plan gen tier: spec, UX, architecture          |
| `MARVIN_CODE_MODEL_TEST_WRITER` | `gemini-3-pro-preview` | Test writer tier: TDD test writing             |
| `MARVIN_CODE_MODEL_AUX_REVIEWER`| `gpt-5.2`              | Aux reviewer: parallel spec reviewers          |

### Provider API Keys

| Variable                    | Fallback               | Description                                    |
|-----------------------------|------------------------|------------------------------------------------|
| `GEMINI_API_KEY`            | `~/.ssh/GEMINI_API_KEY`| Gemini API key                                 |
| `GROQ_API_KEY`              | `~/.ssh/GROQ_API_KEY`  | Groq API key                                   |
| `OPENAI_API_KEY`            | *(none)*               | OpenAI API key                                 |
| `OPENAI_COMPAT_API_KEY`     | *(none)*               | OpenAI-compatible endpoint API key             |

### Provider-Specific Models & URLs

| Variable                    | Default                                              | Description              |
|-----------------------------|------------------------------------------------------|--------------------------|
| `GROQ_MODEL`                | `llama-3.3-70b-versatile`                            | Groq model override      |
| `GEMINI_MODEL`              | `gemini-3-pro-preview`                               | Gemini model override    |
| `OLLAMA_MODEL`              | `qwen3-coder:30b`                                    | Ollama model override    |
| `OPENAI_COMPAT_MODEL`       | `qwen/qwen3-32b`                                     | OpenRouter/etc. model    |
| `OPENAI_COMPAT_URL`         | `https://openrouter.ai/api/v1/chat/completions`      | API endpoint URL         |
| `OLLAMA_URL`                | `http://localhost:11434`                              | Ollama server URL        |

### External Service Keys

| Variable                    | Description                                    |
|-----------------------------|------------------------------------------------|
| `GOOGLE_PLACES_API_KEY`     | Google Places API key (falls back to OSM)      |
| `GNEWS_API_KEY`             | GNews for news search                          |
| `NEWSAPI_KEY`               | NewsAPI.org for news                           |
| `STEAM_API_KEY`             | Steam Web API key                              |
| `OMDB_API_KEY`              | OMDB movie API key                             |
| `RAWG_API_KEY`              | RAWG game API key                              |

### Behavior

| Variable                    | Default    | Description                                    |
|-----------------------------|------------|------------------------------------------------|
| `MARVIN_DEPTH`              | `0`        | Sub-agent nesting depth (auto-incremented)     |
| `MARVIN_READONLY`           | *(unset)*  | `"1"` = read-only agent (no write tools)       |
| `MARVIN_SUBAGENT_LOG`       | *(none)*   | Path for tool call audit JSONL                 |
| `MARVIN_DEBUG_ROUNDS`       | `50`       | Max debug loop iterations (Phase 4a)           |
| `MARVIN_E2E_ROUNDS`         | `10`       | Max E2E smoke-test iterations (Phase 4b)       |
| `MARVIN_FE_ROUNDS`          | `10`       | Max frontend validation iterations (Phase 4c)  |
| `MARVIN_QA_ROUNDS`          | `3`        | Max adversarial QA iterations (Phase 5)        |
| `WHISPER_MODEL`             | `whisper-large-v3` | Groq Whisper model for speech-to-text    |
| `EDITOR`                    | `nano`     | Editor for opening preferences                 |

### Blender MCP

| Variable                    | Default        | Description                            |
|-----------------------------|----------------|----------------------------------------|
| `BLENDER_MCP_HOST`          | `127.0.0.1`    | Blender MCP server host                |
| `BLENDER_MCP_PORT`          | `9876`          | Blender MCP server port                |

---

## 13. Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — prompt executed, response streamed |
| `1` | Error — missing `--prompt`, runtime exception, or LLM failure |

---

## 14. Invariants

1. `busy` and `done` are always cleaned up in a `finally` block
2. SDK event listener registered once per session
3. Context never downgrades (compaction backup is append-only)
4. Tool errors are always actionable (never opaque)
5. Paths cannot escape the working directory sandbox
6. Files >10KB require line ranges
7. No mocks in tests — all real implementations
8. `GIT_DIR` unset before all git operations
