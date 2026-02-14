# Local Finder

A multi-tool CLI assistant powered by the **GitHub Copilot SDK**. Finds nearby places, checks weather & traffic, searches the web, scrapes pages, looks up academic papers, reviews games & movies, manages notifications, takes notes, downloads videos, and more — all from one conversational interface.

## Quick Start

```bash
# Clone and install
cd local-finder
uv venv && uv pip install -r requirements.txt
source .venv/bin/activate

# Run (curses UI, default)
python app.py

# Plain terminal mode
python app.py --plain

# Single-shot mode
python app.py "Find me good ramen near me"
```

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| **Curses** (default) | `python app.py` | Rich terminal UI with colored chat, scrolling, status bar, input history |
| **Plain** | `python app.py --plain` | Original readline-based terminal |
| **Single-shot** | `python app.py "query"` | One question, one answer, then exit |

### Curses Mode Keybindings

| Key | Action |
|-----|--------|
| Enter | Send message |
| ↑ / ↓ | Browse input history |
| PgUp / PgDn | Scroll chat output |
| Ctrl+A / Ctrl+E | Jump to start/end of line |
| Ctrl+U | Clear input line |
| Ctrl+D or ESC | Quit |

## API Setup

### Required

#### 1. GitHub Copilot (powers the LLM)
The Copilot SDK authenticates via your GitHub account. You need **GitHub Copilot access** (Individual, Business, or Enterprise).

```bash
# Install GitHub CLI and authenticate
gh auth login

# Verify Copilot access
gh copilot --version
```

The SDK's bundled `copilot` binary handles token exchange automatically.

#### 2. Google Places API (place search & recommendations)

> **Note:** If the Google Places API is unavailable (no key, quota exceeded, auth error), the app automatically falls back to **OpenStreetMap** (Nominatim + Overpass) — so this key is optional but gives richer results.

**Option A — API Key (recommended):**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select existing)
3. Enable **Places API (New)**: [Direct link](https://console.cloud.google.com/apis/library/places-backend.googleapis.com)
4. Go to **APIs & Services → Credentials → Create Credentials → API Key**
5. Set the key:
```bash
export GOOGLE_PLACES_API_KEY="your-key-here"
```

**Option B — gcloud auth (no API key needed):**
```bash
gcloud auth login
gcloud auth application-default login
gcloud services enable places-backend.googleapis.com

# The app will auto-detect gcloud credentials and set the quota project.
# If you get 401/403 errors, tell the assistant "fix auth" and it will
# call setup_google_auth to enable the API and set the quota project.
```

### Optional (free, enhance features)

#### 3. OMDB — Movie & TV Reviews
Free tier: 1,000 requests/day.

1. Go to [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)
2. Select **FREE** tier, enter your email
3. Check email for your API key (check spam if delayed)
4. Set the key:
```bash
export OMDB_API_KEY="your-key-here"
```

#### 4. RAWG — Video Game Reviews
Free tier: 20,000 requests/month (non-commercial, requires attribution).

1. Go to [rawg.io/apidocs](https://rawg.io/apidocs)
2. Click **Get API Key** and create an account
3. Copy your API key from the dashboard
4. Set the key:
```bash
export RAWG_API_KEY="your-key-here"
```

### No Key Needed (free, built-in)

These services require **no API key** and work out of the box:

| Service | What it does | Limit |
|---------|-------------|-------|
| **OSRM** | Route planning & travel time | 1 req/sec (public demo) |
| **Open-Meteo** | Weather data & forecasts | Unlimited (non-commercial) |
| **OpenStreetMap / Nominatim** | Places fallback (text search) | 1 req/sec |
| **OpenStreetMap / Overpass** | Places fallback (nearby search) | Reasonable use |
| **DuckDuckGo** | Web search (via `ddgs` library) | Reasonable use |
| **Semantic Scholar** | Academic paper search | ~100 req/5min |
| **arXiv** | Preprint search | 1 req/3sec |
| **ntfy.sh** | Push notifications | Unlimited |
| **ip-api.com** | IP geolocation fallback | 45 req/min |
| **Lynx** | Text-mode web browsing | Local (no network limit) |
| **Selenium + Firefox** | JS-rendered page scraping | Local (rate-limited 3s) |
| **yt-dlp** | YouTube/video downloads | Local (install separately) |

### Optional CLI Tools

These are used by some tools and should be installed separately:

```bash
# For yt-dlp_download tool
pip install yt-dlp
# or: sudo apt install yt-dlp

# For browse_web tool
sudo apt install lynx
```

## Recommended .bashrc / .profile

Add all your keys in one place so they persist:

```bash
# ~/.bashrc or ~/.profile
export GOOGLE_PLACES_API_KEY="AIza..."
export OMDB_API_KEY="abc123..."
export RAWG_API_KEY="def456..."
```

Then `source ~/.bashrc` or restart your terminal.

## Usage

```bash
source .venv/bin/activate

# Curses mode (default, recommended)
python app.py

# Plain terminal mode
python app.py --plain

# Single-shot mode
python app.py "Find me good ramen near me"
python app.py "Is Elden Ring worth playing?"
python app.py "Find papers on multi-robot consensus from 2020-2024"
```

### Interactive Commands

| Command | Action |
|---------|--------|
| `preferences` | Open your preferences file in $EDITOR |
| `profiles` | List available profiles |
| `saved` | Show saved places |
| `usage` | Show API usage & costs |
| `quit` / `exit` / Ctrl+D | Exit the app |

### Example Prompts

```
Find the best Thai food near me that delivers
Is the new Dune movie good?
Search arXiv for transformer architectures in robotics
What's the weather like and how long to drive to LAX?
Save my home address as 123 Main St, Anytown USA
Set an alarm for 30 minutes — pizza is in the oven
Create a notification channel for deal alerts
I'm vegetarian and I don't like spicy food
Browse the menu at joe's-crab-shack.com
Write a note about today's meeting in notes/work/meetings.md
Download that YouTube video as audio
List my notes
```

## Features

- **Session context**: conversation history persists across restarts
- **Profiles**: per-user preferences, history, saved places, ntfy subscriptions
- **Auto-restore**: remembers last active profile on startup
- **History summary**: shows recent queries on launch for context
- **Timestamps**: each response is timestamped
- **Usage tracking**: per-session and lifetime cost estimates

### API Fallback Strategy

The app is designed to work with **zero API keys** for most features:

| Tool | Primary API | Fallback | Key Required? |
|------|------------|----------|---------------|
| Places search | Google Places | OpenStreetMap (Nominatim/Overpass) | No (OSM is free) |
| Travel time | OSRM | — | No |
| Weather | Open-Meteo | — | No |
| Web search | DuckDuckGo | — | No |
| Academic search | Semantic Scholar / arXiv | — | No |
| Notifications | ntfy.sh | — | No |
| Movies/TV | OMDB | DuckDuckGo web search | No (DDG is free) |
| Games | RAWG | DuckDuckGo web search | No (DDG is free) |

### Calendar Reminders

When you add a calendar event, cron jobs are automatically scheduled to send notifications **1 hour** and **30 minutes** before the event via:
- Desktop notifications (`notify-send`)
- Push notifications via **ntfy.sh** (auto-creates a `reminders` topic if none exists)

## All Tools (41)

| Category | Tools |
|----------|-------|
| **Location** | `get_my_location` |
| **Places** | `places_text_search`, `places_nearby_search` (Google → OSM fallback) |
| **Travel** | `estimate_travel_time`, `estimate_traffic_adjusted_time` |
| **Search** | `web_search`, `browse_web`, `scrape_page` |
| **Academic** | `search_papers`, `search_arxiv` |
| **Reviews** | `search_movies`, `get_movie_details`, `search_games`, `get_game_details` |
| **Address Book** | `save_place`, `remove_place`, `list_places` |
| **Notifications** | `generate_ntfy_topic`, `ntfy_subscribe`, `ntfy_unsubscribe`, `ntfy_publish`, `ntfy_list` |
| **Alarms** | `set_alarm`, `list_alarms`, `cancel_alarm` |
| **Profile** | `switch_profile`, `update_preferences` |
| **Notes** | `write_note`, `read_note`, `notes_mkdir`, `notes_ls` |
| **Calendar** | `calendar_add_event`, `calendar_delete_event`, `calendar_view`, `calendar_list_upcoming` |
| **File Editing** | `file_read_lines`, `file_apply_patch` |
| **Downloads** | `yt_dlp_download` |
| **System** | `setup_google_auth`, `get_usage`, `exit_app` |
