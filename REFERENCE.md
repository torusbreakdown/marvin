# Local Finder — Reference Directory

Important names, addresses, phone numbers, API endpoints, and uncommon websites
used by this project.

## APIs & Endpoints

| Service | URL | Auth | Notes |
|---------|-----|------|-------|
| Google Places (New) v1 | `https://places.googleapis.com/v1/places:searchText` | API key or gcloud token + `X-Goog-User-Project` | POST with `X-Goog-FieldMask` header. **Falls back to Nominatim** |
| Google Places Nearby | `https://places.googleapis.com/v1/places:searchNearby` | Same as above | POST, needs lat/lng + radius. **Falls back to Overpass** |
| OpenStreetMap Nominatim | `https://nominatim.openstreetmap.org/search` | None (free) | Fallback for text search. 1 req/sec. Requires User-Agent |
| OpenStreetMap Overpass | `https://overpass-api.de/api/interpreter` | None (free) | Fallback for nearby search. Reasonable use |
| OSRM (routing) | `https://router.project-osrm.org/route/v1/{profile}/{coords}` | None (free, public demo) | Coords in **lon,lat** order. 1 req/sec limit |
| Open-Meteo (weather) | `https://api.open-meteo.com/v1/forecast` | None (free, no key) | Returns WMO weather codes |
| DuckDuckGo (web search) | Via `ddgs` Python library | None (free) | `DDGS().text(query, max_results=N)` |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/search` | None (free) | ~100 req/5min |
| arXiv | `https://export.arxiv.org/api/query` | None (free) | HTTPS required, `follow_redirects=True` |
| OMDB (movies/TV) | `https://www.omdbapi.com/` | `OMDB_API_KEY` | 1,000 req/day (free tier) |
| RAWG (games) | `https://api.rawg.io/api/games` | `RAWG_API_KEY` | 20,000 req/month (free tier) |
| ntfy.sh | `https://ntfy.sh/{topic}` | None (free) | Push notifications |
| ip-api.com (IP geolocation) | `http://ip-api.com/json/` | None (free for non-commercial) | Fallback for device location |

## Key Websites (Uncommon)

| Name | URL | Purpose |
|------|-----|---------|
| OSRM Project | https://project-osrm.org/ | Open Source Routing Machine |
| Open-Meteo | https://open-meteo.com/ | Free weather API, no key needed |
| Semantic Scholar | https://www.semanticscholar.org/ | Academic paper search |
| arXiv | https://arxiv.org/ | Preprint repository |
| OMDB | https://www.omdbapi.com/ | Movie/TV database (free API key) |
| RAWG | https://rawg.io/ | Video game database (free API key) |
| ntfy.sh | https://ntfy.sh/ | Free push notification service |
| OpenStreetMap | https://www.openstreetmap.org/ | Free map data (Nominatim + Overpass) |
| ip-api | http://ip-api.com/ | Free IP geolocation |
| yt-dlp | https://github.com/yt-dlp/yt-dlp | YouTube/video downloader |
| GitHub Copilot SDK (PyPI) | https://pypi.org/project/github-copilot-sdk/ | Python SDK for Copilot tool-calling |

## Google Cloud Setup

- **API to enable**: `places-backend.googleapis.com` (Google Places API New)
- **Enable command**: `gcloud services enable places-backend.googleapis.com`
- **Quota project**: Set via `gcloud auth application-default set-quota-project PROJECT_ID`
- **Auth header**: `X-Goog-User-Project: PROJECT_ID` (required for user-credential billing)
- **Console**: https://console.cloud.google.com/apis/library/places-backend.googleapis.com

## Local Paths

| Path | Purpose |
|------|---------|
| `~/.config/local-finder/profiles/<name>/preferences.yaml` | Per-profile user preferences |
| `~/.config/local-finder/profiles/<name>/history` | Per-profile readline/input history |
| `~/.config/local-finder/profiles/<name>/ntfy_subscriptions.json` | Per-profile ntfy subscriptions |
| `~/.config/local-finder/profiles/<name>/saved_places.json` | Per-profile address book |
| `~/.config/local-finder/profiles/<name>/calendar.ics` | Per-profile calendar events (iCal format) |
| `~/.config/local-finder/profiles/<name>/chat_log.json` | Per-profile conversation log (both sides) |
| `~/.config/local-finder/last_profile` | Last active profile (auto-restored on startup) |
| `~/.config/local-finder/usage.json` | Lifetime usage/cost tracking |
| `~/.config/local-finder/ntfy/ntfy_watcher.sh` | Auto-generated cron watcher script |
| `~/.config/local-finder/ntfy/seen.json` | Seen ntfy message IDs (dedup) |
| `~/.local/share/local-finder/alarms/` | Self-destructing alarm scripts |
| `~/.config/local-finder/calendar_reminders/` | Self-destructing calendar reminder scripts |
| `~/.config/local-finder/curses.log` | Redirected stdout/stderr during curses mode |
| `~/Notes/` | Markdown notes directory |
| `~/Downloads/yt-dlp/` | Downloaded videos/audio |

## Browser Automation

| Component | Path | Notes |
|-----------|------|-------|
| Firefox (snap) | `/snap/firefox/current/usr/lib/firefox/firefox` | Headless browser for `scrape_page` |
| geckodriver | `/snap/bin/geckodriver` | Selenium WebDriver for Firefox |

## Cost Estimates (per call)

| Tool | Cost |
|------|------|
| `places_text_search` | ~$0.032 (free via OSM fallback) |
| `places_nearby_search` | ~$0.032 (free via OSM fallback) |
| LLM turn (Copilot) | ~$0.003 |
| OSRM / Open-Meteo / DuckDuckGo / scrape_page | Free |

## Contact / Support

| Resource | Link |
|----------|------|
| Google Cloud Support | https://console.cloud.google.com/support |
| GitHub Copilot Docs | https://docs.github.com/en/copilot |
| OSRM GitHub | https://github.com/Project-OSRM/osrm-backend |
| Open-Meteo GitHub | https://github.com/open-meteo/open-meteo |
