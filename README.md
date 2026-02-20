# Marvin

A multi-tool conversational CLI assistant with 107 tools. Searches the web, browses pages, downloads videos, writes code, manages files, checks weather, finds places, plays music, takes notes, does OCR, and more — all from one terminal interface.

Built in TypeScript (Node.js). Supports multiple LLM providers: Ollama (local), OpenAI, Groq, Gemini, GitHub Copilot, and any OpenAI-compatible API.

## Quick Start

```bash
cd marvin-ts
npm install
npm run build

# Run (curses TUI, default)
node dist/main.js

# Specify provider
MARVIN_PROVIDER=ollama node dist/main.js
MARVIN_PROVIDER=openai OPENAI_API_KEY=sk-... node dist/main.js

# Plain terminal mode
node dist/main.js --plain

# Single-shot
node dist/main.js "What's the weather like?"
```

## UI Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Curses TUI** (default) | `node dist/main.js` | Full-terminal UI with status bar, scrolling chat, input history |
| **Plain** | `--plain` | Simple readline-based terminal |
| **Non-interactive** | `--non-interactive --prompt "..."` | Pipe-friendly, single response |

### Keybindings (Curses TUI)

| Key | Action |
|-----|--------|
| Enter | Send message |
| ↑ / ↓ | Browse input history |
| PgUp / PgDn / Shift+↑↓ | Scroll chat |
| Ctrl+A / Ctrl+E | Jump to start/end of line |
| Ctrl+U | Clear input line |
| Ctrl+R | Reverse search history |
| Ctrl+Z | Undo last chat message |
| Ctrl+V | Push-to-talk (voice mode) |
| Escape | Abort current response / Quit |
| Ctrl+Q / Ctrl+D | Quit |

### Bang Commands

| Command | Action |
|---------|--------|
| `!voice` / `!v` | Toggle voice mode (STT input + TTS output) |
| `!mode [surf\|coding\|lockin]` | Show or switch tool mode |
| `!model [provider] [model]` | Show or switch LLM provider/model |
| `!code` | Toggle coding mode |
| `!shell` / `!sh` | Toggle shell mode |
| `!sh <command>` | Run a shell command directly |
| `usage` | Show session usage & costs |
| `quit` / `exit` | Exit |

## LLM Providers

| Provider | Env Vars | Default Model |
|----------|----------|---------------|
| **ollama** | — (localhost:11434) | qwen3-coder:30b |
| **openai** | `OPENAI_API_KEY` | gpt-5.1 |
| **groq** | `GROQ_API_KEY` | llama-3.3-70b-versatile |
| **gemini** | `GEMINI_API_KEY` | gemini-3-pro-preview |
| **copilot** | GitHub CLI auth (`gh auth login`) | claude-haiku-4.5 |
| **llama-server** | — (localhost:8080) | default |
| **openai-compat** | `OPENAI_API_KEY`, `OPENAI_BASE_URL` | default |

Set provider: `MARVIN_PROVIDER=openai` or `!model openai gpt-4o` at runtime.

## Tool Modes

| Mode | Description |
|------|-------------|
| **surf** (default) | All general tools — web, media, notes, places, weather, etc. No file I/O or shell |
| **coding** | File read/write, git, shell, package management + web reference tools |
| **lockin** | Coding tools only — no entertainment, no browsing distractions |

## Voice Support

STT (speech-to-text) via **faster-whisper** with CUDA + batched inference. TTS (text-to-speech) via **espeak-ng** with British English voice.

```bash
# Setup (one-time)
cd marvin-ts
uv venv .venv && uv pip install faster-whisper  # STT
sudo apt install espeak-ng                       # TTS
sudo apt install alsa-utils                      # arecord for mic input
```

Toggle with `!voice`. Press Ctrl+V to record, press again to stop — transcription is submitted automatically. Responses are spoken aloud when voice mode is on.

## OCR

Extract text from images and PDFs via **OCR.space** API (free tier: 25K pages/month).

```bash
# Optional: set your own API key for higher limits
export OCR_SPACE_API_KEY="your-key"
```

The LLM can call `ocr` on any image/PDF file and will clean up any artifacts.

## Optional API Keys

Most tools work with **zero API keys**. These are optional enhancements:

| Key | What | Free Tier |
|-----|------|-----------|
| `GOOGLE_PLACES_API_KEY` | Richer place search (falls back to OSM) | $200/mo credit |
| `OMDB_API_KEY` | Movie/TV details ([omdbapi.com](https://www.omdbapi.com/apikey.aspx)) | 1,000 req/day |
| `RAWG_API_KEY` | Game details ([rawg.io](https://rawg.io/apidocs)) | 20,000 req/mo |
| `GNEWS_API_KEY` | News search ([gnews.io](https://gnews.io)) | 100 req/day |
| `OCR_SPACE_API_KEY` | OCR ([ocr.space](https://ocr.space)) | 25,000 pages/mo |
| `SPOTIFY_CLIENT_ID` / `_SECRET` | Spotify playback control | Free |

### No Key Needed (built-in)

| Service | What | Limit |
|---------|------|-------|
| DuckDuckGo | Web search | Reasonable use |
| Lynx | Web page reading (paginated) | Local |
| Open-Meteo | Weather forecasts | Unlimited |
| OpenStreetMap | Places fallback | 1 req/sec |
| OSRM | Route planning & travel time | 1 req/sec |
| Semantic Scholar / arXiv | Academic paper search | ~100 req/5min |
| ntfy.sh | Push notifications | Unlimited |
| ip-api.com | IP geolocation | 45 req/min |
| yt-dlp | Video downloads | Local |
| OCR.space | OCR (default key) | 25K pages/mo |

### Optional CLI Tools

```bash
pip install yt-dlp     # Video downloads
sudo apt install lynx   # Web browsing (highly recommended)
sudo apt install espeak-ng  # TTS voice output
```

## Features

- **107 tools** across web, coding, media, places, weather, notes, calendar, and more
- **Curses TUI** with colored output, scrolling, status bar, input history, reverse search
- **Multi-provider LLM** — switch models at runtime with `!model`
- **Voice I/O** — speech-to-text input (faster-whisper/CUDA) + text-to-speech output (espeak-ng)
- **OCR** — extract text from images and PDFs
- **Context compaction** — LLM-powered summarization when context gets full
- **Web pagination** — browse_web returns 10K chunks with continuation tokens
- **Session persistence** — conversation history, profiles, preferences survive restarts
- **Undo** — Ctrl+Z removes last chat message from all stores
- **Abort** — Escape cancels in-flight LLM responses
- **Usage tracking** — per-session and lifetime cost estimates
- **Tool call logging** — debug log in `~/.config/local-finder/profiles/<name>/tool-calls.jsonl`
- **SSRF protection** — blocks requests to private/internal network addresses

## All Tools (107)

| Category | Tools |
|----------|-------|
| **Web** | `web_search`, `search_news`, `browse_web`, `scrape_page` |
| **Wiki** | `wiki_search`, `wiki_summary`, `wiki_full`, `wiki_grep` |
| **Academic** | `search_papers`, `search_arxiv` |
| **Location** | `get_my_location`, `osm_search`, `overpass_query` |
| **Places** | `places_text_search`, `places_nearby_search`, `setup_google_auth` |
| **Weather** | `weather_forecast` |
| **Travel** | `estimate_travel_time`, `get_directions` |
| **Media** | `search_movies`, `get_movie_details`, `search_games`, `get_game_details` |
| **Music** | `music_search`, `music_lookup` |
| **Spotify** | `spotify_auth`, `spotify_search`, `spotify_create_playlist`, `spotify_add_tracks`, `spotify_playback`, `spotify_now_playing` |
| **Steam** | `steam_search`, `steam_app_details`, `steam_featured`, `steam_player_stats`, `steam_user_games`, `steam_user_summary` |
| **Downloads** | `download_file`, `yt_dlp_download` |
| **OCR** | `ocr` |
| **Notes** | `write_note`, `read_note`, `notes_ls`, `notes_mkdir`, `search_notes` |
| **Bookmarks** | `bookmark_save`, `bookmark_list`, `bookmark_search` |
| **Calendar** | `calendar_list_upcoming`, `calendar_add_event`, `calendar_delete_event` |
| **Alarms & Timers** | `set_alarm`, `list_alarms`, `cancel_alarm`, `timer_start`, `timer_check`, `timer_stop` |
| **Notifications** | `generate_ntfy_topic`, `ntfy_subscribe`, `ntfy_unsubscribe`, `ntfy_publish`, `ntfy_list` |
| **Recipes** | `recipe_search`, `recipe_lookup` |
| **Stack Overflow** | `stack_search`, `stack_answers` |
| **GitHub** | `github_clone`, `github_read_file`, `github_grep` |
| **Utilities** | `convert_units`, `dictionary_lookup`, `translate_text`, `system_info`, `read_rss` |
| **Profile** | `switch_profile`, `update_preferences`, `get_usage`, `exit_app` |
| **Coding** | `set_working_dir`, `read_file`, `create_file`, `append_file`, `apply_patch`, `list_files`, `grep_files`, `find_files`, `review_codebase`, `review_status` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_blame`, `git_commit`, `git_branch`, `git_checkout` |
| **Shell** | `run_command`, `install_packages` |
| **Blender** | `blender_get_scene`, `blender_get_object`, `blender_create_object`, `blender_modify_object`, `blender_delete_object`, `blender_set_material`, `blender_execute_code`, `blender_screenshot` |

## Architecture

```
marvin-ts/
├── src/
│   ├── main.ts          # CLI entry, REPL loop, slash commands
│   ├── session.ts       # Session state, compaction, undo
│   ├── context.ts       # Context budget management
│   ├── system-prompt.ts # System prompt builder
│   ├── types.ts         # Shared types
│   ├── history.ts       # Chat log persistence
│   ├── usage.ts         # Cost tracking
│   ├── llm/
│   │   ├── router.ts    # Tool loop, repairToolPairs
│   │   ├── openai.ts    # OpenAI-compatible provider
│   │   ├── ollama.ts    # Ollama provider
│   │   ├── copilot.ts   # GitHub Copilot provider
│   │   └── llama-server.ts
│   ├── ui/
│   │   ├── curses.ts    # neo-blessed TUI
│   │   ├── plain.ts     # readline UI
│   │   └── shared.ts    # UI interface
│   ├── tools/           # 35 tool modules
│   ├── voice/
│   │   ├── voice.ts     # STT/TTS orchestration
│   │   └── stt.py       # faster-whisper Python helper
│   └── profiles/
│       └── manager.ts   # Profile & preferences management
├── .venv/               # Python venv (faster-whisper for STT)
└── dist/                # Compiled JS output
```
