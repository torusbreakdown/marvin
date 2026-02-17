# Marvin Tool Specification

Complete specification of every tool Marvin exposes to the LLM. A reimplementation
MUST support all of these tools with identical parameter schemas and return formats.

Tools are grouped by category. Each tool shows:
- Function name (this is the tool name the LLM calls)
- Description (shown to the LLM in the tool schema)
- Parameters with types, defaults, and descriptions
- Notes on behavior, edge cases, and return format

## Path Security Model (applies to all file/coding tools)

All file-path parameters in coding mode enforce strict boundaries:
1. **Absolute paths are rejected** — all paths must be relative to the working directory.
2. **Path traversal (`..`) is rejected** — cannot escape working directory.
3. **`.tickets/` is blocked** — must use the `tk` tool instead.
4. On rejection, the error message includes the working directory AND a project tree listing.

## Tool Call Format

All tool calls are JSON objects with named parameters. Arguments must NEVER be a raw string.
```json
{"name": "tool_name", "arguments": {"param1": "value1", "param2": 42}}
```

---



## Location & Geolocation
### `get_my_location` (line 726)
**Description**: Get the user's current location. Tries the device's location services (CoreLocation on macOS, GeoClue on Linux) first, then falls back to IP-based geolocation. Returns latitude, longitude, and source.
**Parameters**: None

### `setup_google_auth` (line 778)
**Description**: Set up Google Cloud authentication and enable the Places API. Call this when a Places API request fails with a permissions or auth error (403, 401, PERMISSION_DENIED, etc.). This tool will: 1) check g
**Parameters**: None


## System & Application
### `exit_app` (line 846)
**Description**: Exit the application. Call this when the user wants to quit, e.g. 'exit', 'quit', 'bye', 'goodbye', 'close', 'done', 'stop'.
**Parameters** (ExitAppParams):
  - `message`: `str` (default: 'Goodbye!') — Optional farewell message to display before exiting


## Alarms & Notifications
### `set_alarm` (line 932)
**Description**: Set an alarm that fires at a specific time using a cron job. The alarm will show a desktop notification and play a sound. Accepts absolute times ('14:30', '2026-03-01 09:00') or relative times ('30m',
**Parameters** (SetAlarmParams):
  - `time`: `str` (required) — When the alarm should fire. Accepts: 'HH:MM' for today/tomorrow, 'YYYY-MM-DD HH:MM' for a specific date, or relative like '30m', '2h', '1h30m'.
  - `message`: `str` (required) — The alarm message to display, e.g. 'Time to leave for ramen!'
  - `label`: `str` (default: 'local-finder-alarm') — Short label for identifying this alarm

### `list_alarms` (line 1010)
**Description**: List all active Marvin alarms. Shows label, scheduled time, and message for each alarm.
**Parameters**: None

### `cancel_alarm` (line 1042)
**Description**: Cancel an alarm by its label. Removes the cron job and cleanup script.
**Parameters** (CancelAlarmParams):
  - `label`: `str` (required) — Label of the alarm to cancel (use list_alarms to see labels)


## Push Notifications (ntfy.sh)
### `generate_ntfy_topic` (line 1311)
**Description**: Generate a unique ntfy.sh notification topic URL using a correct-horse-battery-staple style name (5 random dictionary words). Returns the topic name and full URL. Optionally subscribes automatically.
**Parameters** (GenerateNtfyTopicParams):
  - `label`: `str` (default: '') — Optional friendly label for this topic (e.g. 'dinner alerts', 'deal watch')

### `ntfy_subscribe` (line 1339)
**Description**: Subscribe to an existing ntfy.sh topic to receive notifications. New messages will be checked and shown on every prompt.
**Parameters** (NtfySubscribeParams):
  - `topic`: `str` (required) — The ntfy topic name to subscribe to
  - `label`: `str` (default: '') — Friendly label for this subscription

### `ntfy_unsubscribe` (line 1354)
**Description**: Unsubscribe from a ntfy.sh topic.
**Parameters** (NtfyUnsubscribeParams):
  - `topic`: `str` (required) — The ntfy topic name to unsubscribe from

### `ntfy_publish` (line 1372)
**Description**: Send a push notification to a ntfy.sh topic. Use this when the user wants to send themselves a reminder, share a link to their phone, or notify someone.
**Parameters** (NtfyPublishParams):
  - `topic`: `str` (required) — The ntfy topic to publish to
  - `message`: `str` (required) — The notification message to send
  - `title`: `str` (default: '') — Optional notification title

### `ntfy_list` (line 1393)
**Description**: List all active ntfy.sh subscriptions and check for new notifications.
**Parameters**: None


## Usage & Billing
### `get_usage` (line 1424)
**Description**: Show current session and optionally lifetime API usage and estimated costs. Call this when the user asks about usage, costs, or billing.
**Parameters** (GetUsageParams):
  - `include_lifetime`: `bool` (default: False) — Also include lifetime cumulative usage across all sessions


## Web Search & News
### `web_search` (line 1456)
**Description**: Search the web using DuckDuckGo. Returns titles, URLs, and snippets. THIS IS THE DEFAULT TOOL FOR ALL WEB SEARCHES. Use this FIRST whenever the user asks to look something up, find information, search
**Parameters** (WebSearchParams):
  - `query`: `str` (required) — The search query
  - `max_results`: `int` (default: 5) — Maximum number of results to return (1-20)
  - `time_filter`: `str` (default: '') — Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)

### `search_news` (line 1520)
**Description**: Search for recent news articles on ANY topic. Queries GNews, NewsAPI, and DuckDuckGo News simultaneously, deduplicates, and returns ALL articles from the last 2 days. Use this whenever the user asks a
**Parameters** (SearchNewsParams):
  - `query`: `str` (required) — News search query, e.g. 'AI regulation' or 'SpaceX launch'
  - `max_results`: `int` (default: 20) — Max results per source (1-50)
  - `time_filter`: `str` (default: '') — Time filter: 'd' = past day, 'w' = past week, 'm' = past month. Empty = any time.


## Academic & Research
### `search_papers` (line 1647)
**Description**: Search for academic papers using Semantic Scholar. Returns titles, authors, year, citation count, abstract, and PDF links when available. Use this for general academic/scientific paper searches. Free,
**Parameters** (SearchPapersParams):
  - `query`: `str` (required) — Search query for academic papers
  - `max_results`: `int` (default: 5) — Maximum results to return (1-20)
  - `year_min`: `int` (default: 0) — Filter papers from this year onward (0 = no filter)
  - `year_max`: `int` (default: 0) — Filter papers up to this year (0 = no filter)
  - `open_access_only`: `bool` (default: False) — Only return papers with free PDF links

### `search_arxiv` (line 1716)
**Description**: Search arXiv for preprints. Returns titles, authors, abstract, and direct PDF links. Best for recent/cutting-edge research in physics, CS, math, biology, and other sciences. Free, no API key.
**Parameters** (SearchArxivParams):
  - `query`: `str` (required) — Search query for arXiv preprints
  - `max_results`: `int` (default: 5) — Maximum results (1-20)
  - `sort_by`: `str` (default: 'relevance') — Sort by: 'relevance', 'lastUpdatedDate', or 'submittedDate'


## Movies & Games
### `search_movies` (line 1818)
**Description**: Search for movies and TV shows. Uses OMDB if API key is set, otherwise falls back to DuckDuckGo web search. Use this when users ask about film reviews, movie ratings, or 'is X movie good'.
**Parameters** (SearchMoviesParams):
  - `query`: `str` (required) — Movie or TV show title to search for
  - `year`: `str` (default: '') — Optional year to narrow results
  - `type`: `str` (default: '') — Optional type filter: 'movie', 'series', or 'episode'

### `get_movie_details` (line 1869)
**Description**: Get detailed info and reviews for a specific movie/show from OMDB. Returns plot, ratings (IMDb, Rotten Tomatoes, Metacritic), director, actors, awards, and more. Use after search_movies.
**Parameters** (GetMovieDetailsParams):
  - `title`: `str` (default: '') — Movie title (use this or imdb_id)
  - `imdb_id`: `str` (default: '') — IMDb ID like 'tt1234567'

### `search_games` (line 1941)
**Description**: Search for video games. Uses RAWG if API key is set, otherwise falls back to DuckDuckGo web search. Use when users ask about game reviews or 'is X game good'.
**Parameters** (SearchGamesParams):
  - `query`: `str` (required) — Game title to search for
  - `max_results`: `int` (default: 5) — Max results (1-10)

### `get_game_details` (line 2003)
**Description**: Get detailed info for a video game from RAWG by its ID. Returns description, ratings breakdown, Metacritic score, platforms, genres, developers, and more.
**Parameters** (GetGameDetailsParams):
  - `game_id`: `int` (required) — RAWG game ID (from search_games results)


## Coding — Working Directory
### `set_working_dir` (line 2284)
**Description**: Set the working directory for coding operations. All file paths will be relative to this.
**Parameters** (SetWorkingDirParams):
  - `path`: `str` (required) — Absolute path to the working directory for coding operations

### `get_working_dir` (line 2294)
**Description**: Get the current working directory for coding operations.
**Parameters**: None


## Coding — File Operations
### `create_file` (line 2326)
**Description**: Create a new file with the given content. Fails if the file already exists (use apply_patch to edit). Parameters: path (RELATIVE to working dir, e.g. 'src/app.ts' — NO absolute paths), content (the fu
**Parameters** (CreateFileParams):
  - `path`: `str` (required) — File path relative to working directory (no absolute paths)
  - `content`: `str` (default: '') — File content to write. REQUIRED — include the full file content.

### `append_file` (line 2369)
**Description**: Append content to an existing file (file must already exist — use create_file first). Parameters: path (relative to working dir), content (text to append — REQUIRED, must not be empty). Use this after
**Parameters** (AppendFileParams):
  - `path`: `str` (required) — File path relative to working directory (no absolute paths)
  - `content`: `str` (default: '') — Content to append to the file. REQUIRED.

### `apply_patch` (line 2406)
**Description**: Edit a file by replacing an exact string match with new content. Requires 3 parameters: path (RELATIVE to working dir — NO absolute paths), old_str (exact text to find — copy/paste from the file, whit
**Parameters** (ApplyPatchParams):
  - `path`: `str` (required) — File path relative to working directory (no absolute paths)
  - `old_str`: `str` (default: '') — Exact string to find in the file (must match exactly). REQUIRED.
  - `new_str`: `str` (default: '') — Replacement string. REQUIRED (use empty string to delete).


## Coding — Search
### `code_grep` (line 2457)
**Description**: Search for a regex pattern in files within the working directory. Returns matching lines with file paths, line numbers, and context.
**Parameters** (CodeGrepParams):
  - `pattern`: `str` (required) — Regex pattern to search for
  - `glob_filter`: `str` (default: '*') — Glob pattern to filter files (e.g. '*.py', '*.ts')
  - `context_lines`: `int` (default: 2) — Lines of context before and after match
  - `max_results`: `int` (default: 20) — Maximum matches to return

### `tree` (line 2505)
**Description**: List directory tree structure. Respects .gitignore by default.
**Parameters** (TreeParams):
  - `path`: `str` (default: '.') — Directory to list (relative to working dir)
  - `max_depth`: `int` (default: 3) — Maximum depth to traverse
  - `respect_gitignore`: `bool` (default: True) — Skip .gitignore'd files


## Coding — File Reading
### `read_file` (line 2578)
**Description**: Read a file's contents with line numbers. Parameters: path (RELATIVE to working dir, e.g. 'src/app.ts' or '.marvin/upstream/README.md' — NO absolute paths), start_line (optional, 1-based), end_line (o
**Parameters** (ReadFileParams):
  - `path`: `str` (required) — Relative path to file (e.g. 'src/app.ts', '.marvin/upstream/README.md'). NO absolute paths.
  - `start_line`: `int | None` (default: None) — Start line (1-based)
  - `end_line`: `int | None` (default: None) — End line (1-based, inclusive)

**Budget guards**:
  - Files >10KB without `start_line`/`end_line` return an error with line count
  - Session-level budget tracks cumulative chars returned:
    - **200K chars**: warning injected, reads truncated to fit
    - **300K chars**: hard block, content dumped to `.marvin/memories/dump-{file}.txt`
  - Works inside all providers including Copilot SDK (which has no external budget)


## Coding — Git Operations
### `git_status` (line 2654)
**Description**: Show git status of the working directory.
**Parameters**: None

### `git_diff` (line 2659)
**Description**: Show git diff. Use staged=true for staged changes, or path for a specific file.
**Parameters** (GitDiffParams):
  - `staged`: `bool` (default: False) — Show staged changes only
  - `path`: `str | None` (default: None) — Specific file to diff

### `git_commit` (line 2675)
**Description**: Stage and commit changes. Acquires directory lock.
**Parameters** (GitCommitParams):
  - `message`: `str` (required) — Commit message
  - `add_all`: `bool` (default: True) — Stage all changes before committing

### `git_log` (line 2692)
**Description**: Show recent git commits.
**Parameters** (GitLogParams):
  - `max_count`: `int` (default: 10) — Number of commits to show
  - `oneline`: `bool` (default: True) — One-line format

### `git_checkout` (line 2700)
**Description**: Checkout a branch, commit, or file. Acquires directory lock for safety.
**Parameters** (GitCheckoutParams):
  - `target`: `str` (required) — Branch name, commit hash, or file path to checkout
  - `create_branch`: `bool` (default: False) — Create a new branch


## Coding — Shell Execution
### `run_command` (line 2731)
**Description**: Execute a shell command in the working directory. The command is ALWAYS shown to the user and requires confirmation (Enter) before running. Use for builds, tests, installs, or any shell operation.
**Parameters** (RunCommandParams):
  - `command`: `str` (required) — Shell command to execute
  - `timeout`: `int` (default: 60) — Timeout in seconds


## Coding — Ticket System
### `tk` (line 2831)
**Description**: Run the tk ticket CLI. Use to create epics for pipeline stages, tasks for individual agent work items, track status, and add notes. Tickets are stored as markdown in .tickets/. Supports: create, start
**Parameters** (TkParams):
  - `args`: `str` (required) — Arguments to pass to the tk CLI. Examples:
  'create "Phase 1a: Spec" -t epic --parent PARENT_ID'
  'create "Write product spec" -t task --parent EPIC_ID'
  'start TICKET_ID'
  'close TICKET_ID'
  'add-note TICKET_ID "some note"'
  'show TICKET_ID'
  'ls --status=open'


## Coding — Package Management
### `install_packages` (line 2876)
**Description**: Install Python packages into the project's virtual environment using uv. Use this to add dependencies (e.g. httpx, pytest, aiosqlite) to the project. Packages are added to pyproject.toml and installed
**Parameters** (InstallPackagesParams):
  - `packages`: `list[str]` (required) — Package names to install (e.g. ['httpx', 'aiosqlite>=0.20'])
  - `dev`: `bool` (default: False) — Install as dev dependency (--dev flag)


## Coding — Sub-Agent Launching
### `launch_agent` (line 2944)
**Description**: Launch a sub-agent to execute a specific task in non-interactive mode. REQUIRES a valid ticket ID from the tk ticket system — create one with create_ticket first, with dependencies on any prerequisite
**Parameters** (LaunchAgentParams):
  - `ticket_id`: `str` (required) — Ticket ID (from tk) for the task being dispatched. Required — create a ticket first with create_ticket.
  - `prompt`: `str` (required) — The task/prompt for the sub-agent to execute
  - `model`: `str` (default: 'auto') — Model to use: 'auto' (assess task), 'codex' (gpt-5.3-codex, general coding), 'opus' (claude-opus-4.6, complex multi-file / architecture)
  - `working_dir`: `str | None` (default: None) — Working directory (defaults to current coding dir)
  - `design_first`: `bool` (default: False) — Run spec & architecture passes before implementation. Phase 1a uses claude-opus-4.6 to generate a product spec and UX design (.marvin/spec.md). Phase 1b uses claude-opus-4.6 to generate architecture and exhaustive test plan (.marvin/design.md) based on the spec. Recommended for greenfield tasks.
  - `tdd`: `bool` (default: False) — Enable TDD workflow: (1) write failing tests first in parallel agents, (2) implement code, (3) run debug loop until all tests pass. Requires design_first=true or an existing .marvin/design.md.

### `launch_research_agent`
**Description**: Launch a readonly research agent to investigate a question. The agent can read files, search code, browse the web, search Stack Overflow, Wikipedia, and use other read-only tools. It CANNOT edit files, run commands, or create files — it is strictly read-only. Returns the agent's findings as text. No ticket required.
**Parameters** (LaunchResearchAgentParams):
  - `query`: `str` (required) — The research question or investigation query for the agent
  - `model`: `str` (default: 'auto') — Model tier: 'auto', 'codex', or 'opus'
**Notes**:
  - Not available to fixer agents (MARVIN_WRITABLE_FILES) — only plan/review/general agents
  - Spawns a subprocess with MARVIN_READONLY=1, so all write tools are stripped
  - 600s timeout, depth-limited like launch_agent

### `review_codebase`
**Description**: Run a standalone 4-stage code review on an existing codebase. Creates a
unique git branch, runs 4 parallel reviewers per round, dispatches a fixer for issues found,
and repeats until clean or max rounds reached. Requires a ref/ directory with docs explaining
the codebase intent. CODE is ground truth; ref docs are explanatory context only.
**Parameters** (ReviewCodebaseParams):
  - `working_dir`: `str` (required) — Root directory of the codebase to review
  - `ref_dir`: `str` (default: '.ref') — Directory containing reference docs (relative to
    working_dir). Any number of .md/.txt files — treated as explanatory context (NOT ground
    truth). The CODE is ground truth; ref docs explain intent, spec, architecture.
  - `focus`: `str` (default: 'all') — Review focus: 'all', 'backend', 'frontend', 'tests',
    or a glob pattern to match specific files
  - `max_rounds`: `int` (default: 4, range: 1-8) — Maximum review/fix rounds
**Behavior**:
  1. Creates git branch `review/YYYYMMDD-HHMMSS` for the review
  2. Collects ref docs from ref_dir/ and code files from working_dir
  3. Round 1: 4 parallel adversarial reviewers (plan + 2 aux + quality) — must find issues
  4. Clean reviews (REVIEW_CLEAN/SPEC_VERIFIED) cause that reviewer to be dropped
  5. Fixer agent applies patches (hardened DOCUMENT EDITOR prompt — no self-review)
  6. Git checkpoint commits before each review round and after each fixer
  7. R2+ reviewers receive git diff of fixer's changes for accountability
  8. Repeats until all reviewers satisfied or max_rounds exhausted
  9. Returns summary with per-round results
**Reviewer model mapping**:
  - plan reviewer: opus tier (`MARVIN_CODE_MODEL_HIGH`)
  - aux1, aux2, quality: aux_reviewer tier (`MARVIN_CODE_MODEL_AUX_REVIEWER`)
  - fixer: fallback tier (`MARVIN_CODE_MODEL_FALLBACK`)
**Review criteria** (flags only genuine issues):
  - Spec violations — code doesn't match ref doc behavior
  - Security — XSS, injection, unsafe operations
  - Logic bugs — wrong conditions, race conditions, data loss
  - Missing error handling — unhandled exceptions
  - Integration bugs — wrong API shapes, protocol mismatches
  - Test gaps — untested critical paths, inappropriate mocking


## Steam Gaming
### `steam_search` (line 4546)
**Description**: Search the Steam store for games. Returns titles, app IDs, and prices. No API key required. Use when users ask about Steam games, prices, or deals.
**Parameters** (SteamSearchParams):
  - `query`: `str` (required) — Game title to search for on Steam
  - `max_results`: `int` (default: 10) — Max results (1-25)

### `steam_app_details` (line 4602)
**Description**: Get detailed info for a Steam game by app ID. Returns description, price, reviews, genres, release date, screenshots, system requirements, and more. No API key required.
**Parameters** (SteamAppDetailsParams):
  - `app_id`: `int` (required) — Steam app ID (from steam_search results)

### `steam_featured` (line 4689)
**Description**: Get current Steam featured games and specials/deals. No API key required. Use when users ask about Steam sales or deals.
**Parameters**: None

### `steam_player_stats` (line 4741)
**Description**: Get current player count and global achievement stats for a Steam game. Requires STEAM_API_KEY for achievements; player count works without key.
**Parameters** (SteamPlayerStatsParams):
  - `app_id`: `int` (required) — Steam app ID to get player stats for

### `steam_user_games` (line 4786)
**Description**: Get a Steam user's owned games list with playtime. Requires STEAM_API_KEY. Provide the user's 64-bit Steam ID.
**Parameters** (SteamUserGamesParams):
  - `steam_id`: `str` (required) — Steam user's 64-bit ID (e.g. '76561198000000000')

### `steam_user_summary` (line 4830)
**Description**: Get a Steam user's profile summary (name, avatar, status, etc). Requires STEAM_API_KEY.
**Parameters** (SteamUserSummaryParams):
  - `steam_id`: `str` (required) — Steam user's 64-bit ID


## Stack Overflow
### `stack_search` (line 4900)
**Description**: Search Stack Exchange (Stack Overflow, Server Fault, Ask Ubuntu, Unix & Linux, etc.) for questions. Returns titles, scores, answer counts, and tags. Use stack_answers to get the actual answers for a q
**Parameters** (StackSearchParams):
  - `query`: `str` (required) — Search query
  - `site`: `str` (default: 'stackoverflow') — Stack Exchange site: stackoverflow, serverfault, superuser, askubuntu, unix, math, physics, gaming
  - `tagged`: `str | None` (default: None) — Filter by tags, semicolon-separated (e.g. 'python;asyncio')
  - `sort`: `str` (default: 'relevance') — Sort by: relevance, votes, creation, activity
  - `max_results`: `int` (default: 5) — Max results (1-10)

### `stack_answers` (line 4953)
**Description**: Get the top answers for a Stack Exchange question by ID. Returns answer text, scores, and whether it's the accepted answer.
**Parameters** (StackAnswersParams):
  - `question_id`: `int` (required) — Question ID from search results
  - `site`: `str` (default: 'stackoverflow') — Stack Exchange site the question is on


## Wikipedia
### `wiki_search` (line 5021)
**Description**: Search Wikipedia for articles matching a query. Returns titles, snippets, and page IDs. Use wiki_summary or wiki_full to get article content.
**Parameters** (WikiSearchParams):
  - `query`: `str` (required) — Search query
  - `max_results`: `int` (default: 5) — Max results (1-10)

### `wiki_summary` (line 5057)
**Description**: Get a concise summary of a Wikipedia article (1-3 paragraphs). Good for quick facts. Use wiki_full for complete article content.
**Parameters** (WikiSummaryParams):
  - `title`: `str` (required) — Wikipedia article title (from search results)

### `wiki_full` (line 5093)
**Description**: Fetch the FULL content of a Wikipedia article and save it to disk. Returns a confirmation with the file path and a brief extract. The full text is NOT returned in context — use wiki_grep to search it.
**Parameters** (WikiFullParams):
  - `title`: `str` (required) — Wikipedia article title to fetch and save to disk

### `wiki_grep` (line 5144)
**Description**: Search through a previously fetched Wikipedia article saved on disk. Use wiki_full first to fetch the article, then wiki_grep to find specific information within it. Returns matching lines with contex
**Parameters** (WikiGrepParams):
  - `title`: `str` (required) — Wikipedia article title (must have been fetched with wiki_full first)
  - `pattern`: `str` (required) — Text or regex pattern to search for in the saved article


## Recipes
### `recipe_search` (line 5209)
**Description**: Search for recipes by dish name or main ingredient using TheMealDB. Free, no API key needed. Returns meal names, categories, cuisines, and instructions.
**Parameters** (RecipeSearchParams):
  - `query`: `str` (required) — Search query — a dish name like 'pasta' or 'chicken curry'
  - `search_type`: `str` (default: 'name') — 'name' to search by dish name, 'ingredient' to search by main ingredient (e.g. 'chicken')

### `recipe_lookup` (line 5274)
**Description**: Get full recipe details by TheMealDB meal ID. Returns complete ingredients list, measurements, instructions, category, cuisine, and source links.
**Parameters** (RecipeLookupParams):
  - `meal_id`: `str` (required) — TheMealDB meal ID from search results


## Music & Spotify
### `music_search` (line 5351)
**Description**: Search MusicBrainz for artists, albums (releases), or songs (recordings). Free, no API key required. Use when users ask about music, bands, albums, songs, discographies, or release dates.
**Parameters** (MusicSearchParams):
  - `query`: `str` (required) — Search query — artist name, album title, or song title
  - `entity`: `str` (default: 'artist') — What to search for: 'artist', 'release' (album), or 'recording' (song/track)
  - `max_results`: `int` (default: 10) — Max results (1-25)

### `music_lookup` (line 5423)
**Description**: Look up detailed info for an artist, release, or recording by MusicBrainz ID (MBID). For artists: returns discography. For releases: returns track list. For recordings: returns appearances.
**Parameters** (MusicLookupParams):
  - `mbid`: `str` (required) — MusicBrainz ID (UUID) from search results
  - `entity`: `str` (default: 'artist') — Entity type: 'artist', 'release', or 'recording'

### `spotify_auth` (line 5681)
**Description**: Authorize Marvin to access your Spotify account. Call with no arguments to start the auth flow (opens a callback server and returns the login URL). Or call with auth_code if you have one to paste manu
**Parameters** (SpotifyAuthParams):
  - `auth_code`: `str` (default: '') — The authorization code from the Spotify redirect URL (after ?code=). Leave empty to get the authorization URL to visit first.

### `spotify_search` (line 5735)
**Description**: Search Spotify for tracks, artists, albums, or playlists. Returns Spotify URIs that can be used with spotify_add_tracks. Requires Spotify auth (run spotify_auth first if needed).
**Parameters** (SpotifySearchParams):
  - `query`: `str` (required) — Search query (song name, artist, album)
  - `search_type`: `str` (default: 'track') — Type: 'track', 'artist', 'album', or 'playlist'
  - `max_results`: `int` (default: 10) — Max results (1-20)

### `spotify_create_playlist` (line 5800)
**Description**: Create a new Spotify playlist on the authenticated user's account. Returns the playlist ID for use with spotify_add_tracks.
**Parameters** (SpotifyCreatePlaylistParams):
  - `name`: `str` (required) — Playlist name
  - `description`: `str` (default: '') — Playlist description
  - `public`: `bool` (default: False) — Whether the playlist is public

### `spotify_add_tracks` (line 5837)
**Description**: Add tracks to a Spotify playlist. Searches for each track query on Spotify and adds the best match. Provide a list of song queries like ['Bohemian Rhapsody Queen', 'Yesterday Beatles']. Use spotify_cr
**Parameters** (SpotifyAddTracksParams):
  - `playlist_id`: `str` (required) — Spotify playlist ID (from spotify_create_playlist or a Spotify URL)
  - `track_queries`: `list[str]` (required) — List of track queries to search and add, e.g. ['Bohemian Rhapsody Queen', 'Yesterday Beatles']


## Web Browsing & Scraping
### `scrape_page` (line 5972)
**Description**: Scrape a specific web page URL using Selenium + Firefox (headless). ONLY use this when you have a specific URL AND the page requires JavaScript to render. Do NOT use this for searching — use web_searc
**Parameters** (ScrapePageParams):
  - `url`: `str` (required) — The URL to scrape
  - `extract`: `str` (default: 'text') — What to extract: 'text' for full visible text, 'menu' to try extracting menu items/prices, 'links' for all links on the page
  - `css_selector`: `str` (default: '') — Optional CSS selector to narrow extraction to a specific part of the page (e.g. '#menu', '.menu-items', 'main')
  - `max_length`: `int` (default: 4000) — Maximum characters to return (1-8000)

### `browse_web` (line 6094)
**Description**: Read a specific web page URL using Lynx (text browser). ONLY use this when you have a specific URL and want to read its full content. Faster than scrape_page but cannot render JavaScript. Do NOT use t
**Parameters** (BrowseWebParams):
  - `url`: `str` (required) — The URL to browse
  - `max_length`: `int` (default: 4000) — Maximum characters to return (1-8000)


## Google Places & Navigation
### `places_text_search` (line 6366)
**Description**: Search for places using a natural-language query. Automatically uses Google Places API if available, otherwise falls back to OpenStreetMap. Just call this tool — it always returns results. e.g. 'best 
**Parameters** (TextSearchParams):
  - `text_query`: `str` (required) — Natural-language search query, e.g. 'best ramen in downtown Seattle' or 'late night tacos Austin TX'
  - `latitude`: `float` (default: 0.0) — Optional latitude to bias results toward
  - `longitude`: `float` (default: 0.0) — Optional longitude to bias results toward
  - `radius`: `float` (default: 5000.0) — Bias radius in meters (used with lat/lng)
  - `max_results`: `int` (default: 5) — Max results (1-20)
  - `open_now`: `bool` (default: False) — Only show places open now

### `places_nearby_search` (line 6444)
**Description**: Search for nearby places by type and coordinates. Automatically uses Google Places API if available, otherwise falls back to OpenStreetMap. Just call this tool — it always returns results. Use when yo
**Parameters** (NearbySearchParams):
  - `latitude`: `float` (required) — Latitude of the search center
  - `longitude`: `float` (required) — Longitude of the search center
  - `included_types`: `list[str]` (required) — Google place types to include, e.g. ['restaurant'], ['gym'], ['cafe', 'bakery']. See: https://developers.google.com/maps/documentation/places/web-service/place-types
  - `radius`: `float` (default: 5000.0) — Search radius in meters (max 50000)
  - `max_results`: `int` (default: 5) — Max results (1-20)
  - `rank_by`: `str` (default: 'POPULARITY') — Rank by POPULARITY or DISTANCE

### `estimate_travel_time` (line 6515)
**Description**: Get raw travel time and distance between two points using OpenStreetMap routing (OSRM). Returns free-flow (no traffic) estimates. Supports driving, cycling, and walking. For a traffic- and weather-adj
**Parameters** (TravelTimeParams):
  - `origin_lat`: `float` (required) — Origin latitude
  - `origin_lng`: `float` (required) — Origin longitude
  - `dest_lat`: `float` (required) — Destination latitude
  - `dest_lng`: `float` (required) — Destination longitude
  - `mode`: `str` (default: 'driving') — Travel mode: driving, cycling, or foot

### `get_directions` (line 6586)
**Description**: Get turn-by-turn directions between two points using OpenStreetMap (OSRM). Returns step-by-step navigation instructions with distances and durations. Supports driving, cycling, and walking. Free, no A
**Parameters** (DirectionsParams):
  - `origin_lat`: `float` (required) — Origin latitude
  - `origin_lng`: `float` (required) — Origin longitude
  - `dest_lat`: `float` (required) — Destination latitude
  - `dest_lng`: `float` (required) — Destination longitude
  - `mode`: `str` (default: 'driving') — Travel mode: driving, cycling, or foot
  - `waypoints`: `str` (default: '') — Optional intermediate waypoints as 'lat,lng;lat,lng'. The route will pass through these points in order.

### `estimate_traffic_adjusted_time` (line 6708)
**Description**: Estimate traffic- and weather-adjusted travel time between two points. Fetches the OSRM free-flow route, current weather from Open-Meteo, and the current local time, then applies heuristic multipliers
**Parameters** (TrafficAdjustedParams):
  - `origin_lat`: `float` (required) — Origin latitude
  - `origin_lng`: `float` (required) — Origin longitude
  - `dest_lat`: `float` (required) — Destination latitude
  - `dest_lng`: `float` (required) — Destination longitude
  - `mode`: `str` (default: 'driving') — Travel mode: driving, cycling, or foot


## Saved Places & Profiles
### `save_place` (line 7352)
**Description**: Save a place to the user's address book. Use this when the user says 'save this place', 'remember this address', 'bookmark this restaurant', 'that's my home address', or when they share a name, addres
**Parameters** (SavePlaceParams):
  - `label`: `str` (required) — Short label/nickname for this place (e.g. 'home', 'work', 'mom', 'favorite ramen')
  - `name`: `str` (default: '') — Business or place name
  - `address`: `str` (default: '') — Street address
  - `phone`: `str` (default: '') — Phone number
  - `website`: `str` (default: '') — Website URL
  - `lat`: `float` (default: 0.0) — Latitude
  - `lng`: `float` (default: 0.0) — Longitude
  - `notes`: `str` (default: '') — Any extra notes (hours, menu favorites, etc.)

### `remove_place` (line 7384)
**Description**: Remove a saved place from the user's address book by label.
**Parameters** (RemovePlaceParams):
  - `label`: `str` (required) — Label of the saved place to remove

### `list_places` (line 7400)
**Description**: List all saved places in the user's address book. Call this when the user asks 'what places have I saved', 'show my addresses', or 'where is home'.
**Parameters**: None

### `switch_profile` (line 7447)
**Description**: Switch to a different user profile. Each profile has its own preferences file and chat history. Use this when the user wants to switch context, e.g. 'switch to my partner's profile', 'use my work prof
**Parameters** (SwitchProfileParams):
  - `profile_name`: `str` (required) — Name of the profile to switch to (e.g. 'work', 'partner', 'kids'). Creates the profile if it doesn't exist.

### `update_preferences` (line 7531)
**Description**: Update the current user's preferences file. Use this when the user expresses a preference, dislike, allergy, or constraint. Examples:
- 'I don't like sushi' → add 'sushi' to avoid_cuisines
- 'I'm vege
**Parameters** (UpdatePreferencesParams):
  - `key`: `str` (required) — The preference key to update. Must be one of: dietary, spice_tolerance, favorite_cuisines, avoid_cuisines, has_car, max_distance_km, budget, accessibility, notes
  - `action`: `str` (default: 'set') — 'set' replaces the value, 'add' appends to a list, 'remove' removes from a list
  - `value`: `str` (required) — The value to set/add/remove. For lists use comma-separated values (e.g. 'sushi, thai'). For scalars just the value (e.g. 'mild').


## Notes
### `write_note` (line 7621)
**Description**: Write or append to a Markdown note in ~/Notes. Use this when the user asks to save, write, or jot down notes, summaries, recipes, lists, etc.
**Parameters** (WriteNoteParams):
  - `path`: `str` (required) — Relative path inside ~/Notes, e.g. 'recipes/pasta.md' or 'todo.md'. Parent directories are created automatically.
  - `content`: `str` (required) — Markdown content to write.
  - `append`: `bool` (default: False) — If true, append to the file instead of overwriting.

### `read_note` (line 7662)
**Description**: Read a Markdown note from ~/Notes.
**Parameters** (ReadNoteParams):
  - `path`: `str` (required) — Relative path inside ~/Notes to read.

### `notes_mkdir` (line 7693)
**Description**: Create a subdirectory inside ~/Notes for organizing notes.
**Parameters** (NotesMkdirParams):
  - `path`: `str` (required) — Relative directory path inside ~/Notes to create, e.g. 'projects/ai'.

### `notes_ls` (line 7720)
**Description**: List files and directories inside ~/Notes.
**Parameters** (NotesLsParams):
  - `path`: `str` (default: '') — Relative directory path inside ~/Notes to list. Empty = root.

### `yt_dlp_download` (line 7775)
**Description**: Download a video (or audio) from YouTube or other sites using yt-dlp. Use this when the user wants to download, save, or grab a video or audio.
**Parameters** (YtDlpParams):
  - `url`: `str` (required) — YouTube (or other supported) video URL.
  - `audio_only`: `bool` (default: False) — If true, download audio only (mp3/m4a).
  - `output_dir`: `str` (default: '') — Subdirectory inside ~/Downloads/yt-dlp. Empty = root.

### `calendar_add_event` (line 7906)
**Description**: Save an event to the user's calendar (.ics file)
**Parameters** (CalendarAddParams):
  - `title`: `str` (required) — Event title/summary
  - `start`: `str` (required) — Start date/time in ISO format, e.g. 2026-02-14T18:00
  - `end`: `str` (default: '') — End date/time in ISO format. If omitted, defaults to 1 hour after start.
  - `location`: `str` (default: '') — Event location
  - `description`: `str` (default: '') — Event description/notes

### `calendar_delete_event` (line 7950)
**Description**: Delete an event from the calendar by UID or title
**Parameters** (CalendarDeleteParams):
  - `uid`: `str` (default: '') — UID of the event to delete. If empty, match by title.
  - `title`: `str` (default: '') — Title substring to match (case-insensitive). Used if uid is empty.

### `calendar_view` (line 7980)
**Description**: Display a calendar view for a given month with events marked. Returns a text calendar grid plus a list of events in that month.
**Parameters** (CalendarViewParams):
  - `month`: `int` (default: 0) — Month number (1-12). 0 = current month.
  - `year`: `int` (default: 0) — Year. 0 = current year.

### `calendar_list_upcoming` (line 8054)
**Description**: List upcoming events in the next N days (default 7)
**Parameters** (CalendarListParams):
  - `days`: `int` (default: 7) — Number of days ahead to show upcoming events


## File Utilities (non-coding mode)
### `file_read_lines` (line 8228)
**Description**: Read lines from a file in ~/Notes with line numbers. Use to inspect file contents before editing. Files are restricted to ~/Notes.
**Parameters** (FileReadLinesParams):
  - `path`: `str` (required) — Path to a file inside ~/Notes to read, e.g. 'todo.md' or 'projects/readme.md'. Can also use ~/Notes/todo.md.
  - `start`: `int` (default: 1) — First line number to read (1-based, inclusive).
  - `end`: `int` (default: 0) — Last line number to read (inclusive). 0 = until end of file.

### `file_apply_patch` (line 8381)
**Description**: Apply a patch (unified diff or simple REPLACE/INSERT/DELETE commands) to a file in ~/Notes. Always use file_read_lines first to see the current content and line numbers. Files are restricted to ~/Note
**Parameters** (FileApplyPatchParams):
  - `path`: `str` (required) — Path to a file inside ~/Notes to patch, e.g. 'todo.md' or '~/Notes/projects/readme.md'. The file must already exist.
  - `patch`: `str` (required) — A unified-diff style patch to apply. Each hunk starts with '@@ -old_start,old_count +new_start,new_count @@'. Lines beginning with '-' are removed, '+' are added, ' ' (space) are context. Alternatively, provide a simple line-edit format:
  REPLACE <line_number>
  <new content>
  ---
  INSERT <after_line_number>
  <new lines>
  ---
  DELETE <line_number> [count]
  - `dry_run`: `bool` (default: False) — If true, show what would change without modifying the file.


## Ticket System (non-coding mode)
### `create_ticket` (line 8445)
**Description**: Create a TODO / ticket using the local 'tk' ticket system. Use this whenever the user wants to note a task, track a bug, plan a feature, or create any kind of to-do item. Returns the new ticket ID.
**Parameters** (CreateTicketParams):
  - `title`: `str` (required) — Short title for the ticket, e.g. 'Fix login timeout bug'
  - `description`: `str` (default: '') — Longer description of the task or issue.
  - `ticket_type`: `str` (default: 'task') — Type: 'bug', 'feature', 'task', 'epic', or 'chore'.
  - `priority`: `int` (default: 2) — Priority 0-4 where 0 is highest. Default is 2 (medium).
  - `tags`: `str` (default: '') — Comma-separated tags, e.g. 'ui,backend,urgent'.
  - `parent`: `str` (default: '') — Parent ticket ID if this is a sub-task.

### `ticket_add_dep` (line 8482)
**Description**: Add a dependency between tickets: ticket_id depends on depends_on. The dependent ticket is blocked until the dependency is closed.
**Parameters** (TicketDepParams):
  - `ticket_id`: `str` (required) — The ticket that depends on another
  - `depends_on`: `str` (required) — The ticket it depends on (must be completed first)

### `ticket_start` (line 8494)
**Description**: Mark a ticket as in_progress (started). Use when beginning work on a ticket.
**Parameters** (TicketStatusParams):
  - `ticket_id`: `str` (required) — Ticket ID to update

### `ticket_close` (line 8502)
**Description**: Close a ticket (mark as done). Use when a task is fully complete.
**Parameters** (TicketStatusParams):
  - `ticket_id`: `str` (required) — Ticket ID to update

### `ticket_add_note` (line 8516)
**Description**: Add a timestamped note to a ticket. Use for progress updates, findings, blockers, or any important information about the task.
**Parameters** (TicketNoteParams):
  - `ticket_id`: `str` (required) — Ticket ID to add a note to
  - `note`: `str` (required) — The note text to append (timestamped automatically)

### `ticket_show` (line 8523)
**Description**: Show full details of a ticket including description, notes, dependencies, and status.
**Parameters** (TicketStatusParams):
  - `ticket_id`: `str` (required) — Ticket ID to update

### `ticket_list` (line 8536)
**Description**: List tickets in the current project. Optionally filter by status or tag.
**Parameters** (TicketListParams):
  - `status`: `str` (default: '') — Filter by status: 'open', 'in_progress', 'closed', or empty for all
  - `tags`: `str` (default: '') — Filter by tag

### `ticket_dep_tree` (line 8553)
**Description**: Show the dependency tree for a ticket — all its children, their deps, and status.
**Parameters** (TicketTreeParams):
  - `ticket_id`: `str` (required) — Root ticket ID to show dependency tree for


## GitHub
### `github_search` (line 8576)
**Description**: Search GitHub using the gh CLI. Supports searching repositories, code, issues, commits, and users. Use this to find projects, code examples, issues, etc. on GitHub. Requires the 'gh' CLI to be install
**Parameters** (GitHubSearchParams):
  - `query`: `str` (required) — Search query for GitHub, e.g. 'fastapi language:python stars:>100'
  - `search_type`: `str` (default: 'repositories') — What to search: 'repositories', 'code', 'issues', 'commits', or 'users'.
  - `max_results`: `int` (default: 10) — Max results to return (1-30)

### `github_clone` (line 8651)
**Description**: Clone a GitHub repository into ~/github-clones/<owner>/<repo> using the gh CLI. If the repo is already cloned, returns the existing path. IMPORTANT: You MUST use this tool to clone a repo BEFORE readi
**Parameters** (GitHubCloneParams):
  - `repo`: `str` (required) — Repository to clone, e.g. 'owner/repo' or a full GitHub URL. Examples: 'pallets/flask', 'https://github.com/psf/requests'.
  - `shallow`: `bool` (default: True) — If true (default), do a shallow clone (--depth 1) to save time and space.

### `github_read_file` (line 8727)
**Description**: Read a file (or a line range) from a previously cloned GitHub repo in ~/github-clones/. You MUST call github_clone first to clone the repo before using this tool. Do NOT use web scraping, browse_web, 
**Parameters** (GitHubReadFileParams):
  - `repo`: `str` (required) — Repository identifier, e.g. 'owner/repo'. Must already be cloned via github_clone into ~/github-clones/.
  - `path`: `str` (required) — Path to the file within the repo, e.g. 'README.md' or 'src/main.py'.
  - `start`: `int` (default: 0) — Starting line number (1-based). 0 or omitted = start from beginning.
  - `end`: `int` (default: 0) — Ending line number (1-based, inclusive). 0 or omitted = read to end of file.

### `github_grep` (line 8816)
**Description**: Search file contents within a previously cloned GitHub repo using grep. You MUST call github_clone first. Do NOT use web scraping or raw HTTP to search repo contents. Returns matching lines with file 
**Parameters** (GitHubGrepParams):
  - `repo`: `str` (required) — Repository identifier, e.g. 'owner/repo'. Must already be cloned via github_clone.
  - `pattern`: `str` (required) — Search pattern (regex supported).
  - `glob_filter`: `str` (default: '') — Optional glob to restrict search, e.g. '*.py' or 'src/**/*.ts'.
  - `max_results`: `int` (default: 30) — Max matching lines to return (1-100).

### `weather_forecast` (line 8874)
**Description**: Get current weather and a multi-day forecast using the free Open-Meteo API. Provide latitude and longitude (use get_my_location if needed). Returns temperature, conditions, precipitation, wind, and su
**Parameters** (WeatherForecastParams):
  - `latitude`: `float` (required) — Latitude of the location.
  - `longitude`: `float` (required) — Longitude of the location.
  - `days`: `int` (default: 3) — Number of forecast days (1-7).


## Reference & Utilities
### `convert_units` (line 8960)
**Description**: Convert between units (length, weight, volume, speed, temperature) or currencies. Supports km↔mi, kg↔lbs, °C↔°F, L↔gal, and many more. For currencies, uses the free Frankfurter API for live exchange r
**Parameters** (ConvertUnitsParams):
  - `value`: `float` (required) — The numeric value to convert.
  - `from_unit`: `str` (required) — Source unit, e.g. 'km', 'lbs', 'USD', '°F'.
  - `to_unit`: `str` (required) — Target unit, e.g. 'mi', 'kg', 'EUR', '°C'.

### `dictionary_lookup` (line 9017)
**Description**: Look up a word definition, pronunciation, part of speech, and synonyms using the free Dictionary API (dictionaryapi.dev). No API key needed.
**Parameters** (DictionaryLookupParams):
  - `word`: `str` (required) — The word to look up.
  - `include_synonyms`: `bool` (default: True) — Include synonyms if available.

### `translate_text` (line 9079)
**Description**: Translate text between languages using the MyMemory free translation API. No API key needed. Supports most language pairs. Use ISO 639-1 codes: en, es, fr, de, it, pt, ja, ko, zh, ar, ru, etc.
**Parameters** (TranslateTextParams):
  - `text`: `str` (required) — Text to translate.
  - `target_language`: `str` (required) — Target language code, e.g. 'es' (Spanish), 'fr' (French), 'de' (German), 'ja' (Japanese).
  - `source_language`: `str` (default: 'auto') — Source language code, or 'auto' to auto-detect.


## Timers
### `timer_start` (line 9139)
**Description**: Start a named timer. Set duration_seconds for a countdown, or 0 for a stopwatch. Use timer_check to see elapsed/remaining time, and timer_stop to end it.
**Parameters** (TimerStartParams):
  - `name`: `str` (required) — Name for this timer, e.g. 'eggs', 'workout', 'focus'.
  - `duration_seconds`: `int` (default: 0) — Countdown duration in seconds. 0 = stopwatch (counts up).

### `timer_check` (line 9159)
**Description**: Check the status of a running timer. Leave name empty to see all active timers.
**Parameters** (TimerCheckParams):
  - `name`: `str` (default: '') — Timer name. Empty = show all active timers.

### `timer_stop` (line 9188)
**Description**: Stop a running timer and report the final time.
**Parameters** (TimerStopParams):
  - `name`: `str` (required) — Name of the timer to stop.

### `system_info` (line 9218)
**Description**: Report system information: OS, CPU, memory usage, disk usage, uptime, and battery status (if available).
**Parameters**: None


## RSS Feeds
### `read_rss` (line 9268)
**Description**: Fetch and display entries from an RSS or Atom feed. Returns titles, dates, summaries, and links for recent entries.
**Parameters** (ReadRSSParams):
  - `url`: `str` (required) — URL of the RSS or Atom feed.
  - `max_items`: `int` (default: 5) — Max number of feed items to return (1-20).


## Downloads
### `download_file` (line 9325)
**Description**: Download a file from a URL to ~/Downloads/. Auto-detects filename from URL if not specified. Will not overwrite existing files.
**Parameters** (DownloadFileParams):
  - `url`: `str` (required) — URL of the file to download.
  - `filename`: `str` (default: '') — Filename to save as. If empty, auto-detects from URL.


## Bookmarks
### `bookmark_save` (line 9405)
**Description**: Save a URL as a bookmark with optional title, tags, and notes.
**Parameters** (BookmarkSaveParams):
  - `url`: `str` (required) — URL to bookmark.
  - `title`: `str` (default: '') — Title for the bookmark.
  - `tags`: `str` (default: '') — Comma-separated tags, e.g. 'python,tutorial'.
  - `notes`: `str` (default: '') — Optional notes about this bookmark.

### `bookmark_list` (line 9428)
**Description**: List saved bookmarks, optionally filtered by tag.
**Parameters** (BookmarkListParams):
  - `tag`: `str` (default: '') — Filter by tag. Empty = show all.
  - `limit`: `int` (default: 20) — Max bookmarks to show.

### `bookmark_search` (line 9452)
**Description**: Search bookmarks by matching against titles, URLs, notes, and tags.
**Parameters** (BookmarkSearchParams):
  - `query`: `str` (required) — Search text to match against titles, URLs, notes, and tags.
  - `limit`: `int` (default: 10) — Max results to return.


## History & Backups
### `compact_history` (line 9567)
**Description**: Compact the conversation history to fit within a token budget. Backs up the original chat log, then compresses older messages while preserving the most recent ones exactly. Triggers a session rebuild.
**Parameters** (CompactHistoryParams):
  - `target_tokens`: `int` (required) — Target token budget for the compacted history (default 50000).

### `search_history_backups` (line 9606)
**Description**: Search through backed-up conversation history for old messages that were compacted or dropped. Use this when the user asks about something from a previous conversation that is no longer in the current
**Parameters** (SearchHistoryBackupsParams):
  - `query`: `str` (required) — Text to search for in old conversation history backups.
  - `max_results`: `int` (default: 20) — Max matching messages to return.

### `blender_get_scene` (line 9711)
**Description**: Get information about the current Blender scene: objects, lights, cameras, materials. Use this to understand what exists before making changes.
**Parameters**: None

### `blender_get_object` (line 9726)
**Description**: Get detailed info about a specific Blender object: mesh data, materials, transforms, modifiers.
**Parameters** (BlenderObjectInfoParams):
  - `object_name`: `str` (required) — Name of the Blender object to inspect

### `blender_create_object` (line 9747)
**Description**: Create a primitive 3D object in the Blender scene.
**Parameters** (BlenderCreateObjectParams):
  - `object_type`: `str` (required) — Primitive type: cube, sphere, cylinder, cone, torus, plane, uv_sphere, ico_sphere
  - `name`: `str` (default: '') — Object name (optional)
  - `location`: `list[float]` (required) — XYZ location
  - `scale`: `list[float]` (required) — XYZ scale
  - `rotation`: `list[float]` (required) — XYZ rotation in radians

### `blender_modify_object` (line 9773)
**Description**: Modify an existing Blender object's position, scale, or rotation.
**Parameters** (BlenderModifyObjectParams):
  - `object_name`: `str` (required) — Name of the object to modify
  - `location`: `list[float] | None` (default: None) — New XYZ location
  - `scale`: `list[float] | None` (default: None) — New XYZ scale
  - `rotation`: `list[float] | None` (default: None) — New XYZ rotation in radians

### `blender_delete_object` (line 9792)
**Description**: Delete an object from the Blender scene by name.
**Parameters** (BlenderDeleteObjectParams):
  - `object_name`: `str` (required) — Name of the object to delete

### `blender_set_material` (line 9812)
**Description**: Apply or modify a material/color on a Blender object.
**Parameters** (BlenderSetMaterialParams):
  - `object_name`: `str` (required) — Name of the object to apply material to
  - `material_name`: `str` (default: '') — Material name
  - `color`: `list[float]` (required) — RGBA color values (0-1 range)

### `blender_execute_code` (line 9834)
**Description**: Execute arbitrary Python code inside Blender. Has full access to bpy and the Blender API. Use for complex operations not covered by other Blender tools (e.g., adding modifiers, keyframes, compositing 
**Parameters** (BlenderExecuteCodeParams):
  - `code`: `str` (required) — Python code to execute inside Blender (bpy context)

### `blender_screenshot` (line 9849)
**Description**: Capture a screenshot of the current Blender viewport.
**Parameters** (BlenderScreenshotParams):
  - `max_size`: `int` (default: 512) — Max dimension of the screenshot in pixels
___BEGIN___COMMAND_DONE_MARKER___0
