# Marvin TypeScript Refactor Plan

## Why

`app.py` is a ~13,000-line Python monolith with accumulated technical debt:
- Single file makes navigation, testing, and tooling nearly impossible
- The TDD pipeline (`--design-first`) is broken and has never reliably worked
- No tests, no type safety, no separation of concerns
- Session stall bugs (SDK timeout leaves `busy=true` forever, duplicate event listeners)
- Blocking patterns intermixed with async code

The existing `marvin-nodejs/` attempt is also broken — partial tool coverage,
wrong abstractions, and still tangled with the broken pipeline.

## What

A clean TypeScript/Node.js rewrite of the **interactive assistant** — the part
that actually works and is used daily. Scope is deliberately narrow.

## Out of Scope

**The `--design-first` TDD pipeline is explicitly excluded.**

The pipeline is broken, overly complex, and not worth reimplementing. When you
need agent-driven code generation, use Copilot CLI directly. The TypeScript
rewrite will expose a clean `--non-interactive` mode that Copilot CLI can call
as a sub-agent, which is sufficient.

**Excluded pipeline features and their env vars**:
- `launch_agent` tool — pipeline sub-agent dispatch. Not needed.
- `tk` tool (coding-mode ticket CLI wrapping `tk create --parent`) — pipeline
  ticket gating. Not needed. The simpler non-coding-mode `create_ticket` /
  `ticket_*` tools for personal task tracking ARE included.
- `install_packages` — assumes Python/uv. Shell `run_command` is sufficient.
- `MARVIN_DEPTH` — sub-agent nesting depth. Not needed without pipeline.
- `MARVIN_TICKET` — parent ticket gating. Not needed without pipeline.
- Pipeline model tier env vars (`MARVIN_CODE_MODEL_PLAN`, `_PLAN_GEN`,
  `_TEST_WRITER`, `_AUX_REVIEWER`) — not needed.

**Retained sub-agent env vars** (useful independently):
- `MARVIN_READONLY` — strips write tools. Useful for read-only analysis passes.
- `MARVIN_SUBAGENT_LOG` — JSONL tool call audit log. Useful for debugging.
- `MARVIN_CODE_MODEL_LOW`, `MARVIN_CODE_MODEL_HIGH` — model overrides for
  non-interactive coding mode and background code review.

**Deferred** (not in v1, may add later):
- Voice input (`!voice`, `!v`) — requires Groq Whisper integration, audio
  recording. Low priority for v1.
- Blender MCP bridge — 7 tools, niche use case. Add when needed.

## Architecture

```
marvin-ts/
├── src/
│   ├── main.ts              # Entry point, arg parsing
│   ├── session.ts           # SessionManager — provider selection, prompt dispatch
│   ├── context.ts           # Context budget manager (180K/200K/226K thresholds)
│   ├── llm/
│   │   ├── copilot.ts       # Copilot SDK provider
│   │   ├── openai.ts        # OpenAI-compatible (Groq, Gemini, OpenRouter, local)
│   │   ├── ollama.ts        # Ollama provider
│   │   └── router.ts        # _provider_chat equivalent, tool loop
│   ├── tools/
│   │   ├── registry.ts      # Tool registry, schema generation
│   │   ├── location.ts      # get_my_location, places_text_search, places_nearby_search
│   │   ├── places.ts        # save_place, remove_place, list_places, setup_google_auth
│   │   ├── travel.ts        # estimate_travel_time, get_directions, traffic_adjusted_time
│   │   ├── weather.ts       # weather_forecast (Open-Meteo)
│   │   ├── web.ts           # web_search, search_news, browse_web, scrape_page
│   │   ├── media.ts         # search_movies, get_movie_details, search_games, get_game_details
│   │   ├── steam.ts         # steam_search, steam_app_details, steam_featured, steam_player_stats, steam_user_*
│   │   ├── music.ts         # music_search, music_lookup (MusicBrainz)
│   │   ├── recipes.ts       # recipe_search, recipe_lookup (TheMealDB)
│   │   ├── notes.ts         # write_note, read_note, notes_ls, notes_mkdir, search_notes
│   │   ├── files.ts         # read_file, create_file, append_file, apply_patch (coding mode)
│   │   ├── files-notes.ts   # file_read_lines, file_apply_patch (~/Notes, non-coding mode)
│   │   ├── coding.ts        # set_working_dir, get_working_dir, code_grep, tree, review_codebase, review_status
│   │   ├── git.ts           # git_status, git_diff, git_commit, git_log, git_blame, git_branch, git_checkout
│   │   ├── shell.ts         # run_command (with confirmation in interactive, auto-approve in non-interactive)
│   │   ├── github.ts        # github_search, github_clone, github_read_file, github_grep
│   │   ├── calendar.ts      # calendar_add_event, calendar_delete_event, calendar_view, calendar_list_upcoming
│   │   ├── wiki.ts          # wiki_search, wiki_summary, wiki_full, wiki_grep
│   │   ├── academic.ts      # search_papers, search_arxiv
│   │   ├── system.ts        # exit_app, system_info, get_usage
│   │   ├── alarms.ts        # set_alarm, list_alarms, cancel_alarm
│   │   ├── timers.ts        # timer_start, timer_check, timer_stop
│   │   ├── ntfy.ts          # generate_ntfy_topic, ntfy_subscribe/unsubscribe/publish/list + polling logic
│   │   ├── spotify.ts       # spotify_auth, spotify_search, spotify_create_playlist, spotify_add_tracks
│   │   ├── maps.ts          # osm_search, overpass_query
│   │   ├── stack.ts         # stack_search, stack_answers
│   │   ├── tickets.ts       # create_ticket, ticket_start/close/add_note/show/list/dep_tree/add_dep
│   │   ├── bookmarks.ts     # bookmark_save, bookmark_list, bookmark_search
│   │   ├── downloads.ts     # download_file, yt_dlp_download
│   │   └── utilities.ts     # convert_units, dictionary_lookup, translate_text, read_rss
│   ├── ui/
│   │   ├── curses.ts        # blessed/neo-neo-blessed TUI
│   │   ├── plain.ts         # readline-based plain UI
│   │   └── shared.ts        # Message types, history, status bar
│   ├── profiles/
│   │   ├── manager.ts       # Profile load/save, switch_profile
│   │   └── prefs.ts         # Preferences YAML, update_preferences
│   ├── history.ts           # Chat log load/save/append, compact_history, search_history_backups
│   ├── usage.ts             # Token tracking, cost accounting
│   └── system-prompt.ts     # _build_system_message equivalent
├── .marvin/
│   ├── spec.md              # Product spec (this project)
│   ├── ux.md                # UX spec
│   └── upstream/            # Reference docs from Python implementation
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Key Decisions

1. **Copilot SDK first**: Default provider is Copilot SDK (`@github/copilot-sdk`).
   All other providers use the OpenAI-compatible `_openai_chat` path.

2. **Modular tools**: Each tool category is a separate file. The registry auto-
   generates OpenAI-format schemas from Zod schemas.

3. **`blessed` for TUI**: Use `blessed` (or `neo-blessed`) for the curses-style
   TUI. It's well-maintained and integrates naturally with Node async.

4. **No mocks in tests**: All tests use real implementations. No jest.mock(),
   no sinon stubs. Integration tests talk to real local services.

5. **Provider-agnostic tool loop**: `runToolLoop()` in `llm/router.ts` handles
   all providers uniformly via OpenAI-compat schema.

6. **Session stall prevention**: The `done` event and `busy` flag are always
   cleaned up in a `finally` block, not inside conditionals. SDK listener
   registered once per session, not per request.

7. **Context budget as infrastructure**: `context.ts` is not a tool — it is a
   core module that `router.ts` calls to check token counts before/after tool
   results. Compaction triggers mid-conversation and is transparent to tools.

8. **ntfy polling is session-level**: On every submitted message (before LLM
   dispatch), `session.ts` calls `ntfy.ts` polling logic to check subscribed
   topics. New notifications are injected as system messages. This is not a
   tool call — it's a session hook.

## Implementation Order

1. `package.json`, `tsconfig.json`, project scaffolding
2. `tools/registry.ts` — Zod-based tool schema generation (needed by everything)
3. `llm/openai.ts` + `llm/router.ts` — tool loop, streaming, cost tracking
4. Core tools: `files.ts`, `shell.ts`, `git.ts`, `web.ts`, `notes.ts`
5. `profiles/`, `history.ts`, `usage.ts`, `context.ts`
6. `system-prompt.ts` — depends on profiles, history, and context being done
7. `ui/plain.ts` — readline UI (simpler, validate the full loop first)
8. `--non-interactive` mode — simpler than curses, validates the pipeline end-to-end
9. Remaining tool categories: `location.ts`, `places.ts`, `travel.ts`,
   `weather.ts`, `media.ts`, `steam.ts`, `music.ts`, `recipes.ts`, `wiki.ts`,
   `academic.ts`, `calendar.ts`, `maps.ts`, `stack.ts`, `alarms.ts`,
   `timers.ts`, `ntfy.ts`, `spotify.ts`, `github.ts`, `coding.ts`,
   `tickets.ts`, `bookmarks.ts`, `downloads.ts`, `utilities.ts`,
   `files-notes.ts`, `system.ts`
10. `llm/copilot.ts` — SDK provider with proper event handling
11. `ui/curses.ts` — blessed TUI

## Review Notes

### Dependency justification for implementation order

- **Registry before router** (step 2 before 3): The tool loop in `router.ts`
  needs tool definitions from the registry to dispatch calls. You can't test
  the loop without at least a stub tool registered.
- **Context before system-prompt** (step 5 before 6): The system prompt builder
  needs to know the context budget to decide how much history to include.
- **Non-interactive before curses** (step 8 before 11): Non-interactive mode is
  a simpler end-to-end test of the full pipeline (prompt → tools → response)
  without any TUI complexity. Get this working first.

### Spec coverage gaps to flag for spec/ux reviewers

These items exist in the upstream docs but are missing from BOTH spec.md and
ux.md. They are handled here in the plan but the spec/ux reviewers should add
them to their respective docs:

- **Weather**: `weather_forecast` tool (Open-Meteo, free, no API key). In
  TOOLS.md but not in spec.md tool categories.
- **Travel/Directions**: `estimate_travel_time`, `get_directions`,
  `estimate_traffic_adjusted_time`. In TOOLS.md but not in spec.md.
- **Timers**: `timer_start`, `timer_check`, `timer_stop`. In TOOLS.md but not
  in spec.md.
- **Bookmarks**: `bookmark_save`, `bookmark_list`, `bookmark_search`. In
  TOOLS.md but not in spec.md.
- **Downloads**: `download_file`, `yt_dlp_download`. In TOOLS.md but not in
  spec.md.
- **Utilities**: `convert_units`, `dictionary_lookup`, `translate_text`,
  `read_rss`, `system_info`. In TOOLS.md but not in spec.md.
- **Non-coding file tools**: `file_read_lines`, `file_apply_patch` (restricted
  to ~/Notes). In TOOLS.md but not in spec.md.
- **Notes**: `notes_mkdir` tool is in TOOLS.md but not in spec.md §4.10.
- **GitHub**: `github_search` tool is in TOOLS.md but not in spec.md §4.14.
- **Git**: `git_blame`, `git_branch` are in spec.md §4.13 but the plan's tree
  previously omitted them. Now included.
- **Context budget compaction UX**: spec.md §7 describes compaction at 200K
  tokens, but ux.md only mentions a "Context limit warning" in the error table
  — doesn't describe what the user sees during compaction (system message about
  compacted messages, backup path).
- **Non-coding ticket tools**: `create_ticket`, `ticket_*` are in TOOLS.md as
  non-coding-mode tools for personal task tracking. Not in spec.md.
- **Compact history tool**: `compact_history` and `search_history_backups` are
  tools the LLM can call (TOOLS.md). Not in spec.md.

### Scope boundary: what pipeline features leak into non-pipeline code

Some pipeline features are used by the interactive assistant independently:
- **`MARVIN_READONLY`**: Used to strip write tools for read-only analysis. Keep.
- **Ticket tools (non-coding)**: `create_ticket`, `ticket_list`, etc. are
  personal task tracking tools, not pipeline gating. Keep.
- **Background code review**: `review_codebase` / `review_status` launch a
  background marvin process. This is independent of the pipeline. Keep.
- **`.marvin-instructions`**: Loaded into system prompt when working-dir is set.
  This is project-level context, not pipeline. Keep.

Pipeline-only features that are cleanly excluded:
- `launch_agent` tool (spawns sub-agents with `MARVIN_DEPTH` / `MARVIN_TICKET`)
- `tk` tool (coding-mode wrapper around `tk` CLI with first-rejection gating)
- Phase state machine (`.marvin/pipeline_state`)
- All review/fix loops
- `install_packages` tool (Python/uv specific)
