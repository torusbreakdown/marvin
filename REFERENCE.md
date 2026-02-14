# Local Finder — Reference Directory

Important names, addresses, phone numbers, API endpoints, and uncommon websites
used by this project.

## APIs & Endpoints

| Service | URL | Auth | Notes |
|---------|-----|------|-------|
| Google Places (New) v1 | `https://places.googleapis.com/v1/places:searchText` | API key or gcloud token + `X-Goog-User-Project` | POST with `X-Goog-FieldMask` header |
| Google Places Nearby | `https://places.googleapis.com/v1/places:searchNearby` | Same as above | POST, needs lat/lng + radius |
| OSRM (routing) | `https://router.project-osrm.org/route/v1/{profile}/{coords}` | None (free, public demo) | Coords in **lon,lat** order. 1 req/sec limit |
| Open-Meteo (weather) | `https://api.open-meteo.com/v1/forecast` | None (free, no key) | Returns WMO weather codes |
| DuckDuckGo (web search) | Via `ddgs` Python library | None (free) | `DDGS().text(query, max_results=N)` |
| ip-api.com (IP geolocation) | `http://ip-api.com/json/` | None (free for non-commercial) | Fallback for device location |
| OpenMenus (defunct/unreliable) | `https://openmenu.com/search/search.php` | None | Was used for menu scraping; site unreachable as of Feb 2026 |

## Key Websites (Uncommon)

| Name | URL | Purpose |
|------|-----|---------|
| OpenMenu Search | https://openmenu.com/search/ | Restaurant menu search (currently down) |
| OpenMenu API Docs | https://openmenu.com/api/ | Menu API documentation |
| OSRM Project | https://project-osrm.org/ | Open Source Routing Machine |
| Open-Meteo | https://open-meteo.com/ | Free weather API, no key needed |
| WMO Weather Codes | https://open-meteo.com/en/docs | Weather code reference for traffic heuristics |
| ip-api | http://ip-api.com/ | Free IP geolocation |
| GitHub Copilot SDK (PyPI) | https://pypi.org/project/github-copilot-sdk/ | Python SDK for Copilot tool-calling |
| Documenu (alternative) | https://rapidapi.com/collection/restaurant-api | Paid menu API alternative on RapidAPI |

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
| `~/.config/local-finder/profiles/<name>/history` | Per-profile readline history |
| `~/.config/local-finder/usage.json` | Lifetime usage/cost tracking |
| `~/.local/share/local-finder/alarms/` | Self-destructing alarm scripts |

## Browser Automation

| Component | Path | Notes |
|-----------|------|-------|
| Firefox (snap) | `/snap/firefox/current/usr/lib/firefox/firefox` | Headless browser for `scrape_page` |
| geckodriver | `/snap/bin/geckodriver` | Selenium WebDriver for Firefox |

## Cost Estimates (per call)

| Tool | Cost |
|------|------|
| `places_text_search` | ~$0.032 |
| `places_nearby_search` | ~$0.032 |
| LLM turn (Copilot) | ~$0.003 |
| OSRM / Open-Meteo / DuckDuckGo / scrape_page | Free |

## Contact / Support

| Resource | Link |
|----------|------|
| Google Cloud Support | https://console.cloud.google.com/support |
| GitHub Copilot Docs | https://docs.github.com/en/copilot |
| OSRM GitHub | https://github.com/Project-OSRM/osrm-backend |
| Open-Meteo GitHub | https://github.com/open-meteo/open-meteo |
