"""
Marvin — local-business and general-purpose assistant.

Multi-provider LLM backend (Groq, Ollama, OpenAI-compat, Copilot SDK).
Set GOOGLE_PLACES_API_KEY env var for places search.
"""

import asyncio
import json
import os
import platform
import readline
import shutil
import subprocess
import sys
import time as _time

import httpx
from pydantic import BaseModel, Field

try:
    from copilot import CopilotClient, define_tool as _orig_define_tool

    def define_tool(description=""):
        """Wrapper that stores description for Ollama tool schema generation."""
        decorator = _orig_define_tool(description=description)
        def wrapper(fn):
            fn._tool_description = description
            tool = decorator(fn)
            tool._original_fn = fn  # preserve for non-SDK providers
            return tool
        return wrapper
except ImportError:
    CopilotClient = None
    def define_tool(description=""):
        """No-op decorator when copilot SDK is not installed."""
        def wrapper(fn):
            fn._tool_description = description
            return fn
        return wrapper

GOOGLE_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")


# ── Usage tracking ──────────────────────────────────────────────────────────

class UsageTracker:
    """Tracks estimated API costs. Prints a summary every N paid calls."""

    COST_PER_CALL = {
        "places_text_search": 0.032,       # Google Places API (Pro fields)
        "places_nearby_search": 0.032,     # Google Places API (Pro fields)
        "estimate_travel_time": 0.0,       # OSRM is free
        "estimate_traffic_adjusted_time": 0.0,  # OSRM + Open-Meteo, both free
        "get_directions": 0.0,             # OSRM, free
        "web_search": 0.0,                 # DuckDuckGo, free
        "get_my_location": 0.0,
        "setup_google_auth": 0.0,
        "set_alarm": 0.0,
        "list_alarms": 0.0,
        "cancel_alarm": 0.0,
        "switch_profile": 0.0,
        "exit_app": 0.0,
        "get_usage": 0.0,
        "github_search": 0.0,
        "github_clone": 0.0,
        "github_read_file": 0.0,
        "create_ticket": 0.0,
        "github_grep": 0.0,
        "weather_forecast": 0.0,           # Open-Meteo, free
        "convert_units": 0.0,              # Frankfurter, free
        "dictionary_lookup": 0.0,          # dictionaryapi.dev, free
        "translate_text": 0.0,             # MyMemory, free
        "timer_start": 0.0,
        "timer_check": 0.0,
        "timer_stop": 0.0,
        "system_info": 0.0,
        "read_rss": 0.0,
        "download_file": 0.0,
        "bookmark_save": 0.0,
        "bookmark_list": 0.0,
        "bookmark_search": 0.0,
        "compact_history": 0.0,
        "search_history_backups": 0.0,
        # Copilot SDK: GPT-4.1 = 1x multiplier, $0.04/premium request
        # Each LLM turn = 1 premium request = $0.04 overage
        "_llm_turn": 0.04,
    }
    REPORT_INTERVAL = 10

    # Per-token costs ($ per 1M tokens) by provider
    PROVIDER_TOKEN_COSTS = {
        "gemini": {
            "input": 2.00 / 1_000_000,   # $2.00 per 1M input tokens (Gemini 3 Pro)
            "output": 12.00 / 1_000_000,  # $12.00 per 1M output tokens
        },
    }

    def __init__(self):
        self.calls: dict[str, int] = {}
        self.total_paid_calls = 0
        self.session_cost = 0.0
        self.llm_turns = 0
        self.ollama_turns = 0
        self.provider_input_tokens: dict[str, int] = {}
        self.provider_output_tokens: dict[str, int] = {}
        self.provider_cost: dict[str, float] = {}
        self._log_path = os.path.expanduser("~/.config/local-finder/usage.json")

    def record(self, tool_name: str):
        self.calls[tool_name] = self.calls.get(tool_name, 0) + 1
        cost = self.COST_PER_CALL.get(tool_name, 0.0)
        self.session_cost += cost
        if cost > 0:
            self.total_paid_calls += 1

    def record_llm_turn(self):
        self.llm_turns += 1
        self.session_cost += self.COST_PER_CALL["_llm_turn"]

    def record_ollama_turn(self):
        self.ollama_turns += 1

    def record_local_turn(self, provider: str = "ollama", usage: dict | None = None):
        """Record a turn handled by a non-Copilot provider, with optional token usage."""
        self.ollama_turns += 1
        self.calls[f"_provider:{provider}"] = self.calls.get(f"_provider:{provider}", 0) + 1
        if usage:
            in_tok = usage.get("prompt_tokens", 0)
            out_tok = usage.get("completion_tokens", 0)
            self.provider_input_tokens[provider] = self.provider_input_tokens.get(provider, 0) + in_tok
            self.provider_output_tokens[provider] = self.provider_output_tokens.get(provider, 0) + out_tok
            costs = self.PROVIDER_TOKEN_COSTS.get(provider)
            if costs:
                turn_cost = in_tok * costs["input"] + out_tok * costs["output"]
                self.provider_cost[provider] = self.provider_cost.get(provider, 0) + turn_cost
                self.session_cost += turn_cost

    def should_report(self) -> bool:
        return self.total_paid_calls > 0 and self.total_paid_calls % self.REPORT_INTERVAL == 0

    _LLM_MODEL = "gpt-5.2"
    _LLM_MULTIPLIER = 1  # premium requests per LLM turn
    _OVERAGE_RATE = 0.04  # $ per premium request (overage)

    def summary(self) -> str:
        premium_reqs = self.llm_turns * self._LLM_MULTIPLIER
        llm_cost = self.llm_turns * self.COST_PER_CALL["_llm_turn"]
        lines = [f"📊 Usage — ~${self.session_cost:.2f} this session"]
        if self.llm_turns:
            lines.append(
                f"   💲 Copilot ({self._LLM_MODEL}): {self.llm_turns} turns × "
                f"{self._LLM_MULTIPLIER}x = {premium_reqs} premium reqs "
                f"(~${llm_cost:.2f})"
            )
        # Show per-provider local turns
        for key, count in sorted(self.calls.items()):
            if key.startswith("_provider:"):
                prov = key.split(":", 1)[1]
                prov_emoji = {"gemini": "✨", "groq": "⚡", "ollama": "🏠", "openai": "🌐"}.get(prov, "?")
                in_tok = self.provider_input_tokens.get(prov, 0)
                out_tok = self.provider_output_tokens.get(prov, 0)
                cost = self.provider_cost.get(prov, 0)
                if in_tok or out_tok:
                    lines.append(
                        f"   {prov_emoji} {prov}: {count} turns | "
                        f"{in_tok:,} in + {out_tok:,} out tokens "
                        f"(${cost:.4f})"
                    )
                else:
                    lines.append(f"   {prov_emoji} {prov}: {count} turns (free)")
        if self.total_paid_calls:
            api_cost = self.session_cost - llm_cost
            lines.append(f"   Paid API calls: {self.total_paid_calls} (~${api_cost:.3f})")
        for name, count in sorted(self.calls.items()):
            if name.startswith("_provider:"):
                continue
            unit = self.COST_PER_CALL.get(name, 0)
            cost_str = f"${unit * count:.3f}" if unit > 0 else "free"
            lines.append(f"   {name}: {count}x ({cost_str})")
        return "\n".join(lines)

    def save(self):
        try:
            os.makedirs(os.path.dirname(self._log_path), exist_ok=True)
            # Append to cumulative log
            cumulative = {}
            if os.path.exists(self._log_path):
                with open(self._log_path) as f:
                    cumulative = json.load(f)
            cumulative["total_cost"] = cumulative.get("total_cost", 0) + self.session_cost
            cumulative["total_llm_turns"] = cumulative.get("total_llm_turns", 0) + self.llm_turns
            cumulative["total_ollama_turns"] = cumulative.get("total_ollama_turns", 0) + self.ollama_turns
            # Persist per-provider token counts
            tok = cumulative.get("total_provider_tokens", {})
            for prov in set(list(self.provider_input_tokens) + list(self.provider_output_tokens)):
                pt = tok.get(prov, {"input": 0, "output": 0})
                pt["input"] = pt.get("input", 0) + self.provider_input_tokens.get(prov, 0)
                pt["output"] = pt.get("output", 0) + self.provider_output_tokens.get(prov, 0)
                tok[prov] = pt
            cumulative["total_provider_tokens"] = tok
            calls = cumulative.get("total_calls", {})
            for name, count in self.calls.items():
                calls[name] = calls.get(name, 0) + count
            cumulative["total_calls"] = calls
            with open(self._log_path, "w") as f:
                json.dump(cumulative, f, indent=2)
        except Exception:
            pass

    def summary_oneline(self) -> str:
        premium_reqs = self.llm_turns * self._LLM_MULTIPLIER
        local = f" | {self.ollama_turns} local" if self.ollama_turns else ""
        parts = [f"${self.session_cost:.2f}"]
        if self.llm_turns:
            parts.append(f"💲{self.llm_turns} paid ({premium_reqs} reqs)")
        # Show provider-specific counts
        for key, count in sorted(self.calls.items()):
            if key.startswith("_provider:"):
                prov = key.split(":", 1)[1]
                prov_emoji = {"gemini": "✨", "groq": "⚡", "ollama": "🏠", "openai": "🌐"}.get(prov, "?")
                in_tok = self.provider_input_tokens.get(prov, 0)
                out_tok = self.provider_output_tokens.get(prov, 0)
                if in_tok or out_tok:
                    total_tok = in_tok + out_tok
                    parts.append(f"{prov_emoji}{count} ({total_tok:,} tok)")
                else:
                    parts.append(f"{prov_emoji}{count}")
        if self.total_paid_calls:
            parts.append(f"{self.total_paid_calls} API")
        return " | ".join(parts)

    def lifetime_summary(self) -> str:
        try:
            if not os.path.exists(self._log_path):
                return "No lifetime usage data yet."
            with open(self._log_path) as f:
                data = json.load(f)
            total_turns = data.get("total_llm_turns", 0)
            total_reqs = total_turns * self._LLM_MULTIPLIER
            lines = [f"📊 Lifetime usage — ~${data.get('total_cost', 0):.2f} total"]
            lines.append(f"   LLM turns: {total_turns} ({total_reqs} premium reqs)")
            ollama_total = data.get("total_ollama_turns", 0)
            if ollama_total:
                lines.append(f"   Local turns: {ollama_total}")
            # Show lifetime token usage per provider
            for prov, tok in sorted(data.get("total_provider_tokens", {}).items()):
                in_tok = tok.get("input", 0)
                out_tok = tok.get("output", 0)
                costs = self.PROVIDER_TOKEN_COSTS.get(prov)
                if costs and (in_tok or out_tok):
                    cost = in_tok * costs["input"] + out_tok * costs["output"]
                    lines.append(f"   {prov}: {in_tok:,} in + {out_tok:,} out tokens (${cost:.4f})")
            for name, count in sorted(data.get("total_calls", {}).items()):
                lines.append(f"   {name}: {count}x")
            return "\n".join(lines)
        except Exception:
            return "Could not read usage data."


_usage = UsageTracker()


def _get_google_headers() -> dict | None:
    """Build auth headers: use API key if set, otherwise gcloud access token.
    Returns None if neither is available (caller should fall back to OSM)."""
    if GOOGLE_API_KEY:
        return {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": GOOGLE_API_KEY,
            "X-Goog-FieldMask": FIELD_MASK,
        }
    # Fall back to gcloud user credentials
    try:
        token = subprocess.check_output(
            ["gcloud", "auth", "print-access-token"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return None
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "X-Goog-FieldMask": FIELD_MASK,
    }
    # Attach quota project so the request is billed correctly
    try:
        project = subprocess.check_output(
            ["gcloud", "config", "get-value", "project"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        if not project or project == "(unset)":
            # Fallback: pick first available project
            project = subprocess.check_output(
                ["gcloud", "projects", "list", "--format=value(projectId)", "--limit=1"],
                stderr=subprocess.DEVNULL,
            ).decode().strip()
        if project and project != "(unset)":
            headers["X-Goog-User-Project"] = project
    except Exception:
        pass
    return headers

FIELD_MASK = ",".join([
    "places.displayName",
    "places.formattedAddress",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.types",
    "places.googleMapsUri",
    "places.currentOpeningHours",
    "places.nationalPhoneNumber",
])


# ── Device / IP location helpers ─────────────────────────────────────────────

async def _location_macos() -> dict | None:
    """Use CoreLocation via a small Swift snippet (macOS only)."""
    swift_src = r'''
import CoreLocation
import Foundation

class Loc: NSObject, CLLocationManagerDelegate {
    let mgr = CLLocationManager()
    let sem = DispatchSemaphore(value: 0)
    var result: CLLocation?
    override init() {
        super.init()
        mgr.delegate = self
        mgr.desiredAccuracy = kCLLocationAccuracyHundredMeters
        mgr.requestWhenInUseAuthorization()
        mgr.requestLocation()
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations l: [CLLocation]) {
        result = l.last; sem.signal()
    }
    func locationManager(_ m: CLLocationManager, didFailWithError e: Error) {
        sem.signal()
    }
    func run() -> String? {
        _ = sem.wait(timeout: .now() + 5)
        guard let r = result else { return nil }
        return "\(r.coordinate.latitude),\(r.coordinate.longitude)"
    }
}
if let s = Loc().run() { print(s) }
'''
    try:
        proc = await asyncio.create_subprocess_exec(
            "swift", "-e", swift_src,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        parts = stdout.decode().strip().split(",")
        if len(parts) == 2:
            return {"latitude": float(parts[0]), "longitude": float(parts[1])}
    except Exception:
        pass
    return None


async def _location_linux() -> dict | None:
    """Try GeoClue2 via D-Bus (available on most desktop Linux)."""
    if not shutil.which("gdbus"):
        return None
    try:
        # Get a GeoClue client
        proc = await asyncio.create_subprocess_exec(
            "gdbus", "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", "/org/freedesktop/GeoClue2/Manager",
            "--method", "org.freedesktop.GeoClue2.Manager.GetClient",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        client_path = stdout.decode().strip().strip("()',")

        # Start the client
        await (await asyncio.create_subprocess_exec(
            "gdbus", "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", client_path,
            "--method", "org.freedesktop.GeoClue2.Client.Start",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )).communicate()

        await asyncio.sleep(2)

        # Read Location property
        proc2 = await asyncio.create_subprocess_exec(
            "gdbus", "call", "--system",
            "--dest", "org.freedesktop.GeoClue2",
            "--object-path", client_path,
            "--method", "org.freedesktop.DBus.Properties.Get",
            "org.freedesktop.GeoClue2.Client", "Location",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout2, _ = await asyncio.wait_for(proc2.communicate(), timeout=5)
        text = stdout2.decode()

        import re
        loc_match = re.search(r"(/org/freedesktop/GeoClue2/Location/\d+)", text)
        if loc_match:
            loc_path = loc_match.group(1)
            coords = {}
            for prop in ["Latitude", "Longitude"]:
                p = await asyncio.create_subprocess_exec(
                    "gdbus", "call", "--system",
                    "--dest", "org.freedesktop.GeoClue2",
                    "--object-path", loc_path,
                    "--method", "org.freedesktop.DBus.Properties.Get",
                    "org.freedesktop.GeoClue2.Location", prop,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                so, _ = await asyncio.wait_for(p.communicate(), timeout=5)
                val = re.search(r"[-+]?\d+\.\d+", so.decode())
                if val:
                    coords[prop.lower()] = float(val.group())
            if "latitude" in coords and "longitude" in coords:
                return coords
    except Exception:
        pass
    return None


async def _location_ip() -> dict | None:
    """Fallback location — hardcoded server location."""
    return {
        "latitude": 34.1064,
        "longitude": -117.5931,
        "source": "configured",
        "approximate_location": "7903 Elm Ave, Rancho Cucamonga, CA, USA",
    }


async def _get_device_location() -> dict | None:
    """Try device-level location, fall back to IP geolocation."""
    system = platform.system()
    loc = None
    if system == "Darwin":
        loc = await _location_macos()
        if loc:
            loc["source"] = "device"
            return loc
    elif system == "Linux":
        loc = await _location_linux()
        if loc:
            loc["source"] = "device"
            return loc
    return await _location_ip()


# ── Tool 0: Get my location ─────────────────────────────────────────────────

class GetLocationParams(BaseModel):
    pass


@define_tool(
    description=(
        "Get the user's current location. Tries the device's location services "
        "(CoreLocation on macOS, GeoClue on Linux) first, then falls back to "
        "IP-based geolocation. Returns latitude, longitude, and source. "
        "Call this whenever the user says 'near me' or doesn't provide a location."
    )
)
async def get_my_location(params: GetLocationParams) -> str:
    loc = await _get_device_location()
    if not loc:
        return "Could not determine location. Please provide your coordinates or city name."
    parts = []
    if "latitude" in loc and "longitude" in loc:
        parts.append(f"Latitude: {loc['latitude']}")
        parts.append(f"Longitude: {loc['longitude']}")
    parts.append(f"Source: {loc.get('source', 'unknown')}")
    if "approximate_location" in loc:
        parts.append(f"Approximate location: {loc['approximate_location']}")
    if "timezone" in loc:
        parts.append(f"Timezone: {loc['timezone']}")
    if "latitude" not in loc:
        parts.append("NOTE: Only country-level location available. Ask the user for their city if needed.")
    return "\n".join(parts)


# ── Tool: Setup Google Places auth ──────────────────────────────────────────

class SetupAuthParams(BaseModel):
    pass


def _run_cmd(args: list[str], timeout: int = 30) -> tuple[bool, str]:
    """Run a shell command, return (success, output)."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (result.stdout + result.stderr).strip()
        return result.returncode == 0, output
    except Exception as e:
        return False, str(e)


@define_tool(
    description=(
        "Set up Google Cloud authentication and enable the Places API. "
        "Call this when a Places API request fails with a permissions or "
        "auth error (403, 401, PERMISSION_DENIED, etc.). This tool will: "
        "1) check gcloud auth status (and run 'gcloud auth login' if needed), "
        "2) get the current project, "
        "3) enable the Places API on that project, "
        "4) set the project as the quota project. "
        "Only returns an error if a step fails."
    )
)
async def setup_google_auth(params: SetupAuthParams) -> str:
    steps: list[str] = []

    # Step 1: Check if already authed
    ok, out = _run_cmd(["gcloud", "auth", "print-access-token"])
    if not ok:
        # Try interactive login
        ok, out = _run_cmd(["gcloud", "auth", "login", "--brief"], timeout=120)
        if not ok:
            return f"Failed to authenticate with gcloud: {out}"
        steps.append("Authenticated with gcloud.")
    else:
        steps.append("Already authenticated with gcloud.")

    # Step 2: Get current project
    ok, project = _run_cmd(["gcloud", "config", "get-value", "project"])
    project = project.strip()
    if not ok or not project or project == "(unset)":
        return (
            "No active gcloud project set. Run:\n"
            "  gcloud config set project YOUR_PROJECT_ID\n"
            "then try again."
        )
    steps.append(f"Using project: {project}")

    # Step 3: Enable Places API (New)
    ok, out = _run_cmd([
        "gcloud", "services", "enable",
        "places-backend.googleapis.com",
        f"--project={project}",
    ], timeout=60)
    if not ok:
        return f"Failed to enable Places API on project {project}: {out}"
    steps.append("Places API (New) enabled.")

    # Step 4: Set quota project for ADC
    ok, out = _run_cmd([
        "gcloud", "auth", "application-default",
        "set-quota-project", project,
    ])
    if not ok:
        # Non-fatal: quota project may already be set or not needed with user creds
        steps.append(f"Note: could not set quota project (may already be set): {out}")
    else:
        steps.append(f"Quota project set to {project}.")

    steps.append("Setup complete — Places API searches should now work.")
    return "\n".join(steps)


# ── Tool: Exit app ──────────────────────────────────────────────────────────

_exit_requested = asyncio.Event()


class ExitAppParams(BaseModel):
    message: str = Field(
        default="Goodbye!",
        description="Optional farewell message to display before exiting",
    )


@define_tool(
    description=(
        "Exit the application. Call this when the user wants to quit, "
        "e.g. 'exit', 'quit', 'bye', 'goodbye', 'close', 'done', 'stop'."
    )
)
async def exit_app(params: ExitAppParams) -> str:
    _exit_requested.set()
    return params.message


# ── Tool: Set alarm via cron ────────────────────────────────────────────────

ALARM_SCRIPT_DIR = os.path.expanduser("~/.config/local-finder/alarms")


class SetAlarmParams(BaseModel):
    time: str = Field(
        description=(
            "When the alarm should fire. Accepts: "
            "'HH:MM' for today/tomorrow, "
            "'YYYY-MM-DD HH:MM' for a specific date, "
            "or relative like '30m', '2h', '1h30m'."
        )
    )
    message: str = Field(
        description="The alarm message to display, e.g. 'Time to leave for ramen!'",
    )
    label: str = Field(
        default="local-finder-alarm",
        description="Short label for identifying this alarm",
    )


class ListAlarmsParams(BaseModel):
    pass


class CancelAlarmParams(BaseModel):
    label: str = Field(
        description="Label of the alarm to cancel (use list_alarms to see labels)",
    )


def _parse_alarm_time(time_str: str) -> tuple[str, str]:
    """Parse time string into (cron expression, human-readable description)."""
    from datetime import datetime, timedelta
    import re

    now = datetime.now()

    # Relative: 30m, 2h, 1h30m
    rel = re.match(r'^(?:(\d+)h)?(?:(\d+)m)?$', time_str.strip())
    if rel and (rel.group(1) or rel.group(2)):
        hours = int(rel.group(1) or 0)
        minutes = int(rel.group(2) or 0)
        target = now + timedelta(hours=hours, minutes=minutes)
        desc = f"{time_str} from now ({target.strftime('%H:%M')})"
        return f"{target.minute} {target.hour} {target.day} {target.month} *", desc

    # Absolute: HH:MM
    hm = re.match(r'^(\d{1,2}):(\d{2})$', time_str.strip())
    if hm:
        hour, minute = int(hm.group(1)), int(hm.group(2))
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        desc = f"{target.strftime('%Y-%m-%d %H:%M')}"
        return f"{minute} {hour} {target.day} {target.month} *", desc

    # Full datetime: YYYY-MM-DD HH:MM
    full = re.match(r'^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$', time_str.strip())
    if full:
        year, month, day = int(full.group(1)), int(full.group(2)), int(full.group(3))
        hour, minute = int(full.group(4)), int(full.group(5))
        desc = f"{year}-{month:02d}-{day:02d} {hour:02d}:{minute:02d}"
        return f"{minute} {hour} {day} {month} *", desc

    raise ValueError(f"Could not parse time: {time_str!r}")


@define_tool(
    description=(
        "Set an alarm that fires at a specific time using a cron job. "
        "The alarm will show a desktop notification and play a sound. "
        "Accepts absolute times ('14:30', '2026-03-01 09:00') or "
        "relative times ('30m', '2h', '1h30m'). The alarm auto-removes "
        "itself after firing. Use this when the user asks to be reminded "
        "or wants an alarm, e.g. 'remind me in 30 minutes to leave', "
        "'set an alarm for 7pm to pick up food'."
    )
)
async def set_alarm(params: SetAlarmParams) -> str:
    try:
        cron_time, desc = _parse_alarm_time(params.time)
    except ValueError as e:
        return str(e)

    label = params.label.strip().replace(" ", "_").replace("'", "")
    os.makedirs(ALARM_SCRIPT_DIR, exist_ok=True)
    script_path = os.path.join(ALARM_SCRIPT_DIR, f"{label}.sh")

    safe_msg = params.message.replace("'", "'\\''")

    script = f"""#!/bin/bash
# Marvin Alarm: {label}
export DISPLAY=${{DISPLAY:-:0}}
export DBUS_SESSION_BUS_ADDRESS=${{DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}}

# Desktop notification
notify-send -u critical -t 30000 "⏰ {label}" '{safe_msg}' 2>/dev/null || true

# Play sound
if command -v paplay &>/dev/null; then
    paplay /usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga 2>/dev/null || true
elif command -v aplay &>/dev/null; then
    aplay /usr/share/sounds/alsa/Front_Center.wav 2>/dev/null || true
elif command -v pw-play &>/dev/null; then
    pw-play /usr/share/sounds/freedesktop/stereo/alarm-clock-elapsed.oga 2>/dev/null || true
fi

echo ""
echo "⏰ ALARM [{label}]: {safe_msg}"
echo ""

# Self-destruct: remove cron entry and script
crontab -l 2>/dev/null | grep -v '{label}' | crontab -
rm -f '{script_path}'
"""

    with open(script_path, "w") as f:
        f.write(script)
    os.chmod(script_path, 0o755)

    cron_line = f"{cron_time} {script_path} # {label}"

    try:
        result = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True,
        )
        existing = result.stdout if result.returncode == 0 else ""
        lines = [l for l in existing.strip().split("\n") if l and label not in l]
        lines.append(cron_line)

        proc = subprocess.run(
            ["crontab", "-"],
            input="\n".join(lines) + "\n",
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            return f"Failed to install cron job: {proc.stderr}"
    except Exception as e:
        return f"Failed to set alarm: {e}"

    return (
        f"Alarm set!\n"
        f"  Label: {label}\n"
        f"  Time: {desc}\n"
        f"  Message: {params.message}\n"
        f"  Cron: {cron_line}\n"
        f"  Will show a desktop notification + play a sound, then auto-remove."
    )


@define_tool(
    description=(
        "List all active Marvin alarms. Shows label, scheduled time, "
        "and message for each alarm."
    )
)
async def list_alarms(params: ListAlarmsParams) -> str:
    try:
        result = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True,
        )
        if result.returncode != 0:
            return "No crontab found — no alarms set."
        lines = [
            l for l in result.stdout.strip().split("\n")
            if "local-finder" in l.lower() or ALARM_SCRIPT_DIR in l
        ]
        if not lines:
            return "No alarms currently set."
        output = ["Active alarms:"]
        for l in lines:
            parts = l.split("#")
            label = parts[-1].strip() if len(parts) > 1 else "unknown"
            cron_part = parts[0].strip()
            fields = cron_part.split()
            if len(fields) >= 5:
                minute, hour, day, month = fields[0], fields[1], fields[2], fields[3]
                output.append(f"  • {label} — scheduled {month}/{day} {hour}:{minute}")
        return "\n".join(output)
    except Exception as e:
        return f"Error listing alarms: {e}"


@define_tool(
    description=(
        "Cancel an alarm by its label. Removes the cron job and cleanup script."
    )
)
async def cancel_alarm(params: CancelAlarmParams) -> str:
    label = params.label.strip().replace(" ", "_")
    try:
        result = subprocess.run(
            ["crontab", "-l"], capture_output=True, text=True,
        )
        if result.returncode != 0:
            return "No crontab found."

        old_lines = result.stdout.strip().split("\n")
        new_lines = [l for l in old_lines if l and label not in l]

        if len(old_lines) == len(new_lines):
            return f"No alarm found with label '{label}'."

        proc = subprocess.run(
            ["crontab", "-"],
            input="\n".join(new_lines) + "\n" if new_lines else "",
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            return f"Failed to update crontab: {proc.stderr}"

        script_path = os.path.join(ALARM_SCRIPT_DIR, f"{label}.sh")
        if os.path.exists(script_path):
            os.remove(script_path)

        return f"Alarm '{label}' cancelled."
    except Exception as e:
        return f"Error cancelling alarm: {e}"


# ── Tool: ntfy push notifications ───────────────────────────────────────────

import random as _random

_NTFY_BASE = "https://ntfy.sh"


def _ntfy_subs_path() -> str:
    return os.path.join(_profile_dir(), "ntfy_subscriptions.json")


def _load_ntfy_subs() -> dict:
    try:
        with open(_ntfy_subs_path()) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_ntfy_subs(subs: dict):
    pp = _ntfy_subs_path()
    os.makedirs(os.path.dirname(pp), exist_ok=True)
    with open(pp, "w") as f:
        json.dump(subs, f, indent=2)
    _sync_ntfy_cron(subs)


_NTFY_SCRIPT_DIR = os.path.expanduser("~/.config/local-finder/ntfy")
_NTFY_SEEN_FILE = os.path.expanduser("~/.config/local-finder/ntfy/seen.json")
_NTFY_CRON_LABEL = "# local-finder-ntfy-watcher"


def _ntfy_watcher_script_path() -> str:
    return os.path.join(_NTFY_SCRIPT_DIR, "ntfy_watcher.sh")


def _create_ntfy_watcher_script():
    """Create a standalone shell script that polls ntfy topics, walls + notifies."""
    os.makedirs(_NTFY_SCRIPT_DIR, exist_ok=True)
    subs_path = _ntfy_subs_path()
    seen_file = _NTFY_SEEN_FILE
    script = f"""#!/usr/bin/env bash
# Auto-generated by local-finder. Polls ntfy subscriptions every 30 min.
SUBS_FILE="{subs_path}"
SEEN_FILE="{seen_file}"
NTFY_BASE="https://ntfy.sh"

[ ! -f "$SUBS_FILE" ] && exit 0

# Load seen message IDs
if [ -f "$SEEN_FILE" ]; then
    SEEN=$(cat "$SEEN_FILE")
else
    SEEN="[]"
fi

NEW_SEEN="$SEEN"
HAS_NEW=0

# Read each topic from subscriptions JSON
for TOPIC in $(python3 -c "import json,sys; d=json.load(open('$SUBS_FILE')); print(' '.join(d.keys()))" 2>/dev/null); do
    LABEL=$(python3 -c "import json; d=json.load(open('$SUBS_FILE')); print(d.get('$TOPIC',{{}}).get('label','$TOPIC'))" 2>/dev/null)

    # Poll for messages in last 35 minutes
    RESP=$(curl -sf "$NTFY_BASE/$TOPIC/json?poll=1&since=35m" 2>/dev/null)
    [ -z "$RESP" ] && continue

    while IFS= read -r LINE; do
        [ -z "$LINE" ] && continue
        EVENT=$(echo "$LINE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('event',''))" 2>/dev/null)
        [ "$EVENT" != "message" ] && continue

        MSG_ID=$(echo "$LINE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        [ -z "$MSG_ID" ] && continue

        # Skip if already seen
        echo "$SEEN" | python3 -c "import json,sys; ids=json.load(sys.stdin); sys.exit(0 if '$MSG_ID' in ids else 1)" 2>/dev/null && continue

        MSG=$(echo "$LINE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)
        TITLE=$(echo "$LINE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)

        DISPLAY="[$LABEL] $MSG"
        [ -n "$TITLE" ] && DISPLAY="[$LABEL] $TITLE: $MSG"

        # Wall it
        echo "$DISPLAY" | wall 2>/dev/null

        # Desktop notification
        notify-send "ntfy: $LABEL" "$MSG" 2>/dev/null

        # Mark seen
        NEW_SEEN=$(echo "$NEW_SEEN" | python3 -c "import json,sys; ids=json.load(sys.stdin); ids.append('$MSG_ID'); print(json.dumps(ids[-200:]))" 2>/dev/null)
        HAS_NEW=1
    done <<< "$RESP"
done

# Save seen IDs (keep last 200)
if [ "$HAS_NEW" = "1" ]; then
    echo "$NEW_SEEN" > "$SEEN_FILE"
fi
"""
    script_path = _ntfy_watcher_script_path()
    with open(script_path, "w") as f:
        f.write(script)
    os.chmod(script_path, 0o755)


def _sync_ntfy_cron(subs: dict):
    """Install or remove the 30-min cron job based on whether subscriptions exist."""
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        existing = result.stdout if result.returncode == 0 else ""
    except Exception:
        existing = ""

    # Remove old ntfy cron lines
    lines = [l for l in existing.strip().split("\n") if l and _NTFY_CRON_LABEL not in l]

    if subs:
        _create_ntfy_watcher_script()
        script_path = _ntfy_watcher_script_path()
        cron_line = f"*/30 * * * * {script_path} {_NTFY_CRON_LABEL}"
        lines.append(cron_line)

    try:
        subprocess.run(
            ["crontab", "-"],
            input="\n".join(lines) + "\n" if lines else "",
            capture_output=True, text=True,
        )
    except Exception:
        pass


def _generate_topic() -> str:
    """Generate a correct-horse-battery-staple style topic from system dict."""
    dict_path = "/usr/share/dict/words"
    try:
        with open(dict_path) as f:
            words = [
                w.strip().lower() for w in f
                if w.strip().isalpha() and 3 <= len(w.strip()) <= 8
            ]
    except Exception:
        words = [
            "alpha", "bravo", "cedar", "delta", "ember",
            "frost", "grove", "haste", "ivory", "jade",
        ]
    chosen = _random.sample(words, min(5, len(words)))
    return "-".join(chosen)


async def _poll_ntfy_topic(topic: str) -> list[dict]:
    """Poll a ntfy topic for messages since last check."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_NTFY_BASE}/{topic}/json",
                params={"poll": "1", "since": "1h"},
            )
            resp.raise_for_status()
            messages = []
            for line in resp.text.strip().split("\n"):
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line)
                    if msg.get("event") == "message":
                        messages.append({
                            "time": msg.get("time", 0),
                            "message": msg.get("message", ""),
                            "title": msg.get("title", ""),
                            "tags": msg.get("tags", []),
                        })
                except json.JSONDecodeError:
                    continue
            return messages
    except Exception:
        return []


async def _check_all_subscriptions() -> str:
    """Check all subscribed topics and return new notifications."""
    subs = _load_ntfy_subs()
    if not subs:
        return ""
    lines = []
    for topic, info in subs.items():
        messages = await _poll_ntfy_topic(topic)
        if messages:
            label = info.get("label", topic)
            lines.append(f"📬 Notifications for '{label}' ({topic}):")
            for m in messages[-5:]:  # last 5
                title = f" [{m['title']}]" if m.get("title") else ""
                lines.append(f"  • {m['message']}{title}")
    return "\n".join(lines)


class GenerateNtfyTopicParams(BaseModel):
    label: str = Field(
        default="",
        description="Optional friendly label for this topic (e.g. 'dinner alerts', 'deal watch')",
    )


class NtfySubscribeParams(BaseModel):
    topic: str = Field(description="The ntfy topic name to subscribe to")
    label: str = Field(
        default="",
        description="Friendly label for this subscription",
    )


class NtfyUnsubscribeParams(BaseModel):
    topic: str = Field(description="The ntfy topic name to unsubscribe from")


class NtfyPublishParams(BaseModel):
    topic: str = Field(description="The ntfy topic to publish to")
    message: str = Field(description="The notification message to send")
    title: str = Field(default="", description="Optional notification title")


class NtfyListParams(BaseModel):
    pass


@define_tool(
    description=(
        "Generate a unique ntfy.sh notification topic URL using a "
        "correct-horse-battery-staple style name (5 random dictionary words). "
        "Returns the topic name and full URL. Optionally subscribes automatically."
    )
)
async def generate_ntfy_topic(params: GenerateNtfyTopicParams) -> str:
    topic = _generate_topic()
    url = f"{_NTFY_BASE}/{topic}"
    label = params.label or topic

    # Auto-subscribe
    subs = _load_ntfy_subs()
    subs[topic] = {"label": label, "url": url}
    _save_ntfy_subs(subs)

    return (
        f"Generated ntfy topic and subscribed:\n"
        f"  Topic: {topic}\n"
        f"  URL:   {url}\n"
        f"  Label: {label}\n\n"
        f"Anyone can send notifications to this topic:\n"
        f"  curl -d 'Hello!' {url}\n\n"
        f"Or from a browser: {url}\n\n"
        f"A cron job will check every 30 min and wall + notify new messages even when the app is closed."
    )


@define_tool(
    description=(
        "Subscribe to an existing ntfy.sh topic to receive notifications. "
        "New messages will be checked and shown on every prompt."
    )
)
async def ntfy_subscribe(params: NtfySubscribeParams) -> str:
    topic = params.topic.strip()
    label = params.label or topic
    subs = _load_ntfy_subs()
    subs[topic] = {"label": label, "url": f"{_NTFY_BASE}/{topic}"}
    _save_ntfy_subs(subs)
    return (
        f"Subscribed to '{topic}' (label: {label}). {len(subs)} active subscriptions.\n"
        f"A cron job will check every 30 min and wall + notify new messages even when the app is closed."
    )


@define_tool(
    description="Unsubscribe from a ntfy.sh topic."
)
async def ntfy_unsubscribe(params: NtfyUnsubscribeParams) -> str:
    topic = params.topic.strip()
    subs = _load_ntfy_subs()
    if topic not in subs:
        return f"Not subscribed to '{topic}'."
    del subs[topic]
    _save_ntfy_subs(subs)
    remaining = f"{len(subs)} active subscriptions." if subs else "No subscriptions left — cron job removed."
    return f"Unsubscribed from '{topic}'. {remaining}"


@define_tool(
    description=(
        "Send a push notification to a ntfy.sh topic. "
        "Use this when the user wants to send themselves a reminder, "
        "share a link to their phone, or notify someone."
    )
)
async def ntfy_publish(params: NtfyPublishParams) -> str:
    topic = params.topic.strip()
    headers = {}
    if params.title:
        headers["Title"] = params.title
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{_NTFY_BASE}/{topic}",
                content=params.message,
                headers=headers,
            )
            resp.raise_for_status()
    except Exception as e:
        return f"Failed to publish: {e}"
    return f"Notification sent to topic '{topic}'."


@define_tool(
    description="List all active ntfy.sh subscriptions and check for new notifications."
)
async def ntfy_list(params: NtfyListParams) -> str:
    subs = _load_ntfy_subs()
    if not subs:
        return "No ntfy subscriptions. Use generate_ntfy_topic to create one."
    lines = [f"Active subscriptions ({len(subs)}):"]
    for topic, info in subs.items():
        lines.append(f"  • {info.get('label', topic)} → {_NTFY_BASE}/{topic}")
    # Check for new messages
    notifs = await _check_all_subscriptions()
    if notifs:
        lines.append(f"\nNew notifications:\n{notifs}")
    else:
        lines.append("\nNo new notifications.")
    return "\n".join(lines)


# ── Tool: Usage report ──────────────────────────────────────────────────────

class GetUsageParams(BaseModel):
    include_lifetime: bool = Field(
        default=False,
        description="Also include lifetime cumulative usage across all sessions",
    )


@define_tool(
    description=(
        "Show current session and optionally lifetime API usage and estimated costs. "
        "Call this when the user asks about usage, costs, or billing."
    )
)
async def get_usage(params: GetUsageParams) -> str:
    parts = [_usage.summary()]
    if params.include_lifetime:
        parts.append("")
        parts.append(_usage.lifetime_summary())
    return "\n".join(parts)


# ── Tool: Web search via DuckDuckGo ─────────────────────────────────────────

class WebSearchParams(BaseModel):
    query: str = Field(description="The search query")
    max_results: int = Field(
        default=5,
        description="Maximum number of results to return (1-20)",
    )
    time_filter: str = Field(
        default="",
        description="Time filter: '' (any), 'd' (day), 'w' (week), 'm' (month), 'y' (year)",
    )


@define_tool(
    description=(
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets. "
        "THIS IS THE DEFAULT TOOL FOR ALL WEB SEARCHES. Use this FIRST whenever "
        "the user asks to look something up, find information, search for "
        "anything online, check reviews, hours, menus, news, events, etc. "
        "Only use browse_web or scrape_page if you already have a specific URL "
        "and need to read the full page content."
    )
)
async def web_search(params: WebSearchParams) -> str:
    from ddgs import DDGS

    try:
        results = DDGS().text(
            params.query,
            max_results=min(params.max_results, 20),
            timelimit=params.time_filter or None,
        )
    except Exception as e:
        return f"Search failed: {e}"

    if not results:
        return "No results found."

    lines = []
    for i, r in enumerate(results, 1):
        title = r.get("title", "No title")
        url = r.get("href", "")
        body = r.get("body", "")
        lines.append(f"{i}. {title}\n   {url}\n   {body}")
    return "\n\n".join(lines)


# ── Tool: News search (GNews → NewsAPI → DuckDuckGo fallback) ──────────────

GNEWS_API_KEY = os.environ.get("GNEWS_API_KEY", "")
if not GNEWS_API_KEY:
    _gnews_key_path = os.path.expanduser("~/.ssh/GNEWS_API_KEY")
    if os.path.isfile(_gnews_key_path):
        with open(_gnews_key_path) as _f:
            _key = _f.read().strip()
            if _key:
                GNEWS_API_KEY = _key

NEWSAPI_KEY = os.environ.get("NEWSAPI_KEY", "")
if not NEWSAPI_KEY:
    _newsapi_key_path = os.path.expanduser("~/.ssh/NEWSAPI_KEY")
    if os.path.isfile(_newsapi_key_path):
        with open(_newsapi_key_path) as _f:
            _key = _f.read().strip()
            if _key:
                NEWSAPI_KEY = _key

class SearchNewsParams(BaseModel):
    query: str = Field(description="News search query, e.g. 'AI regulation' or 'SpaceX launch'")
    max_results: int = Field(default=20, description="Max results per source (1-50)")
    time_filter: str = Field(
        default="",
        description="Time filter: 'd' = past day, 'w' = past week, 'm' = past month. Empty = any time.",
    )


@define_tool(
    description=(
        "Search for recent news articles on ANY topic. Queries GNews, NewsAPI, and "
        "DuckDuckGo News simultaneously, deduplicates, and returns ALL articles from "
        "the last 2 days. Use this whenever the user asks about news, current events, "
        "headlines, what's happening, recent developments, or wants to know what's new "
        "in a field (e.g. 'indie game news', 'AI news', 'tech news'). "
        "IMPORTANT: Return ALL articles from the results to the user — do not "
        "summarize or omit any. The user wants an exhaustive list."
    )
)
async def search_news(params: SearchNewsParams) -> str:
    from datetime import datetime, timedelta, timezone
    max_res = min(params.max_results, 50)
    two_days_ago = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%dT00:00:00Z")
    seen_urls: set[str] = set()
    all_articles: list[str] = []

    def _dedup_add(title: str, source: str, date: str, url: str, body: str, via: str):
        if not url or url in seen_urls:
            return
        seen_urls.add(url)
        all_articles.append(
            f"• {title}\n"
            f"  📰 {source} — {date} [{via}]\n"
            f"  {url}\n"
            f"  {body}"
        )

    async def _fetch_gnews():
        if not GNEWS_API_KEY:
            return
        try:
            gn_params: dict = {
                "q": params.query, "lang": "en", "max": max_res,
                "apikey": GNEWS_API_KEY, "sortby": "publishedAt",
                "from": two_days_ago,
            }
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get("https://gnews.io/api/v4/search", params=gn_params)
                if r.status_code == 200:
                    for a in r.json().get("articles", []):
                        _dedup_add(
                            a.get("title", ""), a.get("source", {}).get("name", ""),
                            a.get("publishedAt", ""), a.get("url", ""),
                            a.get("description", ""), "GNews",
                        )
        except Exception:
            pass

    async def _fetch_newsapi():
        if not NEWSAPI_KEY:
            return
        try:
            na_params: dict = {
                "q": params.query, "language": "en", "pageSize": max_res,
                "sortBy": "publishedAt", "apiKey": NEWSAPI_KEY,
                "from": two_days_ago,
            }
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.get("https://newsapi.org/v2/everything", params=na_params)
                if r.status_code == 200:
                    for a in r.json().get("articles", []):
                        _dedup_add(
                            a.get("title", ""), a.get("source", {}).get("name", ""),
                            a.get("publishedAt", ""), a.get("url", ""),
                            a.get("description", ""), "NewsAPI",
                        )
        except Exception:
            pass

    async def _fetch_ddg():
        from ddgs import DDGS
        try:
            results = DDGS().news(params.query, max_results=max_res, timelimit="d")
            for r in (results or []):
                _dedup_add(
                    r.get("title", ""), r.get("source", ""),
                    r.get("date", ""), r.get("url", ""),
                    r.get("body", ""), "DDG",
                )
        except Exception:
            pass

    await asyncio.gather(_fetch_gnews(), _fetch_newsapi(), _fetch_ddg())

    if all_articles:
        header = f"News for '{params.query}' (last 2 days) — {len(all_articles)} articles:\n"
        return header + "\n\n".join(all_articles)

    # Last resort: DDG web search
    from ddgs import DDGS
    try:
        results = DDGS().text(
            f"{params.query} news latest",
            max_results=max_res, timelimit="d",
        )
        if results:
            lines = []
            for r in results:
                lines.append(
                    f"• {r.get('title', '')}\n"
                    f"  {r.get('href', '')}\n"
                    f"  {r.get('body', '')}"
                )
            return f"(web search fallback) News for '{params.query}':\n\n" + "\n\n".join(lines)
    except Exception as e:
        return f"News search failed: {e}"

    return f"No news found for '{params.query}'."


# ── Tool: Academic paper search ─────────────────────────────────────────────

class SearchPapersParams(BaseModel):
    query: str = Field(description="Search query for academic papers")
    max_results: int = Field(default=5, description="Maximum results to return (1-20)")
    year_min: int = Field(default=0, description="Filter papers from this year onward (0 = no filter)")
    year_max: int = Field(default=0, description="Filter papers up to this year (0 = no filter)")
    open_access_only: bool = Field(default=False, description="Only return papers with free PDF links")


class SearchArxivParams(BaseModel):
    query: str = Field(description="Search query for arXiv preprints")
    max_results: int = Field(default=5, description="Maximum results (1-20)")
    sort_by: str = Field(
        default="relevance",
        description="Sort by: 'relevance', 'lastUpdatedDate', or 'submittedDate'",
    )


@define_tool(
    description=(
        "Search for academic papers using Semantic Scholar. Returns titles, "
        "authors, year, citation count, abstract, and PDF links when available. "
        "Use this for general academic/scientific paper searches. Free, no API key."
    )
)
async def search_papers(params: SearchPapersParams) -> str:
    api_params = {
        "query": params.query,
        "limit": min(params.max_results, 20),
        "fields": "title,authors,year,citationCount,abstract,url,openAccessPdf,externalIds",
    }
    if params.year_min or params.year_max:
        yr_min = str(params.year_min) if params.year_min else ""
        yr_max = str(params.year_max) if params.year_max else ""
        api_params["year"] = f"{yr_min}-{yr_max}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://api.semanticscholar.org/graph/v1/paper/search",
                params=api_params,
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Semantic Scholar search failed: {e}"

    papers = data.get("data", [])
    if not papers:
        return f"No papers found for '{params.query}'."

    lines = []
    for i, p in enumerate(papers, 1):
        title = p.get("title", "Untitled")
        authors = ", ".join(a.get("name", "") for a in (p.get("authors") or [])[:4])
        if len(p.get("authors") or []) > 4:
            authors += " et al."
        year = p.get("year", "N/A")
        cites = p.get("citationCount", 0)
        url = p.get("url", "")
        abstract = (p.get("abstract") or "")[:200]
        if abstract and len(p.get("abstract", "")) > 200:
            abstract += "..."
        pdf = ""
        oa = p.get("openAccessPdf")
        if oa and oa.get("url"):
            pdf = f"\n   📄 PDF: {oa['url']}"

        if params.open_access_only and not pdf:
            continue

        arxiv_id = (p.get("externalIds") or {}).get("ArXiv", "")
        arxiv_link = f"\n   arXiv: https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""

        entry = f"{i}. {title}\n   {authors} ({year}) — {cites} citations\n   {url}{pdf}{arxiv_link}"
        if abstract:
            entry += f"\n   {abstract}"
        lines.append(entry)

    if not lines:
        return f"No open-access papers found for '{params.query}'."

    total = data.get("total", len(lines))
    header = f"Found {total} papers for '{params.query}' (showing {len(lines)}):\n"
    return header + "\n\n".join(lines)


@define_tool(
    description=(
        "Search arXiv for preprints. Returns titles, authors, abstract, "
        "and direct PDF links. Best for recent/cutting-edge research in "
        "physics, CS, math, biology, and other sciences. Free, no API key."
    )
)
async def search_arxiv(params: SearchArxivParams) -> str:
    import xml.etree.ElementTree as ET

    sort_map = {
        "relevance": "relevance",
        "lastUpdatedDate": "lastUpdatedDate",
        "submittedDate": "submittedDate",
    }
    sort_by = sort_map.get(params.sort_by, "relevance")

    api_params = {
        "search_query": f"all:{params.query}",
        "start": 0,
        "max_results": min(params.max_results, 20),
        "sortBy": sort_by,
        "sortOrder": "descending",
    }

    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
            resp = await client.get(
                "https://export.arxiv.org/api/query",
                params=api_params,
            )
            resp.raise_for_status()
    except Exception as e:
        return f"arXiv search failed: {e}"

    ns = {"atom": "http://www.w3.org/2005/Atom"}
    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError as e:
        return f"Failed to parse arXiv response: {e}"

    entries = root.findall("atom:entry", ns)
    if not entries:
        return f"No arXiv preprints found for '{params.query}'."

    lines = []
    for i, entry in enumerate(entries, 1):
        title = (entry.findtext("atom:title", "", ns) or "").strip().replace("\n", " ")
        authors = [a.findtext("atom:name", "", ns) for a in entry.findall("atom:author", ns)]
        author_str = ", ".join(authors[:4])
        if len(authors) > 4:
            author_str += " et al."
        published = (entry.findtext("atom:published", "", ns) or "")[:10]
        abstract = (entry.findtext("atom:summary", "", ns) or "").strip().replace("\n", " ")[:200]
        if len(entry.findtext("atom:summary", "", ns) or "") > 200:
            abstract += "..."

        abs_url = ""
        pdf_url = ""
        for link in entry.findall("atom:link", ns):
            if link.get("title") == "pdf":
                pdf_url = link.get("href", "")
            elif link.get("rel") == "alternate":
                abs_url = link.get("href", "")

        categories = [c.get("term", "") for c in entry.findall("atom:category", ns)]
        cat_str = ", ".join(categories[:3]) if categories else ""

        result = f"{i}. {title}\n   {author_str} ({published})"
        if cat_str:
            result += f" [{cat_str}]"
        result += f"\n   {abs_url}"
        if pdf_url:
            result += f"\n   📄 PDF: {pdf_url}"
        if abstract:
            result += f"\n   {abstract}"
        lines.append(result)

    header = f"arXiv results for '{params.query}' ({len(lines)} papers):\n"
    return header + "\n\n".join(lines)


# ── Tool: Film/movie reviews (OMDB) ─────────────────────────────────────────

OMDB_API_KEY = os.environ.get("OMDB_API_KEY", "")


class SearchMoviesParams(BaseModel):
    query: str = Field(description="Movie or TV show title to search for")
    year: str = Field(default="", description="Optional year to narrow results")
    type: str = Field(
        default="",
        description="Optional type filter: 'movie', 'series', or 'episode'",
    )


class GetMovieDetailsParams(BaseModel):
    title: str = Field(default="", description="Movie title (use this or imdb_id)")
    imdb_id: str = Field(default="", description="IMDb ID like 'tt1234567'")


@define_tool(
    description=(
        "Search for movies and TV shows. Uses OMDB if API key is set, "
        "otherwise falls back to DuckDuckGo web search. "
        "Use this when users ask about film reviews, movie ratings, "
        "or 'is X movie good'."
    )
)
async def search_movies(params: SearchMoviesParams) -> str:
    if not OMDB_API_KEY:
        # Fallback to DuckDuckGo
        from ddgs import DDGS
        try:
            q = f"{params.query} movie"
            if params.year:
                q += f" {params.year}"
            results = DDGS().text(q, max_results=min(params.max_results, 10))
        except Exception as e:
            return f"Search failed: {e}"
        if not results:
            return f"No results for '{params.query}'."
        lines = [f"Movie results via web search (set OMDB_API_KEY for richer data):"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.get('title', '?')}\n   {r.get('href', '')}\n   {r.get('body', '')}")
        return "\n\n".join(lines)

    api_params = {"apikey": OMDB_API_KEY, "s": params.query}
    if params.year:
        api_params["y"] = params.year
    if params.type:
        api_params["type"] = params.type

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://www.omdbapi.com/", params=api_params)
            data = resp.json()
    except Exception as e:
        return f"OMDB search failed: {e}"

    if data.get("Response") == "False":
        return f"No results: {data.get('Error', 'Unknown error')}"

    results = data.get("Search", [])
    lines = []
    for i, m in enumerate(results[:10], 1):
        lines.append(
            f"{i}. {m.get('Title', '?')} ({m.get('Year', '?')}) "
            f"[{m.get('Type', '?')}] — IMDb: {m.get('imdbID', '?')}"
        )
    return f"Found {len(results)} results for '{params.query}':\n" + "\n".join(lines)


@define_tool(
    description=(
        "Get detailed info and reviews for a specific movie/show from OMDB. "
        "Returns plot, ratings (IMDb, Rotten Tomatoes, Metacritic), "
        "director, actors, awards, and more. Use after search_movies."
    )
)
async def get_movie_details(params: GetMovieDetailsParams) -> str:
    if not OMDB_API_KEY:
        # Fallback to DuckDuckGo
        from ddgs import DDGS
        q = params.title or params.imdb_id or ""
        if not q:
            return "Provide either a title or IMDb ID."
        try:
            results = DDGS().text(f"{q} movie review rating", max_results=5)
        except Exception as e:
            return f"Search failed: {e}"
        if not results:
            return f"No results for '{q}'."
        lines = [f"Movie details via web search (set OMDB_API_KEY for richer data):"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.get('title', '?')}\n   {r.get('href', '')}\n   {r.get('body', '')}")
        return "\n\n".join(lines)

    api_params = {"apikey": OMDB_API_KEY, "plot": "full"}
    if params.imdb_id:
        api_params["i"] = params.imdb_id
    elif params.title:
        api_params["t"] = params.title
    else:
        return "Provide either a title or IMDb ID."

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://www.omdbapi.com/", params=api_params)
            data = resp.json()
    except Exception as e:
        return f"OMDB lookup failed: {e}"

    if data.get("Response") == "False":
        return f"Not found: {data.get('Error', 'Unknown error')}"

    lines = [
        f"🎬 {data.get('Title', '?')} ({data.get('Year', '?')})",
        f"   Rated: {data.get('Rated', 'N/A')} | {data.get('Runtime', 'N/A')} | {data.get('Genre', 'N/A')}",
        f"   Director: {data.get('Director', 'N/A')}",
        f"   Actors: {data.get('Actors', 'N/A')}",
    ]
    for r in data.get("Ratings", []):
        lines.append(f"   ⭐ {r.get('Source', '?')}: {r.get('Value', '?')}")
    lines.append(f"   Awards: {data.get('Awards', 'N/A')}")
    lines.append(f"   Box Office: {data.get('BoxOffice', 'N/A')}")
    lines.append(f"\n   Plot: {data.get('Plot', 'N/A')}")
    lines.append(f"\n   IMDb: https://www.imdb.com/title/{data.get('imdbID', '')}/")
    return "\n".join(lines)


# ── Tool: Video game reviews (RAWG) ─────────────────────────────────────────

RAWG_API_KEY = os.environ.get("RAWG_API_KEY", "")


class SearchGamesParams(BaseModel):
    query: str = Field(description="Game title to search for")
    max_results: int = Field(default=5, description="Max results (1-10)")


class GetGameDetailsParams(BaseModel):
    game_id: int = Field(description="RAWG game ID (from search_games results)")


@define_tool(
    description=(
        "Search for video games. Uses RAWG if API key is set, "
        "otherwise falls back to DuckDuckGo web search. "
        "Use when users ask about game reviews or 'is X game good'."
    )
)
async def search_games(params: SearchGamesParams) -> str:
    if not RAWG_API_KEY:
        # Fallback to DuckDuckGo
        from ddgs import DDGS
        try:
            results = DDGS().text(
                f"{params.query} video game review",
                max_results=min(params.max_results, 10),
            )
        except Exception as e:
            return f"Search failed: {e}"
        if not results:
            return f"No results for '{params.query}'."
        lines = [f"Game results via web search (set RAWG_API_KEY for richer data):"]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r.get('title', '?')}\n   {r.get('href', '')}\n   {r.get('body', '')}")
        return "\n\n".join(lines)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.rawg.io/api/games",
                params={
                    "key": RAWG_API_KEY,
                    "search": params.query,
                    "page_size": min(params.max_results, 10),
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"RAWG search failed: {e}"

    games = data.get("results", [])
    if not games:
        return f"No games found for '{params.query}'."

    lines = []
    for i, g in enumerate(games, 1):
        name = g.get("name", "?")
        released = g.get("released", "N/A")
        rating = g.get("rating", 0)
        metacritic = g.get("metacritic", "N/A")
        platforms = ", ".join(
            p.get("platform", {}).get("name", "") for p in (g.get("platforms") or [])[:4]
        )
        gid = g.get("id", 0)
        lines.append(
            f"{i}. {name} ({released})\n"
            f"   Rating: {rating}/5 | Metacritic: {metacritic} | Platforms: {platforms}\n"
            f"   RAWG ID: {gid} (use with get_game_details)"
        )
    return f"Found games for '{params.query}':\n\n" + "\n\n".join(lines)


@define_tool(
    description=(
        "Get detailed info for a video game from RAWG by its ID. "
        "Returns description, ratings breakdown, Metacritic score, "
        "platforms, genres, developers, and more."
    )
)
async def get_game_details(params: GetGameDetailsParams) -> str:
    if not RAWG_API_KEY:
        return (
            "RAWG_API_KEY not set — cannot look up by game ID without it. "
            "Use search_games to find info via web search, or set RAWG_API_KEY."
        )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"https://api.rawg.io/api/games/{params.game_id}",
                params={"key": RAWG_API_KEY},
            )
            resp.raise_for_status()
            g = resp.json()
    except Exception as e:
        return f"RAWG lookup failed: {e}"

    desc = (g.get("description_raw") or "")[:500]
    if len(g.get("description_raw") or "") > 500:
        desc += "..."

    platforms = ", ".join(
        p.get("platform", {}).get("name", "") for p in (g.get("platforms") or [])
    )
    genres = ", ".join(x.get("name", "") for x in (g.get("genres") or []))
    devs = ", ".join(x.get("name", "") for x in (g.get("developers") or []))
    pubs = ", ".join(x.get("name", "") for x in (g.get("publishers") or []))

    lines = [
        f"🎮 {g.get('name', '?')} ({g.get('released', 'N/A')})",
        f"   Rating: {g.get('rating', 0)}/5 ({g.get('ratings_count', 0)} ratings)",
        f"   Metacritic: {g.get('metacritic', 'N/A')}",
        f"   Platforms: {platforms}",
        f"   Genres: {genres}",
        f"   Developers: {devs}",
        f"   Publishers: {pubs}",
        f"   Playtime: ~{g.get('playtime', 'N/A')} hours",
        f"   Website: {g.get('website', 'N/A')}",
    ]

    # Ratings breakdown
    for r in g.get("ratings", []):
        lines.append(f"   {r.get('title', '?').capitalize()}: {r.get('percent', 0)}% ({r.get('count', 0)})")

    lines.append(f"\n   {desc}")
    lines.append(f"\n   RAWG: https://rawg.io/games/{g.get('slug', '')}")
    return "\n".join(lines)


# ── Coding Agent Mode ────────────────────────────────────────────────────────

_coding_mode = False
_coding_working_dir: str | None = None
_LOCK_EXPIRE_SECONDS = 300  # 5 minutes


def _resolve_coding_path(rel_path: str) -> str:
    """Resolve a path relative to coding working directory."""
    if not _coding_working_dir:
        raise ValueError("No working directory set. Use set_working_dir first.")
    if os.path.isabs(rel_path):
        return rel_path
    return os.path.normpath(os.path.join(_coding_working_dir, rel_path))


def _lock_path(directory: str) -> str:
    return os.path.join(directory, ".marvin.lock")


def _acquire_lock(directory: str, tool_name: str) -> str | None:
    """Acquire a directory lock atomically. Returns None on success, error string on failure."""
    lp = _lock_path(directory)
    my_pid = os.getpid()

    # Check for existing lock
    if os.path.exists(lp):
        try:
            with open(lp) as f:
                lock_info = json.loads(f.read())
            lock_time = lock_info.get("time", 0)
            lock_pid = lock_info.get("pid", -1)

            # Same process re-entrancy: allow nested locks from same PID
            if lock_pid == my_pid:
                return None

            # Check if lock holder process is still alive
            stale = False
            if isinstance(lock_pid, int) and lock_pid > 0:
                try:
                    os.kill(lock_pid, 0)  # signal 0 = check existence
                except ProcessLookupError:
                    stale = True  # process is dead
                except PermissionError:
                    pass  # process exists but we can't signal it

            if not stale and _time.time() - lock_time < _LOCK_EXPIRE_SECONDS:
                owner = lock_info.get("tool", "?")
                user = lock_info.get("user", "?")
                age = int(_time.time() - lock_time)
                return (
                    f"🔒 Directory locked by '{owner}' (PID {lock_pid}, user {user}, {age}s ago). "
                    f"Cannot proceed — another operation is in progress."
                )
            # Stale lock (expired or dead process), safe to overwrite
        except (json.JSONDecodeError, OSError):
            pass  # corrupted lock, overwrite

    # Atomic lock creation using O_CREAT|O_EXCL via tempfile + rename
    lock_data = {
        "pid": my_pid,
        "user": os.environ.get("USER", "unknown"),
        "time": _time.time(),
        "tool": tool_name,
        "dir": directory,
    }
    tmp_path = lp + f".{my_pid}.tmp"
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            os.write(fd, json.dumps(lock_data).encode())
        finally:
            os.close(fd)
        os.replace(tmp_path, lp)  # atomic on POSIX
    except FileExistsError:
        # Another process beat us to it
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return "🔒 Lock contention — another process is acquiring the lock. Retry shortly."
    except OSError as e:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return f"Failed to acquire lock: {e}"
    return None


def _release_lock(directory: str):
    """Release a directory lock (only if we own it)."""
    lp = _lock_path(directory)
    try:
        if os.path.exists(lp):
            with open(lp) as f:
                lock_info = json.loads(f.read())
            if lock_info.get("pid") == os.getpid():
                os.unlink(lp)
    except (OSError, json.JSONDecodeError):
        pass


def _read_instructions_file() -> str:
    """Read coding instructions for the current working directory.

    Looks for instructions at (in order):
      1. ~/.marvin/instructions/<base64-safe-path>.md  (preferred — survives workspace wipes)
      2. .marvin-instructions in the working directory (legacy)
      3. .marvin/instructions.md in the working directory (legacy)
    """
    if not _coding_working_dir:
        return ""
    # Primary location: outside workspace
    import hashlib
    safe_name = _coding_working_dir.strip("/").replace("/", "_")
    home_instructions = os.path.join(
        os.path.expanduser("~"), ".marvin", "instructions", f"{safe_name}.md"
    )
    search_paths = [
        home_instructions,
        os.path.join(_coding_working_dir, ".marvin-instructions"),
        os.path.join(_coding_working_dir, ".marvin", "instructions.md"),
    ]
    for p in search_paths:
        if os.path.isfile(p):
            try:
                with open(p) as f:
                    return f.read().strip()
            except OSError:
                pass
    return ""


class SetWorkingDirParams(BaseModel):
    path: str = Field(description="Absolute path to the working directory for coding operations")


class GetWorkingDirParams(BaseModel):
    pass


class CreateFileParams(BaseModel):
    path: str = Field(description="File path (relative to working dir or absolute)")
    content: str = Field(description="File content to write")


class ApplyPatchParams(BaseModel):
    path: str = Field(description="File path to edit (relative to working dir or absolute)")
    old_str: str = Field(description="Exact string to find in the file (must match exactly)")
    new_str: str = Field(description="Replacement string")


class CodeGrepParams(BaseModel):
    pattern: str = Field(description="Regex pattern to search for")
    glob_filter: str = Field(default="*", description="Glob pattern to filter files (e.g. '*.py', '*.ts')")
    context_lines: int = Field(default=2, description="Lines of context before and after match")
    max_results: int = Field(default=20, description="Maximum matches to return")


class TreeParams(BaseModel):
    path: str = Field(default=".", description="Directory to list (relative to working dir)")
    max_depth: int = Field(default=3, description="Maximum depth to traverse")
    respect_gitignore: bool = Field(default=True, description="Skip .gitignore'd files")


class ReadFileParams(BaseModel):
    path: str = Field(description="File path (relative to working dir or absolute)")
    start_line: int | None = Field(default=None, description="Start line (1-based)")
    end_line: int | None = Field(default=None, description="End line (1-based, inclusive)")


class GitStatusParams(BaseModel):
    pass


class GitDiffParams(BaseModel):
    staged: bool = Field(default=False, description="Show staged changes only")
    path: str | None = Field(default=None, description="Specific file to diff")


class GitCommitParams(BaseModel):
    message: str = Field(description="Commit message")
    add_all: bool = Field(default=True, description="Stage all changes before committing")


class GitLogParams(BaseModel):
    max_count: int = Field(default=10, description="Number of commits to show")
    oneline: bool = Field(default=True, description="One-line format")


class GitCheckoutParams(BaseModel):
    target: str = Field(description="Branch name, commit hash, or file path to checkout")
    create_branch: bool = Field(default=False, description="Create a new branch")


class RunCommandParams(BaseModel):
    command: str = Field(description="Shell command to execute")
    timeout: int = Field(default=60, description="Timeout in seconds")


class LaunchAgentParams(BaseModel):
    ticket_id: str = Field(description="Ticket ID (from tk) for the task being dispatched. Required — create a ticket first with create_ticket.")
    prompt: str = Field(description="The task/prompt for the sub-agent to execute")
    model: str = Field(
        default="auto",
        description=(
            "Model to use: 'auto' (assess task), 'codex' (gpt-5.3-codex, cheap local edits), "
            "'opus' (claude-opus-4.6, complex multi-file), 'sonnet' (claude-sonnet-4.5, docs), "
            "'haiku' (claude-haiku-4.5, summaries/formatting)"
        )
    )
    working_dir: str | None = Field(default=None, description="Working directory (defaults to current coding dir)")
    design_first: bool = Field(
        default=False,
        description=(
            "Run spec & architecture passes before implementation. Phase 1a uses "
            "claude-opus-4.6 to generate a product spec and UX design (.marvin/spec.md). "
            "Phase 1b uses claude-opus-4.6 to generate architecture and exhaustive test plan "
            "(.marvin/design.md) based on the spec. Recommended for greenfield tasks."
        )
    )
    tdd: bool = Field(
        default=False,
        description=(
            "Enable TDD workflow: (1) write failing tests first in parallel agents, "
            "(2) implement code, (3) run debug loop until all tests pass. "
            "Requires design_first=true or an existing .marvin/design.md."
        )
    )


# ── Coding tools ─────────────────────────────────────────────────────────────

@define_tool(
    description="Set the working directory for coding operations. All file paths will be relative to this."
)
async def set_working_dir(params: SetWorkingDirParams) -> str:
    global _coding_working_dir
    p = os.path.expanduser(params.path)
    if not os.path.isdir(p):
        return f"Directory does not exist: {p}"
    _coding_working_dir = os.path.abspath(p)
    return f"✅ Working directory set to: {_coding_working_dir}"


@define_tool(description="Get the current working directory for coding operations.")
async def get_working_dir(params: GetWorkingDirParams) -> str:
    if not _coding_working_dir:
        return "No working directory set. Use set_working_dir to set one."
    return f"Working directory: {_coding_working_dir}"


@define_tool(
    description=(
        "Create a new file. Acquires a directory lock first. "
        "Refuses if the file already exists. Path is relative to working dir."
    )
)
async def create_file(params: CreateFileParams) -> str:
    try:
        full = _resolve_coding_path(params.path)
    except ValueError as e:
        return str(e)

    if os.path.exists(full):
        return f"File already exists: {full}. Use apply_patch to edit it."

    parent = os.path.dirname(full)
    os.makedirs(parent, exist_ok=True)
    err = _acquire_lock(parent, "create_file")
    if err:
        return err
    try:
        with open(full, "w") as f:
            f.write(params.content)
    except OSError as e:
        return f"Failed to create file: {e}"
    finally:
        _release_lock(parent)

    lines = params.content.count("\n") + 1
    return f"✅ Created {full} ({lines} lines)"


@define_tool(
    description=(
        "Edit a file by replacing an exact string match with new content. "
        "Acquires a directory lock. The old_str must match exactly one location in the file."
    )
)
async def apply_patch(params: ApplyPatchParams) -> str:
    try:
        full = _resolve_coding_path(params.path)
    except ValueError as e:
        return str(e)

    if not os.path.isfile(full):
        return f"File not found: {full}"

    parent = os.path.dirname(full)
    err = _acquire_lock(parent, "apply_patch")
    if err:
        return err
    try:
        with open(full) as f:
            content = f.read()

        count = content.count(params.old_str)
        if count == 0:
            return f"old_str not found in {full}. Make sure it matches exactly."
        if count > 1:
            return f"old_str matches {count} locations in {full}. Make it more specific."

        new_content = content.replace(params.old_str, params.new_str, 1)
        with open(full, "w") as f:
            f.write(new_content)
    except OSError as e:
        return f"Failed to edit file: {e}"
    finally:
        _release_lock(parent)

    return f"✅ Patched {full}"


@define_tool(
    description=(
        "Search for a regex pattern in files within the working directory. "
        "Returns matching lines with file paths, line numbers, and context."
    )
)
async def code_grep(params: CodeGrepParams) -> str:
    if not _coding_working_dir:
        return "No working directory set. Use set_working_dir first."

    import re
    try:
        pat = re.compile(params.pattern, re.IGNORECASE)
    except re.error as e:
        return f"Invalid regex: {e}"

    import fnmatch
    matches = []
    for root, dirs, files in os.walk(_coding_working_dir):
        # Skip hidden dirs and common noise
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "venv", ".venv")]
        for fname in files:
            if not fnmatch.fnmatch(fname, params.glob_filter):
                continue
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, _coding_working_dir)
            try:
                with open(fpath, errors="replace") as f:
                    lines = f.readlines()
            except (OSError, UnicodeDecodeError):
                continue
            for i, line in enumerate(lines):
                if pat.search(line):
                    start = max(0, i - params.context_lines)
                    end = min(len(lines), i + params.context_lines + 1)
                    ctx = []
                    for j in range(start, end):
                        marker = ">" if j == i else " "
                        ctx.append(f"  {marker} {j+1:4d} | {lines[j].rstrip()}")
                    matches.append(f"{rel}:{i+1}\n" + "\n".join(ctx))
                    if len(matches) >= params.max_results:
                        break
            if len(matches) >= params.max_results:
                break

    if not matches:
        return f"No matches for '{params.pattern}' in {_coding_working_dir}"

    return f"Found {len(matches)} match(es):\n\n" + "\n\n".join(matches)


@define_tool(
    description="List directory tree structure. Respects .gitignore by default."
)
async def tree(params: TreeParams) -> str:
    try:
        root = _resolve_coding_path(params.path)
    except ValueError as e:
        return str(e)

    if not os.path.isdir(root):
        return f"Not a directory: {root}"

    # Try git ls-files first for gitignore support
    gitignore_files = set()
    if params.respect_gitignore:
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "ls-files", "--cached", "--others", "--exclude-standard",
                cwd=root, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0:
                gitignore_files = set(stdout.decode().strip().split("\n"))
        except Exception:
            pass

    lines = [os.path.basename(root) + "/"]
    file_count = 0

    def _walk(path: str, prefix: str, depth: int):
        nonlocal file_count
        if depth > params.max_depth:
            return
        try:
            entries = sorted(os.listdir(path))
        except OSError:
            return
        entries = [e for e in entries if not e.startswith(".")]
        dirs_list = [e for e in entries if os.path.isdir(os.path.join(path, e))]
        files_list = [e for e in entries if not os.path.isdir(os.path.join(path, e))]

        # Filter gitignored
        if gitignore_files:
            rel_base = os.path.relpath(path, root)
            files_list = [f for f in files_list if
                          os.path.join(rel_base, f).lstrip("./") in gitignore_files or not gitignore_files]

        all_items = dirs_list + files_list
        for i, name in enumerate(all_items):
            is_last = i == len(all_items) - 1
            connector = "└── " if is_last else "├── "
            full = os.path.join(path, name)
            if os.path.isdir(full):
                if name in ("node_modules", "__pycache__", ".git", "venv", ".venv"):
                    continue
                lines.append(f"{prefix}{connector}{name}/")
                ext = "    " if is_last else "│   "
                _walk(full, prefix + ext, depth + 1)
            else:
                lines.append(f"{prefix}{connector}{name}")
                file_count += 1

    _walk(root, "", 1)
    lines.append(f"\n{file_count} files")
    return "\n".join(lines)


@define_tool(
    description="Read a file's contents. Optionally specify a line range."
)
async def read_file(params: ReadFileParams) -> str:
    try:
        full = _resolve_coding_path(params.path)
    except ValueError as e:
        return str(e)

    if not os.path.isfile(full):
        return f"File not found: {full}"

    try:
        with open(full, errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return f"Failed to read file: {e}"

    total = len(lines)
    start = (params.start_line or 1) - 1
    end = params.end_line or total
    start = max(0, min(start, total))
    end = max(start, min(end, total))
    selected = lines[start:end]

    numbered = []
    for i, line in enumerate(selected, start + 1):
        numbered.append(f"{i:4d} | {line.rstrip()}")

    header = f"{os.path.relpath(full, _coding_working_dir or '.')} ({total} lines)"
    if params.start_line or params.end_line:
        header += f" [showing {start+1}-{end}]"
    return header + "\n" + "\n".join(numbered)


# ── Git tools ────────────────────────────────────────────────────────────────

async def _git_run(*args: str, cwd: str | None = None) -> str:
    """Run a git command and return output."""
    wd = cwd or _coding_working_dir
    if not wd:
        return "No working directory set. Use set_working_dir first."
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            cwd=wd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        out = stdout.decode(errors="replace").strip()
        err = stderr.decode(errors="replace").strip()
        if proc.returncode != 0:
            return f"git {' '.join(args)} failed:\n{err or out}"
        return out or "(no output)"
    except Exception as e:
        return f"git error: {e}"


@define_tool(description="Show git status of the working directory.")
async def git_status(params: GitStatusParams) -> str:
    return await _git_run("status", "--short", "--branch")


@define_tool(description="Show git diff. Use staged=true for staged changes, or path for a specific file.")
async def git_diff(params: GitDiffParams) -> str:
    args = ["--no-pager", "diff"]
    if params.staged:
        args.append("--cached")
    if params.path:
        try:
            full = _resolve_coding_path(params.path)
            args.extend(["--", full])
        except ValueError as e:
            return str(e)
    return await _git_run(*args)


@define_tool(
    description="Stage and commit changes. Acquires directory lock."
)
async def git_commit(params: GitCommitParams) -> str:
    if not _coding_working_dir:
        return "No working directory set."
    err = _acquire_lock(_coding_working_dir, "git_commit")
    if err:
        return err
    try:
        if params.add_all:
            result = await _git_run("add", "-A")
            if "failed" in result:
                return result
        return await _git_run("commit", "-m", params.message)
    finally:
        _release_lock(_coding_working_dir)


@define_tool(description="Show recent git commits.")
async def git_log(params: GitLogParams) -> str:
    fmt = "--oneline" if params.oneline else "--format=medium"
    return await _git_run("--no-pager", "log", fmt, f"-{params.max_count}")


@define_tool(
    description="Checkout a branch, commit, or file. Acquires directory lock for safety."
)
async def git_checkout(params: GitCheckoutParams) -> str:
    if not _coding_working_dir:
        return "No working directory set."
    err = _acquire_lock(_coding_working_dir, "git_checkout")
    if err:
        return err
    try:
        if params.create_branch:
            return await _git_run("checkout", "-b", params.target)
        return await _git_run("checkout", params.target)
    finally:
        _release_lock(_coding_working_dir)


# ── Shell execution tool ─────────────────────────────────────────────────────

# Global reference for the user-prompt callback (set by curses UI or CLI)
_command_prompt_callback = None
# Auto-approve all commands (set in non-interactive/sub-agent mode)
_auto_approve_commands = False


@define_tool(
    description=(
        "Execute a shell command in the working directory. The command is ALWAYS "
        "shown to the user and requires confirmation (Enter) before running. "
        "Use for builds, tests, installs, or any shell operation."
    )
)
async def run_command(params: RunCommandParams) -> str:
    if not _coding_working_dir:
        return "No working directory set. Use set_working_dir first."

    # Sub-agents auto-approve; interactive mode prompts user
    if _auto_approve_commands:
        pass  # skip confirmation
    elif _command_prompt_callback:
        confirmed = await _command_prompt_callback(params.command)
        if not confirmed:
            return "Command cancelled by user."
    else:
        print(f"\n  $ {params.command}")
        print("  Press Enter to execute, or Ctrl+C to cancel...")
        try:
            input()
        except (KeyboardInterrupt, EOFError):
            return "Command cancelled by user."

    try:
        proc = await asyncio.create_subprocess_shell(
            params.command,
            cwd=_coding_working_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=params.timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return f"Command timed out after {params.timeout}s"
    except Exception as e:
        return f"Command failed: {e}"

    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()
    result = []
    if out:
        result.append(out)
    if err:
        result.append(f"STDERR:\n{err}")
    if not result:
        result.append("(no output)")
    exit_str = f"[exit code: {proc.returncode}]"
    return "\n".join(result) + f"\n{exit_str}"


# ── Sub-agent dispatch ───────────────────────────────────────────────────────

_AGENT_MODELS = {
    "codex": "gpt-5.3-codex",
    "opus": "claude-opus-4.6",
    "sonnet": "claude-sonnet-4.5",
    "haiku": "claude-haiku-4.5",
}


def _auto_select_model(prompt: str) -> str:
    """Heuristic model selection based on task description."""
    p = prompt.lower()
    # Summaries, formatting, simple tasks
    if any(w in p for w in ("summarize", "summary", "format", "lint", "rename variable", "fix typo", "fix whitespace")):
        return "haiku"
    # Documentation
    if any(w in p for w in ("document", "readme", "docstring", "jsdoc", "comment")):
        return "sonnet"
    # Complex multi-file operations
    if any(w in p for w in ("refactor", "architect", "redesign", "multi-file", "across files", "migrate")):
        return "opus"
    # Default: cheap local edits
    return "codex"


@define_tool(
    description=(
        "Launch a sub-agent to execute a specific task in non-interactive mode. "
        "REQUIRES a valid ticket ID from the tk ticket system — create one with "
        "create_ticket first, with dependencies on any prerequisite tickets. "
        "The sub-agent runs as a separate process with its own context. "
        "Recursion depth is limited to 1 (sub-agents cannot launch further sub-agents). "
        "Model is auto-selected based on task complexity, or specify manually: "
        "codex (cheap edits), opus (complex multi-file), sonnet (docs), haiku (summaries)."
    )
)
async def launch_agent(params: LaunchAgentParams) -> str:
    # Validate ticket exists and is not blocked
    if not shutil.which("tk"):
        return "Error: 'tk' CLI is not installed. Cannot validate ticket."

    ok, ticket_info = _run_cmd(["tk", "show", params.ticket_id], timeout=5)
    if not ok:
        return f"🚫 Invalid ticket ID '{params.ticket_id}'. Create a ticket with create_ticket first."

    # Check if ticket is blocked by unresolved dependencies
    ok_blocked, blocked_out = _run_cmd(["tk", "blocked"], timeout=5)
    if ok_blocked and params.ticket_id in blocked_out:
        return (
            f"🚫 Ticket {params.ticket_id} is blocked by unresolved dependencies. "
            f"Resolve dependencies first.\n{blocked_out}"
        )

    # Mark ticket as in_progress
    _run_cmd(["tk", "start", params.ticket_id], timeout=5)

    # Check recursion depth
    depth = int(os.environ.get("MARVIN_DEPTH", "0"))
    if depth >= 1:
        return "🚫 Recursion limit reached. Sub-agents cannot launch further sub-agents."

    # Model selection
    if params.model == "auto":
        tier = _auto_select_model(params.prompt)
    else:
        tier = params.model
    model_name = _AGENT_MODELS.get(tier)
    if not model_name:
        return f"Unknown model tier '{tier}'. Use: codex, opus, sonnet, haiku, or auto."

    wd = params.working_dir or _coding_working_dir
    if not wd:
        return "No working directory set for sub-agent."

    import sys as _sys
    app_path = os.path.abspath(_sys.argv[0])

    async def _notify_pipeline(msg: str, title: str = "Marvin Pipeline"):
        """Send a ntfy notification for pipeline status updates."""
        subs = _load_ntfy_subs()
        if not subs:
            return
        topic = next(iter(subs))
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-s", "-d", msg,
                "-H", f"Title: {title}",
                "-H", "Tags: robot",
                f"{_NTFY_BASE}/{topic}",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=10)
        except Exception:
            pass

    async def _run_sub(prompt: str, model: str, timeout_s: int = 600, label: str = "") -> tuple[int, str, str]:
        """Run a non-interactive sub-agent subprocess. Returns (rc, stdout, stderr)."""
        sub_env = os.environ.copy()
        sub_env["MARVIN_DEPTH"] = str(depth + 1)
        sub_env["MARVIN_MODEL"] = model
        sub_env["MARVIN_TICKET"] = params.ticket_id
        sub_env["PYTHONUNBUFFERED"] = "1"
        cmd = [_sys.executable, app_path, "--non-interactive", "--working-dir", wd, "--prompt", prompt]
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=wd, env=sub_env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            sout, serr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
            return proc.returncode or 0, (sout or b"").decode(errors="replace").strip(), (serr or b"").decode(errors="replace").strip()
        except asyncio.TimeoutError:
            if proc and proc.returncode is None:
                proc.kill()
            return -1, "", f"{label or 'Sub-agent'} timed out after {timeout_s}s"
        except Exception as e:
            return -1, "", f"{label or 'Sub-agent'} failed: {e}"

    # Hard errors are non-retryable; timeouts and crashes retry with escalating timeouts.
    _HARD_ERRORS = ("ModuleNotFoundError", "ImportError", "model capability",
                    "not installed", "No such file", "Permission denied")
    _MAX_RETRIES = 3

    async def _run_sub_with_retry(
        prompt: str, model: str, base_timeout: int = 600, label: str = "",
    ) -> tuple[int, str, str]:
        """Run _run_sub with up to _MAX_RETRIES attempts, escalating timeout each time."""
        rc, out, err = -1, "", ""
        for attempt in range(1, _MAX_RETRIES + 1):
            timeout_s = base_timeout * attempt
            rc, out, err = await _run_sub(prompt, model, timeout_s=timeout_s, label=label)
            if rc == 0 and out:
                return rc, out, err
            combined = f"{out} {err}"
            if any(m in combined for m in _HARD_ERRORS):
                _run_cmd(["tk", "add-note", params.ticket_id,
                          f"{label}: hard error (attempt {attempt}) — {(err or out)[:200]}"], timeout=5)
                return rc, out, err  # non-retryable
            if attempt < _MAX_RETRIES:
                next_timeout = base_timeout * (attempt + 1)
                _run_cmd(["tk", "add-note", params.ticket_id,
                          f"{label}: attempt {attempt}/{_MAX_RETRIES} failed (exit {rc}) — retrying ({next_timeout}s timeout)"], timeout=5)
        _run_cmd(["tk", "add-note", params.ticket_id,
                  f"{label}: failed after {_MAX_RETRIES} attempts (exit {rc})"], timeout=5)
        return rc, out, err

    # ── Phase 1a: Spec & UX Design ──────────────────────────────────────
    if params.design_first:
        design_dir = os.path.join(wd, ".marvin")
        os.makedirs(design_dir, exist_ok=True)

        instructions_ctx = ""
        safe_name = wd.strip("/").replace("/", "_")
        instructions_paths = [
            os.path.join(os.path.expanduser("~"), ".marvin", "instructions", f"{safe_name}.md"),
            os.path.join(wd, ".marvin-instructions"),
            os.path.join(wd, ".marvin", "instructions.md"),
        ]
        for ipath in instructions_paths:
            if os.path.isfile(ipath):
                try:
                    instructions_ctx = open(ipath).read()
                except Exception:
                    pass
                break

        # Phase 1a: Spec & UX
        _run_cmd(["tk", "add-note", params.ticket_id, "Phase 1a: Spec & UX design (claude-opus-4.6)"], timeout=5)
        await _notify_pipeline("🎨 Phase 1a: Spec & UX design started")
        spec_prompt = (
            "You are a senior product designer. Your job is to produce a detailed "
            "SPECIFICATION and UX DESIGN for the following task. Do NOT write any code "
            "and do NOT describe architecture or file structure. Focus ONLY on:\n\n"
            "1. **Product Spec** — what the product does, who it's for, core user stories, "
            "acceptance criteria for each feature, constraints and non-functional requirements.\n"
            "2. **UX Design Schema** — describe every screen/view, its components, layout, "
            "interactions, states, transitions, and responsive breakpoints. Use a structured "
            "format. Cover every user flow end-to-end: happy path, error states, empty states, "
            "loading states.\n"
            "3. **Style Guide** — colors, typography, spacing, component naming conventions, "
            "accessibility requirements (ARIA, keyboard nav, contrast ratios).\n"
            "4. **Information Architecture** — navigation structure, URL scheme, data "
            "relationships from the user's perspective.\n\n"
            f"TASK:\n{params.prompt}\n\n"
        )
        if instructions_ctx:
            spec_prompt += f"PROJECT INSTRUCTIONS:\n{instructions_ctx}\n\n"
        spec_prompt += (
            "Save the spec as .marvin/spec.md using create_file. "
            "Be exhaustive — every screen, every interaction, every edge case. "
            "The architecture pass will read this spec to design the technical solution."
        )

        rc, sout, serr = await _run_sub_with_retry(spec_prompt, "claude-opus-4.6", base_timeout=600, label="Spec/UX pass")
        spec_path = os.path.join(design_dir, "spec.md")
        if os.path.isfile(spec_path) and os.path.getsize(spec_path) > 100:
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Spec/UX complete — agent saved .marvin/spec.md ({os.path.getsize(spec_path)} bytes)"], timeout=5)
        elif rc == 0 and sout:
            with open(spec_path, "w") as f:
                f.write(sout)
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Spec/UX complete — saved output to .marvin/spec.md ({len(sout)} chars)"], timeout=5)
        else:
            _run_cmd(["tk", "add-note", params.ticket_id, f"Pipeline ABORTED: spec/UX pass failed (exit {rc})"], timeout=5)
            await _notify_pipeline(f"🚫 Pipeline ABORTED: spec/UX pass failed (exit {rc})")
            return f"🚫 Spec/UX pass failed after {_MAX_RETRIES} retries (exit {rc}, ticket {params.ticket_id}):\n{serr or sout}"

        # Phase 1b: Architecture & Test Plan (reads the spec)
        _run_cmd(["tk", "add-note", params.ticket_id, "Phase 1b: Architecture & test plan (claude-opus-4.6)"], timeout=5)
        await _notify_pipeline("📐 Phase 1b: Architecture & test plan started")

        try:
            spec_text = open(spec_path).read()
        except Exception as e:
            return f"Failed to read spec: {e}"

        arch_prompt = (
            "You are a senior software architect. A product spec and UX design has already "
            "been created at .marvin/spec.md. Read it first with read_file, then produce "
            "a detailed ARCHITECTURE and TEST PLAN. Do NOT write any code. Produce:\n\n"
            "1. **Architecture** — file structure, modules, data flow, API endpoints "
            "(with request/response shapes and status codes), database schema, error handling "
            "strategy, technology choices with rationale. Every decision must trace back to "
            "a requirement in the spec.\n"
            "2. **Implementation Plan** — ordered list of every file to create, with a "
            "1-2 sentence description of each file's responsibility, key functions/classes, "
            "and which spec requirements it fulfills.\n"
            "3. **Test Plan** — this is the MOST IMPORTANT section. For EVERY module, "
            "endpoint, component, and user flow, list:\n"
            "   - The test file path (e.g. tests/test_database.py)\n"
            "   - Every individual test function name and exactly what it verifies\n"
            "   - Cover ALL of: happy path, error cases, edge cases, boundary conditions, "
            "invalid input, missing data, concurrent access, empty states\n"
            "   - Include unit tests, integration tests, and API endpoint tests\n"
            "   - Every public function MUST have at least one test\n"
            "   - Every API route MUST have tests for success, validation error, and not-found\n"
            "   - Every error handler MUST be tested\n"
            "   - Aim for 100%% functional coverage\n"
            "   - Group tests by module with clear descriptions\n\n"
        )
        if instructions_ctx:
            arch_prompt += f"PROJECT INSTRUCTIONS:\n{instructions_ctx}\n\n"
        arch_prompt += (
            "Save the architecture document as .marvin/design.md using create_file. "
            "Be thorough and specific — this document and the spec together will be "
            "the sole reference for the test-writing and implementation agents. "
            "The test plan section is CRITICAL — it must be exhaustive enough that "
            "agents can write a complete test suite with full coverage from it alone."
        )

        rc, dout, derr = await _run_sub_with_retry(arch_prompt, "claude-opus-4.6", base_timeout=600, label="Architecture pass")
        design_path = os.path.join(design_dir, "design.md")
        if os.path.isfile(design_path) and os.path.getsize(design_path) > 100:
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Architecture complete — agent saved .marvin/design.md ({os.path.getsize(design_path)} bytes)"], timeout=5)
        elif rc == 0 and dout:
            with open(design_path, "w") as f:
                f.write(dout)
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Architecture complete — saved output to .marvin/design.md ({len(dout)} chars)"], timeout=5)
        else:
            _run_cmd(["tk", "add-note", params.ticket_id, f"Pipeline ABORTED: architecture pass failed (exit {rc})"], timeout=5)
            await _notify_pipeline(f"🚫 Pipeline ABORTED: architecture pass failed (exit {rc})")
            return f"🚫 Architecture pass failed after {_MAX_RETRIES} retries (exit {rc}, ticket {params.ticket_id}):\n{derr or dout}"

    # ── Phase 2: Test-first pass (TDD, optional) ─────────────────────────
    design_path = os.path.join(wd, ".marvin", "design.md")
    if params.tdd:
        if not os.path.isfile(design_path):
            return "🚫 TDD requires a design doc. Use design_first=true or create .marvin/design.md manually."

        _run_cmd(["tk", "add-note", params.ticket_id, "Phase 2: Writing failing tests (parallel agents)"], timeout=5)
        await _notify_pipeline("🧪 Phase 2: Writing failing tests (parallel agents)")

        try:
            design_doc = open(design_path).read()
        except Exception as e:
            return f"Failed to read design doc: {e}"

        # Parse test plan from design doc — find "Test Plan" section
        test_sections: list[str] = []
        in_test_plan = False
        current_section: list[str] = []
        for line in design_doc.split("\n"):
            if "test plan" in line.lower() and line.strip().startswith("#"):
                in_test_plan = True
                continue
            if in_test_plan:
                if line.strip().startswith("#") and "test" not in line.lower():
                    break
                current_section.append(line)
                if line.strip().startswith("##") or line.strip().startswith("###"):
                    if len(current_section) > 3:
                        test_sections.append("\n".join(current_section[:-1]))
                        current_section = [line]
        if current_section:
            test_sections.append("\n".join(current_section))
        if not test_sections:
            test_sections = ["See Test Plan section in .marvin/design.md"]

        # Batch into groups of ~3 sections per agent
        batches: list[list[str]] = []
        for i in range(0, len(test_sections), 3):
            batches.append(test_sections[i:i+3])

        # Launch test-writing agents in parallel — each with its own retry loop
        test_tasks = []
        for i, batch in enumerate(batches):
            batch_text = "\n\n---\n\n".join(batch)
            test_prompt = (
                "You are writing tests for a TDD workflow. Read BOTH the spec at "
                ".marvin/spec.md AND the architecture doc at .marvin/design.md, then "
                "write ONLY the test files described below.\n\n"
                "REQUIREMENTS:\n"
                "- Tests MUST fail (the implementation doesn't exist yet)\n"
                "- Write EVERY test listed in the Test Plan section — do not skip any\n"
                "- Each test function must have a clear docstring explaining what it verifies\n"
                "- Test EVERY public function, EVERY API route (success + error + edge cases), "
                "EVERY error handler, EVERY user flow described in the spec\n"
                "- Cover: happy path, validation errors, missing data, not-found, "
                "empty inputs, boundary values, concurrent access where relevant\n"
                "- Use pytest fixtures for shared setup (database, test client, etc)\n"
                "- Use pytest.mark.parametrize for testing multiple inputs\n"
                "- Mock external dependencies (subprocess calls, file I/O) appropriately\n"
                "- Do NOT write any implementation code — only tests\n"
                "- Do NOT try to run the tests — they are expected to fail\n\n"
                f"TEST SECTIONS TO WRITE:\n{batch_text}\n\n"
                "Commit the test files with a descriptive message like "
                "'Add failing tests for <module> (TDD red phase)'."
            )
            test_tasks.append(_run_sub_with_retry(
                test_prompt, "gpt-5.3-codex", base_timeout=300, label=f"Test agent {i+1}"))

        test_results = await asyncio.gather(*test_tasks)
        failures = []
        for i, (rc, out, err) in enumerate(test_results):
            if rc != 0:
                failures.append(f"Test agent {i+1} failed (exit {rc}): {err or out}")
        if len(failures) == len(test_results):
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Pipeline ABORTED: all {len(test_results)} test agents failed after retries"], timeout=5)
            await _notify_pipeline(f"🚫 Pipeline ABORTED: all test agents failed")
            return f"🚫 All test agents failed — aborting pipeline (ticket {params.ticket_id}):\n" + "\n".join(failures)
        if failures:
            _run_cmd(["tk", "add-note", params.ticket_id,
                      f"Test-first pass: {len(failures)}/{len(test_results)} agents failed (continuing with partial tests)"], timeout=5)

        _run_cmd(["tk", "add-note", params.ticket_id,
                  f"Test-first pass complete — {len(test_results)} agents, {len(failures)} failures"], timeout=5)

    # ── Phase 3: Implementation ──────────────────────────────────────────
    _run_cmd(["tk", "add-note", params.ticket_id, f"Phase 3: Implementation ({tier}/{model_name})"], timeout=5)
    await _notify_pipeline(f"🔨 Phase 3: Implementation started ({tier}/{model_name})")

    impl_prompt = params.prompt
    spec_path = os.path.join(wd, ".marvin", "spec.md")
    if os.path.isfile(design_path):
        impl_prompt = (
            f"{params.prompt}\n\n"
            "IMPORTANT: Read these documents with read_file BEFORE writing any code:\n"
        )
        if os.path.isfile(spec_path):
            impl_prompt += "  - .marvin/spec.md (product spec & UX design)\n"
        impl_prompt += (
            "  - .marvin/design.md (architecture & implementation plan)\n\n"
            "Follow the architecture, file structure, and UX design specified in those "
            "documents exactly. Do not deviate unless you encounter a technical impossibility."
        )
    if params.tdd:
        impl_prompt += (
            "\n\nTDD MODE: Failing tests have already been written. "
            "Read the test files to understand what's expected, then implement "
            "the code to make them pass. After implementing, run the tests with "
            "run_command to verify they pass."
        )

    rc, impl_out, impl_err = await _run_sub_with_retry(impl_prompt, model_name, base_timeout=600, label="Implementation")
    if rc != 0:
        _run_cmd(["tk", "add-note", params.ticket_id, f"Pipeline ABORTED: implementation failed (exit {rc})"], timeout=5)
        await _notify_pipeline(f"🚫 Pipeline ABORTED: implementation failed (exit {rc})")
        return f"🚫 Implementation failed after {_MAX_RETRIES} retries (exit {rc}, ticket {params.ticket_id}):\n{impl_err or impl_out}"

    _run_cmd(["tk", "add-note", params.ticket_id, "Implementation complete"], timeout=5)

    # ── Phase 4: Debug loop (TDD green phase) ────────────────────────────
    if params.tdd:
        _run_cmd(["tk", "add-note", params.ticket_id, "Phase 4: Debug loop — running tests until green"], timeout=5)
        await _notify_pipeline("🐛 Phase 4: Debug loop — running tests until green")

        max_debug_rounds = 5
        for debug_round in range(1, max_debug_rounds + 1):
            debug_prompt = (
                "You are in the TDD debug loop (round {round}/{max}). Your ONLY job:\n"
                "1. Run ALL tests with run_command (e.g. 'pytest -v' or the project's test runner)\n"
                "2. If all tests pass → respond with exactly 'ALL_TESTS_PASS' and commit\n"
                "3. If tests fail → read the failure output carefully, fix the code "
                "(NOT the tests unless a test has a genuine bug), and run tests again\n"
                "4. Repeat until all tests pass or you've made 3 fix attempts this round\n\n"
                "Read .marvin/design.md if you need to understand the intended behavior. "
                "Make MINIMAL changes to fix failures. Do NOT refactor working code. "
                "Commit each fix with a message like 'Fix <what> to pass <test_name>'."
            ).format(round=debug_round, max=max_debug_rounds)

            rc, dbg_out, dbg_err = await _run_sub_with_retry(
                debug_prompt, "gpt-5.3-codex", base_timeout=300, label=f"Debug round {debug_round}")

            if "ALL_TESTS_PASS" in (dbg_out or ""):
                _run_cmd(["tk", "add-note", params.ticket_id, f"All tests pass after {debug_round} debug round(s)"], timeout=5)
                break
            if rc != 0:
                _run_cmd(["tk", "add-note", params.ticket_id, f"Debug round {debug_round} failed (exit {rc})"], timeout=5)
        else:
            _run_cmd(["tk", "add-note", params.ticket_id, f"Debug loop exhausted ({max_debug_rounds} rounds) — some tests may still fail"], timeout=5)

    # ── Done ─────────────────────────────────────────────────────────────
    _run_cmd(["tk", "add-note", params.ticket_id, f"Completed by {tier} sub-agent"], timeout=5)
    _run_cmd(["tk", "close", params.ticket_id], timeout=5)

    phases = ["Implementation"]
    if params.design_first:
        phases.insert(0, "Design")
    if params.tdd:
        phases.insert(-1, "Test-first")
        phases.append("Debug loop")

    await _notify_pipeline(f"✅ Pipeline complete ({' → '.join(phases)})\nTicket: {params.ticket_id}")
    return f"[{tier} / {model_name}] Ticket {params.ticket_id} ✅ ({' → '.join(phases)})\n\n{impl_out}"


# ── Tool: Steam store & API ──────────────────────────────────────────────────

STEAM_API_KEY = os.environ.get("STEAM_API_KEY", "")
if not STEAM_API_KEY:
    _steam_key_path = os.path.expanduser("~/.ssh/STEAM_API_KEY")
    if os.path.isfile(_steam_key_path):
        with open(_steam_key_path) as _f:
            _key = _f.read().strip()
            if _key:
                STEAM_API_KEY = _key


class SteamSearchParams(BaseModel):
    query: str = Field(description="Game title to search for on Steam")
    max_results: int = Field(default=10, description="Max results (1-25)")


class SteamAppDetailsParams(BaseModel):
    app_id: int = Field(description="Steam app ID (from steam_search results)")


class SteamPlayerStatsParams(BaseModel):
    app_id: int = Field(description="Steam app ID to get player stats for")


class SteamUserGamesParams(BaseModel):
    steam_id: str = Field(description="Steam user's 64-bit ID (e.g. '76561198000000000')")


class SteamUserSummaryParams(BaseModel):
    steam_id: str = Field(description="Steam user's 64-bit ID")


@define_tool(
    description=(
        "Search the Steam store for games. Returns titles, app IDs, and prices. "
        "No API key required. Use when users ask about Steam games, prices, or deals."
    )
)
async def steam_search(params: SteamSearchParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://store.steampowered.com/api/storesearch/",
                params={"term": params.query, "l": "english", "cc": "US"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Steam search failed: {e}"

    items = data.get("items", [])
    if not items:
        return f"No Steam results for '{params.query}'."

    lines = []
    for i, item in enumerate(items[:params.max_results], 1):
        name = item.get("name", "?")
        app_id = item.get("id", 0)
        price_info = item.get("price", {})
        if price_info:
            price = price_info.get("final", 0) / 100
            initial = price_info.get("initial", 0) / 100
            discount = ""
            if initial > price:
                pct = round((1 - price / initial) * 100)
                discount = f" (-{pct}%, was ${initial:.2f})"
            price_str = f"${price:.2f}{discount}" if price > 0 else "Free"
        else:
            price_str = "N/A"
        platforms = []
        meta = item.get("metascore", "")
        if item.get("platforms", {}).get("windows"):
            platforms.append("Win")
        if item.get("platforms", {}).get("mac"):
            platforms.append("Mac")
        if item.get("platforms", {}).get("linux"):
            platforms.append("Linux")
        plat_str = "/".join(platforms) if platforms else "?"
        meta_str = f" | Metascore: {meta}" if meta else ""
        lines.append(
            f"{i}. {name} — {price_str}\n"
            f"   Platforms: {plat_str}{meta_str}\n"
            f"   Steam ID: {app_id} | https://store.steampowered.com/app/{app_id}"
        )
    return f"Steam results for '{params.query}':\n\n" + "\n\n".join(lines)


@define_tool(
    description=(
        "Get detailed info for a Steam game by app ID. Returns description, price, "
        "reviews, genres, release date, screenshots, system requirements, and more. "
        "No API key required."
    )
)
async def steam_app_details(params: SteamAppDetailsParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://store.steampowered.com/api/appdetails/",
                params={"appids": str(params.app_id), "cc": "US", "l": "english"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Steam app details failed: {e}"

    entry = data.get(str(params.app_id), {})
    if not entry.get("success"):
        return f"No Steam data for app ID {params.app_id}."
    d = entry["data"]

    name = d.get("name", "?")
    desc = (d.get("short_description") or "")[:400]
    release = d.get("release_date", {}).get("date", "N/A")
    devs = ", ".join(d.get("developers", []))
    pubs = ", ".join(d.get("publishers", []))
    genres = ", ".join(g.get("description", "") for g in d.get("genres", []))
    categories = ", ".join(c.get("description", "") for c in d.get("categories", [])[:6])

    # Price
    price_data = d.get("price_overview", {})
    if d.get("is_free"):
        price_str = "Free to Play"
    elif price_data:
        price_str = price_data.get("final_formatted", "N/A")
        discount = price_data.get("discount_percent", 0)
        if discount:
            price_str += f" (-{discount}%, was {price_data.get('initial_formatted', '?')})"
    else:
        price_str = "N/A"

    # Review summary
    rec = d.get("recommendations", {})
    total_reviews = rec.get("total", "N/A")

    # Metacritic
    mc = d.get("metacritic", {})
    mc_str = f"{mc.get('score', 'N/A')}" if mc else "N/A"

    # Platforms
    platforms = d.get("platforms", {})
    plats = []
    if platforms.get("windows"):
        plats.append("Windows")
    if platforms.get("mac"):
        plats.append("macOS")
    if platforms.get("linux"):
        plats.append("Linux")

    # DLC count
    dlc = d.get("dlc", [])
    dlc_str = f"{len(dlc)} DLC available" if dlc else ""

    lines = [
        f"🎮 {name}",
        f"   Released: {release}",
        f"   Price: {price_str}",
        f"   Metacritic: {mc_str} | Reviews: {total_reviews} recommendations",
        f"   Genres: {genres}",
        f"   Categories: {categories}",
        f"   Developers: {devs}",
        f"   Publishers: {pubs}",
        f"   Platforms: {', '.join(plats)}",
    ]
    if dlc_str:
        lines.append(f"   {dlc_str}")
    lines.append(f"\n   {desc}")
    lines.append(f"\n   Store: https://store.steampowered.com/app/{params.app_id}")
    return "\n".join(lines)


class SteamFeaturedParams(BaseModel):
    pass


@define_tool(
    description=(
        "Get current Steam featured games and specials/deals. "
        "No API key required. Use when users ask about Steam sales or deals."
    )
)
async def steam_featured(params: SteamFeaturedParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://store.steampowered.com/api/featured/")
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Steam featured failed: {e}"

    lines = []
    for section in ("featured_win", "featured_mac", "featured_linux"):
        items = data.get(section, [])
        if items and not lines:
            lines.append("🔥 Steam Featured Games:")
        for item in items[:8]:
            name = item.get("name", "?")
            app_id = item.get("id", 0)
            price = item.get("final_price", 0) / 100
            orig = item.get("original_price", 0) / 100
            discount = item.get("discount_percent", 0)
            if discount:
                price_str = f"${price:.2f} (-{discount}%, was ${orig:.2f})"
            elif price > 0:
                price_str = f"${price:.2f}"
            else:
                price_str = "Free"
            lines.append(f"  • {name} — {price_str}  (ID: {app_id})")
        if items:
            break  # one platform is enough

    # Specials
    specials = data.get("specials", {}).get("items", [])
    if specials:
        lines.append("\n💰 Current Specials:")
        for item in specials[:10]:
            name = item.get("name", "?")
            app_id = item.get("id", 0)
            price = item.get("final_price", 0) / 100
            orig = item.get("original_price", 0) / 100
            discount = item.get("discount_percent", 0)
            price_str = f"${price:.2f} (-{discount}%, was ${orig:.2f})" if discount else f"${price:.2f}"
            lines.append(f"  • {name} — {price_str}  (ID: {app_id})")

    return "\n".join(lines) if lines else "No featured games found."


@define_tool(
    description=(
        "Get current player count and global achievement stats for a Steam game. "
        "Requires STEAM_API_KEY for achievements; player count works without key."
    )
)
async def steam_player_stats(params: SteamPlayerStatsParams) -> str:
    lines = []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Current player count (no key needed)
            resp = await client.get(
                "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
                params={"appid": params.app_id},
            )
            resp.raise_for_status()
            count = resp.json().get("response", {}).get("player_count")
            if count is not None:
                lines.append(f"👥 Current players: {count:,}")
    except Exception as e:
        lines.append(f"Player count unavailable: {e}")

    if STEAM_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
                    params={"gameid": params.app_id},
                )
                resp.raise_for_status()
                achievements = resp.json().get("achievementpercentages", {}).get("achievements", [])
                if achievements:
                    lines.append(f"\n🏆 Achievements ({len(achievements)} total):")
                    for a in sorted(achievements, key=lambda x: -x.get("percent", 0))[:10]:
                        lines.append(f"  • {a.get('name', '?')}: {a.get('percent', 0):.1f}%")
                    if len(achievements) > 10:
                        lines.append(f"  ... and {len(achievements) - 10} more")
        except Exception:
            pass
    elif not lines:
        lines.append("Set STEAM_API_KEY for achievement data.")

    return "\n".join(lines) if lines else f"No stats available for app {params.app_id}."


@define_tool(
    description=(
        "Get a Steam user's owned games list with playtime. "
        "Requires STEAM_API_KEY. Provide the user's 64-bit Steam ID."
    )
)
async def steam_user_games(params: SteamUserGamesParams) -> str:
    if not STEAM_API_KEY:
        return "STEAM_API_KEY not set. Get one at https://steamcommunity.com/dev"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
                params={
                    "key": STEAM_API_KEY,
                    "steamid": params.steam_id,
                    "include_appinfo": 1,
                    "include_played_free_games": 1,
                },
            )
            resp.raise_for_status()
            data = resp.json().get("response", {})
    except Exception as e:
        return f"Steam user games failed: {e}"

    games = data.get("games", [])
    if not games:
        return "No games found (profile may be private)."

    total = data.get("game_count", len(games))
    games_sorted = sorted(games, key=lambda g: g.get("playtime_forever", 0), reverse=True)

    lines = [f"🎮 {total} games owned. Top by playtime:"]
    for g in games_sorted[:20]:
        name = g.get("name", f"App {g.get('appid', '?')}")
        hours = g.get("playtime_forever", 0) / 60
        recent = g.get("playtime_2weeks", 0) / 60
        recent_str = f" ({recent:.1f}h last 2 weeks)" if recent > 0 else ""
        lines.append(f"  • {name} — {hours:.1f}h{recent_str}")
    if total > 20:
        lines.append(f"  ... and {total - 20} more")
    return "\n".join(lines)


@define_tool(
    description=(
        "Get a Steam user's profile summary (name, avatar, status, etc). "
        "Requires STEAM_API_KEY."
    )
)
async def steam_user_summary(params: SteamUserSummaryParams) -> str:
    if not STEAM_API_KEY:
        return "STEAM_API_KEY not set. Get one at https://steamcommunity.com/dev"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
                params={"key": STEAM_API_KEY, "steamids": params.steam_id},
            )
            resp.raise_for_status()
            players = resp.json().get("response", {}).get("players", [])
    except Exception as e:
        return f"Steam user summary failed: {e}"

    if not players:
        return "User not found."

    p = players[0]
    status_map = {0: "Offline", 1: "Online", 2: "Busy", 3: "Away", 4: "Snooze", 5: "Looking to trade", 6: "Looking to play"}
    status = status_map.get(p.get("personastate", 0), "Unknown")
    game = p.get("gameextrainfo", "")
    game_str = f"\n   Currently playing: {game}" if game else ""

    lines = [
        f"👤 {p.get('personaname', '?')}",
        f"   Status: {status}{game_str}",
        f"   Profile: {p.get('profileurl', 'N/A')}",
        f"   Created: {p.get('timecreated', 'N/A')}",
    ]
    return "\n".join(lines)


# ── Tool: Stack Exchange ─────────────────────────────────────────────────────

_SE_API = "https://api.stackexchange.com/2.3"
_SE_SITES = {
    "stackoverflow": "Stack Overflow",
    "serverfault": "Server Fault",
    "superuser": "Super User",
    "askubuntu": "Ask Ubuntu",
    "unix": "Unix & Linux",
    "math": "Mathematics",
    "physics": "Physics",
    "gaming": "Arqade (Gaming)",
}


class StackSearchParams(BaseModel):
    query: str = Field(description="Search query")
    site: str = Field(
        default="stackoverflow",
        description="Stack Exchange site: stackoverflow, serverfault, superuser, askubuntu, unix, math, physics, gaming"
    )
    tagged: str | None = Field(default=None, description="Filter by tags, semicolon-separated (e.g. 'python;asyncio')")
    sort: str = Field(default="relevance", description="Sort by: relevance, votes, creation, activity")
    max_results: int = Field(default=5, description="Max results (1-10)")


class StackAnswersParams(BaseModel):
    question_id: int = Field(description="Question ID from search results")
    site: str = Field(default="stackoverflow", description="Stack Exchange site the question is on")


@define_tool(
    description=(
        "Search Stack Exchange (Stack Overflow, Server Fault, Ask Ubuntu, Unix & Linux, etc.) "
        "for questions. Returns titles, scores, answer counts, and tags. "
        "Use stack_answers to get the actual answers for a question."
    )
)
async def stack_search(params: StackSearchParams) -> str:
    qp: dict = {
        "order": "desc",
        "sort": params.sort,
        "intitle": params.query,
        "site": params.site,
        "pagesize": min(params.max_results, 10),
        "filter": "!nNPvSNVZJS",  # include body excerpt
    }
    if params.tagged:
        qp["tagged"] = params.tagged

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_SE_API}/search/advanced", params=qp)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Stack Exchange search failed: {e}"

    items = data.get("items", [])
    if not items:
        return f"No questions found for '{params.query}' on {params.site}."

    site_name = _SE_SITES.get(params.site, params.site)
    lines = [f"{site_name} results for '{params.query}':\n"]
    for i, q in enumerate(items, 1):
        title = q.get("title", "?")
        qid = q.get("question_id", 0)
        score = q.get("score", 0)
        answers = q.get("answer_count", 0)
        accepted = "✅" if q.get("accepted_answer_id") else ""
        tags = ", ".join(q.get("tags", [])[:5])
        link = q.get("link", "")
        is_answered = q.get("is_answered", False)

        lines.append(f"{i}. [{score}↑] **{title}** {accepted}")
        lines.append(f"   ID: {qid} | {answers} answer(s) | Tags: {tags}")
        if link:
            lines.append(f"   {link}")
        lines.append("")

    quota = data.get("quota_remaining", "?")
    lines.append(f"_API quota remaining: {quota}_")
    return "\n".join(lines)


@define_tool(
    description=(
        "Get the top answers for a Stack Exchange question by ID. "
        "Returns answer text, scores, and whether it's the accepted answer."
    )
)
async def stack_answers(params: StackAnswersParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_SE_API}/questions/{params.question_id}/answers",
                params={
                    "order": "desc", "sort": "votes",
                    "site": params.site, "pagesize": 3,
                    "filter": "!nNPvSNe7B1",  # include answer body as markdown
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Stack Exchange answers failed: {e}"

    items = data.get("items", [])
    if not items:
        return f"No answers found for question {params.question_id}."

    lines = [f"Top {len(items)} answer(s) for question {params.question_id}:\n"]
    for i, a in enumerate(items, 1):
        score = a.get("score", 0)
        accepted = " ✅ ACCEPTED" if a.get("is_accepted") else ""
        body = a.get("body_markdown", a.get("body", ""))
        # Truncate very long answers
        if len(body) > 1500:
            body = body[:1500] + "\n... (truncated)"

        lines.append(f"── Answer {i} [{score}↑]{accepted} ──")
        lines.append(body)
        lines.append("")

    return "\n".join(lines)


# ── Tool: Wikipedia ──────────────────────────────────────────────────────────

_WIKI_API = "https://en.wikipedia.org/w/api.php"
_WIKI_REST = "https://en.wikipedia.org/api/rest_v1"
_WIKI_HEADERS = {"User-Agent": "MarvinAssistant/1.0"}
_WIKI_CACHE_DIR = os.path.expanduser("~/.cache/marvin/wiki")


class WikiSearchParams(BaseModel):
    query: str = Field(description="Search query")
    max_results: int = Field(default=5, description="Max results (1-10)")


class WikiSummaryParams(BaseModel):
    title: str = Field(description="Wikipedia article title (from search results)")


class WikiFullParams(BaseModel):
    title: str = Field(description="Wikipedia article title to fetch and save to disk")


class WikiGrepParams(BaseModel):
    title: str = Field(description="Wikipedia article title (must have been fetched with wiki_full first)")
    pattern: str = Field(description="Text or regex pattern to search for in the saved article")


@define_tool(
    description=(
        "Search Wikipedia for articles matching a query. Returns titles, snippets, "
        "and page IDs. Use wiki_summary or wiki_full to get article content."
    )
)
async def wiki_search(params: WikiSearchParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10, headers=_WIKI_HEADERS) as client:
            resp = await client.get(_WIKI_API, params={
                "action": "query", "list": "search", "format": "json",
                "srsearch": params.query, "srlimit": min(params.max_results, 10),
                "utf8": "1",
            })
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Wikipedia search failed: {e}"

    results = data.get("query", {}).get("search", [])
    if not results:
        return f"No Wikipedia articles found for '{params.query}'."

    lines = [f"Wikipedia results for '{params.query}':\n"]
    for i, r in enumerate(results, 1):
        title = r.get("title", "?")
        snippet = r.get("snippet", "").replace('<span class="searchmatch">', "**").replace("</span>", "**")
        # Strip remaining HTML tags
        import re
        snippet = re.sub(r"<[^>]+>", "", snippet)
        lines.append(f"{i}. **{title}**")
        lines.append(f"   {snippet}")
        lines.append("")
    return "\n".join(lines)


@define_tool(
    description=(
        "Get a concise summary of a Wikipedia article (1-3 paragraphs). "
        "Good for quick facts. Use wiki_full for complete article content."
    )
)
async def wiki_summary(params: WikiSummaryParams) -> str:
    import urllib.parse
    encoded = urllib.parse.quote(params.title.replace(" ", "_"), safe="")
    try:
        async with httpx.AsyncClient(timeout=10, headers=_WIKI_HEADERS) as client:
            resp = await client.get(f"{_WIKI_REST}/page/summary/{encoded}")
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Wikipedia summary failed: {e}"

    title = data.get("title", params.title)
    extract = data.get("extract", "")
    url = data.get("content_urls", {}).get("desktop", {}).get("page", "")
    description = data.get("description", "")

    if not extract:
        return f"No summary found for '{params.title}'."

    lines = [f"**{title}**"]
    if description:
        lines.append(f"_{description}_")
    lines.append("")
    lines.append(extract)
    if url:
        lines.append(f"\n{url}")
    return "\n".join(lines)


@define_tool(
    description=(
        "Fetch the FULL content of a Wikipedia article and save it to disk. "
        "Returns a confirmation with the file path and a brief extract. "
        "The full text is NOT returned in context — use wiki_grep to search it."
    )
)
async def wiki_full(params: WikiFullParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=15, headers=_WIKI_HEADERS) as client:
            resp = await client.get(_WIKI_API, params={
                "action": "query", "prop": "extracts", "format": "json",
                "titles": params.title, "explaintext": "1", "utf8": "1",
            })
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Wikipedia fetch failed: {e}"

    pages = data.get("query", {}).get("pages", {})
    if not pages:
        return f"No article found for '{params.title}'."

    page = next(iter(pages.values()))
    if page.get("missing") is not None:
        return f"Wikipedia article '{params.title}' does not exist."

    title = page.get("title", params.title)
    extract = page.get("extract", "")
    if not extract:
        return f"Article '{title}' has no text content."

    # Save to disk
    os.makedirs(_WIKI_CACHE_DIR, exist_ok=True)
    safe_name = title.replace("/", "_").replace(" ", "_")
    filepath = os.path.join(_WIKI_CACHE_DIR, f"{safe_name}.txt")
    with open(filepath, "w") as f:
        f.write(extract)

    word_count = len(extract.split())
    preview = extract[:300].replace("\n", " ")
    if len(extract) > 300:
        preview += "..."

    return (
        f"Saved **{title}** ({word_count:,} words) to:\n  {filepath}\n\n"
        f"Preview: {preview}\n\n"
        f"Use wiki_grep(title='{title}', pattern='...') to search the full article."
    )


@define_tool(
    description=(
        "Search through a previously fetched Wikipedia article saved on disk. "
        "Use wiki_full first to fetch the article, then wiki_grep to find "
        "specific information within it. Returns matching lines with context."
    )
)
async def wiki_grep(params: WikiGrepParams) -> str:
    safe_name = params.title.replace("/", "_").replace(" ", "_")
    filepath = os.path.join(_WIKI_CACHE_DIR, f"{safe_name}.txt")

    if not os.path.exists(filepath):
        return (
            f"Article '{params.title}' not found on disk. "
            f"Use wiki_full(title='{params.title}') to fetch it first."
        )

    with open(filepath) as f:
        content = f.read()

    import re
    lines = content.split("\n")
    matches = []
    try:
        pat = re.compile(params.pattern, re.IGNORECASE)
    except re.error:
        pat = re.compile(re.escape(params.pattern), re.IGNORECASE)

    for i, line in enumerate(lines):
        if pat.search(line):
            # Include 1 line of context before and after
            start = max(0, i - 1)
            end = min(len(lines), i + 2)
            context = "\n".join(f"  {lines[j]}" for j in range(start, end))
            matches.append(f"Line {i + 1}:\n{context}")

    if not matches:
        return f"No matches for '{params.pattern}' in '{params.title}'."

    header = f"Found {len(matches)} match(es) for '{params.pattern}' in '{params.title}':\n\n"
    # Cap output to avoid flooding context
    shown = matches[:15]
    result = header + "\n\n".join(shown)
    if len(matches) > 15:
        result += f"\n\n... and {len(matches) - 15} more matches."
    return result


# ── Tool: TheMealDB recipe search ────────────────────────────────────────────

_MEALDB_BASE = "https://www.themealdb.com/api/json/v1/1"


class RecipeSearchParams(BaseModel):
    query: str = Field(description="Search query — a dish name like 'pasta' or 'chicken curry'")
    search_type: str = Field(
        default="name",
        description="'name' to search by dish name, 'ingredient' to search by main ingredient (e.g. 'chicken')"
    )


class RecipeLookupParams(BaseModel):
    meal_id: str = Field(description="TheMealDB meal ID from search results")


@define_tool(
    description=(
        "Search for recipes by dish name or main ingredient using TheMealDB. "
        "Free, no API key needed. Returns meal names, categories, cuisines, "
        "and instructions."
    )
)
async def recipe_search(params: RecipeSearchParams) -> str:
    if params.search_type == "ingredient":
        url = f"{_MEALDB_BASE}/filter.php"
        qp = {"i": params.query}
    else:
        url = f"{_MEALDB_BASE}/search.php"
        qp = {"s": params.query}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=qp)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Recipe search failed: {e}"

    meals = data.get("meals") or []
    if not meals:
        return f"No recipes found for '{params.query}'."

    lines = [f"Found {len(meals)} recipe(s) for '{params.query}':\n"]
    for i, m in enumerate(meals[:10], 1):
        name = m.get("strMeal", "?")
        mid = m.get("idMeal", "")
        cat = m.get("strCategory", "")
        area = m.get("strArea", "")
        instructions = m.get("strInstructions", "")

        lines.append(f"{i}. **{name}** (id: {mid})")
        if cat or area:
            lines.append(f"   {cat}{' · ' + area if area else ''}")

        # Ingredient search only returns name/id/thumb — no details
        if instructions:
            # Collect ingredients
            ingredients = []
            for j in range(1, 21):
                ing = m.get(f"strIngredient{j}", "")
                measure = m.get(f"strMeasure{j}", "")
                if ing and ing.strip():
                    ingredients.append(f"{measure.strip()} {ing.strip()}".strip())
            if ingredients:
                lines.append(f"   Ingredients: {', '.join(ingredients[:10])}")
                if len(ingredients) > 10:
                    lines.append(f"     ... and {len(ingredients) - 10} more")
            # Truncate instructions
            short = instructions[:200].replace("\r\n", " ").replace("\n", " ")
            if len(instructions) > 200:
                short += "..."
            lines.append(f"   Instructions: {short}")
            lines.append(f"   Use recipe_lookup with meal_id='{mid}' for full details.")
        else:
            lines.append(f"   Use recipe_lookup with meal_id='{mid}' for full recipe.")
        lines.append("")

    return "\n".join(lines)


@define_tool(
    description=(
        "Get full recipe details by TheMealDB meal ID. Returns complete "
        "ingredients list, measurements, instructions, category, cuisine, "
        "and source links."
    )
)
async def recipe_lookup(params: RecipeLookupParams) -> str:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_MEALDB_BASE}/lookup.php", params={"i": params.meal_id})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Recipe lookup failed: {e}"

    meals = data.get("meals") or []
    if not meals:
        return f"No recipe found for ID '{params.meal_id}'."

    m = meals[0]
    name = m.get("strMeal", "?")
    cat = m.get("strCategory", "")
    area = m.get("strArea", "")
    instructions = m.get("strInstructions", "")
    source = m.get("strSource", "")
    youtube = m.get("strYoutube", "")
    tags = m.get("strTags", "") or ""

    ingredients = []
    for j in range(1, 21):
        ing = m.get(f"strIngredient{j}", "")
        measure = m.get(f"strMeasure{j}", "")
        if ing and ing.strip():
            ingredients.append(f"  • {measure.strip()} {ing.strip()}".strip())

    lines = [f"**{name}**"]
    if cat or area:
        lines.append(f"Category: {cat} | Cuisine: {area}")
    if tags:
        lines.append(f"Tags: {tags}")
    if ingredients:
        lines.append(f"\nIngredients ({len(ingredients)}):")
        lines.extend(ingredients)
    if instructions:
        lines.append(f"\nInstructions:\n{instructions.strip()}")
    if source:
        lines.append(f"\nSource: {source}")
    if youtube:
        lines.append(f"Video: {youtube}")

    return "\n".join(lines)


# ── Tool: MusicBrainz search ─────────────────────────────────────────────────

_MB_BASE = "https://musicbrainz.org/ws/2"
_MB_HEADERS = {"User-Agent": "MarvinAssistant/1.0 (https://github.com/marvin)", "Accept": "application/json"}


class MusicSearchParams(BaseModel):
    query: str = Field(description="Search query — artist name, album title, or song title")
    entity: str = Field(
        default="artist",
        description="What to search for: 'artist', 'release' (album), or 'recording' (song/track)",
    )
    max_results: int = Field(default=10, description="Max results (1-25)")


class MusicLookupParams(BaseModel):
    mbid: str = Field(description="MusicBrainz ID (UUID) from search results")
    entity: str = Field(
        default="artist",
        description="Entity type: 'artist', 'release', or 'recording'",
    )


@define_tool(
    description=(
        "Search MusicBrainz for artists, albums (releases), or songs (recordings). "
        "Free, no API key required. Use when users ask about music, bands, albums, "
        "songs, discographies, or release dates."
    )
)
async def music_search(params: MusicSearchParams) -> str:
    entity = params.entity if params.entity in ("artist", "release", "recording") else "artist"
    try:
        async with httpx.AsyncClient(timeout=10, headers=_MB_HEADERS) as client:
            resp = await client.get(
                f"{_MB_BASE}/{entity}/",
                params={"query": params.query, "fmt": "json", "limit": min(params.max_results, 25)},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"MusicBrainz search failed: {e}"

    items = data.get(f"{entity}s", data.get(entity, []))
    if not items:
        return f"No {entity} results for '{params.query}'."

    lines = []
    if entity == "artist":
        for i, a in enumerate(items, 1):
            name = a.get("name", "?")
            country = a.get("country", "")
            kind = a.get("type", "")
            score = a.get("score", "")
            disambiguation = a.get("disambiguation", "")
            life = a.get("life-span", {})
            begin = life.get("begin", "")
            end = life.get("end", "present") if life.get("ended") else ""
            years = f" ({begin}–{end})" if begin else ""
            extra = f" — {disambiguation}" if disambiguation else ""
            lines.append(
                f"{i}. {name}{extra}\n"
                f"   {kind} | {country}{years} | Score: {score}\n"
                f"   MBID: {a.get('id', '?')}"
            )
    elif entity == "release":
        for i, r in enumerate(items, 1):
            title = r.get("title", "?")
            artists = ", ".join(ac.get("artist", {}).get("name", "?") for ac in r.get("artist-credit", []))
            date = r.get("date", "N/A")
            country = r.get("country", "")
            status = r.get("status", "")
            tracks = r.get("track-count", "?")
            lines.append(
                f"{i}. {title} — {artists}\n"
                f"   Released: {date} | {country} | {status} | {tracks} tracks\n"
                f"   MBID: {r.get('id', '?')}"
            )
    elif entity == "recording":
        for i, r in enumerate(items, 1):
            title = r.get("title", "?")
            artists = ", ".join(ac.get("artist", {}).get("name", "?") for ac in r.get("artist-credit", []))
            length_ms = r.get("length", 0)
            length_str = f"{length_ms // 60000}:{(length_ms % 60000) // 1000:02d}" if length_ms else "?"
            releases = r.get("releases", [])
            album = releases[0].get("title", "") if releases else ""
            album_str = f" (from '{album}')" if album else ""
            lines.append(
                f"{i}. {title} — {artists} [{length_str}]{album_str}\n"
                f"   MBID: {r.get('id', '?')}"
            )

    return f"MusicBrainz {entity} results for '{params.query}':\n\n" + "\n\n".join(lines)


@define_tool(
    description=(
        "Look up detailed info for an artist, release, or recording by MusicBrainz ID (MBID). "
        "For artists: returns discography. For releases: returns track list. "
        "For recordings: returns appearances."
    )
)
async def music_lookup(params: MusicLookupParams) -> str:
    entity = params.entity if params.entity in ("artist", "release", "recording") else "artist"
    inc_map = {
        "artist": "releases+release-groups+genres+tags",
        "release": "recordings+artist-credits+labels+genres",
        "recording": "releases+artist-credits+genres",
    }
    try:
        async with httpx.AsyncClient(timeout=10, headers=_MB_HEADERS) as client:
            resp = await client.get(
                f"{_MB_BASE}/{entity}/{params.mbid}",
                params={"fmt": "json", "inc": inc_map[entity]},
            )
            resp.raise_for_status()
            d = resp.json()
    except Exception as e:
        return f"MusicBrainz lookup failed: {e}"

    lines = []
    if entity == "artist":
        name = d.get("name", "?")
        kind = d.get("type", "")
        country = d.get("country", "")
        life = d.get("life-span", {})
        begin = life.get("begin", "")
        end = life.get("end", "present") if not life.get("ended") else life.get("end", "")
        genres = ", ".join(g.get("name", "") for g in d.get("genres", [])[:8])
        tags = ", ".join(t.get("name", "") for t in d.get("tags", [])[:8])

        lines.append(f"🎵 {name}")
        lines.append(f"   Type: {kind} | Country: {country}")
        if begin:
            lines.append(f"   Active: {begin}–{end}")
        if genres:
            lines.append(f"   Genres: {genres}")
        if tags:
            lines.append(f"   Tags: {tags}")

        rgs = d.get("release-groups", [])
        if rgs:
            albums = [rg for rg in rgs if rg.get("primary-type") == "Album"]
            singles = [rg for rg in rgs if rg.get("primary-type") == "Single"]
            eps = [rg for rg in rgs if rg.get("primary-type") == "EP"]
            if albums:
                lines.append(f"\n   📀 Albums ({len(albums)}):")
                for rg in sorted(albums, key=lambda x: x.get("first-release-date", ""))[:20]:
                    lines.append(f"     • {rg.get('title', '?')} ({rg.get('first-release-date', 'N/A')})")
            if eps:
                lines.append(f"\n   💿 EPs ({len(eps)}):")
                for rg in sorted(eps, key=lambda x: x.get("first-release-date", ""))[:10]:
                    lines.append(f"     • {rg.get('title', '?')} ({rg.get('first-release-date', 'N/A')})")
            if singles:
                lines.append(f"\n   🎤 Singles ({len(singles)}):")
                for rg in sorted(singles, key=lambda x: x.get("first-release-date", ""))[:15]:
                    lines.append(f"     • {rg.get('title', '?')} ({rg.get('first-release-date', 'N/A')})")

        lines.append(f"\n   MusicBrainz: https://musicbrainz.org/artist/{params.mbid}")

    elif entity == "release":
        title = d.get("title", "?")
        artists = ", ".join(ac.get("artist", {}).get("name", "?") for ac in d.get("artist-credit", []))
        date = d.get("date", "N/A")
        country = d.get("country", "")
        status = d.get("status", "")
        barcode = d.get("barcode", "")
        labels = ", ".join(li.get("label", {}).get("name", "?") for li in d.get("label-info", []) if li.get("label"))
        genres = ", ".join(g.get("name", "") for g in d.get("genres", [])[:8])

        lines.append(f"💿 {title} — {artists}")
        lines.append(f"   Released: {date} | {country} | {status}")
        if labels:
            lines.append(f"   Label: {labels}")
        if genres:
            lines.append(f"   Genres: {genres}")
        if barcode:
            lines.append(f"   Barcode: {barcode}")

        media = d.get("media", [])
        for disc in media:
            disc_title = disc.get("title", "")
            disc_label = f" — {disc_title}" if disc_title else ""
            fmt = disc.get("format", "")
            lines.append(f"\n   📋 Tracklist ({fmt}{disc_label}):")
            for t in disc.get("tracks", []):
                pos = t.get("position", "?")
                tname = t.get("title", "?")
                length_ms = t.get("length", 0)
                length_str = f"{length_ms // 60000}:{(length_ms % 60000) // 1000:02d}" if length_ms else "?"
                lines.append(f"     {pos}. {tname} [{length_str}]")

        lines.append(f"\n   MusicBrainz: https://musicbrainz.org/release/{params.mbid}")

    elif entity == "recording":
        title = d.get("title", "?")
        artists = ", ".join(ac.get("artist", {}).get("name", "?") for ac in d.get("artist-credit", []))
        length_ms = d.get("length", 0)
        length_str = f"{length_ms // 60000}:{(length_ms % 60000) // 1000:02d}" if length_ms else "?"
        genres = ", ".join(g.get("name", "") for g in d.get("genres", [])[:8])

        lines.append(f"🎶 {title} — {artists} [{length_str}]")
        if genres:
            lines.append(f"   Genres: {genres}")
        releases = d.get("releases", [])
        if releases:
            lines.append(f"\n   Appears on ({len(releases)} releases):")
            for r in releases[:10]:
                lines.append(f"     • {r.get('title', '?')} ({r.get('date', 'N/A')})")

        lines.append(f"\n   MusicBrainz: https://musicbrainz.org/recording/{params.mbid}")

    return "\n".join(lines)


# ── Tool: Spotify (playlist create/add, search) ─────────────────────────────

def _load_ssh_key(name: str) -> str:
    v = os.environ.get(name, "")
    if v:
        return v
    p = os.path.expanduser(f"~/.ssh/{name}")
    if os.path.isfile(p):
        with open(p) as f:
            return f.read().strip()
    return ""

def _spotify_creds() -> tuple[str, str]:
    # Load dynamically so updating ~/.ssh/SPOTIFY_CLIENT_ID takes effect without restarting.
    return _load_ssh_key("SPOTIFY_CLIENT_ID"), _load_ssh_key("SPOTIFY_CLIENT_SECRET")


_SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/callback"
_SPOTIFY_TOKEN_PATH = os.path.expanduser("~/.config/local-finder/spotify_token.json")
_SPOTIFY_SCOPES = "playlist-modify-public playlist-modify-private"


def _spotify_save_token(token_data: dict):
    token_data["_saved_at"] = _time.time()
    os.makedirs(os.path.dirname(_SPOTIFY_TOKEN_PATH), exist_ok=True)
    with open(_SPOTIFY_TOKEN_PATH, "w") as f:
        json.dump(token_data, f)


def _spotify_load_token() -> dict | None:
    if os.path.isfile(_SPOTIFY_TOKEN_PATH):
        with open(_SPOTIFY_TOKEN_PATH) as f:
            return json.load(f)
    return None


async def _spotify_refresh_token(refresh_token: str) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://accounts.spotify.com/api/token",
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": _spotify_creds()[0],
                    "client_secret": _spotify_creds()[1],
                },
            )
            resp.raise_for_status()
            data = resp.json()
            # Preserve refresh token if not returned
            if "refresh_token" not in data:
                data["refresh_token"] = refresh_token
            _spotify_save_token(data)
            return data
    except Exception:
        return None


async def _spotify_get_token() -> str | None:
    """Return a valid access token, refreshing if needed."""
    token_data = _spotify_load_token()
    if not token_data:
        return None
    # Check expiry (tokens last 3600s, refresh at 3300s)
    saved_at = token_data.get("_saved_at", 0)
    expires_in = token_data.get("expires_in", 3600)
    if _time.time() - saved_at > expires_in - 300:
        refresh = token_data.get("refresh_token")
        if refresh:
            token_data = await _spotify_refresh_token(refresh)
            if not token_data:
                return None
    return token_data.get("access_token")


async def _spotify_headers() -> dict | None:
    token = await _spotify_get_token()
    if not token:
        return None
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


class SpotifyAuthParams(BaseModel):
    auth_code: str = Field(
        default="",
        description="The authorization code from the Spotify redirect URL (after ?code=). "
                    "Leave empty to get the authorization URL to visit first.",
    )


class SpotifyCreatePlaylistParams(BaseModel):
    name: str = Field(description="Playlist name")
    description: str = Field(default="", description="Playlist description")
    public: bool = Field(default=False, description="Whether the playlist is public")


class SpotifyAddTracksParams(BaseModel):
    playlist_id: str = Field(description="Spotify playlist ID (from spotify_create_playlist or a Spotify URL)")
    track_queries: list[str] = Field(
        description="List of track queries to search and add, e.g. ['Bohemian Rhapsody Queen', 'Yesterday Beatles']"
    )


class SpotifySearchParams(BaseModel):
    query: str = Field(description="Search query (song name, artist, album)")
    search_type: str = Field(default="track", description="Type: 'track', 'artist', 'album', or 'playlist'")
    max_results: int = Field(default=10, description="Max results (1-20)")


async def _spotify_exchange_code(code: str) -> str:
    """Exchange an auth code for tokens and save them."""
    client_id, client_secret = _spotify_creds()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://accounts.spotify.com/api/token",
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _SPOTIFY_REDIRECT_URI,
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
            )
            resp.raise_for_status()
            token_data = resp.json()
    except Exception as e:
        return f"Token exchange failed: {e}"

    if "access_token" not in token_data:
        return f"Auth failed: {token_data.get('error_description', token_data)}"

    _spotify_save_token(token_data)
    return ""


@define_tool(
    description=(
        "Authorize Marvin to access your Spotify account. Call with no arguments to "
        "start the auth flow (opens a callback server and returns the login URL). "
        "Or call with auth_code if you have one to paste manually. "
        "Only needed once — the token is saved and auto-refreshes."
    )
)
async def spotify_auth(params: SpotifyAuthParams) -> str:
    client_id, client_secret = _spotify_creds()
    if not client_id or not client_secret:
        return (
            "Spotify credentials not configured. Put your Client ID and Secret in:\n"
            "  ~/.ssh/SPOTIFY_CLIENT_ID\n  ~/.ssh/SPOTIFY_CLIENT_SECRET\n"
            "Get them at https://developer.spotify.com/dashboard/"
        )

    # If already authed, check if token works
    if not params.auth_code:
        existing = await _spotify_get_token()
        if existing:
            return "✅ Already authorized with Spotify! Token is valid."

        import urllib.parse
        auth_url = (
            "https://accounts.spotify.com/authorize?"
            + urllib.parse.urlencode({
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": _SPOTIFY_REDIRECT_URI,
                "scope": _SPOTIFY_SCOPES,
            })
        )
        return (
            f"Open this URL in your browser to authorize Spotify:\n\n{auth_url}\n\n"
            "After you log in and approve, the browser will redirect to a page that "
            "won't load (127.0.0.1) — that's expected.\n"
            "Copy the ENTIRE URL from your browser's address bar and paste it back here.\n"
            "It will look like: http://127.0.0.1:8888/callback?code=AQD..."
        )

    # Manual code entry path
    code = params.auth_code
    if "code=" in code:
        import urllib.parse
        parsed = urllib.parse.urlparse(code)
        qs = urllib.parse.parse_qs(parsed.query)
        code = qs.get("code", [code])[0]

    result = await _spotify_exchange_code(code)
    if result:
        return result
    return "✅ Spotify authorized successfully! Token saved."


@define_tool(
    description=(
        "Search Spotify for tracks, artists, albums, or playlists. "
        "Returns Spotify URIs that can be used with spotify_add_tracks. "
        "Requires Spotify auth (run spotify_auth first if needed)."
    )
)
async def spotify_search(params: SpotifySearchParams) -> str:
    headers = await _spotify_headers()
    if not headers:
        return "Not authorized with Spotify. Use spotify_auth first."

    stype = params.search_type if params.search_type in ("track", "artist", "album", "playlist") else "track"
    try:
        async with httpx.AsyncClient(timeout=10, headers=headers) as client:
            resp = await client.get(
                "https://api.spotify.com/v1/search",
                params={"q": params.query, "type": stype, "limit": min(params.max_results, 20)},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Spotify search failed: {e}"

    items = data.get(f"{stype}s", {}).get("items", [])
    if not items:
        return f"No Spotify results for '{params.query}'."

    lines = []
    if stype == "track":
        for i, t in enumerate(items, 1):
            name = t.get("name", "?")
            artists = ", ".join(a.get("name", "?") for a in t.get("artists", []))
            album = t.get("album", {}).get("name", "")
            dur_ms = t.get("duration_ms", 0)
            dur = f"{dur_ms // 60000}:{(dur_ms % 60000) // 1000:02d}"
            uri = t.get("uri", "")
            url = t.get("external_urls", {}).get("spotify", "")
            lines.append(f"{i}. {name} — {artists} [{dur}]\n   Album: {album}\n   URI: {uri}\n   {url}")
    elif stype == "artist":
        for i, a in enumerate(items, 1):
            name = a.get("name", "?")
            genres = ", ".join(a.get("genres", [])[:4])
            followers = a.get("followers", {}).get("total", 0)
            url = a.get("external_urls", {}).get("spotify", "")
            lines.append(f"{i}. {name} | {genres} | {followers:,} followers\n   {url}")
    elif stype == "album":
        for i, a in enumerate(items, 1):
            name = a.get("name", "?")
            artists = ", ".join(ar.get("name", "?") for ar in a.get("artists", []))
            date = a.get("release_date", "N/A")
            tracks = a.get("total_tracks", "?")
            uri = a.get("uri", "")
            url = a.get("external_urls", {}).get("spotify", "")
            lines.append(f"{i}. {name} — {artists} ({date}) | {tracks} tracks\n   URI: {uri}\n   {url}")
    elif stype == "playlist":
        for i, p in enumerate(items, 1):
            name = p.get("name", "?")
            owner = p.get("owner", {}).get("display_name", "?")
            tracks = p.get("tracks", {}).get("total", "?")
            url = p.get("external_urls", {}).get("spotify", "")
            lines.append(f"{i}. {name} by {owner} | {tracks} tracks\n   ID: {p.get('id', '?')}\n   {url}")

    return f"Spotify {stype} results for '{params.query}':\n\n" + "\n\n".join(lines)


@define_tool(
    description=(
        "Create a new Spotify playlist on the authenticated user's account. "
        "Returns the playlist ID for use with spotify_add_tracks."
    )
)
async def spotify_create_playlist(params: SpotifyCreatePlaylistParams) -> str:
    headers = await _spotify_headers()
    if not headers:
        return "Not authorized with Spotify. Use spotify_auth first."

    try:
        async with httpx.AsyncClient(timeout=10, headers=headers) as client:
            # Create playlist (preferred endpoint; avoids user-id permission edge cases)
            resp = await client.post(
                "https://api.spotify.com/v1/me/playlists",
                json={
                    "name": params.name,
                    "description": params.description,
                    "public": params.public,
                },
            )
            resp.raise_for_status()
            pl = resp.json()
    except Exception as e:
        return f"Failed to create playlist: {e}"

    return (
        f"✅ Created playlist: {pl.get('name', '?')}\n"
        f"   ID: {pl.get('id', '?')}\n"
        f"   URL: {pl.get('external_urls', {}).get('spotify', 'N/A')}\n"
        f"   Use spotify_add_tracks with playlist_id=\"{pl.get('id', '')}\" to add songs."
    )


@define_tool(
    description=(
        "Add tracks to a Spotify playlist. Searches for each track query on Spotify "
        "and adds the best match. Provide a list of song queries like "
        "['Bohemian Rhapsody Queen', 'Yesterday Beatles']. "
        "Use spotify_create_playlist first to get a playlist_id."
    )
)
async def spotify_add_tracks(params: SpotifyAddTracksParams) -> str:
    headers = await _spotify_headers()
    if not headers:
        return "Not authorized with Spotify. Use spotify_auth first."

    added = []
    failed = []
    uris = []

    try:
        async with httpx.AsyncClient(timeout=15, headers=headers) as client:
            for q in params.track_queries:
                try:
                    resp = await client.get(
                        "https://api.spotify.com/v1/search",
                        params={"q": q, "type": "track", "limit": 5},
                    )
                    resp.raise_for_status()
                    items = resp.json().get("tracks", {}).get("items", [])
                    if items:
                        def score_track(t: dict) -> int:
                            name = (t.get("name") or "").lower()
                            album = (t.get("album", {}).get("name") or "").lower()
                            artists = " ".join((a.get("name") or "") for a in t.get("artists", [])).lower()
                            blob = f"{name} {album} {artists}"

                            score = 0
                            for kw, w in (
                                ("gregorian", 5),
                                ("chant", 4),
                                ("monk", 3),
                                ("monks", 3),
                                ("schola", 3),
                                ("abbey", 2),
                                ("antiphon", 2),
                                ("plainchant", 5),
                                ("silos", 2),
                            ):
                                if kw in blob:
                                    score += w
                            for kw, w in (("remix", 6), ("version", 2), ("rainstorm", 6), ("double", 2)):
                                if kw in blob:
                                    score -= w
                            return score

                        track = max(items, key=score_track)
                        uris.append(track["uri"])
                        artists = ", ".join(a["name"] for a in track.get("artists", []))
                        added.append(f"  ✅ {track['name']} — {artists}")
                    else:
                        failed.append(f"  ❌ '{q}' — not found")
                except Exception as e:
                    failed.append(f"  ❌ '{q}' — {e}")

            # Add all found tracks in one batch (Spotify supports up to 100)
            if uris:
                for batch_start in range(0, len(uris), 100):
                    batch = uris[batch_start:batch_start + 100]
                    resp = await client.post(
                        f"https://api.spotify.com/v1/playlists/{params.playlist_id}/items",
                        json={"uris": batch},
                    )
                    resp.raise_for_status()
    except Exception as e:
        return f"Failed to add tracks: {e}"

    lines = [f"Added {len(added)} tracks to playlist:"]
    lines.extend(added)
    if failed:
        lines.append(f"\nFailed ({len(failed)}):")
        lines.extend(failed)
    return "\n".join(lines)


# ── Tool: Selenium page scraper ──────────────────────────────────────────────

_SCRAPE_MIN_DELAY = 3.0  # seconds between requests
_scrape_last_request: float = 0.0
_FIREFOX_BIN = "/snap/firefox/current/usr/lib/firefox/firefox"


def _scrape_rate_limit():
    """Sleep if needed to respect rate limit."""
    global _scrape_last_request
    elapsed = _time.monotonic() - _scrape_last_request
    if elapsed < _SCRAPE_MIN_DELAY:
        _time.sleep(_SCRAPE_MIN_DELAY - elapsed)
    _scrape_last_request = _time.monotonic()


def _get_selenium_driver():
    """Create a headless Firefox webdriver."""
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options

    opts = Options()
    opts.add_argument("--headless")
    if os.path.exists(_FIREFOX_BIN):
        opts.binary_location = _FIREFOX_BIN
    driver = webdriver.Firefox(options=opts)
    driver.set_page_load_timeout(30)
    return driver


class ScrapePageParams(BaseModel):
    url: str = Field(description="The URL to scrape")
    extract: str = Field(
        default="text",
        description=(
            "What to extract: 'text' for full visible text, "
            "'menu' to try extracting menu items/prices, "
            "'links' for all links on the page"
        ),
    )
    css_selector: str = Field(
        default="",
        description=(
            "Optional CSS selector to narrow extraction to a specific "
            "part of the page (e.g. '#menu', '.menu-items', 'main')"
        ),
    )
    max_length: int = Field(
        default=4000,
        description="Maximum characters to return (1-8000)",
    )


@define_tool(
    description=(
        "Scrape a specific web page URL using Selenium + Firefox (headless). "
        "ONLY use this when you have a specific URL AND the page requires "
        "JavaScript to render. Do NOT use this for searching — use web_search "
        "instead. Slow (launches browser). Rate-limited to 1 request per 3 seconds."
    )
)
async def scrape_page(params: ScrapePageParams) -> str:
    from bs4 import BeautifulSoup

    _scrape_rate_limit()
    _usage.record("scrape_page")

    driver = None
    try:
        driver = await asyncio.get_event_loop().run_in_executor(
            None, _get_selenium_driver
        )

        def _load():
            driver.get(params.url)
            _time.sleep(2)  # let JS render
            return driver.page_source

        html = await asyncio.get_event_loop().run_in_executor(None, _load)
    except Exception as e:
        return f"Scrape failed: {e}"
    finally:
        if driver:
            try:
                await asyncio.get_event_loop().run_in_executor(
                    None, driver.quit
                )
            except Exception:
                pass

    soup = BeautifulSoup(html, "html.parser")

    # Remove script/style/nav/footer noise
    for tag in soup.select("script, style, noscript, nav, footer, header, iframe"):
        tag.decompose()

    # Narrow to CSS selector if provided
    if params.css_selector:
        target = soup.select_one(params.css_selector)
        if not target:
            return (
                f"CSS selector '{params.css_selector}' not found on page. "
                f"Available IDs: {[t.get('id') for t in soup.select('[id]')][:15]}"
            )
        soup = target

    max_len = min(params.max_length, 8000)

    if params.extract == "links":
        links = []
        for a in soup.select("a[href]"):
            text = a.get_text(strip=True)
            href = a["href"]
            if text and href and not href.startswith("#"):
                links.append(f"• {text} → {href}")
        result = "\n".join(links[:100]) if links else "No links found."
        return result[:max_len]

    if params.extract == "menu":
        # Heuristic: look for price patterns and nearby text
        import re
        text = soup.get_text(separator="\n", strip=True)
        lines = text.split("\n")
        menu_lines = []
        price_re = re.compile(r'\$\d+\.?\d*|\d+\.\d{2}')
        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue
            if price_re.search(line):
                # Include preceding line as item name if it has no price
                if i > 0 and not price_re.search(lines[i - 1]):
                    prev = lines[i - 1].strip()
                    if prev and prev not in [l.split(" — ")[0] for l in menu_lines[-3:]]:
                        menu_lines.append(f"{prev} — {line}")
                        continue
                menu_lines.append(line)
            elif len(line) < 60 and line[0].isupper():
                # Possible section header or item name without price
                menu_lines.append(line)

        if menu_lines:
            result = f"Menu items found on {params.url}:\n\n"
            result += "\n".join(menu_lines)
            return result[:max_len]
        else:
            # Fall through to plain text
            result = f"No obvious menu/price patterns found. Full page text:\n\n"
            result += soup.get_text(separator="\n", strip=True)
            return result[:max_len]

    # Default: full text
    text = soup.get_text(separator="\n", strip=True)
    # Collapse blank lines
    lines = [l for l in text.split("\n") if l.strip()]
    result = f"Page content from {params.url}:\n\n"
    result += "\n".join(lines)
    return result[:max_len]


# ── Tool: Lynx web browser ───────────────────────────────────────────────────

_BROWSE_MIN_DELAY = 1.0
_browse_last_request: float = 0.0


class BrowseWebParams(BaseModel):
    url: str = Field(description="The URL to browse")
    max_length: int = Field(
        default=4000,
        description="Maximum characters to return (1-8000)",
    )


@define_tool(
    description=(
        "Read a specific web page URL using Lynx (text browser). "
        "ONLY use this when you have a specific URL and want to read its full "
        "content. Faster than scrape_page but cannot render JavaScript. "
        "Do NOT use this for searching — use web_search instead. "
        "Good for articles, docs, wiki pages. Rate-limited to 1 request/sec."
    )
)
async def browse_web(params: BrowseWebParams) -> str:
    global _browse_last_request
    elapsed = _time.monotonic() - _browse_last_request
    if elapsed < _BROWSE_MIN_DELAY:
        await asyncio.sleep(_BROWSE_MIN_DELAY - elapsed)
    _browse_last_request = _time.monotonic()

    try:
        proc = await asyncio.create_subprocess_exec(
            "lynx", "-dump", "-nolist", "-width=120",
            "-accept_all_cookies", "-noreferer",
            "-useragent=Mozilla/5.0", params.url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
    except asyncio.TimeoutError:
        return f"Lynx timed out fetching {params.url}"
    except Exception as e:
        return f"Lynx failed: {e}"

    text = stdout.decode("utf-8", errors="replace")
    if not text.strip():
        err = stderr.decode("utf-8", errors="replace").strip()
        return f"No content from {params.url}" + (f" — {err}" if err else "")

    # Collapse excessive blank lines
    lines = text.split("\n")
    cleaned = []
    blank_count = 0
    for line in lines:
        if not line.strip():
            blank_count += 1
            if blank_count <= 2:
                cleaned.append("")
        else:
            blank_count = 0
            cleaned.append(line)

    max_len = min(params.max_length, 8000)
    result = "\n".join(cleaned).strip()
    if len(result) > max_len:
        result = result[:max_len] + "\n\n[... truncated]"
    return (
        "[INSTRUCTION: The raw text below was extracted by Lynx and may contain "
        "formatting artifacts like broken columns, garbled tables, stray unicode, "
        "or repeated whitespace. Clean it up before presenting to the user: fix "
        "alignment, merge broken lines, format tables/lists readably, and remove "
        "navigation/boilerplate junk. Keep all factual content.]\n\n"
        + result
    )


def _format_places(data: dict) -> str:
    """Format Google Places API response into readable text."""
    places = data.get("places", [])
    if not places:
        return "No results found."

    lines = []
    for i, place in enumerate(places, 1):
        name = place.get("displayName", {}).get("text", "Unknown")
        rating = place.get("rating", "N/A")
        reviews = place.get("userRatingCount", 0)
        price = place.get("priceLevel", "N/A")
        addr = place.get("formattedAddress", "N/A")
        phone = place.get("nationalPhoneNumber", "N/A")
        url = place.get("googleMapsUri", "")
        types = ", ".join(
            t.replace("_", " ").title()
            for t in place.get("types", [])[:4]
        )
        open_now = ""
        hrs = place.get("currentOpeningHours", {})
        if "openNow" in hrs:
            open_now = " | Open now" if hrs["openNow"] else " | Closed"

        lines.append(
            f"{i}. {name}\n"
            f"   Rating: {rating}/5 ({reviews} reviews) | Price: {price}{open_now}\n"
            f"   Types: {types}\n"
            f"   Address: {addr}\n"
            f"   Phone: {phone}\n"
            f"   {url}"
        )
    return "\n\n".join(lines)


    return "\n\n".join(lines)


# ── OSM Nominatim / Overpass fallback ────────────────────────────────────────

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_OVERPASS_URL = "https://overpass-api.de/api/interpreter"


async def _nominatim_search(
    query: str,
    lat: float = 0.0,
    lng: float = 0.0,
    limit: int = 5,
) -> str:
    """Search OpenStreetMap via Nominatim as a fallback for Google Places."""
    params: dict = {
        "q": query,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": limit,
        "extratags": 1,
    }
    if lat and lng:
        params["viewbox"] = f"{lng-0.05},{lat+0.05},{lng+0.05},{lat-0.05}"
        params["bounded"] = 1
    headers = {"User-Agent": "LocalFinder/1.0"}

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(_NOMINATIM_URL, params=params, headers=headers)
        if resp.status_code != 200:
            return f"Nominatim error {resp.status_code}: {resp.text}"
        results = resp.json()

    if not results:
        # Retry without bounding box
        if lat and lng:
            params.pop("viewbox", None)
            params.pop("bounded", None)
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(_NOMINATIM_URL, params=params, headers=headers)
                results = resp.json() if resp.status_code == 200 else []
        if not results:
            return "No results found on OpenStreetMap."

    lines = [f"Results from OpenStreetMap (Google Places unavailable):"]
    for i, r in enumerate(results[:limit], 1):
        name = r.get("display_name", "Unknown")
        cat = r.get("category", "")
        rtype = r.get("type", "")
        addr = r.get("address", {})
        road = addr.get("road", "")
        city = addr.get("city") or addr.get("town") or addr.get("village", "")
        tags = r.get("extratags", {})
        phone = tags.get("phone", "")
        website = tags.get("website", "")
        cuisine = tags.get("cuisine", "")
        opening = tags.get("opening_hours", "")

        parts = [f"{i}. {name}"]
        if cat and rtype:
            parts.append(f"   Type: {cat}/{rtype}")
        if cuisine:
            parts.append(f"   Cuisine: {cuisine}")
        if road and city:
            parts.append(f"   Address: {road}, {city}")
        if phone:
            parts.append(f"   Phone: {phone}")
        if website:
            parts.append(f"   Web: {website}")
        if opening:
            parts.append(f"   Hours: {opening}")
        lines.append("\n".join(parts))
    return "\n\n".join(lines)


async def _overpass_nearby(
    lat: float,
    lng: float,
    place_types: list[str],
    radius: float = 5000.0,
    limit: int = 5,
) -> str:
    """Search nearby places using Overpass API as fallback for Google Nearby."""
    osm_tags = {
        "restaurant": '"amenity"="restaurant"',
        "cafe": '"amenity"="cafe"',
        "bakery": '"shop"="bakery"',
        "bar": '"amenity"="bar"',
        "gym": '"leisure"="fitness_centre"',
        "gas_station": '"amenity"="fuel"',
        "pharmacy": '"amenity"="pharmacy"',
        "hospital": '"amenity"="hospital"',
        "supermarket": '"shop"="supermarket"',
        "park": '"leisure"="park"',
        "hotel": '"tourism"="hotel"',
        "bank": '"amenity"="bank"',
        "library": '"amenity"="library"',
    }

    filters = []
    for pt in place_types:
        tag = osm_tags.get(pt, f'"amenity"="{pt}"')
        filters.append(f'node[{tag}](around:{radius},{lat},{lng});')
        filters.append(f'way[{tag}](around:{radius},{lat},{lng});')

    query = f"""[out:json][timeout:15];
(
  {"".join(filters)}
);
out center {limit};"""

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(_OVERPASS_URL, data={"data": query})
        if resp.status_code != 200:
            return f"Overpass API error {resp.status_code}: {resp.text}"
        data = resp.json()

    elements = data.get("elements", [])
    if not elements:
        return "No nearby results found on OpenStreetMap."

    lines = [f"Nearby results from OpenStreetMap (Google Places unavailable):"]
    for i, el in enumerate(elements[:limit], 1):
        tags = el.get("tags", {})
        name = tags.get("name", "Unknown")
        cuisine = tags.get("cuisine", "")
        phone = tags.get("phone", "")
        website = tags.get("website", "")
        opening = tags.get("opening_hours", "")
        street = tags.get("addr:street", "")
        city = tags.get("addr:city", "")

        parts = [f"{i}. {name}"]
        if cuisine:
            parts.append(f"   Cuisine: {cuisine}")
        if street:
            addr_str = street
            if city:
                addr_str += f", {city}"
            parts.append(f"   Address: {addr_str}")
        if phone:
            parts.append(f"   Phone: {phone}")
        if website:
            parts.append(f"   Web: {website}")
        if opening:
            parts.append(f"   Hours: {opening}")
        lines.append("\n".join(parts))
    return "\n\n".join(lines)


# ── Tool 1: Text Search (natural language queries) ───────────────────────────

class TextSearchParams(BaseModel):
    text_query: str = Field(
        description=(
            "Natural-language search query, e.g. "
            "'best ramen in downtown Seattle' or 'late night tacos Austin TX'"
        )
    )
    latitude: float = Field(
        default=0.0,
        description="Optional latitude to bias results toward",
    )
    longitude: float = Field(
        default=0.0,
        description="Optional longitude to bias results toward",
    )
    radius: float = Field(
        default=5000.0,
        description="Bias radius in meters (used with lat/lng)",
    )
    max_results: int = Field(default=5, description="Max results (1-20)")
    open_now: bool = Field(default=False, description="Only show places open now")


@define_tool(
    description=(
        "Search for places using a natural-language query. "
        "Automatically uses Google Places API if available, otherwise falls back "
        "to OpenStreetMap. Just call this tool — it always returns results. "
        "e.g. 'best pizza near me', 'quiet cafes to work from in Brooklyn'."
    )
)
async def places_text_search(params: TextSearchParams) -> str:
    _usage.record("places_text_search")
    body: dict = {
        "textQuery": params.text_query,
        "maxResultCount": min(params.max_results, 20),
    }
    if params.open_now:
        body["openNow"] = True
    if params.latitude and params.longitude:
        body["locationBias"] = {
            "circle": {
                "center": {
                    "latitude": params.latitude,
                    "longitude": params.longitude,
                },
                "radius": params.radius,
            }
        }

    headers = _get_google_headers()

    if headers:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://places.googleapis.com/v1/places:searchText",
                    headers=headers,
                    content=json.dumps(body),
                )
                if resp.status_code == 200:
                    return _format_places(resp.json())
                else:
                    import sys
                    print(f"  ⚠️  Google Places API {resp.status_code}, falling back to OSM", file=sys.stderr)
        except Exception as e:
            import sys
            print(f"  ⚠️  Google Places error: {e}, falling back to OSM", file=sys.stderr)

    # Fallback to OpenStreetMap Nominatim
    return await _nominatim_search(
        params.text_query,
        lat=params.latitude,
        lng=params.longitude,
        limit=params.max_results,
    )


# ── Tool 2: Nearby Search (structured type + location) ───────────────────────

class NearbySearchParams(BaseModel):
    latitude: float = Field(description="Latitude of the search center")
    longitude: float = Field(description="Longitude of the search center")
    included_types: list[str] = Field(
        description=(
            "Google place types to include, e.g. ['restaurant'], "
            "['gym'], ['cafe', 'bakery']. "
            "See: https://developers.google.com/maps/documentation/places/web-service/place-types"
        )
    )
    radius: float = Field(
        default=5000.0,
        description="Search radius in meters (max 50000)",
    )
    max_results: int = Field(default=5, description="Max results (1-20)")
    rank_by: str = Field(
        default="POPULARITY",
        description="Rank by POPULARITY or DISTANCE",
    )


@define_tool(
    description=(
        "Search for nearby places by type and coordinates. "
        "Automatically uses Google Places API if available, otherwise falls back "
        "to OpenStreetMap. Just call this tool — it always returns results. "
        "Use when you know the exact location (lat/lng) and place type."
    )
)
async def places_nearby_search(params: NearbySearchParams) -> str:
    _usage.record("places_nearby_search")
    body = {
        "includedTypes": params.included_types,
        "maxResultCount": min(params.max_results, 20),
        "rankPreference": params.rank_by,
        "locationRestriction": {
            "circle": {
                "center": {
                    "latitude": params.latitude,
                    "longitude": params.longitude,
                },
                "radius": min(params.radius, 50000.0),
            }
        },
    }

    headers = _get_google_headers()

    if headers:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://places.googleapis.com/v1/places:searchNearby",
                    headers=headers,
                    content=json.dumps(body),
                )
                if resp.status_code == 200:
                    return _format_places(resp.json())
                else:
                    import sys
                    print(f"  ⚠️  Google Places API {resp.status_code}, falling back to OSM", file=sys.stderr)
        except Exception as e:
            import sys
            print(f"  ⚠️  Google Places error: {e}, falling back to OSM", file=sys.stderr)

    # Fallback to OpenStreetMap Overpass
    return await _overpass_nearby(
        params.latitude,
        params.longitude,
        params.included_types,
        radius=params.radius,
        limit=params.max_results,
    )


# ── Tool: Travel time estimate via OSRM ─────────────────────────────────────

OSRM_BASE = "https://router.project-osrm.org/route/v1"


class TravelTimeParams(BaseModel):
    origin_lat: float = Field(description="Origin latitude")
    origin_lng: float = Field(description="Origin longitude")
    dest_lat: float = Field(description="Destination latitude")
    dest_lng: float = Field(description="Destination longitude")
    mode: str = Field(
        default="driving",
        description="Travel mode: driving, cycling, or foot",
    )


@define_tool(
    description=(
        "Get raw travel time and distance between two points using "
        "OpenStreetMap routing (OSRM). Returns free-flow (no traffic) estimates. "
        "Supports driving, cycling, and walking. "
        "For a traffic- and weather-adjusted estimate, call "
        "estimate_traffic_adjusted_time instead or in addition."
    )
)
async def estimate_travel_time(params: TravelTimeParams) -> str:
    profile = params.mode if params.mode in ("driving", "cycling", "foot") else "driving"
    coords = f"{params.origin_lng},{params.origin_lat};{params.dest_lng},{params.dest_lat}"
    url = f"{OSRM_BASE}/{profile}/{coords}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params={"overview": "false", "alternatives": "false"})
        if resp.status_code != 200:
            return f"OSRM routing error {resp.status_code}: {resp.text}"
        data = resp.json()

    if data.get("code") != "Ok" or not data.get("routes"):
        return f"Could not find a route: {data.get('code', 'unknown error')}"

    route = data["routes"][0]
    dist_km = route["distance"] / 1000
    dur_mins = route["duration"] / 60

    mode_label = {"driving": "🚗 Driving", "cycling": "🚲 Cycling", "foot": "🚶 Walking"}.get(profile, profile)
    return (
        f"{mode_label} (free-flow, no traffic):\n"
        f"  Distance: {dist_km:.1f} km ({dist_km * 0.621371:.1f} mi)\n"
        f"  Duration: {_fmt_mins(dur_mins)}"
    )


def _fmt_mins(m: float) -> str:
    if m < 60:
        return f"{m:.0f} min"
    return f"{int(m // 60)}h {int(m % 60)}m"


# ── Tool: Turn-by-turn directions via OSRM ──────────────────────────────────

class DirectionsParams(BaseModel):
    origin_lat: float = Field(description="Origin latitude")
    origin_lng: float = Field(description="Origin longitude")
    dest_lat: float = Field(description="Destination latitude")
    dest_lng: float = Field(description="Destination longitude")
    mode: str = Field(
        default="driving",
        description="Travel mode: driving, cycling, or foot",
    )
    waypoints: str = Field(
        default="",
        description=(
            "Optional intermediate waypoints as 'lat,lng;lat,lng'. "
            "The route will pass through these points in order."
        ),
    )


# OSRM maneuver type → human-readable instruction
_MANEUVER_LABELS = {
    "turn": "Turn", "new name": "Continue onto", "depart": "Depart",
    "arrive": "Arrive", "merge": "Merge", "on ramp": "Take ramp",
    "off ramp": "Take exit", "fork": "Fork", "end of road": "End of road",
    "continue": "Continue", "roundabout": "Roundabout", "rotary": "Rotary",
    "roundabout turn": "Roundabout turn", "notification": "",
    "exit roundabout": "Exit roundabout", "exit rotary": "Exit rotary",
}


@define_tool(
    description=(
        "Get turn-by-turn directions between two points using OpenStreetMap (OSRM). "
        "Returns step-by-step navigation instructions with distances and durations. "
        "Supports driving, cycling, and walking. Free, no API key needed. "
        "Optionally include waypoints for multi-stop routes."
    )
)
async def get_directions(params: DirectionsParams) -> str:
    profile = params.mode if params.mode in ("driving", "cycling", "foot") else "driving"

    # Build coordinate string: origin[;waypoints];destination
    coord_parts = [f"{params.origin_lng},{params.origin_lat}"]
    if params.waypoints.strip():
        for wp in params.waypoints.split(";"):
            wp = wp.strip()
            if "," in wp:
                lat, lng = wp.split(",", 1)
                coord_parts.append(f"{lng.strip()},{lat.strip()}")
    coord_parts.append(f"{params.dest_lng},{params.dest_lat}")
    coords = ";".join(coord_parts)

    url = f"{OSRM_BASE}/{profile}/{coords}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={
                "overview": "full",
                "geometries": "geojson",
                "steps": "true",
            })
            if resp.status_code != 200:
                return f"Routing error {resp.status_code}: {resp.text}"
            data = resp.json()
    except Exception as e:
        return f"Routing request failed: {e}"

    if data.get("code") != "Ok" or not data.get("routes"):
        return f"Could not find a route: {data.get('code', 'unknown error')}"

    route = data["routes"][0]
    total_km = route["distance"] / 1000
    total_mins = route["duration"] / 60

    mode_emoji = {"driving": "🚗", "cycling": "🚲", "foot": "🚶"}.get(profile, "📍")
    lines = [
        f"{mode_emoji} Directions ({profile})",
        f"   Total: {total_km:.1f} km ({total_km * 0.621371:.1f} mi), {_fmt_mins(total_mins)}",
        "",
    ]

    step_num = 0
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})
            m_type = maneuver.get("type", "")
            modifier = maneuver.get("modifier", "")

            # Skip zero-distance waypoint artifacts
            if step.get("distance", 0) == 0 and m_type not in ("depart", "arrive"):
                continue

            step_num += 1
            label = _MANEUVER_LABELS.get(m_type, m_type.replace("_", " ").title())
            if modifier:
                label = f"{label} {modifier}"

            name = step.get("name", "")
            dist_m = step.get("distance", 0)
            dur_s = step.get("duration", 0)

            if dist_m >= 1000:
                dist_str = f"{dist_m / 1000:.1f} km"
            else:
                dist_str = f"{dist_m:.0f} m"

            dur_str = _fmt_mins(dur_s / 60) if dur_s >= 60 else f"{dur_s:.0f}s"

            if m_type == "arrive":
                lines.append(f"  {step_num}. 🏁 Arrive{' at ' + name if name else ''}")
            elif name:
                lines.append(f"  {step_num}. {label} — {name} ({dist_str}, {dur_str})")
            else:
                lines.append(f"  {step_num}. {label} ({dist_str}, {dur_str})")

    return "\n".join(lines)


# ── Tool: Traffic- and weather-adjusted travel time ─────────────────────────

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    85: "Slight snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}


class TrafficAdjustedParams(BaseModel):
    origin_lat: float = Field(description="Origin latitude")
    origin_lng: float = Field(description="Origin longitude")
    dest_lat: float = Field(description="Destination latitude")
    dest_lng: float = Field(description="Destination longitude")
    mode: str = Field(
        default="driving",
        description="Travel mode: driving, cycling, or foot",
    )


@define_tool(
    description=(
        "Estimate traffic- and weather-adjusted travel time between two points. "
        "Fetches the OSRM free-flow route, current weather from Open-Meteo, "
        "and the current local time, then applies heuristic multipliers for "
        "time-of-day traffic patterns and weather conditions. "
        "Returns ALL raw inputs (base duration, weather, local time, multipliers) "
        "plus a heuristic estimate. YOU (the LLM) should validate whether the "
        "estimate is reasonable given the context and adjust if needed before "
        "presenting to the user."
    )
)
async def estimate_traffic_adjusted_time(params: TrafficAdjustedParams) -> str:
    profile = params.mode if params.mode in ("driving", "cycling", "foot") else "driving"

    # 1. Get OSRM route
    coords = f"{params.origin_lng},{params.origin_lat};{params.dest_lng},{params.dest_lat}"
    url = f"{OSRM_BASE}/{profile}/{coords}"

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params={"overview": "false", "alternatives": "false"})
        if resp.status_code != 200:
            return f"OSRM routing error {resp.status_code}: {resp.text}"
        route_data = resp.json()

    if route_data.get("code") != "Ok" or not route_data.get("routes"):
        return f"Could not find a route: {route_data.get('code', 'unknown error')}"

    route = route_data["routes"][0]
    dist_km = route["distance"] / 1000
    base_mins = route["duration"] / 60

    # 2. Get weather at midpoint
    mid_lat = (params.origin_lat + params.dest_lat) / 2
    mid_lng = (params.origin_lng + params.dest_lng) / 2

    weather_str = "unavailable"
    weather_code = -1
    temp_c = None
    precip_mm = 0.0
    wind_kmh = 0.0
    visibility_ok = True

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            wresp = await client.get(OPEN_METEO_URL, params={
                "latitude": mid_lat,
                "longitude": mid_lng,
                "current": "temperature_2m,apparent_temperature,weathercode,"
                           "precipitation,rain,snowfall,windspeed_10m,windgusts_10m,"
                           "is_day,relative_humidity_2m",
                "timezone": "auto",
            })
            if wresp.status_code == 200:
                wdata = wresp.json().get("current", {})
                weather_code = wdata.get("weathercode", -1)
                temp_c = wdata.get("temperature_2m")
                feels_like = wdata.get("apparent_temperature")
                precip_mm = wdata.get("precipitation", 0) or 0
                rain_mm = wdata.get("rain", 0) or 0
                snow_mm = wdata.get("snowfall", 0) or 0
                wind_kmh = wdata.get("windspeed_10m", 0) or 0
                gusts_kmh = wdata.get("windgusts_10m", 0) or 0
                humidity = wdata.get("relative_humidity_2m", 0)
                is_day = wdata.get("is_day", 1)

                condition = WMO_CODES.get(weather_code, f"Code {weather_code}")
                weather_str = (
                    f"{condition}, {temp_c}°C (feels {feels_like}°C), "
                    f"precip {precip_mm}mm, rain {rain_mm}mm, snow {snow_mm}mm, "
                    f"wind {wind_kmh} km/h (gusts {gusts_kmh} km/h), "
                    f"humidity {humidity}%, {'day' if is_day else 'night'}"
                )
                # Fog / freezing conditions reduce visibility
                if weather_code in (45, 48, 56, 57, 66, 67, 75, 86, 95, 96, 99):
                    visibility_ok = False
    except Exception:
        pass

    # 3. Get local time at destination via timezone offset
    from datetime import datetime, timezone
    local_hour = None
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            tresp = await client.get(OPEN_METEO_URL, params={
                "latitude": params.dest_lat,
                "longitude": params.dest_lng,
                "current": "temperature_2m",
                "timezone": "auto",
            })
            if tresp.status_code == 200:
                tdata = tresp.json()
                # current.time is in local time e.g. "2026-02-13T15:30"
                time_str = tdata.get("current", {}).get("time", "")
                if "T" in time_str:
                    local_hour = int(time_str.split("T")[1].split(":")[0])
    except Exception:
        pass

    if local_hour is None:
        local_hour = datetime.now(timezone.utc).hour
        time_source = "UTC (could not determine local)"
    else:
        time_source = "local"

    # 4. Compute heuristic multipliers
    # Time-of-day traffic multiplier (driving only)
    time_multiplier = 1.0
    time_reason = "off-peak"
    if profile == "driving":
        if 7 <= local_hour <= 9:
            time_multiplier = 1.5
            time_reason = "morning rush hour"
        elif 16 <= local_hour <= 18:
            time_multiplier = 1.6
            time_reason = "evening rush hour"
        elif 11 <= local_hour <= 13:
            time_multiplier = 1.2
            time_reason = "lunch hour"
        elif 19 <= local_hour <= 21:
            time_multiplier = 1.15
            time_reason = "post-rush"
        elif 22 <= local_hour or local_hour <= 5:
            time_multiplier = 0.9
            time_reason = "late night / early morning"

    # Weather multiplier
    weather_multiplier = 1.0
    weather_reason = "clear conditions"
    if precip_mm > 0 or weather_code >= 51:
        if snow_mm > 0 or weather_code in (71, 73, 75, 77, 85, 86):
            weather_multiplier = 1.5
            weather_reason = "snow/ice — slippery roads"
        elif weather_code in (65, 67, 82):
            weather_multiplier = 1.35
            weather_reason = "heavy rain — reduced visibility"
        elif weather_code in (61, 63, 80, 81):
            weather_multiplier = 1.2
            weather_reason = "rain — wet roads"
        elif weather_code in (51, 53, 55):
            weather_multiplier = 1.1
            weather_reason = "drizzle"
    if not visibility_ok:
        weather_multiplier = max(weather_multiplier, 1.3)
        weather_reason += " + low visibility"
    if wind_kmh > 60:
        weather_multiplier += 0.1
        weather_reason += " + high winds"

    combined_multiplier = time_multiplier * weather_multiplier
    adjusted_mins = base_mins * combined_multiplier

    mode_label = {"driving": "🚗 Driving", "cycling": "🚲 Cycling", "foot": "🚶 Walking"}.get(profile, profile)

    return (
        f"=== Traffic & Weather Adjusted Estimate ===\n"
        f"Mode: {mode_label}\n"
        f"Distance: {dist_km:.1f} km ({dist_km * 0.621371:.1f} mi)\n"
        f"\n"
        f"--- Raw Inputs ---\n"
        f"OSRM free-flow duration: {_fmt_mins(base_mins)}\n"
        f"Local time at destination: {local_hour}:00 ({time_source})\n"
        f"Weather: {weather_str}\n"
        f"\n"
        f"--- Heuristic Multipliers ---\n"
        f"Time-of-day: x{time_multiplier:.2f} ({time_reason})\n"
        f"Weather: x{weather_multiplier:.2f} ({weather_reason})\n"
        f"Combined: x{combined_multiplier:.2f}\n"
        f"\n"
        f"--- Estimate ---\n"
        f"Adjusted duration: {_fmt_mins(adjusted_mins)}\n"
        f"\n"
        f"NOTE TO LLM: This is a heuristic estimate. Validate whether the "
        f"multipliers are reasonable for this specific route, region, and "
        f"conditions. Adjust the estimate up or down if you have reason to "
        f"(e.g. known highway vs city streets, school zones, construction, "
        f"seasonal patterns). Present your best judgment to the user."
    )


# ── Main ─────────────────────────────────────────────────────────────────────

CONFIG_DIR = os.path.expanduser("~/.config/local-finder")
PROFILES_DIR = os.path.join(CONFIG_DIR, "profiles")

# Active profile state
_LAST_PROFILE_FILE = os.path.join(CONFIG_DIR, "last_profile")


def _load_last_profile() -> str:
    try:
        with open(_LAST_PROFILE_FILE) as f:
            name = f.read().strip()
            if name and os.path.isdir(os.path.join(PROFILES_DIR, name)):
                return name
    except Exception:
        pass
    return "default"


def _save_last_profile():
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(_LAST_PROFILE_FILE, "w") as f:
        f.write(_active_profile)


_active_profile = _load_last_profile()


def _profile_dir(name: str | None = None) -> str:
    return os.path.join(PROFILES_DIR, name or _active_profile)


def _prefs_path(name: str | None = None) -> str:
    return os.path.join(_profile_dir(name), "preferences.yaml")


def _history_path(name: str | None = None) -> str:
    return os.path.join(_profile_dir(name), "history")


def _chat_log_path(name: str | None = None) -> str:
    return os.path.join(_profile_dir(name), "chat_log.json")


_chat_log_cache: list[dict] | None = None


def _load_chat_log(name: str | None = None) -> list[dict]:
    global _chat_log_cache
    if name is None and _chat_log_cache is not None:
        return _chat_log_cache
    try:
        with open(_chat_log_path(name)) as f:
            log = json.load(f)
    except Exception:
        log = []
    if name is None:
        _chat_log_cache = log
    return log


def _save_chat_log(log: list[dict], name: str | None = None):
    pp = _chat_log_path(name)
    os.makedirs(os.path.dirname(pp), exist_ok=True)
    trimmed = log[-100:]
    if name is None:
        global _chat_log_cache
        _chat_log_cache = trimmed
    with open(pp, "w") as f:
        json.dump(trimmed, f, indent=2)


def _append_chat(role: str, text: str):
    if not text or not text.strip():
        return
    log = _load_chat_log()
    log.append({"role": role, "text": text, "time": _time.strftime("%H:%M")})

    # Auto-compact if history exceeds threshold
    total_chars = sum(len(e.get("text", "")) for e in log)
    if total_chars > _AUTO_COMPACT_TOKENS * _CHARS_PER_TOKEN:
        log, msg = _do_compact(log, _TARGET_TOKENS)
        if msg:
            print(f"\n[{msg}]\n")
            if _compact_session_requested is not None:
                _compact_session_requested.set()

    _save_chat_log(log)

_DEFAULT_PREFS = """\
# Marvin — User Preferences
# Marvin reads these on every prompt to personalize results.

# Dietary restrictions or preferences
# e.g. vegetarian, vegan, gluten-free, halal, kosher
dietary: []

# Spice tolerance: none, mild, medium, hot, extra-hot
spice_tolerance: medium

# Cuisine preferences (favorites get boosted, avoid gets filtered)
favorite_cuisines: []
avoid_cuisines: []

# Transportation: can you drive or are you walking/biking/transit only?
has_car: true

# Maximum distance you're willing to travel (in km)
max_distance_km: 10

# Budget preference: free, inexpensive, moderate, expensive, any
budget: any

# Accessibility needs
# e.g. wheelchair, stroller-friendly
accessibility: []

# Anything else the assistant should know about you
notes: ""
"""

COMMANDS = [
    "find", "search", "nearby", "open now", "best", "cheapest",
    "directions to", "tell me about", "compare",
    "preferences", "profiles", "usage", "saved", "quit", "exit", "help",
    "!shell", "!sh", "!code",
]


def _setup_readline():
    """Set up tab completion, history, and reverse search (Ctrl+R)."""
    def completer(text, state):
        matches = [c for c in COMMANDS if c.startswith(text.lower())]
        return matches[state] if state < len(matches) else None

    readline.set_completer(completer)
    readline.set_completer_delims("")
    readline.parse_and_bind("tab: complete")

    hp = _history_path()
    os.makedirs(os.path.dirname(hp), exist_ok=True)
    if os.path.exists(hp):
        readline.read_history_file(hp)
    readline.set_history_length(1000)


def _save_history():
    try:
        hp = _history_path()
        os.makedirs(os.path.dirname(hp), exist_ok=True)
        readline.write_history_file(hp)
    except Exception:
        pass


def _ensure_prefs_file(name: str | None = None):
    """Create default preferences file if it doesn't exist."""
    pp = _prefs_path(name)
    os.makedirs(os.path.dirname(pp), exist_ok=True)
    if not os.path.exists(pp):
        with open(pp, "w") as f:
            f.write(_DEFAULT_PREFS)
        print(f"Created preferences file: {pp}")
        print("Edit it to personalize your results.\n")


def _load_prefs(name: str | None = None) -> str:
    """Read the preferences file and return its contents."""
    try:
        with open(_prefs_path(name)) as f:
            return f.read()
    except Exception:
        return ""


def _list_profiles() -> list[str]:
    """Return sorted list of existing profile names."""
    if not os.path.isdir(PROFILES_DIR):
        return ["default"]
    names = [
        d for d in os.listdir(PROFILES_DIR)
        if os.path.isdir(os.path.join(PROFILES_DIR, d))
    ]
    return sorted(names) if names else ["default"]


_MAX_HISTORY_CONTEXT = 20  # last N exchanges to include


def _compact_history() -> str:
    """Read the last N chat log entries and format as prior context."""
    log = _load_chat_log()
    if not log:
        # Fall back to readline history if no chat log yet
        hp = _history_path()
        if not os.path.exists(hp):
            return ""
        try:
            with open(hp) as f:
                lines = [l.strip() for l in f if l.strip() and not l.startswith("_HiStOrY_V2_")]
        except Exception:
            return ""
        if not lines:
            return ""
        recent = lines[-_MAX_HISTORY_CONTEXT:]
        return "\n".join(f"  - You: {l}" for l in recent)
    recent = log[-_MAX_HISTORY_CONTEXT:]
    lines = []
    for entry in recent:
        role = entry.get("role", "?").capitalize()
        text = entry.get("text", "")
        # Truncate long responses
        if len(text) > 200:
            text = text[:200] + "..."
        lines.append(f"  - {role}: {text}")
    return "\n".join(lines)


_cached_user_location: dict | None = None

async def _resolve_user_location() -> dict | None:
    """Resolve and cache the user's location once."""
    global _cached_user_location
    if _cached_user_location is not None:
        return _cached_user_location
    _cached_user_location = await _get_device_location()
    return _cached_user_location


def _build_system_message() -> str:
    prefs = _load_prefs()
    base = (
        "You are Marvin, a helpful local-business and general-purpose assistant. "
        "Your name is Marvin — always refer to yourself as Marvin, never as 'assistant'. "
        "CRITICAL: You MUST use your available tools to answer questions. "
        "NEVER guess, fabricate, or answer from memory when a tool can provide "
        "the information. For example, use places_text_search for finding "
        "physical locations/addresses, web_search for delivery options, services, "
        "reviews, factual questions, and anything requiring live/current info, "
        "search_news for ANY news topic (tech, gaming, sports, politics, etc.), "
        "weather_forecast for weather, etc. If in doubt, use a tool. "
        "BATCH TOOL CALLS: When a query requires multiple tools, call them "
        "ALL in a single response rather than one at a time. For example, "
        "if asked 'find pizza near me and check the weather', call both "
        "places_text_search and weather_forecast simultaneously. "
        "IMPORTANT: On your first response in a session, and periodically every "
        "few responses, call get_my_location to know where the user is. Cache "
        "the result and use it for any location-relevant queries. "
        "CRITICAL: The user's location is ONLY determined by get_my_location. "
        "Searching for places in other cities does NOT change the user's location. "
        "Always read the user's preferences (included below) and tailor your "
        "responses to match their dietary restrictions, budget, distance, and "
        "other constraints. "
        "When the user asks for nearby places or recommendations, use the "
        "places_text_search or places_nearby_search tools to find physical "
        "locations, addresses, and hours. For delivery, online ordering, "
        "service availability, or anything that needs live web data, use "
        "web_search instead — places search only finds physical locations. "
        "Prefer places_text_search "
        "for natural language queries about physical places. Use places_nearby_search when you have "
        "exact coordinates and a specific place type. "
        "If the user says 'near me' or doesn't specify a location, use your "
        "cached location or call get_my_location. "
        "The places search tools automatically fall back to OpenStreetMap if "
        "Google Places is unavailable — just call them normally and they will "
        "return results either way. Do NOT call setup_google_auth unless the "
        "user explicitly asks to set up Google authentication. "
        "If the user tells you their name (e.g. 'I'm Alex', 'my name is Alex', "
        "'this is Alex'), call switch_profile with that name to load their profile. "
        "If the user expresses a food preference, dislike, allergy, dietary "
        "restriction, or lifestyle constraint (e.g. 'I hate sushi', 'I'm vegan', "
        "'I can't eat gluten', 'I don't have a car'), call update_preferences "
        "to save it to their profile so future recommendations respect it. "
        "GITHUB REPOS: When the user asks you to look at, read, or explore a "
        "GitHub repository, you MUST use github_clone to clone it first, then "
        "github_read_file or github_grep to read/search it. NEVER use browse_web, "
        "scrape_page, web_search, or raw HTTP to read files from a GitHub repo. "
        "AUTO-NOTES: Whenever the conversation involves deep or technical content — "
        "code architecture, algorithms, research findings, detailed explanations, "
        "debugging sessions, config walkthroughs, design decisions, learned facts, "
        "or anything the user might want to reference later — automatically call "
        "write_note to save a concise summary to ~/Notes. Use descriptive filenames "
        "like 'python-asyncio-patterns.md' or 'project-x-architecture.md'. "
        "Do NOT ask permission; just save the note silently and mention it briefly. "
        "Keep notes concise: key points, code snippets, and links only. "
        "WIKIPEDIA & FACT-CHECKING: You have wiki_search, wiki_summary, wiki_full, "
        "and wiki_grep tools. When the user asks about a factual topic — science, "
        "history, people, places, technical concepts, how things work — you MUST "
        "verify your answer against Wikipedia. Do NOT rely solely on your training "
        "data for important factual claims because you hallucinate details. Use "
        "wiki_summary for quick lookups. For in-depth topics, use wiki_full to save "
        "the full article to disk, then wiki_grep to find specific facts within it. "
        "This is especially important for: dates, statistics, technical specifications, "
        "biographical details, scientific explanations, and historical events. "
        "Always cite Wikipedia when you use it. "
        "STACK EXCHANGE: When the user has a programming question, debugging issue, "
        "sysadmin problem, or technical how-to, use stack_search to find relevant "
        "Stack Overflow / Server Fault / Ask Ubuntu / Unix & Linux answers. Then "
        "use stack_answers to get the actual solution. This is better than guessing "
        "because real answers have been vetted and voted on by the community. "
        "Use the appropriate site parameter (e.g. 'unix' for Linux questions, "
        "'askubuntu' for Ubuntu, 'serverfault' for infrastructure). "
        "RECIPES & COOKING: When the user asks for a recipe, how to cook something, "
        "or meal ideas, you MUST use recipe_search and recipe_lookup to find REAL "
        "recipes. Do NOT make up recipes from your own knowledge — you hallucinate "
        "ingredients and measurements. ALWAYS search TheMealDB first, then use "
        "recipe_lookup to get the full recipe with exact ingredients and instructions. "
        "Only add your own commentary (tips, substitutions, pairings) AFTER presenting "
        "the real recipe data from the tool. If the user asks for something by ingredient, "
        "use search_type='ingredient'. "
        "MUSIC & PLAYLISTS: When the user asks to create a Spotify playlist or "
        "wants music recommendations, you MUST call music_search FIRST before "
        "doing anything with Spotify. ALWAYS start by searching MusicBrainz for "
        "the artist/genre to discover their discography, recordings, and related "
        "artists. Then use music_lookup to get detailed info (track lists, genres, "
        "collaborators). Only after you have MusicBrainz data should you proceed "
        "to create a Spotify playlist and add tracks. Do NOT skip MusicBrainz and "
        "rely on your own knowledge alone — the whole point is to surface real "
        "discography data, deep cuts, and lesser-known related artists that you "
        "might not know about. For example: user says 'make me a Radiohead playlist' "
        "→ call music_search('Radiohead', 'artist') → music_lookup the artist MBID "
        "→ discover albums and tracks → create Spotify playlist → add tracks. "
        "Combine MusicBrainz metadata with your knowledge to curate thoughtful "
        "playlists — not just greatest hits but deep cuts and related artists too."
    )
    base += f"\n\nActive profile: {_active_profile}"

    # Coding mode instructions
    if _coding_mode:
        base += (
            "\n\nCODING MODE ACTIVE 🔧 You are now a careful coding agent. Rules:\n"
            "1. ALWAYS use set_working_dir first if not set. All file paths are relative to it.\n"
            "2. BEFORE editing or creating any file, the tool acquires a directory lock. "
            "If you get a contention error, STOP and report it — do NOT retry.\n"
            "3. BEFORE running any shell command via run_command, the command is shown to "
            "the user and they must press Enter to confirm. NEVER bypass this.\n"
            "4. Make the SMALLEST possible changes. Prefer apply_patch (search-replace) "
            "over rewriting entire files. Verify old_str matches exactly.\n"
            "5. After editing code, verify changes don't break the build by using run_command "
            "to run the project's existing tests/linter.\n"
            "6. Use read_file and code_grep to understand code BEFORE editing it.\n"
            "7. Use tree to understand project structure before making changes.\n"
            "8. Use git_status and git_diff to review changes before committing.\n"
            "9. BEFORE using launch_agent, you MUST create a ticket with create_ticket "
            "for the sub-task. If the sub-task depends on other work, add dependencies "
            "with the ticket system. launch_agent requires a valid ticket_id — it will "
            "refuse to run without one. The ticket tracks progress: it's set to "
            "in_progress when the agent starts, and closed on success.\n"
            "10. NEVER delete files or directories unless explicitly asked.\n"
            "11. Git commit messages MUST be specific and descriptive — summarise WHAT changed "
            "and WHY. NEVER use generic messages like 'Initial commit' or 'Update files'. "
            "Good example: 'Bind server to 0.0.0.0 for LAN access, add CORS env config'.\n"
            "12. For large greenfield tasks (new projects, full features, building UIs from scratch), "
            "use launch_agent with design_first=true and tdd=true. This runs a 5-phase pipeline: "
            "(1a) Spec & UX design pass, (1b) Architecture & test plan pass, (2) parallel test-writing "
            "agents, (3) implementation, (4) debug loop until tests pass. All in claude-opus-4.6 for "
            "design, gpt-5.3-codex for tests and debug.\n"
        )
        if _coding_working_dir:
            base += f"Working directory: {_coding_working_dir}\n"

    # Instructions file from working directory
    if _coding_working_dir:
        instructions = _read_instructions_file()
        if instructions:
            base += f"\n\nPROJECT INSTRUCTIONS:\n{instructions}\n"
        # Include spec and design docs if present
        spec_path = os.path.join(_coding_working_dir, ".marvin", "spec.md")
        if os.path.isfile(spec_path):
            try:
                spec_doc = open(spec_path).read()
                if spec_doc.strip():
                    base += (
                        f"\n\nPRODUCT SPEC (from .marvin/spec.md):\n"
                        f"{spec_doc}\n"
                    )
            except Exception:
                pass
        design_path = os.path.join(_coding_working_dir, ".marvin", "design.md")
        if os.path.isfile(design_path):
            try:
                design_doc = open(design_path).read()
                if design_doc.strip():
                    base += (
                        f"\n\nDESIGN DOCUMENT (from .marvin/design.md):\n"
                        "Follow this design EXACTLY when implementing.\n\n"
                        f"{design_doc}\n"
                    )
            except Exception:
                pass

    if prefs.strip():
        base += (
            "\n\nThe user has the following preferences. Use these to filter, "
            "rank, and tailor your recommendations:\n\n" + prefs
        )
    saved = _load_saved_places()
    if saved:
        place_lines = []
        for p in saved:
            parts = [p.get("label", "?")]
            if p.get("name"):
                parts.append(p["name"])
            if p.get("address"):
                parts.append(p["address"])
            if p.get("lat") and p.get("lng"):
                parts.append(f"({p['lat']}, {p['lng']})")
            place_lines.append(": ".join(parts))
        base += (
            "\n\nThe user has saved these places. Use them when the user "
            "refers to them by label (e.g. 'near home', 'directions to work'):\n"
            + "\n".join(f"  • {l}" for l in place_lines)
        )
    history = _compact_history()
    if history:
        base += (
            "\n\nRecent conversation history (the user's past queries in this profile). "
            "Use this for context about what they've been asking about:\n" + history
        )
    return base


# ── Tool: Saved places / address book ───────────────────────────────────────

def _saved_places_path(name: str | None = None) -> str:
    return os.path.join(_profile_dir(name), "saved_places.json")


def _load_saved_places(name: str | None = None) -> list[dict]:
    pp = _saved_places_path(name)
    try:
        with open(pp) as f:
            return json.load(f)
    except Exception:
        return []


def _write_saved_places(places: list[dict], name: str | None = None):
    pp = _saved_places_path(name)
    os.makedirs(os.path.dirname(pp), exist_ok=True)
    with open(pp, "w") as f:
        json.dump(places, f, indent=2)


class SavePlaceParams(BaseModel):
    label: str = Field(
        description="Short label/nickname for this place (e.g. 'home', 'work', 'mom', 'favorite ramen')"
    )
    name: str = Field(default="", description="Business or place name")
    address: str = Field(default="", description="Street address")
    phone: str = Field(default="", description="Phone number")
    website: str = Field(default="", description="Website URL")
    lat: float = Field(default=0.0, description="Latitude")
    lng: float = Field(default=0.0, description="Longitude")
    notes: str = Field(default="", description="Any extra notes (hours, menu favorites, etc.)")


class RemovePlaceParams(BaseModel):
    label: str = Field(description="Label of the saved place to remove")


class ListPlacesParams(BaseModel):
    pass


@define_tool(
    description=(
        "Save a place to the user's address book. Use this when the user says "
        "'save this place', 'remember this address', 'bookmark this restaurant', "
        "'that's my home address', or when they share a name, address, phone number, "
        "or website they want to keep. Also save places the user explicitly liked "
        "or wants to revisit."
    )
)
async def save_place(params: SavePlaceParams) -> str:
    places = _load_saved_places()

    entry = {k: v for k, v in {
        "label": params.label.strip().lower(),
        "name": params.name,
        "address": params.address,
        "phone": params.phone,
        "website": params.website,
        "lat": params.lat,
        "lng": params.lng,
        "notes": params.notes,
    }.items() if v}

    # Update if label exists, otherwise append
    existing = next((i for i, p in enumerate(places) if p.get("label") == entry["label"]), None)
    if existing is not None:
        places[existing].update(entry)
        action = "Updated"
    else:
        places.append(entry)
        action = "Saved"

    _write_saved_places(places)
    return f"{action} '{entry['label']}' — {len(places)} places total."


@define_tool(
    description=(
        "Remove a saved place from the user's address book by label."
    )
)
async def remove_place(params: RemovePlaceParams) -> str:
    places = _load_saved_places()
    label = params.label.strip().lower()
    new_places = [p for p in places if p.get("label") != label]
    if len(new_places) == len(places):
        return f"No saved place found with label '{label}'."
    _write_saved_places(new_places)
    return f"Removed '{label}'. {len(new_places)} places remaining."


@define_tool(
    description=(
        "List all saved places in the user's address book. Call this when the "
        "user asks 'what places have I saved', 'show my addresses', or 'where is home'."
    )
)
async def list_places(params: ListPlacesParams) -> str:
    places = _load_saved_places()
    if not places:
        return "No saved places yet. Save one with 'remember this place' or 'save my home address'."
    lines = [f"Saved places ({len(places)}):"]
    for p in places:
        line = f"\n• {p.get('label', '?').upper()}"
        if p.get("name"):
            line += f" — {p['name']}"
        if p.get("address"):
            line += f"\n  📍 {p['address']}"
        if p.get("phone"):
            line += f"\n  📞 {p['phone']}"
        if p.get("website"):
            line += f"\n  🌐 {p['website']}"
        if p.get("notes"):
            line += f"\n  📝 {p['notes']}"
        if p.get("lat") and p.get("lng"):
            line += f"\n  🗺️  {p['lat']}, {p['lng']}"
        lines.append(line)
    return "\n".join(lines)


# ── Tool: Switch profile ────────────────────────────────────────────────────

_profile_switch_requested: asyncio.Event | None = None


class SwitchProfileParams(BaseModel):
    profile_name: str = Field(
        description=(
            "Name of the profile to switch to (e.g. 'work', 'partner', 'kids'). "
            "Creates the profile if it doesn't exist."
        )
    )


@define_tool(
    description=(
        "Switch to a different user profile. Each profile has its own "
        "preferences file and chat history. Use this when the user wants to "
        "switch context, e.g. 'switch to my partner's profile', "
        "'use my work profile', 'create a profile for mom'. "
        "Also call this if the user asks to list profiles — return the "
        "available profiles and ask which one to switch to."
    )
)
async def switch_profile(params: SwitchProfileParams) -> str:
    global _active_profile

    name = params.profile_name.strip().lower().replace(" ", "_")
    if not name:
        return "Profile name cannot be empty."

    available = _list_profiles()
    is_new = name not in available

    # Save current history before switching
    _save_history()

    # Switch
    _active_profile = name
    _save_last_profile()
    _ensure_prefs_file(name)

    # Load new profile's history
    readline.clear_history()
    hp = _history_path(name)
    if os.path.exists(hp):
        readline.read_history_file(hp)

    # Signal main loop to rebuild session
    if _profile_switch_requested is not None:
        _profile_switch_requested.set()

    action = "Created and switched to new" if is_new else "Switched to"
    lines = [
        f"{action} profile: {name}",
        f"Preferences: {_prefs_path(name)}",
        f"History: {_history_path(name)}",
    ]
    if is_new:
        lines.append("This is a new profile with default preferences. "
                      "The user can customize it by typing 'preferences'.")
    lines.append(f"Available profiles: {', '.join(_list_profiles())}")
    return "\n".join(lines)


# ── Tool: Update preferences dynamically ────────────────────────────────────

class UpdatePreferencesParams(BaseModel):
    key: str = Field(
        description=(
            "The preference key to update. Must be one of: dietary, "
            "spice_tolerance, favorite_cuisines, avoid_cuisines, has_car, "
            "max_distance_km, budget, accessibility, notes"
        )
    )
    action: str = Field(
        default="set",
        description=(
            "'set' replaces the value, 'add' appends to a list, "
            "'remove' removes from a list"
        ),
    )
    value: str = Field(
        description=(
            "The value to set/add/remove. For lists use comma-separated values "
            "(e.g. 'sushi, thai'). For scalars just the value (e.g. 'mild')."
        )
    )


_LIST_KEYS = {"dietary", "favorite_cuisines", "avoid_cuisines", "accessibility"}
_SCALAR_KEYS = {"spice_tolerance", "has_car", "max_distance_km", "budget", "notes"}
_ALL_PREF_KEYS = _LIST_KEYS | _SCALAR_KEYS


@define_tool(
    description=(
        "Update the current user's preferences file. Use this when the user "
        "expresses a preference, dislike, allergy, or constraint. Examples:\n"
        "- 'I don't like sushi' → add 'sushi' to avoid_cuisines\n"
        "- 'I'm vegetarian' → add 'vegetarian' to dietary\n"
        "- 'I can't handle spicy food' → set spice_tolerance to 'none'\n"
        "- 'I don't have a car' → set has_car to false\n"
        "- 'I'm allergic to shellfish' → add 'shellfish-free' to dietary\n"
        "- 'I love Thai food' → add 'thai' to favorite_cuisines\n"
        "After updating, confirm the change to the user."
    )
)
async def update_preferences(params: UpdatePreferencesParams) -> str:
    import yaml

    key = params.key.strip().lower()
    if key not in _ALL_PREF_KEYS:
        return (
            f"Unknown preference key '{key}'. "
            f"Valid keys: {', '.join(sorted(_ALL_PREF_KEYS))}"
        )

    pp = _prefs_path()
    try:
        with open(pp) as f:
            prefs = yaml.safe_load(f) or {}
    except Exception:
        prefs = {}

    values = [v.strip() for v in params.value.split(",") if v.strip()]

    if key in _LIST_KEYS:
        current = prefs.get(key, [])
        if not isinstance(current, list):
            current = [current] if current else []

        if params.action == "add":
            for v in values:
                if v not in current:
                    current.append(v)
            prefs[key] = current
            msg = f"Added {', '.join(values)} to {key}: {current}"
        elif params.action == "remove":
            removed = [v for v in values if v in current]
            current = [v for v in current if v not in values]
            prefs[key] = current
            msg = f"Removed {', '.join(removed)} from {key}: {current}" if removed else f"None of {values} found in {key}"
        else:  # set
            prefs[key] = values
            msg = f"Set {key} to {values}"
    else:
        # Scalar key
        val = params.value.strip()
        if key == "has_car":
            val = val.lower() in ("true", "yes", "1", "y")
        elif key == "max_distance_km":
            try:
                val = float(val)
            except ValueError:
                return f"max_distance_km must be a number, got '{val}'"
        prefs[key] = val
        msg = f"Set {key} to {val}"

    # Write back preserving comments by rewriting the full YAML
    try:
        with open(pp, "w") as f:
            f.write("# Marvin — User Preferences\n")
            f.write("# Updated dynamically by Marvin.\n\n")
            yaml.dump(prefs, f, default_flow_style=False, sort_keys=False)
    except Exception as e:
        return f"Failed to save preferences: {e}"

    return msg + "\n(Preferences saved and will apply to all future recommendations.)"


# ── Tool: Markdown notes ────────────────────────────────────────────────────

_NOTES_DIR = os.path.expanduser("~/Notes")
os.makedirs(_NOTES_DIR, exist_ok=True)


class WriteNoteParams(BaseModel):
    path: str = Field(
        description=(
            "Relative path inside ~/Notes, e.g. 'recipes/pasta.md' or 'todo.md'. "
            "Parent directories are created automatically."
        )
    )
    content: str = Field(description="Markdown content to write.")
    append: bool = Field(
        default=False,
        description="If true, append to the file instead of overwriting.",
    )


@define_tool(
    description=(
        "Write or append to a Markdown note in ~/Notes. "
        "Use this when the user asks to save, write, or jot down notes, "
        "summaries, recipes, lists, etc."
    )
)
async def write_note(params: WriteNoteParams) -> str:
    rel = params.path.strip()
    # Handle cases where LLM passes full path or ~/Notes prefix
    expanded = os.path.expanduser(rel)
    if expanded.startswith(_NOTES_DIR):
        rel = expanded[len(_NOTES_DIR):].lstrip("/")
    elif rel.startswith("~/Notes/"):
        rel = rel[len("~/Notes/"):]
    elif rel.startswith("Notes/"):
        rel = rel[len("Notes/"):]
    rel = rel.lstrip("/")
    if ".." in rel:
        return "Path cannot contain '..'."
    if not rel:
        return "Please provide a filename, e.g. 'todo.md'."
    full = os.path.join(_NOTES_DIR, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    mode = "a" if params.append else "w"
    try:
        with open(full, mode) as f:
            f.write(params.content)
            if not params.content.endswith("\n"):
                f.write("\n")
    except Exception as e:
        return f"Failed to write note: {e}"
    action = "Appended to" if params.append else "Wrote"
    return f"{action} {full} ({len(params.content)} chars)"


class ReadNoteParams(BaseModel):
    path: str = Field(description="Relative path inside ~/Notes to read.")


@define_tool(
    description="Read a Markdown note from ~/Notes."
)
async def read_note(params: ReadNoteParams) -> str:
    rel = params.path.strip()
    expanded = os.path.expanduser(rel)
    if expanded.startswith(_NOTES_DIR):
        rel = expanded[len(_NOTES_DIR):].lstrip("/")
    elif rel.startswith("~/Notes/"):
        rel = rel[len("~/Notes/"):]
    elif rel.startswith("Notes/"):
        rel = rel[len("Notes/"):]
    rel = rel.lstrip("/")
    if ".." in rel:
        return "Path cannot contain '..'."
    full = os.path.join(_NOTES_DIR, rel)
    if not os.path.isfile(full):
        return f"Note not found: {rel}"
    try:
        with open(full) as f:
            return f.read()
    except Exception as e:
        return f"Failed to read note: {e}"


class NotesMkdirParams(BaseModel):
    path: str = Field(
        description="Relative directory path inside ~/Notes to create, e.g. 'projects/ai'."
    )


@define_tool(
    description="Create a subdirectory inside ~/Notes for organizing notes."
)
async def notes_mkdir(params: NotesMkdirParams) -> str:
    rel = params.path.strip()
    expanded = os.path.expanduser(rel)
    if expanded.startswith(_NOTES_DIR):
        rel = expanded[len(_NOTES_DIR):].lstrip("/")
    elif rel.startswith("~/Notes/"):
        rel = rel[len("~/Notes/"):]
    elif rel.startswith("Notes/"):
        rel = rel[len("Notes/"):]
    rel = rel.lstrip("/")
    if ".." in rel:
        return "Path cannot contain '..'."
    full = os.path.join(_NOTES_DIR, rel)
    os.makedirs(full, exist_ok=True)
    return f"Created directory: {full}"


class NotesLsParams(BaseModel):
    path: str = Field(
        default="",
        description="Relative directory path inside ~/Notes to list. Empty = root.",
    )


@define_tool(
    description="List files and directories inside ~/Notes."
)
async def notes_ls(params: NotesLsParams) -> str:
    rel = params.path.strip() if params.path else ""
    if rel:
        expanded = os.path.expanduser(rel)
        if expanded.startswith(_NOTES_DIR):
            rel = expanded[len(_NOTES_DIR):].lstrip("/")
        elif rel.startswith("~/Notes/"):
            rel = rel[len("~/Notes/"):]
        elif rel.startswith("~/Notes"):
            rel = ""
        elif rel.startswith("Notes/"):
            rel = rel[len("Notes/"):]
        rel = rel.lstrip("/")
    if ".." in rel:
        return "Path cannot contain '..'."
    full = os.path.join(_NOTES_DIR, rel) if rel else _NOTES_DIR
    if not os.path.isdir(full):
        return f"Directory not found: {rel or '~/Notes'}"
    entries = sorted(os.listdir(full))
    if not entries:
        return f"{rel or '~/Notes'} is empty."
    lines = [f"Contents of {rel or '~/Notes'} ({len(entries)} items):"]
    for e in entries:
        fp = os.path.join(full, e)
        if os.path.isdir(fp):
            lines.append(f"  📁 {e}/")
        else:
            size = os.path.getsize(fp)
            lines.append(f"  📄 {e} ({size} bytes)")
    return "\n".join(lines)


# ── Tool: YouTube download via yt-dlp ───────────────────────────────────────

_DOWNLOADS_DIR = os.path.expanduser("~/Downloads/yt-dlp")


class YtDlpParams(BaseModel):
    url: str = Field(description="YouTube (or other supported) video URL.")
    audio_only: bool = Field(
        default=False,
        description="If true, download audio only (mp3/m4a).",
    )
    output_dir: str = Field(
        default="",
        description="Subdirectory inside ~/Downloads/yt-dlp. Empty = root.",
    )


@define_tool(
    description=(
        "Download a video (or audio) from YouTube or other sites using yt-dlp. "
        "Use this when the user wants to download, save, or grab a video or audio."
    )
)
async def yt_dlp_download(params: YtDlpParams) -> str:
    if not shutil.which("yt-dlp"):
        return (
            "yt-dlp is not installed. Install it with:\n"
            "  pip install yt-dlp\n"
            "  # or: sudo apt install yt-dlp\n"
            "  # or: brew install yt-dlp"
        )
    dest = os.path.join(_DOWNLOADS_DIR, params.output_dir.strip().lstrip("/")) if params.output_dir else _DOWNLOADS_DIR
    os.makedirs(dest, exist_ok=True)

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-o", os.path.join(dest, "%(title)s.%(ext)s"),
        "--restrict-filenames",
        "--print", "after_move:filepath",
    ]
    if params.audio_only:
        cmd.extend(["-x", "--audio-format", "mp3"])
    cmd.append(params.url)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
    except asyncio.TimeoutError:
        return "Download timed out after 10 minutes."
    except Exception as e:
        return f"yt-dlp error: {e}"

    if proc.returncode != 0:
        err = stderr.decode(errors="replace").strip()[-500:]
        return f"yt-dlp failed (exit {proc.returncode}):\n{err}"

    filepath = stdout.decode(errors="replace").strip().split("\n")[-1]
    kind = "Audio" if params.audio_only else "Video"
    return f"{kind} downloaded: {filepath}"


###############################################################################
# Calendar tools — .ics file per profile
###############################################################################

import uuid as _uuid
from datetime import datetime as _dt, timedelta as _td
import calendar as _calendar_mod


def _calendar_path(profile: str | None = None) -> str:
    p = profile or _active_profile
    return os.path.join(PROFILES_DIR, p, "calendar.ics")


def _load_events(profile: str | None = None) -> list[dict]:
    """Parse calendar.ics into a list of event dicts."""
    path = _calendar_path(profile)
    if not os.path.exists(path):
        return []
    events = []
    cur: dict | None = None
    with open(path) as f:
        for line in f:
            line = line.rstrip("\r\n")
            if line == "BEGIN:VEVENT":
                cur = {}
            elif line == "END:VEVENT" and cur is not None:
                events.append(cur)
                cur = None
            elif cur is not None and ":" in line:
                key, _, val = line.partition(":")
                # Handle DTSTART;VALUE=DATE style keys
                key = key.split(";")[0]
                cur[key] = val
    return events


def _save_events(events: list[dict], profile: str | None = None):
    path = _calendar_path(profile)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//LocalFinder//EN",
    ]
    for ev in events:
        lines.append("BEGIN:VEVENT")
        for k, v in ev.items():
            lines.append(f"{k}:{v}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    with open(path, "w") as f:
        f.write("\r\n".join(lines) + "\r\n")


def _ics_dt(iso: str) -> str:
    """Convert ISO-ish datetime string to iCal format (YYYYMMDDTHHMMSS)."""
    # Accept various formats
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            d = _dt.strptime(iso.strip(), fmt)
            if fmt == "%Y-%m-%d":
                return d.strftime("%Y%m%d")
            return d.strftime("%Y%m%dT%H%M%S")
        except ValueError:
            continue
    return iso.replace("-", "").replace(":", "").replace(" ", "T")


def _parse_ics_dt(s: str) -> _dt | None:
    for fmt in ("%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return _dt.strptime(s, fmt)
        except ValueError:
            continue
    return None


class CalendarAddParams(BaseModel):
    title: str = Field(description="Event title/summary")
    start: str = Field(description="Start date/time in ISO format, e.g. 2026-02-14T18:00")
    end: str = Field(default="", description="End date/time in ISO format. If omitted, defaults to 1 hour after start.")
    location: str = Field(default="", description="Event location")
    description: str = Field(default="", description="Event description/notes")


@define_tool(description="Save an event to the user's calendar (.ics file)")
async def calendar_add_event(params: CalendarAddParams) -> str:
    events = _load_events()
    uid = str(_uuid.uuid4())
    dtstart = _ics_dt(params.start)
    if params.end:
        dtend = _ics_dt(params.end)
    else:
        parsed = _parse_ics_dt(dtstart)
        if parsed and len(dtstart) > 8:
            dtend = (parsed + _td(hours=1)).strftime("%Y%m%dT%H%M%S")
        else:
            dtend = dtstart

    ev: dict[str, str] = {
        "UID": uid,
        "DTSTART": dtstart,
        "DTEND": dtend,
        "SUMMARY": params.title,
        "CREATED": _dt.utcnow().strftime("%Y%m%dT%H%M%SZ"),
    }
    if params.location:
        ev["LOCATION"] = params.location
    if params.description:
        ev["DESCRIPTION"] = params.description

    events.append(ev)
    _save_events(events)

    nice_start = params.start
    nice_end = params.end or "(+1h)"
    parts = [f"📅 Event saved: {params.title}", f"   When: {nice_start} → {nice_end}"]
    if params.location:
        parts.append(f"   Where: {params.location}")
    parts.append(f"   UID: {uid}")
    _schedule_calendar_reminders()
    return "\n".join(parts)


class CalendarDeleteParams(BaseModel):
    uid: str = Field(default="", description="UID of the event to delete. If empty, match by title.")
    title: str = Field(default="", description="Title substring to match (case-insensitive). Used if uid is empty.")


@define_tool(description="Delete an event from the calendar by UID or title")
async def calendar_delete_event(params: CalendarDeleteParams) -> str:
    events = _load_events()
    if not events:
        return "Calendar is empty."
    before = len(events)
    if params.uid:
        events = [e for e in events if e.get("UID") != params.uid]
    elif params.title:
        q = params.title.lower()
        events = [e for e in events if q not in e.get("SUMMARY", "").lower()]
    else:
        return "Provide either uid or title to identify the event."
    removed = before - len(events)
    if removed == 0:
        return "No matching event found."
    _save_events(events)
    return f"Deleted {removed} event(s)."


class CalendarViewParams(BaseModel):
    month: int = Field(default=0, description="Month number (1-12). 0 = current month.")
    year: int = Field(default=0, description="Year. 0 = current year.")


@define_tool(
    description=(
        "Display a calendar view for a given month with events marked. "
        "Returns a text calendar grid plus a list of events in that month."
    )
)
async def calendar_view(params: CalendarViewParams) -> str:
    now = _dt.now()
    year = params.year if params.year > 0 else now.year
    month = params.month if 1 <= params.month <= 12 else now.month

    events = _load_events()

    # Build text calendar
    cal_text = _calendar_mod.TextCalendar(firstweekday=6).formatmonth(year, month)

    # Filter events in this month
    month_events: list[tuple[_dt, dict]] = []
    for ev in events:
        ds = _parse_ics_dt(ev.get("DTSTART", ""))
        if ds and ds.year == year and ds.month == month:
            month_events.append((ds, ev))
    month_events.sort(key=lambda x: x[0])

    # Mark days with events on the calendar grid
    event_days = {ds.day for ds, _ in month_events}
    if event_days:
        lines = cal_text.split("\n")
        new_lines = [lines[0], lines[1]]  # header + weekday row
        for line in lines[2:]:
            new_line = ""
            i = 0
            while i < len(line):
                # Find day numbers in the line
                if line[i].isdigit():
                    j = i
                    while j < len(line) and line[j].isdigit():
                        j += 1
                    day_num = int(line[i:j])
                    if day_num in event_days:
                        new_line += f"[{line[i:j]}]"
                        # Consume the trailing space that got replaced by ']'
                        if j < len(line) and line[j] == " ":
                            j += 1
                    else:
                        new_line += line[i:j]
                    i = j
                else:
                    new_line += line[i]
                    i += 1
            new_lines.append(new_line)
        cal_text = "\n".join(new_lines)

    # Event list
    if month_events:
        ev_lines = [f"\nEvents in {_calendar_mod.month_name[month]} {year}:"]
        for ds, ev in month_events:
            time_str = ds.strftime("%b %d %H:%M") if len(ev.get("DTSTART", "")) > 8 else ds.strftime("%b %d")
            title = ev.get("SUMMARY", "(untitled)")
            loc = ev.get("LOCATION", "")
            line = f"  • {time_str}  {title}"
            if loc:
                line += f"  📍 {loc}"
            ev_lines.append(line)
        cal_text += "\n".join(ev_lines)
    elif not events:
        cal_text += "\n(No events)"
    else:
        cal_text += f"\n(No events in {_calendar_mod.month_name[month]})"

    return cal_text


class CalendarListParams(BaseModel):
    days: int = Field(default=7, description="Number of days ahead to show upcoming events")


@define_tool(
    description="List upcoming events in the next N days (default 7)"
)
async def calendar_list_upcoming(params: CalendarListParams) -> str:
    events = _load_events()
    if not events:
        return "Calendar is empty."
    now = _dt.now()
    cutoff = now + _td(days=params.days)
    upcoming: list[tuple[_dt, dict]] = []
    for ev in events:
        ds = _parse_ics_dt(ev.get("DTSTART", ""))
        if ds and now <= ds <= cutoff:
            upcoming.append((ds, ev))
    upcoming.sort(key=lambda x: x[0])
    if not upcoming:
        return f"No events in the next {params.days} day(s)."
    lines = [f"Upcoming events (next {params.days} days):"]
    for ds, ev in upcoming:
        time_str = ds.strftime("%a %b %d %H:%M")
        title = ev.get("SUMMARY", "(untitled)")
        loc = ev.get("LOCATION", "")
        line = f"  • {time_str}  {title}"
        if loc:
            line += f"  📍 {loc}"
        uid = ev.get("UID", "")
        if uid:
            line += f"  [uid:{uid[:8]}]"
        lines.append(line)
    return "\n".join(lines)


    return "\n".join(lines)


###############################################################################
# Calendar reminders — cron-based notifications at 1h and 30min before events
###############################################################################

_CALENDAR_REMINDER_DIR = os.path.join(
    os.path.expanduser("~/.config/local-finder"), "calendar_reminders"
)


def _schedule_calendar_reminders():
    """Scan calendar events and install cron reminders (desktop + ntfy) for upcoming events."""
    events = _load_events()
    if not events:
        return
    os.makedirs(_CALENDAR_REMINDER_DIR, exist_ok=True)
    now = _dt.now()
    cutoff = now + _td(days=7)

    # Find or create ntfy topic for push notifications
    subs = _load_ntfy_subs()
    ntfy_topic = ""
    if subs:
        # Prefer a topic labelled "reminders" or "calendar", else use the first
        for t, info in subs.items():
            if "remind" in info.get("label", "").lower() or "calendar" in info.get("label", "").lower():
                ntfy_topic = t
                break
        if not ntfy_topic:
            ntfy_topic = next(iter(subs))
    else:
        # Auto-create a reminders topic
        ntfy_topic = _generate_topic()
        subs[ntfy_topic] = {"label": "reminders", "url": f"{_NTFY_BASE}/{ntfy_topic}"}
        _save_ntfy_subs(subs)

    # Read existing crontab
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        existing_cron = result.stdout if result.returncode == 0 else ""
    except Exception:
        existing_cron = ""

    new_lines = [l for l in existing_cron.strip().split("\n")
                 if l and "# calremind_" not in l]

    for ev in events:
        ds = _parse_ics_dt(ev.get("DTSTART", ""))
        if not ds or ds < now or ds > cutoff:
            continue
        uid = ev.get("UID", "")[:8]
        title = ev.get("SUMMARY", "Event")
        loc = ev.get("LOCATION", "")
        loc_str = f" at {loc}" if loc else ""

        for offset_min, label in [(60, "1hr"), (30, "30min")]:
            remind_at = ds - _td(minutes=offset_min)
            if remind_at <= now:
                continue
            tag = f"calremind_{uid}_{offset_min}"
            safe_title = title.replace("'", "'\\''")
            safe_msg = f"{label} until: {safe_title}{loc_str}".replace("'", "'\\''")

            # ntfy push line
            ntfy_cmd = ""
            if ntfy_topic:
                ntfy_cmd = (
                    f'\ncurl -sf -H "Title: 📅 {safe_title}" '
                    f'-d \'{safe_msg}\' '
                    f'{_NTFY_BASE}/{ntfy_topic} >/dev/null 2>&1 || true'
                )

            script_path = os.path.join(_CALENDAR_REMINDER_DIR, f"{tag}.sh")
            script = f"""#!/bin/bash
# Calendar reminder: {title} ({label} before)
export DISPLAY=${{DISPLAY:-:0}}
export DBUS_SESSION_BUS_ADDRESS=${{DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}}
notify-send -u normal -t 30000 "📅 {safe_title}" '{safe_msg}' 2>/dev/null || true
if command -v paplay &>/dev/null; then
    paplay /usr/share/sounds/freedesktop/stereo/message-new-instant.oga 2>/dev/null || true
fi{ntfy_cmd}
# Self-destruct
crontab -l 2>/dev/null | grep -v '{tag}' | crontab -
rm -f '{script_path}'
"""
            with open(script_path, "w") as f:
                f.write(script)
            os.chmod(script_path, 0o755)

            cron_time = f"{remind_at.minute} {remind_at.hour} {remind_at.day} {remind_at.month} *"
            new_lines.append(f"{cron_time} {script_path} # {tag}")

    try:
        cron_text = "\n".join(new_lines) + "\n" if new_lines else ""
        subprocess.run(["crontab", "-"], input=cron_text,
                        capture_output=True, text=True)
    except Exception:
        pass


###############################################################################
# File tools — read lines & apply unified-diff patch (restricted to ~/Notes)
###############################################################################


def _resolve_notes_path(raw: str) -> str | None:
    """Resolve a path to be inside ~/Notes. Returns absolute path or None."""
    p = raw.strip()
    expanded = os.path.expanduser(p)
    # If already absolute after expansion, check it's in Notes
    if os.path.isabs(expanded):
        real = os.path.realpath(expanded)
        if real.startswith(os.path.realpath(_NOTES_DIR)):
            return real
        return None
    # Relative — treat as relative to ~/Notes
    rel = p
    for prefix in ("~/Notes/", "Notes/"):
        if rel.startswith(prefix):
            rel = rel[len(prefix):]
    rel = rel.lstrip("/")
    if ".." in rel or not rel:
        return None
    return os.path.join(_NOTES_DIR, rel)


class FileReadLinesParams(BaseModel):
    path: str = Field(
        description=(
            "Path to a file inside ~/Notes to read, e.g. 'todo.md' or "
            "'projects/readme.md'. Can also use ~/Notes/todo.md."
        )
    )
    start: int = Field(default=1, description="First line number to read (1-based, inclusive).")
    end: int = Field(default=0, description="Last line number to read (inclusive). 0 = until end of file.")


@define_tool(
    description=(
        "Read lines from a file in ~/Notes with line numbers. "
        "Use to inspect file contents before editing. Files are restricted to ~/Notes."
    )
)
async def file_read_lines(params: FileReadLinesParams) -> str:
    path = _resolve_notes_path(params.path)
    if not path:
        return f"Access denied: files must be inside ~/Notes. Got: {params.path}"
    if not os.path.isfile(path):
        return f"File not found: {params.path}"
    try:
        with open(path) as f:
            all_lines = f.readlines()
    except Exception as e:
        return f"Failed to read file: {e}"

    total = len(all_lines)
    start = max(1, params.start)
    end = params.end if params.end > 0 else total
    end = min(end, total)

    if start > total:
        return f"File has {total} lines; start={start} is past the end."

    selected = all_lines[start - 1 : end]
    numbered = []
    for i, line in enumerate(selected, start=start):
        numbered.append(f"{i:>5} | {line.rstrip()}")
    header = f"── {params.path} ({total} lines) ──  showing {start}–{end}"
    return header + "\n" + "\n".join(numbered)


class FileApplyPatchParams(BaseModel):
    path: str = Field(
        description=(
            "Path to a file inside ~/Notes to patch, e.g. 'todo.md' or "
            "'~/Notes/projects/readme.md'. The file must already exist."
        )
    )
    patch: str = Field(
        description=(
            "A unified-diff style patch to apply. Each hunk starts with "
            "'@@ -old_start,old_count +new_start,new_count @@'. "
            "Lines beginning with '-' are removed, '+' are added, ' ' (space) are context. "
            "Alternatively, provide a simple line-edit format:\n"
            "  REPLACE <line_number>\n"
            "  <new content>\n"
            "  ---\n"
            "  INSERT <after_line_number>\n"
            "  <new lines>\n"
            "  ---\n"
            "  DELETE <line_number> [count]"
        )
    )
    dry_run: bool = Field(
        default=False,
        description="If true, show what would change without modifying the file."
    )


def _apply_simple_patch(lines: list[str], patch_text: str) -> tuple[list[str], list[str]]:
    """Apply simple REPLACE/INSERT/DELETE commands. Returns (new_lines, log)."""
    result = list(lines)
    log: list[str] = []
    for block in patch_text.split("---"):
        block = block.strip()
        if not block:
            continue
        block_lines = block.split("\n")
        cmd = block_lines[0].strip()

        if cmd.upper().startswith("REPLACE "):
            lno = int(cmd.split()[1])
            if lno < 1 or lno > len(result):
                log.append(f"REPLACE {lno}: out of range (file has {len(result)} lines)")
                continue
            new_content = "\n".join(block_lines[1:])
            old = result[lno - 1]
            result[lno - 1] = new_content
            log.append(f"REPLACE line {lno}: {old.rstrip()!r} → {new_content.rstrip()!r}")

        elif cmd.upper().startswith("INSERT "):
            lno = int(cmd.split()[1])
            new_lines = block_lines[1:]
            for i, nl in enumerate(new_lines):
                result.insert(lno + i, nl)
            log.append(f"INSERT {len(new_lines)} line(s) after line {lno}")

        elif cmd.upper().startswith("DELETE "):
            parts = cmd.split()
            lno = int(parts[1])
            count = int(parts[2]) if len(parts) > 2 else 1
            if lno < 1 or lno + count - 1 > len(result):
                log.append(f"DELETE {lno}: out of range")
                continue
            del result[lno - 1 : lno - 1 + count]
            log.append(f"DELETE {count} line(s) starting at line {lno}")

        else:
            log.append(f"Unknown command: {cmd}")
    return result, log


def _apply_unified_diff(lines: list[str], patch_text: str) -> tuple[list[str], list[str]]:
    """Apply a unified-diff patch. Returns (new_lines, log)."""
    import re
    result = list(lines)
    log: list[str] = []
    hunk_re = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
    offset = 0  # cumulative line shift from prior hunks

    patch_lines = patch_text.split("\n")
    i = 0
    while i < len(patch_lines):
        m = hunk_re.match(patch_lines[i])
        if not m:
            i += 1
            continue
        old_start = int(m.group(1))
        i += 1
        # Collect hunk body
        removes: list[int] = []
        adds: list[str] = []
        pos = old_start - 1 + offset
        while i < len(patch_lines) and not patch_lines[i].startswith("@@"):
            line = patch_lines[i]
            if line.startswith("-"):
                removes.append(pos)
                pos += 1
            elif line.startswith("+"):
                adds.append(line[1:])
            elif line.startswith(" "):
                pos += 1
            else:
                break
            i += 1

        # Apply: delete then insert
        for idx in sorted(removes, reverse=True):
            if 0 <= idx < len(result):
                del result[idx]
        insert_at = (min(removes) if removes else old_start - 1 + offset)
        for j, new_line in enumerate(adds):
            result.insert(insert_at + j, new_line)
        offset += len(adds) - len(removes)
        log.append(f"Hunk @@ -{old_start}: -{len(removes)} +{len(adds)} lines")

    return result, log


@define_tool(
    description=(
        "Apply a patch (unified diff or simple REPLACE/INSERT/DELETE commands) to a file in ~/Notes. "
        "Always use file_read_lines first to see the current content and line numbers. "
        "Files are restricted to ~/Notes."
    )
)
async def file_apply_patch(params: FileApplyPatchParams) -> str:
    path = _resolve_notes_path(params.path)
    if not path:
        return f"Access denied: files must be inside ~/Notes. Got: {params.path}"
    if not os.path.isfile(path):
        return f"File not found: {params.path}"
    try:
        with open(path) as f:
            lines = f.readlines()
    except Exception as e:
        return f"Failed to read file: {e}"

    # Strip trailing newlines for processing, re-add on write
    stripped = [l.rstrip("\n") for l in lines]

    patch = params.patch.strip()
    if "@@" in patch:
        new_lines, log = _apply_unified_diff(stripped, patch)
    else:
        new_lines, log = _apply_simple_patch(stripped, patch)

    if not log:
        return "No changes detected in patch."

    summary = "\n".join(log)

    if params.dry_run:
        return f"Dry run — would apply:\n{summary}"

    try:
        with open(path, "w") as f:
            f.write("\n".join(new_lines))
            if new_lines:
                f.write("\n")
    except Exception as e:
        return f"Failed to write file: {e}"

    return f"Patched {params.path}:\n{summary}"


# ── Tool: Create ticket (tk) ─────────────────────────────────────────────────

class CreateTicketParams(BaseModel):
    title: str = Field(description="Short title for the ticket, e.g. 'Fix login timeout bug'")
    description: str = Field(default="", description="Longer description of the task or issue.")
    ticket_type: str = Field(
        default="task",
        description="Type: 'bug', 'feature', 'task', 'epic', or 'chore'.",
    )
    priority: int = Field(
        default=2,
        description="Priority 0-4 where 0 is highest. Default is 2 (medium).",
    )
    tags: str = Field(default="", description="Comma-separated tags, e.g. 'ui,backend,urgent'.")
    parent: str = Field(default="", description="Parent ticket ID if this is a sub-task.")


@define_tool(
    description=(
        "Create a TODO / ticket using the local 'tk' ticket system. "
        "Use this whenever the user wants to note a task, track a bug, plan a feature, "
        "or create any kind of to-do item. Returns the new ticket ID."
    )
)
async def create_ticket(params: CreateTicketParams) -> str:
    if not shutil.which("tk"):
        return "Error: 'tk' CLI is not installed."

    cmd = ["tk", "create", params.title]
    if params.description:
        cmd += ["-d", params.description]
    if params.ticket_type:
        cmd += ["-t", params.ticket_type]
    cmd += ["-p", str(max(0, min(4, params.priority)))]
    if params.tags:
        cmd += ["--tags", params.tags]
    if params.parent:
        cmd += ["--parent", params.parent]

    ok, output = _run_cmd(cmd, timeout=10)
    if not ok:
        return f"Failed to create ticket: {output}"

    ticket_id = output.strip()

    # Fetch the created ticket for confirmation
    ok2, details = _run_cmd(["tk", "show", ticket_id], timeout=5)
    if ok2:
        return f"Created ticket {ticket_id}\n{details}"
    return f"Created ticket: {ticket_id}"


# ── Tool: GitHub search ─────────────────────────────────────────────────────

class GitHubSearchParams(BaseModel):
    query: str = Field(description="Search query for GitHub, e.g. 'fastapi language:python stars:>100'")
    search_type: str = Field(
        default="repositories",
        description="What to search: 'repositories', 'code', 'issues', 'commits', or 'users'.",
    )
    max_results: int = Field(default=10, description="Max results to return (1-30)")


@define_tool(
    description=(
        "Search GitHub using the gh CLI. Supports searching repositories, code, issues, "
        "commits, and users. Use this to find projects, code examples, issues, etc. on GitHub. "
        "Requires the 'gh' CLI to be installed and authenticated."
    )
)
async def github_search(params: GitHubSearchParams) -> str:
    if not shutil.which("gh"):
        return "Error: 'gh' CLI is not installed. Install it from https://cli.github.com/"

    search_type = params.search_type.lower()
    limit = max(1, min(params.max_results, 30))

    type_map = {
        "repositories": "repos",
        "repos": "repos",
        "code": "code",
        "issues": "issues",
        "commits": "commits",
        "users": "users",
    }
    gh_type = type_map.get(search_type)
    if not gh_type:
        return f"Unknown search type '{search_type}'. Use: repositories, code, issues, commits, or users."

    if gh_type == "users":
        # gh search doesn't support users directly — use the API
        ok, output = _run_cmd(
            ["gh", "api", f"search/users?q={params.query}&per_page={limit}"],
            timeout=30,
        )
        if not ok:
            return f"GitHub user search failed: {output}"
        try:
            data = json.loads(output)
            items = data.get("items", [])
            if not items:
                return "No users found."
            lines = []
            for u in items:
                lines.append(f"• {u.get('login', '?')}  —  {u.get('html_url', '')}")
            return "\n".join(lines)
        except Exception as e:
            return f"Failed to parse results: {e}"

    cmd = ["gh", "search", gh_type, params.query, "--limit", str(limit)]
    ok, output = _run_cmd(cmd, timeout=30)
    if not ok:
        return f"GitHub search failed: {output}"
    if not output:
        return f"No {search_type} found for '{params.query}'."
    return output


# ── Tool: GitHub clone ──────────────────────────────────────────────────────

_GITHUB_CLONES_DIR = os.path.expanduser("~/github-clones")


class GitHubCloneParams(BaseModel):
    repo: str = Field(
        description=(
            "Repository to clone, e.g. 'owner/repo' or a full GitHub URL. "
            "Examples: 'pallets/flask', 'https://github.com/psf/requests'."
        )
    )
    shallow: bool = Field(
        default=True,
        description="If true (default), do a shallow clone (--depth 1) to save time and space.",
    )


@define_tool(
    description=(
        "Clone a GitHub repository into ~/github-clones/<owner>/<repo> using the gh CLI. "
        "If the repo is already cloned, returns the existing path. "
        "IMPORTANT: You MUST use this tool to clone a repo BEFORE reading any files from it. "
        "Do NOT try to fetch repo files via raw HTTP, web scraping, or any other method — "
        "always clone first with this tool, then use github_read_file or github_grep."
    )
)
async def github_clone(params: GitHubCloneParams) -> str:
    # Normalize repo identifier
    repo = params.repo.strip().rstrip("/")
    for prefix in ("https://github.com/", "http://github.com/", "github.com/"):
        if repo.lower().startswith(prefix):
            repo = repo[len(prefix):]
            break
    if repo.endswith(".git"):
        repo = repo[:-4]

    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return f"Invalid repo format: '{params.repo}'. Use 'owner/repo'."

    owner, name = parts
    dest = os.path.join(_GITHUB_CLONES_DIR, owner, name)

    # Already cloned?
    if os.path.isdir(os.path.join(dest, ".git")):
        return f"Repository already cloned at {dest}"

    os.makedirs(os.path.dirname(dest), exist_ok=True)

    # Try gh first (handles private repos + auth), fall back to git clone
    # for public repos that don't need auth
    cmd = ["git", "clone"]
    if params.shallow:
        cmd += ["--depth", "1"]
    cmd += [f"https://github.com/{owner}/{name}.git", dest]

    if shutil.which("gh"):
        gh_cmd = ["gh", "repo", "clone", f"{owner}/{name}", dest]
        if params.shallow:
            gh_cmd += ["--", "--depth", "1"]
        ok, output = _run_cmd(gh_cmd, timeout=120)
        if ok:
            return f"Cloned {owner}/{name} to {dest}"
        # gh failed (likely auth) — fall back to plain git for public repos

    ok, output = _run_cmd(cmd, timeout=120)
    if not ok:
        return f"Clone failed: {output}"

    return f"Cloned {owner}/{name} to {dest}"


# ── Tool: GitHub read file ──────────────────────────────────────────────────

class GitHubReadFileParams(BaseModel):
    repo: str = Field(
        description=(
            "Repository identifier, e.g. 'owner/repo'. Must already be cloned "
            "via github_clone into ~/github-clones/."
        )
    )
    path: str = Field(
        description="Path to the file within the repo, e.g. 'README.md' or 'src/main.py'."
    )
    start: int = Field(
        default=0,
        description="Starting line number (1-based). 0 or omitted = start from beginning.",
    )
    end: int = Field(
        default=0,
        description="Ending line number (1-based, inclusive). 0 or omitted = read to end of file.",
    )


@define_tool(
    description=(
        "Read a file (or a line range) from a previously cloned GitHub repo in ~/github-clones/. "
        "You MUST call github_clone first to clone the repo before using this tool. "
        "Do NOT use web scraping, browse_web, or raw HTTP to read GitHub repo files — "
        "always use github_clone then this tool. Read-only, never modifies files."
    )
)
async def github_read_file(params: GitHubReadFileParams) -> str:
    repo = params.repo.strip().rstrip("/")
    for prefix in ("https://github.com/", "http://github.com/", "github.com/"):
        if repo.lower().startswith(prefix):
            repo = repo[len(prefix):]
            break
    if repo.endswith(".git"):
        repo = repo[:-4]

    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return f"Invalid repo format: '{params.repo}'. Use 'owner/repo'."

    owner, name = parts
    repo_dir = os.path.join(_GITHUB_CLONES_DIR, owner, name)

    if not os.path.isdir(repo_dir):
        return f"Repository not cloned yet. Run github_clone for '{owner}/{name}' first."

    # Resolve and validate the file path (prevent directory traversal)
    file_path = os.path.normpath(os.path.join(repo_dir, params.path))
    if not file_path.startswith(repo_dir):
        return "Access denied: path escapes the repository directory."

    if not os.path.exists(file_path):
        # If it's a directory, list its contents instead
        return f"File not found: {params.path}"

    if os.path.isdir(file_path):
        try:
            entries = sorted(os.listdir(file_path))
        except Exception as e:
            return f"Failed to list directory: {e}"
        dirs = [e + "/" for e in entries if os.path.isdir(os.path.join(file_path, e))]
        files = [e for e in entries if not os.path.isdir(os.path.join(file_path, e))]
        listing = "\n".join(dirs + files)
        return f"── {params.path}/ ({len(dirs)} dirs, {len(files)} files) ──\n{listing}"

    # Check file size (skip huge binaries)
    size = os.path.getsize(file_path)
    if size > 512_000:
        return f"File is too large ({size:,} bytes). Try specifying a line range with start/end."

    try:
        with open(file_path) as f:
            all_lines = f.readlines()
    except UnicodeDecodeError:
        return f"Cannot read binary file: {params.path}"
    except Exception as e:
        return f"Failed to read file: {e}"

    total = len(all_lines)
    start = max(1, params.start) if params.start > 0 else 1
    end = params.end if params.end > 0 else total
    end = min(end, total)

    if start > total:
        return f"File has {total} lines; start={start} is past the end."

    selected = all_lines[start - 1 : end]
    numbered = []
    for i, line in enumerate(selected, start=start):
        numbered.append(f"{i:>5} | {line.rstrip()}")

    header = f"── {owner}/{name}/{params.path} ({total} lines) ──  showing {start}–{end}"
    return header + "\n" + "\n".join(numbered)


# ── Tool: GitHub grep ───────────────────────────────────────────────────────

class GitHubGrepParams(BaseModel):
    repo: str = Field(
        description="Repository identifier, e.g. 'owner/repo'. Must already be cloned via github_clone."
    )
    pattern: str = Field(description="Search pattern (regex supported).")
    glob_filter: str = Field(
        default="",
        description="Optional glob to restrict search, e.g. '*.py' or 'src/**/*.ts'.",
    )
    max_results: int = Field(default=30, description="Max matching lines to return (1-100).")


@define_tool(
    description=(
        "Search file contents within a previously cloned GitHub repo using grep. "
        "You MUST call github_clone first. Do NOT use web scraping or raw HTTP "
        "to search repo contents. Returns matching lines with file paths and line numbers."
    )
)
async def github_grep(params: GitHubGrepParams) -> str:
    repo = params.repo.strip().rstrip("/")
    for prefix in ("https://github.com/", "http://github.com/", "github.com/"):
        if repo.lower().startswith(prefix):
            repo = repo[len(prefix):]
            break
    if repo.endswith(".git"):
        repo = repo[:-4]

    parts = repo.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return f"Invalid repo format: '{params.repo}'. Use 'owner/repo'."

    repo_dir = os.path.join(_GITHUB_CLONES_DIR, parts[0], parts[1])
    if not os.path.isdir(repo_dir):
        return f"Repository not cloned yet. Run github_clone for '{parts[0]}/{parts[1]}' first."

    limit = max(1, min(params.max_results, 100))

    # Prefer ripgrep, fall back to grep
    if shutil.which("rg"):
        cmd = ["rg", "-n", "--no-heading", "-m", str(limit), params.pattern]
        if params.glob_filter:
            cmd += ["-g", params.glob_filter]
        cmd.append(repo_dir)
    else:
        cmd = ["grep", "-rn", "--include", params.glob_filter or "*", params.pattern, repo_dir]

    ok, output = _run_cmd(cmd, timeout=30)
    # grep returns exit 1 for no matches
    if not output:
        return f"No matches for '{params.pattern}' in {parts[0]}/{parts[1]}."

    # Strip the repo_dir prefix for cleaner output
    lines = output.split("\n")
    cleaned = []
    for line in lines[:limit]:
        if line.startswith(repo_dir):
            line = line[len(repo_dir):].lstrip("/")
        cleaned.append(line)
    return "\n".join(cleaned)


# ── Tool: Weather forecast (Open-Meteo) ────────────────────────────────────

class WeatherForecastParams(BaseModel):
    latitude: float = Field(description="Latitude of the location.")
    longitude: float = Field(description="Longitude of the location.")
    days: int = Field(default=3, description="Number of forecast days (1-7).")


@define_tool(
    description=(
        "Get current weather and a multi-day forecast using the free Open-Meteo API. "
        "Provide latitude and longitude (use get_my_location if needed). "
        "Returns temperature, conditions, precipitation, wind, and sunrise/sunset."
    )
)
async def weather_forecast(params: WeatherForecastParams) -> str:
    days = max(1, min(params.days, 7))
    url = (
        f"https://api.open-meteo.com/v1/forecast?"
        f"latitude={params.latitude}&longitude={params.longitude}"
        f"&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
        f"weather_code,wind_speed_10m,wind_direction_10m"
        f"&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,"
        f"weather_code,sunrise,sunset,wind_speed_10m_max"
        f"&forecast_days={days}&timezone=auto"
    )
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Weather request failed: {e}"

    wmo_codes = {
        0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
        55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
        71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
        80: "Light showers", 81: "Showers", 82: "Heavy showers",
        85: "Light snow showers", 86: "Snow showers",
        95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + heavy hail",
    }

    lines = []
    cur = data.get("current", {})
    if cur:
        code = cur.get("weather_code", -1)
        desc = wmo_codes.get(code, f"Code {code}")
        lines.append(f"🌡 Now: {cur.get('temperature_2m')}°C (feels {cur.get('apparent_temperature')}°C)")
        lines.append(f"   {desc}, humidity {cur.get('relative_humidity_2m')}%")
        lines.append(f"   Wind: {cur.get('wind_speed_10m')} km/h")

    daily = data.get("daily", {})
    dates = daily.get("time", [])
    for i, date in enumerate(dates):
        code = daily.get("weather_code", [None])[i]
        desc = wmo_codes.get(code, f"Code {code}") if code is not None else "?"
        hi = daily.get("temperature_2m_max", [None])[i]
        lo = daily.get("temperature_2m_min", [None])[i]
        precip = daily.get("precipitation_sum", [None])[i]
        wind = daily.get("wind_speed_10m_max", [None])[i]
        sunrise = daily.get("sunrise", [None])[i]
        sunset = daily.get("sunset", [None])[i]
        lines.append(f"\n📅 {date}: {desc}")
        lines.append(f"   High {hi}°C / Low {lo}°C, precip {precip}mm, wind {wind} km/h")
        if sunrise and sunset:
            lines.append(f"   ☀ {sunrise.split('T')[1]} → 🌙 {sunset.split('T')[1]}")

    return "\n".join(lines) if lines else "No forecast data returned."


# ── Tool: Unit/currency converter ───────────────────────────────────────────

class ConvertUnitsParams(BaseModel):
    value: float = Field(description="The numeric value to convert.")
    from_unit: str = Field(description="Source unit, e.g. 'km', 'lbs', 'USD', '°F'.")
    to_unit: str = Field(description="Target unit, e.g. 'mi', 'kg', 'EUR', '°C'.")


_UNIT_CONVERSIONS: dict[tuple[str, str], float] = {
    ("km", "mi"): 0.621371, ("mi", "km"): 1.60934,
    ("m", "ft"): 3.28084, ("ft", "m"): 0.3048,
    ("cm", "in"): 0.393701, ("in", "cm"): 2.54,
    ("kg", "lbs"): 2.20462, ("lbs", "kg"): 0.453592,
    ("lb", "kg"): 0.453592, ("kg", "lb"): 2.20462,
    ("g", "oz"): 0.035274, ("oz", "g"): 28.3495,
    ("l", "gal"): 0.264172, ("gal", "l"): 3.78541,
    ("ml", "floz"): 0.033814, ("floz", "ml"): 29.5735,
    ("km/h", "mph"): 0.621371, ("mph", "km/h"): 1.60934,
    ("m/s", "km/h"): 3.6, ("km/h", "m/s"): 0.277778,
}


@define_tool(
    description=(
        "Convert between units (length, weight, volume, speed, temperature) or currencies. "
        "Supports km↔mi, kg↔lbs, °C↔°F, L↔gal, and many more. "
        "For currencies, uses the free Frankfurter API for live exchange rates."
    )
)
async def convert_units(params: ConvertUnitsParams) -> str:
    fr = params.from_unit.strip().lower().replace("°", "")
    to = params.to_unit.strip().lower().replace("°", "")

    # Temperature
    if fr in ("c", "celsius") and to in ("f", "fahrenheit"):
        result = params.value * 9 / 5 + 32
        return f"{params.value}°C = {result:.2f}°F"
    if fr in ("f", "fahrenheit") and to in ("c", "celsius"):
        result = (params.value - 32) * 5 / 9
        return f"{params.value}°F = {result:.2f}°C"
    if fr in ("c", "celsius") and to in ("k", "kelvin"):
        result = params.value + 273.15
        return f"{params.value}°C = {result:.2f}K"
    if fr in ("k", "kelvin") and to in ("c", "celsius"):
        result = params.value - 273.15
        return f"{params.value}K = {result:.2f}°C"

    # Standard unit conversions
    key = (fr, to)
    if key in _UNIT_CONVERSIONS:
        result = params.value * _UNIT_CONVERSIONS[key]
        return f"{params.value} {params.from_unit} = {result:.4g} {params.to_unit}"

    # Try currency conversion via Frankfurter API
    fr_cur = params.from_unit.strip().upper()
    to_cur = params.to_unit.strip().upper()
    if len(fr_cur) == 3 and len(to_cur) == 3 and fr_cur.isalpha() and to_cur.isalpha():
        try:
            url = f"https://api.frankfurter.app/latest?from={fr_cur}&to={to_cur}&amount={params.value}"
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
            rates = data.get("rates", {})
            if to_cur in rates:
                return f"{params.value} {fr_cur} = {rates[to_cur]:.2f} {to_cur} (rate as of {data.get('date', 'today')})"
            return f"Currency '{to_cur}' not found. Check the currency code."
        except Exception as e:
            return f"Currency conversion failed: {e}"

    return f"Unknown conversion: {params.from_unit} → {params.to_unit}. Supported: km/mi, kg/lbs, °C/°F, L/gal, and 3-letter currency codes."


# ── Tool: Dictionary/thesaurus ──────────────────────────────────────────────

class DictionaryLookupParams(BaseModel):
    word: str = Field(description="The word to look up.")
    include_synonyms: bool = Field(default=True, description="Include synonyms if available.")


@define_tool(
    description=(
        "Look up a word definition, pronunciation, part of speech, and synonyms "
        "using the free Dictionary API (dictionaryapi.dev). No API key needed."
    )
)
async def dictionary_lookup(params: DictionaryLookupParams) -> str:
    url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{params.word.strip()}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                return f"No definition found for '{params.word}'."
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Dictionary lookup failed: {e}"

    if not isinstance(data, list) or not data:
        return f"No definition found for '{params.word}'."

    entry = data[0]
    lines = [f"📖 {entry.get('word', params.word)}"]

    phonetics = entry.get("phonetics", [])
    for p in phonetics:
        if p.get("text"):
            lines.append(f"   Pronunciation: {p['text']}")
            break

    all_synonyms = set()
    for meaning in entry.get("meanings", []):
        pos = meaning.get("partOfSpeech", "")
        lines.append(f"\n  [{pos}]")
        for defn in meaning.get("definitions", [])[:3]:
            lines.append(f"    • {defn.get('definition', '')}")
            if defn.get("example"):
                lines.append(f"      Example: \"{defn['example']}\"")
        if params.include_synonyms:
            for s in meaning.get("synonyms", [])[:5]:
                all_synonyms.add(s)

    if all_synonyms:
        lines.append(f"\n  Synonyms: {', '.join(sorted(all_synonyms))}")

    return "\n".join(lines)


# ── Tool: Translation ───────────────────────────────────────────────────────

class TranslateTextParams(BaseModel):
    text: str = Field(description="Text to translate.")
    target_language: str = Field(
        description="Target language code, e.g. 'es' (Spanish), 'fr' (French), 'de' (German), 'ja' (Japanese)."
    )
    source_language: str = Field(
        default="auto",
        description="Source language code, or 'auto' to auto-detect.",
    )


@define_tool(
    description=(
        "Translate text between languages using the MyMemory free translation API. "
        "No API key needed. Supports most language pairs. "
        "Use ISO 639-1 codes: en, es, fr, de, it, pt, ja, ko, zh, ar, ru, etc."
    )
)
async def translate_text(params: TranslateTextParams) -> str:
    src = params.source_language.strip().lower()
    tgt = params.target_language.strip().lower()
    if src == "auto":
        langpair = f"autodetect|{tgt}"
    else:
        langpair = f"{src}|{tgt}"

    url = "https://api.mymemory.translated.net/get"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={"q": params.text, "langpair": langpair})
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return f"Translation failed: {e}"

    rd = data.get("responseData", {})
    translated = rd.get("translatedText", "")
    if not translated:
        return f"Translation returned no result. Check language codes."

    detected = data.get("responseDetails", "")
    match_pct = rd.get("match", 0)

    lines = [f"🌐 Translation ({src} → {tgt}):"]
    lines.append(translated)
    if match_pct and isinstance(match_pct, (int, float)):
        lines.append(f"   (confidence: {match_pct:.0%})")

    return "\n".join(lines)


# ── Tool: Timer/stopwatch ──────────────────────────────────────────────────

_active_timers: dict[str, dict] = {}


class TimerStartParams(BaseModel):
    name: str = Field(description="Name for this timer, e.g. 'eggs', 'workout', 'focus'.")
    duration_seconds: int = Field(
        default=0,
        description="Countdown duration in seconds. 0 = stopwatch (counts up).",
    )


class TimerCheckParams(BaseModel):
    name: str = Field(default="", description="Timer name. Empty = show all active timers.")


class TimerStopParams(BaseModel):
    name: str = Field(description="Name of the timer to stop.")


@define_tool(
    description=(
        "Start a named timer. Set duration_seconds for a countdown, or 0 for a stopwatch. "
        "Use timer_check to see elapsed/remaining time, and timer_stop to end it."
    )
)
async def timer_start(params: TimerStartParams) -> str:
    name = params.name.strip().lower()
    if not name:
        return "Timer name is required."
    if name in _active_timers:
        return f"Timer '{name}' is already running. Stop it first."

    _active_timers[name] = {
        "start": _time.time(),
        "duration": params.duration_seconds,
    }
    if params.duration_seconds > 0:
        mins, secs = divmod(params.duration_seconds, 60)
        return f"⏱ Timer '{name}' started: {mins}m {secs}s countdown."
    return f"⏱ Stopwatch '{name}' started."


@define_tool(
    description="Check the status of a running timer. Leave name empty to see all active timers."
)
async def timer_check(params: TimerCheckParams) -> str:
    if not _active_timers:
        return "No active timers."

    name = params.name.strip().lower()
    if name:
        if name not in _active_timers:
            return f"No timer named '{name}'. Active: {', '.join(_active_timers.keys())}"
        return _format_timer(name, _active_timers[name])

    lines = []
    for n, t in _active_timers.items():
        lines.append(_format_timer(n, t))
    return "\n".join(lines)


def _format_timer(name: str, t: dict) -> str:
    elapsed = _time.time() - t["start"]
    if t["duration"] > 0:
        remaining = max(0, t["duration"] - elapsed)
        if remaining == 0:
            return f"⏱ '{name}': ⏰ TIME'S UP! (elapsed {elapsed:.0f}s)"
        mins, secs = divmod(int(remaining), 60)
        return f"⏱ '{name}': {mins}m {secs}s remaining"
    mins, secs = divmod(int(elapsed), 60)
    return f"⏱ '{name}': {mins}m {secs}s elapsed"


@define_tool(description="Stop a running timer and report the final time.")
async def timer_stop(params: TimerStopParams) -> str:
    name = params.name.strip().lower()
    if name not in _active_timers:
        if _active_timers:
            return f"No timer named '{name}'. Active: {', '.join(_active_timers.keys())}"
        return "No active timers."

    t = _active_timers.pop(name)
    elapsed = _time.time() - t["start"]
    mins, secs = divmod(int(elapsed), 60)
    if t["duration"] > 0:
        over = elapsed - t["duration"]
        if over > 0:
            return f"⏱ Timer '{name}' stopped. Ran {mins}m {secs}s ({over:.0f}s over)."
        return f"⏱ Timer '{name}' stopped at {mins}m {secs}s."
    return f"⏱ Stopwatch '{name}' stopped at {mins}m {secs}s."


# ── Tool: System info ──────────────────────────────────────────────────────

class SystemInfoParams(BaseModel):
    pass


@define_tool(
    description=(
        "Report system information: OS, CPU, memory usage, disk usage, uptime, "
        "and battery status (if available)."
    )
)
async def system_info(params: SystemInfoParams) -> str:
    import psutil

    lines = []
    lines.append(f"🖥 OS: {platform.system()} {platform.release()} ({platform.machine()})")
    lines.append(f"   Python: {platform.python_version()}")

    cpu_count = psutil.cpu_count(logical=True)
    cpu_pct = psutil.cpu_percent(interval=0.5)
    lines.append(f"   CPU: {cpu_count} cores, {cpu_pct}% utilization")

    mem = psutil.virtual_memory()
    lines.append(f"   Memory: {mem.used / (1024**3):.1f} / {mem.total / (1024**3):.1f} GB ({mem.percent}%)")

    disk = psutil.disk_usage("/")
    lines.append(f"   Disk (/): {disk.used / (1024**3):.1f} / {disk.total / (1024**3):.1f} GB ({disk.percent}%)")

    # Uptime
    boot = psutil.boot_time()
    uptime_secs = _time.time() - boot
    days, rem = divmod(int(uptime_secs), 86400)
    hours, rem = divmod(rem, 3600)
    mins, _ = divmod(rem, 60)
    lines.append(f"   Uptime: {days}d {hours}h {mins}m")

    # Battery
    try:
        batt = psutil.sensors_battery()
        if batt:
            status = "charging" if batt.power_plugged else "on battery"
            lines.append(f"   Battery: {batt.percent:.0f}% ({status})")
    except Exception:
        pass

    return "\n".join(lines)


# ── Tool: RSS feed reader ──────────────────────────────────────────────────

class ReadRSSParams(BaseModel):
    url: str = Field(description="URL of the RSS or Atom feed.")
    max_items: int = Field(default=5, description="Max number of feed items to return (1-20).")


@define_tool(
    description=(
        "Fetch and display entries from an RSS or Atom feed. "
        "Returns titles, dates, summaries, and links for recent entries."
    )
)
async def read_rss(params: ReadRSSParams) -> str:
    import feedparser

    try:
        feed = feedparser.parse(params.url)
    except Exception as e:
        return f"Failed to parse feed: {e}"

    if feed.bozo and not feed.entries:
        return f"Could not parse feed at {params.url}: {feed.bozo_exception}"

    title = feed.feed.get("title", params.url)
    entries = feed.entries[: max(1, min(params.max_items, 20))]

    if not entries:
        return f"Feed '{title}' has no entries."

    lines = [f"📡 {title} ({len(entries)} items)"]
    for i, e in enumerate(entries, 1):
        entry_title = e.get("title", "No title")
        link = e.get("link", "")
        published = e.get("published", e.get("updated", ""))
        summary = e.get("summary", "")
        # Strip HTML tags from summary
        if "<" in summary:
            import re
            summary = re.sub(r"<[^>]+>", "", summary)
        if len(summary) > 200:
            summary = summary[:200] + "…"
        lines.append(f"\n{i}. {entry_title}")
        if published:
            lines.append(f"   📅 {published}")
        if summary:
            lines.append(f"   {summary}")
        if link:
            lines.append(f"   🔗 {link}")

    return "\n".join(lines)


# ── Tool: File download ────────────────────────────────────────────────────

class DownloadFileParams(BaseModel):
    url: str = Field(description="URL of the file to download.")
    filename: str = Field(
        default="",
        description="Filename to save as. If empty, auto-detects from URL.",
    )


@define_tool(
    description=(
        "Download a file from a URL to ~/Downloads/. "
        "Auto-detects filename from URL if not specified. "
        "Will not overwrite existing files."
    )
)
async def download_file(params: DownloadFileParams) -> str:
    downloads_dir = os.path.expanduser("~/Downloads")
    os.makedirs(downloads_dir, exist_ok=True)

    # Determine filename
    fname = params.filename.strip()
    if not fname:
        from urllib.parse import urlparse, unquote
        path = urlparse(params.url).path
        fname = unquote(os.path.basename(path)) or "download"

    dest = os.path.join(downloads_dir, fname)
    if os.path.exists(dest):
        return f"File already exists: {dest}. Choose a different filename."

    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", params.url) as resp:
                resp.raise_for_status()
                total = 0
                with open(dest, "wb") as f:
                    async for chunk in resp.aiter_bytes(8192):
                        f.write(chunk)
                        total += len(chunk)
    except Exception as e:
        # Clean up partial download
        if os.path.exists(dest):
            os.remove(dest)
        return f"Download failed: {e}"

    size_str = f"{total:,} bytes"
    if total > 1_000_000:
        size_str = f"{total / 1_000_000:.1f} MB"
    elif total > 1_000:
        size_str = f"{total / 1_000:.1f} KB"

    return f"⬇ Downloaded {fname} ({size_str}) to {dest}"


# ── Tool: Bookmarks manager ────────────────────────────────────────────────

_BOOKMARKS_PATH = os.path.expanduser("~/.config/local-finder/bookmarks.json")


def _load_bookmarks() -> list[dict]:
    if os.path.exists(_BOOKMARKS_PATH):
        try:
            with open(_BOOKMARKS_PATH) as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _save_bookmarks(bookmarks: list[dict]):
    os.makedirs(os.path.dirname(_BOOKMARKS_PATH), exist_ok=True)
    with open(_BOOKMARKS_PATH, "w") as f:
        json.dump(bookmarks, f, indent=2)


class BookmarkSaveParams(BaseModel):
    url: str = Field(description="URL to bookmark.")
    title: str = Field(default="", description="Title for the bookmark.")
    tags: str = Field(default="", description="Comma-separated tags, e.g. 'python,tutorial'.")
    notes: str = Field(default="", description="Optional notes about this bookmark.")


class BookmarkListParams(BaseModel):
    tag: str = Field(default="", description="Filter by tag. Empty = show all.")
    limit: int = Field(default=20, description="Max bookmarks to show.")


class BookmarkSearchParams(BaseModel):
    query: str = Field(description="Search text to match against titles, URLs, notes, and tags.")
    limit: int = Field(default=10, description="Max results to return.")


@define_tool(
    description="Save a URL as a bookmark with optional title, tags, and notes."
)
async def bookmark_save(params: BookmarkSaveParams) -> str:
    bookmarks = _load_bookmarks()

    # Check for duplicate URL
    for bm in bookmarks:
        if bm.get("url") == params.url:
            return f"Already bookmarked: {params.url}"

    entry = {
        "url": params.url,
        "title": params.title or params.url,
        "tags": [t.strip() for t in params.tags.split(",") if t.strip()] if params.tags else [],
        "notes": params.notes,
        "saved_at": _time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    bookmarks.append(entry)
    _save_bookmarks(bookmarks)
    return f"🔖 Bookmarked: {entry['title']}"


@define_tool(
    description="List saved bookmarks, optionally filtered by tag."
)
async def bookmark_list(params: BookmarkListParams) -> str:
    bookmarks = _load_bookmarks()
    if not bookmarks:
        return "No bookmarks saved yet."

    tag = params.tag.strip().lower()
    if tag:
        bookmarks = [b for b in bookmarks if tag in [t.lower() for t in b.get("tags", [])]]
        if not bookmarks:
            return f"No bookmarks with tag '{tag}'."

    lines = [f"🔖 Bookmarks ({len(bookmarks)} total)"]
    for bm in bookmarks[: params.limit]:
        tags_str = f" [{', '.join(bm.get('tags', []))}]" if bm.get("tags") else ""
        lines.append(f"  • {bm.get('title', '?')}{tags_str}")
        lines.append(f"    {bm.get('url', '')}")
        if bm.get("notes"):
            lines.append(f"    📝 {bm['notes']}")
    return "\n".join(lines)


@define_tool(
    description="Search bookmarks by matching against titles, URLs, notes, and tags."
)
async def bookmark_search(params: BookmarkSearchParams) -> str:
    bookmarks = _load_bookmarks()
    if not bookmarks:
        return "No bookmarks saved yet."

    q = params.query.strip().lower()
    matches = []
    for bm in bookmarks:
        haystack = " ".join([
            bm.get("title", ""), bm.get("url", ""),
            bm.get("notes", ""), " ".join(bm.get("tags", [])),
        ]).lower()
        if q in haystack:
            matches.append(bm)

    if not matches:
        return f"No bookmarks matching '{params.query}'."

    lines = [f"🔍 {len(matches)} bookmark(s) matching '{params.query}'"]
    for bm in matches[: params.limit]:
        tags_str = f" [{', '.join(bm.get('tags', []))}]" if bm.get("tags") else ""
        lines.append(f"  • {bm.get('title', '?')}{tags_str}")
        lines.append(f"    {bm.get('url', '')}")
    return "\n".join(lines)


# ── Tool: Compact history ───────────────────────────────────────────────────

_compact_session_requested: asyncio.Event | None = None

_TARGET_TOKENS = 50_000
_AUTO_COMPACT_TOKENS = 80_000  # auto-compact when history exceeds this
_CHARS_PER_TOKEN = 4
_PRESERVE_RECENT = 20  # keep this many recent messages verbatim


def _do_compact(log: list[dict], target_tokens: int = _TARGET_TOKENS) -> tuple[list[dict], str]:
    """Compact a chat log to fit within a token budget.

    Returns (new_log, summary_message).  Backs up the original file first.
    Recent messages are preserved exactly; older ones are truncated/dropped.
    """
    target_chars = target_tokens * _CHARS_PER_TOKEN
    current_chars = sum(len(e.get("text", "")) for e in log)

    if current_chars <= target_chars:
        return log, ""

    # Back up the original
    backup_path = _chat_log_path() + f".backup.{_time.strftime('%Y%m%d_%H%M%S')}"
    try:
        import shutil as _sh
        _sh.copy2(_chat_log_path(), backup_path)
    except Exception:
        backup_path = "(backup failed)"

    # Split: preserve recent messages exactly, compact the older ones
    preserve_count = min(_PRESERVE_RECENT, len(log))
    recent = log[-preserve_count:]
    older = log[:-preserve_count] if preserve_count < len(log) else []

    recent_chars = sum(len(e.get("text", "")) for e in recent)
    budget_for_older = max(0, target_chars - recent_chars)

    if not older:
        return log, ""

    older_chars = sum(len(e.get("text", "")) for e in older)
    if older_chars <= budget_for_older:
        compacted_older = older
    else:
        max_per_msg = max(40, budget_for_older // len(older))
        compacted_older = []
        for entry in older:
            e = dict(entry)
            text = e.get("text", "")
            if len(text) > max_per_msg:
                e["text"] = text[:max_per_msg] + "…"
            compacted_older.append(e)

        while compacted_older:
            total = sum(len(e.get("text", "")) for e in compacted_older)
            if total <= budget_for_older:
                break
            compacted_older.pop(0)

    new_log = compacted_older + recent
    new_chars = sum(len(e.get("text", "")) for e in new_log)
    dropped = len(log) - len(new_log)

    parts = [
        f"✂ Auto-compacted history: {len(log)} → {len(new_log)} messages",
        f"({current_chars // _CHARS_PER_TOKEN:,} → ~{new_chars // _CHARS_PER_TOKEN:,} tokens)",
    ]
    if dropped:
        parts.append(f"{dropped} oldest dropped")
    parts.append(f"backup: {backup_path}")
    return new_log, " | ".join(parts)


class CompactHistoryParams(BaseModel):
    target_tokens: int = Field(
        default=_TARGET_TOKENS,
        description="Target token budget for the compacted history (default 50000).",
    )


@define_tool(
    description=(
        "Compact the conversation history to fit within a token budget. "
        "Backs up the original chat log, then compresses older messages while "
        "preserving the most recent ones exactly. Triggers a session rebuild. "
        "Call this when the conversation is getting long or the context is full."
    )
)
async def compact_history(params: CompactHistoryParams) -> str:
    log = _load_chat_log()
    if not log:
        return "Chat log is empty — nothing to compact."

    target_chars = params.target_tokens * _CHARS_PER_TOKEN
    current_chars = sum(len(e.get("text", "")) for e in log)

    if current_chars <= target_chars:
        return (
            f"History is already within budget "
            f"(~{current_chars // _CHARS_PER_TOKEN:,} tokens, "
            f"target {params.target_tokens:,}). No compaction needed."
        )

    new_log, summary = _do_compact(log, params.target_tokens)
    _save_chat_log(new_log)

    # Signal session rebuild
    if _compact_session_requested is not None:
        _compact_session_requested.set()

    return summary or "No compaction needed."


# ── Tool: Search history backups ────────────────────────────────────────────

class SearchHistoryBackupsParams(BaseModel):
    query: str = Field(description="Text to search for in old conversation history backups.")
    max_results: int = Field(default=20, description="Max matching messages to return.")


@define_tool(
    description=(
        "Search through backed-up conversation history for old messages that were "
        "compacted or dropped. Use this when the user asks about something from a "
        "previous conversation that is no longer in the current history."
    )
)
async def search_history_backups(params: SearchHistoryBackupsParams) -> str:
    profile_dir = _profile_dir()
    if not os.path.isdir(profile_dir):
        return "No profile directory found."

    # Find all backup files, newest first
    backups = sorted(
        [f for f in os.listdir(profile_dir) if f.startswith("chat_log.json.backup.")],
        reverse=True,
    )
    if not backups:
        return "No history backups found."

    q = params.query.lower()
    limit = max(1, min(params.max_results, 50))
    matches = []

    for backup_name in backups:
        backup_path = os.path.join(profile_dir, backup_name)
        try:
            with open(backup_path) as f:
                log = json.load(f)
        except Exception:
            continue

        # Extract timestamp from filename (chat_log.json.backup.YYYYMMDD_HHMMSS)
        ts = backup_name.rsplit(".", 1)[-1]

        for entry in log:
            text = entry.get("text", "")
            if q in text.lower():
                role = entry.get("role", "?")
                time_str = entry.get("time", "")
                # Trim for display
                snippet = text
                if len(snippet) > 300:
                    # Show context around the match
                    idx = snippet.lower().find(q)
                    start = max(0, idx - 100)
                    end = min(len(snippet), idx + len(q) + 100)
                    snippet = ("…" if start > 0 else "") + snippet[start:end] + ("…" if end < len(snippet) else "")
                matches.append(f"[{ts} {time_str}] {role}: {snippet}")
                if len(matches) >= limit:
                    break
        if len(matches) >= limit:
            break

    if not matches:
        return f"No matches for '{params.query}' in {len(backups)} backup(s)."

    header = f"🔍 Found {len(matches)} match(es) across {len(backups)} backup(s):"
    return header + "\n" + "\n".join(matches)


# ── Blender MCP Tools ────────────────────────────────────────────────────────
#
# Connects to the Blender-MCP addon's socket server (default localhost:9876).
# The addon must be enabled in Blender: Preferences → Add-ons → BlenderMCP.

BLENDER_MCP_HOST = os.environ.get("BLENDER_MCP_HOST", "127.0.0.1")
BLENDER_MCP_PORT = int(os.environ.get("BLENDER_MCP_PORT", "9876"))
_blender_available: bool | None = None


async def _blender_send(command: dict, timeout: float = 30.0) -> dict:
    """Send a JSON command to Blender MCP addon and return the response."""
    global _blender_available
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(BLENDER_MCP_HOST, BLENDER_MCP_PORT),
            timeout=5.0,
        )
        payload = json.dumps(command).encode("utf-8")
        writer.write(payload)
        await writer.drain()

        chunks = []
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), timeout=timeout)
            if not chunk:
                break
            chunks.append(chunk)
        writer.close()
        _blender_available = True
        data = json.loads(b"".join(chunks).decode("utf-8"))
        if data.get("status") == "error":
            return {"error": data.get("message", "Unknown Blender error")}
        return data.get("result", data)
    except (ConnectionRefusedError, OSError, asyncio.TimeoutError) as e:
        _blender_available = False
        return {"error": f"Blender not connected ({e}). Enable the BlenderMCP addon and click 'Start'."}
    except Exception as e:
        return {"error": str(e)}


class BlenderSceneParams(BaseModel):
    pass


@define_tool(
    description=(
        "Get information about the current Blender scene: objects, lights, "
        "cameras, materials. Use this to understand what exists before making changes."
    )
)
async def blender_get_scene(params: BlenderSceneParams) -> str:
    result = await _blender_send({"type": "get_scene_info"})
    return json.dumps(result, indent=2)


class BlenderObjectInfoParams(BaseModel):
    object_name: str = Field(description="Name of the Blender object to inspect")


@define_tool(
    description=(
        "Get detailed info about a specific Blender object: mesh data, "
        "materials, transforms, modifiers."
    )
)
async def blender_get_object(params: BlenderObjectInfoParams) -> str:
    result = await _blender_send({
        "type": "get_object_info",
        "params": {"object_name": params.object_name},
    })
    return json.dumps(result, indent=2)


class BlenderCreateObjectParams(BaseModel):
    object_type: str = Field(
        description="Primitive type: cube, sphere, cylinder, cone, torus, plane, uv_sphere, ico_sphere"
    )
    name: str = Field(default="", description="Object name (optional)")
    location: list[float] = Field(default=[0, 0, 0], description="XYZ location")
    scale: list[float] = Field(default=[1, 1, 1], description="XYZ scale")
    rotation: list[float] = Field(default=[0, 0, 0], description="XYZ rotation in radians")


@define_tool(
    description="Create a primitive 3D object in the Blender scene."
)
async def blender_create_object(params: BlenderCreateObjectParams) -> str:
    cmd: dict = {
        "type": "create_object",
        "params": {
            "object_type": params.object_type,
            "location": params.location,
            "scale": params.scale,
            "rotation": params.rotation,
        },
    }
    if params.name:
        cmd["params"]["name"] = params.name
    result = await _blender_send(cmd)
    return json.dumps(result, indent=2)


class BlenderModifyObjectParams(BaseModel):
    object_name: str = Field(description="Name of the object to modify")
    location: list[float] | None = Field(default=None, description="New XYZ location")
    scale: list[float] | None = Field(default=None, description="New XYZ scale")
    rotation: list[float] | None = Field(default=None, description="New XYZ rotation in radians")


@define_tool(
    description="Modify an existing Blender object's position, scale, or rotation."
)
async def blender_modify_object(params: BlenderModifyObjectParams) -> str:
    p: dict = {"object_name": params.object_name}
    if params.location is not None:
        p["location"] = params.location
    if params.scale is not None:
        p["scale"] = params.scale
    if params.rotation is not None:
        p["rotation"] = params.rotation
    result = await _blender_send({"type": "modify_object", "params": p})
    return json.dumps(result, indent=2)


class BlenderDeleteObjectParams(BaseModel):
    object_name: str = Field(description="Name of the object to delete")


@define_tool(
    description="Delete an object from the Blender scene by name."
)
async def blender_delete_object(params: BlenderDeleteObjectParams) -> str:
    result = await _blender_send({
        "type": "delete_object",
        "params": {"object_name": params.object_name},
    })
    return json.dumps(result, indent=2)


class BlenderSetMaterialParams(BaseModel):
    object_name: str = Field(description="Name of the object to apply material to")
    material_name: str = Field(default="", description="Material name")
    color: list[float] = Field(
        default=[0.8, 0.8, 0.8, 1.0],
        description="RGBA color values (0-1 range)",
    )


@define_tool(
    description="Apply or modify a material/color on a Blender object."
)
async def blender_set_material(params: BlenderSetMaterialParams) -> str:
    p: dict = {
        "object_name": params.object_name,
        "material_data": {"color": params.color},
    }
    if params.material_name:
        p["material_name"] = params.material_name
    result = await _blender_send({"type": "set_material", "params": p})
    return json.dumps(result, indent=2)


class BlenderExecuteCodeParams(BaseModel):
    code: str = Field(description="Python code to execute inside Blender (bpy context)")


@define_tool(
    description=(
        "Execute arbitrary Python code inside Blender. Has full access to bpy "
        "and the Blender API. Use for complex operations not covered by other "
        "Blender tools (e.g., adding modifiers, keyframes, compositing nodes)."
    )
)
async def blender_execute_code(params: BlenderExecuteCodeParams) -> str:
    result = await _blender_send({
        "type": "execute_blender_code",
        "params": {"code": params.code},
    })
    return json.dumps(result, indent=2)


class BlenderScreenshotParams(BaseModel):
    max_size: int = Field(default=512, description="Max dimension of the screenshot in pixels")


@define_tool(
    description="Capture a screenshot of the current Blender viewport."
)
async def blender_screenshot(params: BlenderScreenshotParams) -> str:
    result = await _blender_send({
        "type": "get_viewport_screenshot",
        "params": {"max_size": params.max_size},
    })
    if isinstance(result, dict) and "error" not in result:
        return "Screenshot captured. Image data returned from Blender."
    return json.dumps(result, indent=2)


# ── LLM Provider Infrastructure ─────────────────────────────────────────────
#
# Providers (set via LLM_PROVIDER env var or --provider flag):
#   "gemini"   ✨  — Google Gemini API (default, free tier, 1M context)
#   "groq"     ⚡  — Groq cloud API (fast & cheap)
#   "ollama"   🏠  — Local Ollama instance (free, slower)
#   "openai"   🌐  — OpenAI-compatible endpoint (non-Chinese providers)
#   "copilot"  💲  — Copilot SDK fallback (paid premium requests)

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "copilot")

# ── Groq config ──
_groq_key_path = os.path.expanduser("~/.ssh/GROQ_API_KEY")
if not os.environ.get("GROQ_API_KEY") and os.path.isfile(_groq_key_path):
    with open(_groq_key_path) as _f:
        _key = _f.read().strip()
        if _key:
            os.environ["GROQ_API_KEY"] = _key
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# ── OpenAI-compatible config (e.g. OpenRouter, DeepInfra, Together) ──
OPENAI_API_KEY = os.environ.get("OPENAI_COMPAT_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_COMPAT_MODEL", "qwen/qwen3-32b")
OPENAI_URL = os.environ.get(
    "OPENAI_COMPAT_URL", "https://openrouter.ai/api/v1/chat/completions"
)

# ── Ollama config ──
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3-coder:30b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# ── Gemini config ──
_gemini_key_path = os.path.expanduser("~/.ssh/GEMINI_API_KEY")
if not os.environ.get("GEMINI_API_KEY") and os.path.isfile(_gemini_key_path):
    with open(_gemini_key_path) as _f:
        _key = _f.read().strip()
        if _key:
            os.environ["GEMINI_API_KEY"] = _key
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-pro-preview")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

# ── Provider metadata ──
PROVIDER_EMOJI = {
    "gemini": "✨",
    "groq": "⚡",
    "ollama": "🏠",
    "openai": "🌐",
    "copilot": "💲",
}
PROVIDER_LABEL = {
    "gemini": f"Gemini ({GEMINI_MODEL})",
    "groq": f"Groq ({GROQ_MODEL})",
    "ollama": f"Ollama ({OLLAMA_MODEL})",
    "openai": f"OpenAI-compat ({OPENAI_MODEL})",
    "copilot": None,  # dynamic — computed in _copilot_label()
}


def _copilot_label() -> str:
    effort = "high" if _coding_mode else "low"
    return f"Copilot SDK (GPT-5.2-{effort})"


_ollama_ok: bool | None = None


def _free_ram_gb() -> float:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / (1024 * 1024)
    except Exception:
        pass
    return 0.0


async def _ensure_ollama() -> bool:
    """Ensure Ollama is installed, running, and has the model pulled."""
    global _ollama_ok
    if _ollama_ok is not None:
        return _ollama_ok

    if _free_ram_gb() < 16:
        print(f"⚠️  Only {_free_ram_gb():.0f}GB free RAM — skipping local LLM")
        _ollama_ok = False
        return False

    async def _ping() -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{OLLAMA_URL}/api/tags")
                return r.status_code == 200
        except Exception:
            return False

    if not await _ping():
        if not shutil.which("ollama"):
            print("📦 Installing Ollama...")
            try:
                proc = await asyncio.create_subprocess_exec(
                    "bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.wait(), timeout=120)
                if proc.returncode != 0:
                    _ollama_ok = False
                    return False
            except Exception:
                _ollama_ok = False
                return False

        print("🚀 Starting Ollama...")
        try:
            subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            for _ in range(30):
                await asyncio.sleep(1)
                if await _ping():
                    break
            else:
                _ollama_ok = False
                return False
        except Exception:
            _ollama_ok = False
            return False

    # Check if model is already pulled
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{OLLAMA_URL}/api/tags")
            models = [m["name"] for m in r.json().get("models", [])]
            model_base = OLLAMA_MODEL.split(":")[0]
            if not any(model_base in m for m in models):
                print(f"📥 Pulling {OLLAMA_MODEL} (this may take a while)...")
                proc = await asyncio.create_subprocess_exec(
                    "ollama", "pull", OLLAMA_MODEL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.wait(), timeout=1800)
                if proc.returncode != 0:
                    _ollama_ok = False
                    return False
                print(f"✅ {OLLAMA_MODEL} ready")
    except Exception:
        _ollama_ok = False
        return False

    _ollama_ok = True
    return True


def _tools_to_openai_format(tool_funcs: list) -> list[dict]:
    """Convert @define_tool functions to OpenAI tool call format."""
    import inspect
    tools = []
    for func in tool_funcs:
        fname = getattr(func, "name", None) or func.__name__

        # SDK Tool objects already carry a parameters schema
        if hasattr(func, "parameters") and isinstance(func.parameters, dict):
            properties = {k: v for k, v in func.parameters.get("properties", {}).items()}
            required = func.parameters.get("required", [])
            for prop in properties.values():
                prop.pop("title", None)
        else:
            sig = inspect.signature(func)
            params_type = None
            for p in sig.parameters.values():
                if p.annotation and p.annotation is not inspect.Parameter.empty:
                    params_type = p.annotation
                    break
            properties = {}
            required = []
            if params_type and hasattr(params_type, "model_json_schema"):
                schema = params_type.model_json_schema()
                properties = schema.get("properties", {})
                required = schema.get("required", [])
                for prop in properties.values():
                    prop.pop("title", None)

        desc = getattr(func, "_tool_description", "") or getattr(func, "description", "") or getattr(func, "__doc__", "") or ""
        tools.append({
            "type": "function",
            "function": {
                "name": fname,
                "description": desc,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        })
    return tools


async def _openai_chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    stream: bool = True,
    *,
    api_url: str,
    api_key: str,
    model: str,
) -> dict:
    """OpenAI-compatible chat completion (works with Groq, OpenRouter, etc.)."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    body: dict = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "stream_options": {"include_usage": True} if stream else None,
    }
    if not stream:
        body.pop("stream_options")
    # Gemini thinking config
    if "gemini-3" in model:
        body["google"] = {
            "thinking_config": {"thinking_level": "low"}
        }
    elif "gemini-2.5" in model:
        body["google"] = {
            "thinking_config": {
                "thinking_budget": 2048,
                "include_thoughts": False,
            }
        }
    if tools:
        body["tools"] = tools
        body["stream"] = False
        stream = False

    timeout = httpx.Timeout(300.0, connect=10.0)

    if not stream:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(api_url, headers=headers, json=body)
            r.raise_for_status()
            rjson = r.json()
            choice = rjson["choices"][0]
            usage = rjson.get("usage", {})
            msg = choice["message"]
            # Gemini thinking models may return None content
            if msg.get("content") is None:
                msg["content"] = ""
            return msg, usage

    # Streaming
    full_content = ""
    usage: dict = {}
    async with httpx.AsyncClient(timeout=timeout) as c:
        async with c.stream("POST", api_url, headers=headers, json=body) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                # Capture usage from final chunk
                if "usage" in chunk:
                    usage = chunk["usage"]
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                text = delta.get("content") or ""
                if text:
                    print(text, end="", flush=True)
                    full_content += text

    final_msg = {"role": "assistant", "content": full_content}
    return final_msg, usage


async def _ollama_chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    stream: bool = True,
) -> dict:
    """Ollama chat completion."""
    body: dict = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": stream,
    }
    if tools:
        body["tools"] = tools
        body["stream"] = False
        stream = False

    timeout = httpx.Timeout(300.0, connect=10.0)

    if not stream:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{OLLAMA_URL}/api/chat", json=body)
            r.raise_for_status()
            return r.json().get("message", {}), {}

    full_content = ""
    final_msg: dict = {}
    async with httpx.AsyncClient(timeout=timeout) as c:
        async with c.stream("POST", f"{OLLAMA_URL}/api/chat", json=body) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if chunk.get("done"):
                    final_msg = chunk.get("message", {"role": "assistant", "content": full_content})
                    break
                delta = chunk.get("message", {}).get("content", "")
                if delta:
                    print(delta, end="", flush=True)
                    full_content += delta

    if not final_msg:
        final_msg = {"role": "assistant", "content": full_content}
    return final_msg, {}


async def _provider_chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    stream: bool = True,
    provider: str | None = None,
) -> tuple[dict, dict]:
    """Route chat to the active provider. Returns (message, usage)."""
    prov = provider or LLM_PROVIDER
    if prov == "gemini":
        return await _openai_chat(
            messages, tools, stream,
            api_url=GEMINI_URL, api_key=GEMINI_API_KEY, model=GEMINI_MODEL,
        )
    elif prov == "groq":
        return await _openai_chat(
            messages, tools, stream,
            api_url=GROQ_URL, api_key=GROQ_API_KEY, model=GROQ_MODEL,
        )
    elif prov == "openai":
        return await _openai_chat(
            messages, tools, stream,
            api_url=OPENAI_URL, api_key=OPENAI_API_KEY, model=OPENAI_MODEL,
        )
    elif prov == "ollama":
        return await _ollama_chat(messages, tools, stream)
    else:
        raise ValueError(f"Unknown provider: {prov} (use gemini/groq/ollama/openai/copilot)")


async def _run_tool_loop(
    prompt: str,
    tool_funcs: list,
    system_message: str,
    provider: str | None = None,
    max_rounds: int = 10,
    history: list[dict] | None = None,
) -> tuple[str, list[dict]]:
    """Run a full tool-calling loop via any OpenAI-compatible provider.
    Returns (final_response_text, updated_messages) so caller can maintain history."""
    import inspect
    prov = provider or LLM_PROVIDER
    emoji = PROVIDER_EMOJI.get(prov, "?")
    tool_map = {(getattr(f, 'name', None) or f.__name__): f for f in tool_funcs}
    tools_schema = _tools_to_openai_format(tool_funcs)

    messages = [{"role": "system", "content": system_message}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": prompt})

    for _round in range(max_rounds):
        response, resp_usage = await _provider_chat(messages, tools=tools_schema, stream=False, provider=prov)
        _usage.record_local_turn(prov, resp_usage)

        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            content = response.get("content", "")
            if content:
                print(content, end="", flush=True)
                # Build clean history: user/assistant pairs only
                conv = [m for m in messages[1:] if m.get("role") in ("user", "assistant") and not m.get("tool_calls")]
                conv.append({"role": "assistant", "content": content})
                return content, conv
            messages.append(response)
            response, resp_usage = await _provider_chat(messages, tools=None, stream=True, provider=prov)
            _usage.record_local_turn(prov, resp_usage)
            content = response.get("content", "")
            conv = [m for m in messages[1:] if m.get("role") in ("user", "assistant") and not m.get("tool_calls")]
            conv.append({"role": "assistant", "content": content})
            return content, conv

        messages.append(response)

        async def _exec_tool(tc):
            fn = tc.get("function", {})
            fn_name = fn.get("name", "")
            fn_args = fn.get("arguments", {})
            if isinstance(fn_args, str):
                try:
                    fn_args = json.loads(fn_args)
                except json.JSONDecodeError:
                    fn_args = {}
            func = tool_map.get(fn_name)
            if not func:
                return tc.get("id", ""), fn_name, f"Unknown tool: {fn_name}"
            # Use original function for non-SDK providers
            callable_fn = getattr(func, '_original_fn', func)
            try:
                sig = inspect.signature(callable_fn)
                params_type = None
                for p in sig.parameters.values():
                    if p.annotation and p.annotation is not inspect.Parameter.empty:
                        params_type = p.annotation
                        break
                if params_type:
                    result = await callable_fn(params_type(**fn_args))
                else:
                    result = await callable_fn()
            except Exception as e:
                result = f"Error calling {fn_name}: {e}"
            return tc.get("id", ""), fn_name, result

        tasks = [_exec_tool(tc) for tc in tool_calls]
        results = await asyncio.gather(*tasks)

        tool_names = [name for _, name, _ in results]
        print(f"  {emoji} 🔧 {', '.join(tool_names)}", flush=True)

        for call_id, fn_name, result in results:
            _usage.record(fn_name)
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": fn_name,
                "content": str(result),
            })

    # Max rounds — final summary
    response, resp_usage = await _provider_chat(messages, tools=None, stream=True, provider=prov)
    _usage.record_local_turn(prov, resp_usage)
    content = response.get("content", "")
    conv = [m for m in messages[1:] if m.get("role") in ("user", "assistant") and not m.get("tool_calls")]
    conv.append({"role": "assistant", "content": content})
    return content, conv


# ── Speech-to-text via Groq Whisper ─────────────────────────────────────────

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "whisper-large-v3")
_stt_enabled = False


def _check_stt_deps() -> bool:
    """Check if audio recording dependencies are available."""
    try:
        import sounddevice  # noqa: F401
        return True
    except (ImportError, OSError):
        return False


async def _record_and_transcribe(duration: float = 5.0) -> str:
    """Record audio from mic and transcribe via Groq Whisper API."""
    import sounddevice as sd
    import tempfile
    import wave

    sample_rate = 16000
    print(f"🎤 Recording ({duration}s)... ", end="", flush=True)

    # Record audio synchronously (sounddevice blocks)
    audio = sd.rec(
        int(duration * sample_rate),
        samplerate=sample_rate,
        channels=1,
        dtype="int16",
    )
    sd.wait()
    print("done. Transcribing... ", end="", flush=True)

    # Write to temp WAV file
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
        with wave.open(tmp, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(audio.tobytes())

    try:
        # Send to Groq Whisper API
        timeout = httpx.Timeout(30.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as c:
            with open(tmp_path, "rb") as f:
                r = await c.post(
                    "https://api.groq.com/openai/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                    files={"file": ("audio.wav", f, "audio/wav")},
                    data={"model": WHISPER_MODEL},
                )
            r.raise_for_status()
            text = r.json().get("text", "").strip()
            print(f"✅ \"{text}\"")
            return text
    finally:
        os.unlink(tmp_path)


def _build_all_tools():
    """Single source of truth for the tool list used by all UI modes."""
    return [
        get_my_location, setup_google_auth,
        places_text_search, places_nearby_search,
        estimate_travel_time, estimate_traffic_adjusted_time, get_directions,
        web_search, search_news, get_usage,
        search_papers, search_arxiv,
        search_movies, get_movie_details,
        search_games, get_game_details,
        steam_search, steam_app_details, steam_featured,
        steam_player_stats, steam_user_games, steam_user_summary,
        # Coding agent tools
        set_working_dir, get_working_dir,
        create_file, apply_patch, code_grep, tree, read_file,
        git_status, git_diff, git_commit, git_log, git_checkout,
        run_command, launch_agent,
        # Knowledge tools
        stack_search, stack_answers,
        wiki_search, wiki_summary, wiki_full, wiki_grep,
        recipe_search, recipe_lookup,
        music_search, music_lookup,
        spotify_auth, spotify_search, spotify_create_playlist, spotify_add_tracks,
        scrape_page, browse_web,
        save_place, remove_place, list_places,
        set_alarm, list_alarms, cancel_alarm,
        generate_ntfy_topic, ntfy_subscribe, ntfy_unsubscribe,
        ntfy_publish, ntfy_list,
        switch_profile, update_preferences, exit_app,
        write_note, read_note, notes_mkdir, notes_ls,
        yt_dlp_download,
        calendar_add_event, calendar_delete_event,
        calendar_view, calendar_list_upcoming,
        file_read_lines, file_apply_patch,
        github_search, github_clone, github_read_file,
        github_grep,
        create_ticket,
        weather_forecast,
        convert_units,
        dictionary_lookup,
        translate_text,
        timer_start, timer_check, timer_stop,
        system_info,
        read_rss,
        download_file,
        bookmark_save, bookmark_list, bookmark_search,
        compact_history,
        search_history_backups,
        blender_get_scene, blender_get_object, blender_create_object,
        blender_modify_object, blender_delete_object, blender_set_material,
        blender_execute_code, blender_screenshot,
    ]


class SessionManager:
    """Manages provider selection, SDK sessions, and prompt dispatch.

    Used by both plain and curses UI paths so provider logic is not duplicated.
    """

    def __init__(self, all_tools: list, on_delta=None, on_message=None, on_idle=None):
        self.all_tools = all_tools
        self.active_provider = LLM_PROVIDER
        self.emoji = ""
        self.label = ""
        self._sdk_client = None
        self._sdk_session = None
        self._done = asyncio.Event()
        self._chunks: list[str] = []
        self._SESSION_TIMEOUT = 180
        self._conversation: list[dict] = []  # conversation history for non-SDK providers
        # Callbacks for streaming (curses uses these; plain uses print)
        self._on_delta = on_delta
        self._on_message = on_message
        self._on_idle = on_idle

    async def init_provider(self):
        """Determine and initialize the active provider from CLI flags."""
        for a in sys.argv[1:]:
            if a.startswith("--provider="):
                self.active_provider = a.split("=", 1)[1]
            elif a == "--provider" and sys.argv.index(a) + 1 < len(sys.argv):
                self.active_provider = sys.argv[sys.argv.index(a) + 1]

        if self.active_provider == "ollama":
            ok = await _ensure_ollama()
            if not ok:
                self.active_provider = "gemini" if GEMINI_API_KEY else ("groq" if GROQ_API_KEY else "copilot")

        self.emoji = PROVIDER_EMOJI.get(self.active_provider, "?")
        self.label = _copilot_label() if self.active_provider == "copilot" else PROVIDER_LABEL.get(self.active_provider, self.active_provider)

        # Seed conversation history from chat log for context continuity
        if self.active_provider != "copilot":
            chat_log = _load_chat_log()
            for entry in chat_log[-20:]:  # last 20 entries for context
                role = entry.get("role", "")
                text = entry.get("text", "")
                if role == "you":
                    self._conversation.append({"role": "user", "content": text})
                elif role == "assistant":
                    self._conversation.append({"role": "assistant", "content": text})

    def _on_event(self, event):
        etype = event.type.value
        if etype == "assistant.message_delta":
            delta = event.data.delta_content or ""
            self._chunks.append(delta)
            if self._on_delta:
                self._on_delta(delta)
            else:
                print(delta, end="", flush=True)
        elif etype == "assistant.message":
            _usage.record_llm_turn()
            if not self._chunks:
                text = event.data.content
                if self._on_message:
                    self._on_message(text)
                else:
                    print(text)
                _append_chat("assistant", text)
            else:
                text = "".join(self._chunks).strip()
                if self._on_message:
                    self._on_message(text)
                else:
                    print()
                _append_chat("assistant", text)
            if not self._on_message and _usage.should_report():
                print(f"\n{_usage.summary()}\n")
        elif etype == "session.idle":
            self._done.set()
            if self._on_idle:
                self._on_idle()

    async def _get_sdk_session(self):
        if self._sdk_session is not None:
            return self._sdk_session
        if CopilotClient is None:
            raise RuntimeError("Copilot SDK not installed — cannot use paid fallback")
        import shutil
        cli_path = shutil.which("copilot") or "copilot"
        self._sdk_client = CopilotClient({"cli_path": cli_path})
        await self._sdk_client.start()
        effort = "high" if _coding_mode else "low"
        self._sdk_session = await self._sdk_client.create_session({
            "model": "gpt-5.2",
            "reasoning_effort": effort,
            "tools": self.all_tools,
            "system_message": {"content": _build_system_message()},
        })
        return self._sdk_session

    async def rebuild_sdk_session(self):
        if self._sdk_session:
            await self._sdk_session.destroy()
        effort = "high" if _coding_mode else "low"
        self._sdk_session = await self._sdk_client.create_session({
            "model": "gpt-5.2",
            "reasoning_effort": effort,
            "tools": self.all_tools,
            "system_message": {"content": _build_system_message()},
        })
        return self._sdk_session

    async def _send_sdk(self, user_prompt: str):
        session = await self._get_sdk_session()
        session.on(self._on_event)
        self._done.clear()
        self._chunks.clear()
        await session.send({"prompt": user_prompt})
        timeout = 900 if _coding_mode else self._SESSION_TIMEOUT
        try:
            await asyncio.wait_for(self._done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            msg = f"\n⚠️  Response timed out after {timeout}s. Try again."
            if self._on_message:
                self._on_message(msg)
            else:
                print(msg)

    async def send_prompt(self, user_prompt: str, force_sdk: bool = False) -> str | None:
        """Send a prompt via active provider, with Copilot SDK as fallback.

        Returns the response text when using the tool loop provider,
        or None when the SDK path handles output via callbacks.
        """
        if not force_sdk and self.active_provider != "copilot":
            try:
                rounds = 50 if _coding_mode else 10
                result, conv = await _run_tool_loop(
                    user_prompt, self.all_tools, _build_system_message(),
                    provider=self.active_provider,
                    history=self._conversation,
                    max_rounds=rounds,
                )
                # Keep conversation history (cap to avoid unbounded growth)
                cap = 100 if _coding_mode else 40
                self._conversation = conv[-cap:]
                # Return result first so UI displays immediately;
                # save to chat log after (cached, fast)
                stripped = result.strip() if result else ""
                _append_chat("assistant", stripped)
                return result
            except Exception as e:
                msg = f"\n⚠️  {self.emoji} error: {e} — falling back to 💲 Copilot SDK"
                if self._on_message:
                    self._on_message(msg)
                else:
                    print(msg)
        await self._send_sdk(user_prompt)
        return None

    async def cleanup(self):
        if self._sdk_session:
            await self._sdk_session.destroy()
        if self._sdk_client:
            await self._sdk_client.stop()


async def _run_curses_interactive(stdscr):
    """Run the curses UI as a thin display wrapper around the core app logic."""
    global _profile_switch_requested, _compact_session_requested, _coding_mode
    import sys as _sys
    import curses_ui

    # Re-initialize events for this event loop
    _profile_switch_requested = asyncio.Event()
    _compact_session_requested = asyncio.Event()
    _ensure_prefs_file()

    all_tools = _build_all_tools()

    # Redirect stdout/stderr so library warnings don't corrupt curses
    _log_path = os.path.join(
        os.path.expanduser("~/.config/local-finder"), "curses.log"
    )
    os.makedirs(os.path.dirname(_log_path), exist_ok=True)
    _log_file = open(_log_path, "a")
    _orig_stdout = _sys.stdout
    _orig_stderr = _sys.stderr
    _sys.stdout = _log_file
    _sys.stderr = _log_file

    ui = curses_ui.CursesUI(stdscr)
    stdscr.timeout(100)  # getch returns -1 after 100ms so animation can tick

    hp = _history_path()
    ui.load_history(hp)

    def update_status():
        n_msgs = len(ui.messages)
        subs = len(_load_ntfy_subs())
        status = (
            f" {mgr.emoji} {mgr.label} │ Profile: {_active_profile} │ "
            f"Messages: {n_msgs} │ Subs: {subs} │ "
            f"{_usage.summary_oneline()}"
        )
        ui.set_status(status)

    # Wire up SessionManager with curses display callbacks
    done = asyncio.Event()

    def _on_delta(delta):
        ui.stream_delta(delta)
        ui.render()

    def _on_message(text):
        if ui.is_streaming:
            ui.end_stream()
        else:
            ui.add_message("assistant", text)
        update_status()
        ui.render()

    def _on_idle():
        if ui.is_streaming:
            ui.end_stream()
        done.set()
        ui.render()

    mgr = SessionManager(all_tools, on_delta=_on_delta, on_message=_on_message, on_idle=_on_idle)
    await mgr.init_provider()

    # Show ASCII art splash
    _art_path = os.path.join(os.path.dirname(__file__), "marvin.txt")
    ui.render_splash(_art_path)

    # Load full chat log into the UI as scrollable messages
    chat_log = _load_chat_log()
    if chat_log:
        for entry in chat_log:
            role = entry.get("role", "system")
            text = entry.get("text", "")
            ui.add_message(role, text)
        ui.add_message("system",
            f"─── Session resumed ───\n"
            f"Profile: {_active_profile} │ {mgr.emoji} Provider: {mgr.label}\n"
            f"Scroll: PgUp/PgDn, Shift+↑↓, mouse wheel. Ctrl+Q to quit."
        )
    else:
        ui.add_message("system",
            f"Welcome to Local Finder!\n"
            f"Profile: {_active_profile} │ {mgr.emoji} Provider: {mgr.label}\n"
            f"Type your message below. PgUp/PgDn to scroll. Ctrl+Q to quit."
        )
    update_status()
    ui.render()

    queued_prompt = None
    submitted = None
    busy = False

    async def _do_send(prompt_text: str):
        nonlocal busy
        ui.begin_stream()
        update_status()
        ui.render()
        done.clear()
        busy = True

        result = await mgr.send_prompt(prompt_text)
        # _run_tool_loop returns text directly (non-SDK path)
        if result is not None:
            if ui.is_streaming:
                ui.end_stream()
            ui.add_message("assistant", result.strip())
            update_status()
            ui.render()
            busy = False
            done.set()

    try:
        while True:
            if _exit_requested.is_set():
                break

            key = stdscr.getch()

            if key == 4 or key == 17:  # Ctrl+D or Ctrl+Q
                break

            if key != -1 and not busy:
                result = ui.handle_key(key)
                ui.render()

                if result is not None:
                    submitted = result
                    lower = submitted.lower()
                    if lower in ("quit", "exit"):
                        break
                    elif lower == "preferences":
                        ui.add_message("system",
                            f"Preferences file: {_prefs_path()}\n"
                            f"(Edit preferences from the regular terminal mode.)")
                        ui.render()
                    elif lower == "profiles":
                        ui.add_message("system",
                            f"Active: {_active_profile}\n"
                            f"Available: {', '.join(_list_profiles())}")
                        ui.render()
                    elif lower == "usage":
                        ui.add_message("system",
                            f"{_usage.summary()}\n{_usage.lifetime_summary()}")
                        ui.render()
                    elif lower == "saved":
                        places = _load_saved_places()
                        if not places:
                            ui.add_message("system", "No saved places yet.")
                        else:
                            lines = [f"Saved places ({len(places)}):"]
                            for p in places:
                                name = p.get("label", "?").upper()
                                if p.get("name"):
                                    name += f" — {p['name']}"
                                lines.append(name)
                                if p.get("address"):
                                    lines.append(f"  📍 {p['address']}")
                            ui.add_message("system", "\n".join(lines))
                        ui.render()
                    elif lower == "!code":
                        _coding_mode = not _coding_mode
                        state = "ON 🔧" if _coding_mode else "OFF"
                        info = f"Coding mode {state}"
                        if _coding_mode:
                            info += "\n  Max tool rounds: 50 | Context: 100 msgs | Reasoning: high"
                            if _coding_working_dir:
                                info += f"\n  Working dir: {_coding_working_dir}"
                            else:
                                info += "\n  Set working dir with: set_working_dir"
                        ui.add_message("system", info)
                        ui.render()
                        # Rebuild SDK session to pick up reasoning_effort change
                        await mgr.rebuild_sdk_session()
                        mgr.label = _copilot_label()
                    else:
                        try:
                            notifs = await _check_all_subscriptions()
                            if notifs:
                                ui.add_message("system", f"🔔 {notifs}")
                        except Exception:
                            pass

                        ui.add_message("you", submitted)
                        _append_chat("you", submitted)
                        await _do_send(submitted)

            elif key != -1 and busy:
                if key == 4 or key == 17:
                    break
                result = ui.handle_key(key)
                if result is not None:
                    queued_prompt = result
                ui.render()

            # Check if response just finished
            if done.is_set() and busy:
                busy = False

                if _profile_switch_requested.is_set():
                    _profile_switch_requested.clear()
                    await mgr.rebuild_sdk_session()
                    ui.add_message("system",
                        f"Session rebuilt for profile: {_active_profile}")
                    await _do_send(submitted)

                if _compact_session_requested.is_set():
                    _compact_session_requested.clear()
                    await mgr.rebuild_sdk_session()
                    ui.add_message("system", "Session rebuilt with compacted history")

                update_status()
                ui.render()

                if queued_prompt and not busy:
                    submitted = queued_prompt
                    queued_prompt = None
                    ui.add_message("you", submitted)
                    _append_chat("you", submitted)
                    await _do_send(submitted)
            await asyncio.sleep(0.03)

            update_status()
            ui.render()
    finally:
        try:
            if ui.input_history:
                os.makedirs(os.path.dirname(hp), exist_ok=True)
                with open(hp, "w") as f:
                    f.write("_HiStOrY_V2_\n")
                    for line in ui.input_history[-1000:]:
                        f.write(line + "\n")
        except Exception:
            pass
        _save_last_profile()
        _usage.save()
        await mgr.cleanup()

        _sys.stdout = _orig_stdout
        _sys.stderr = _orig_stderr
        _log_file.close()


class _CursesRequested(Exception):
    pass


async def _run_non_interactive():
    """Run a single prompt non-interactively (for sub-agent dispatch)."""
    global _coding_mode, _coding_working_dir, _auto_approve_commands

    _auto_approve_commands = True  # sub-agents don't prompt for shell commands

    # Parse args
    prompt_text = None
    working_dir = None
    skip_next = False
    for i, a in enumerate(sys.argv[1:], 1):
        if skip_next:
            skip_next = False
            continue
        if a == "--prompt" and i < len(sys.argv) - 1:
            prompt_text = sys.argv[i + 1]
            skip_next = True
        elif a == "--working-dir" and i < len(sys.argv) - 1:
            working_dir = sys.argv[i + 1]
            skip_next = True

    if not prompt_text:
        print("Error: --prompt is required in non-interactive mode", file=sys.stderr)
        sys.exit(1)

    # Set up coding mode
    _coding_mode = True
    if working_dir:
        _coding_working_dir = os.path.abspath(working_dir)

    # Use model from env if specified
    model_override = os.environ.get("MARVIN_MODEL")

    all_tools = _build_all_tools()
    system_msg = _build_system_message()

    model_override = os.environ.get("MARVIN_MODEL")  # e.g. "claude-opus-4.6"

    # Route through Copilot SDK when available — it handles all model tiers.
    # Fall back to _run_tool_loop only for explicit non-SDK providers.
    use_sdk = CopilotClient is not None and LLM_PROVIDER == "copilot"
    # If MARVIN_MODEL is set to a known non-SDK provider, use the tool loop instead
    _non_sdk_providers = {"gemini", "groq", "ollama", "openai"}
    if model_override and model_override in _non_sdk_providers:
        use_sdk = False

    try:
        if use_sdk:
            import shutil
            cli_path = shutil.which("copilot") or "copilot"
            client = CopilotClient({"cli_path": cli_path})
            await client.start()
            done = asyncio.Event()
            chunks: list[str] = []

            def _on_event(event):
                etype = event.get("type", "")
                if etype == "content.delta":
                    delta = event.get("delta", "")
                    chunks.append(delta)
                    # Each delta on its own line so subprocess pipe can stream
                    print(delta, flush=True)
                elif etype == "session.idle":
                    done.set()

            sdk_model = model_override or "gpt-5.2"
            session = await client.create_session({
                "model": sdk_model,
                "reasoning_effort": "high" if _coding_mode else "low",
                "tools": all_tools,
                "system_message": {"content": system_msg},
            })
            session.on(_on_event)
            await session.send({"prompt": prompt_text})
            try:
                await asyncio.wait_for(done.wait(), timeout=900)
            except asyncio.TimeoutError:
                print("\n(timed out after 900s)", file=sys.stderr)
            print()  # final newline
            await session.destroy()
            await client.stop()
        else:
            prov = model_override or LLM_PROVIDER
            result, _ = await _run_tool_loop(
                prompt_text, all_tools, system_msg,
                provider=prov,
                max_rounds=50,
            )
            print(result or "(no output)")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


async def main():
    global _profile_switch_requested, _compact_session_requested, _coding_mode, _coding_working_dir

    # Non-interactive sub-agent mode
    if "--non-interactive" in sys.argv:
        await _run_non_interactive()
        return

    # Curses is default; --plain disables it
    use_plain = "--plain" in sys.argv
    # Filter out flags from prompt args
    skip_next = False
    args = []
    for a in sys.argv[1:]:
        if skip_next:
            skip_next = False
            continue
        if a in ("--plain", "--curses"):
            continue
        if a == "--provider":
            skip_next = True
            continue
        if a.startswith("--provider="):
            continue
        args.append(a)

    if not GOOGLE_API_KEY and not shutil.which("gcloud"):
        pass  # Places will silently fall back to OpenStreetMap

    _ensure_prefs_file()
    _profile_switch_requested = asyncio.Event()
    _compact_session_requested = asyncio.Event()

    prompt = " ".join(args) if args else None
    interactive = prompt is None

    if not use_plain and interactive:
        raise _CursesRequested()

    all_tools = _build_all_tools()

    mgr = SessionManager(all_tools)
    await mgr.init_provider()

    emoji = mgr.emoji
    label = mgr.label
    print(f"{emoji} Provider: {label}")

    async def _send_prompt(user_prompt: str, force_sdk: bool = False):
        await mgr.send_prompt(user_prompt, force_sdk=force_sdk)

    # Schedule calendar reminders on startup
    _schedule_calendar_reminders()

    if interactive:
        _setup_readline()
        history = _compact_history()
        if history:
            print(f"Welcome back! Profile: {_active_profile}")
            print(f"{emoji} Provider: {label}")
            print(f"Recent history:\n{history}")
        else:
            print("Marvin — interactive mode")
            print(f"Profile: {_active_profile} | {emoji} Provider: {label}")
        print("Tab to complete, Ctrl+R to search history, 'quit' to exit.")
        if _check_stt_deps() and GROQ_API_KEY:
            _stt_enabled = True
            print("🎤 Voice: '!v' for one-shot, '!voice' to toggle always-on")
        # Check Blender connection
        _bl_test = await _blender_send({"type": "get_scene_info"})
        if "error" not in _bl_test:
            print("🎨 Blender connected — use natural language to control 3D scenes")
        print()
        shell_mode = False
        voice_mode = False
        try:
            while True:
                if _exit_requested.is_set():
                    break
                try:
                    mode_tag = "shell" if shell_mode else _active_profile
                    prompt = input(f"[{mode_tag}] {'$' if shell_mode else 'You'}: ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break
                if not prompt:
                    if voice_mode and _stt_enabled:
                        try:
                            prompt = await _record_and_transcribe()
                        except Exception as e:
                            print(f"⚠️  Voice error: {e}\n")
                            continue
                        if not prompt:
                            print("(no speech detected)\n")
                            continue
                    else:
                        continue

                # Toggle shell mode
                if prompt.lower() in ("!shell", "!sh"):
                    shell_mode = not shell_mode
                    state = "ON" if shell_mode else "OFF"
                    print(f"Shell mode {state}. "
                          f"{'Type commands directly. !shell to exit.' if shell_mode else 'Back to Marvin.'}\n")
                    continue

                # Toggle coding mode
                if prompt.lower() == "!code":
                    global _coding_mode
                    _coding_mode = not _coding_mode
                    state = "ON 🔧" if _coding_mode else "OFF"
                    print(f"Coding mode {state}")
                    if _coding_mode:
                        print("  Max tool rounds: 50 | Context: 100 msgs")
                        if _coding_working_dir:
                            print(f"  Working dir: {_coding_working_dir}")
                        else:
                            print("  Set working dir with: set_working_dir")
                    print()
                    if _coding_mode and mgr.active_provider != "copilot":
                        await mgr.rebuild_sdk_session()
                    continue

                # Voice mode toggle
                if prompt.lower() == "!voice" and _stt_enabled:
                    voice_mode = not voice_mode
                    state = "ON 🎤" if voice_mode else "OFF"
                    print(f"Voice mode {state}\n")
                    continue

                # Blender connection status
                if prompt.lower() == "!blender":
                    _bl_test = await _blender_send({"type": "get_scene_info"})
                    if "error" in _bl_test:
                        print(f"❌ Blender: {_bl_test['error']}\n")
                    else:
                        obj_count = _bl_test.get("object_count", "?")
                        print(f"🎨 Blender connected — {obj_count} objects in scene\n")
                    continue

                # One-shot voice input
                if prompt.lower().startswith("!v") and _stt_enabled:
                    parts = prompt.split(None, 1)
                    dur = 5.0
                    if len(parts) > 1:
                        try:
                            dur = float(parts[1])
                        except ValueError:
                            pass
                    try:
                        prompt = await _record_and_transcribe(dur)
                    except Exception as e:
                        print(f"⚠️  Voice error: {e}\n")
                        continue
                    if not prompt:
                        print("(no speech detected)\n")
                        continue

                # Shell mode: run command directly
                if shell_mode or (prompt.startswith("!") and not prompt.startswith("!pro")):
                    cmd_str = prompt if shell_mode else prompt[1:].strip()
                    if not cmd_str:
                        continue
                    print(f"$ {cmd_str}")
                    try:
                        result = subprocess.run(
                            cmd_str, shell=True,
                            capture_output=True, text=True, timeout=120,
                        )
                        output = (result.stdout + result.stderr).rstrip()
                    except subprocess.TimeoutExpired:
                        output = "(command timed out after 120s)"
                    except Exception as e:
                        output = f"(error: {e})"
                    if output:
                        print(output)
                    else:
                        print("(no output)")
                    _append_chat("you", f"$ {cmd_str}")
                    _append_chat("assistant", output or "(no output)")
                    print()
                    continue
                if prompt.lower() == "preferences":
                    print(f"Opening {_prefs_path()}")
                    editor = os.environ.get("EDITOR", "nano")
                    subprocess.call([editor, _prefs_path()])
                    print("Preferences reloaded.\n")
                    continue
                if prompt.lower() == "profiles":
                    print(f"Active: {_active_profile}")
                    print(f"Available: {', '.join(_list_profiles())}\n")
                    continue
                if prompt.lower() == "usage":
                    print(_usage.summary())
                    print()
                    print(_usage.lifetime_summary())
                    print()
                    continue
                if prompt.lower() == "saved":
                    places = _load_saved_places()
                    if not places:
                        print("No saved places yet.\n")
                    else:
                        print(f"Saved places ({len(places)}):")
                        for p in places:
                            parts = [p.get("label", "?").upper()]
                            if p.get("name"):
                                parts[0] += f" — {p['name']}"
                            if p.get("address"):
                                parts.append(f"  📍 {p['address']}")
                            if p.get("phone"):
                                parts.append(f"  📞 {p['phone']}")
                            if p.get("website"):
                                parts.append(f"  🌐 {p['website']}")
                            print("\n".join(parts))
                        print()
                    continue

                # Check ntfy subscriptions before each prompt
                notifs = await _check_all_subscriptions()
                if notifs:
                    print(f"\n{notifs}\n")

                # Check for !pro prefix to force paid model
                force_sdk = False
                if prompt.lower().startswith("!pro "):
                    force_sdk = True
                    prompt = prompt[5:].strip()
                    print("☁️  Forcing Copilot SDK for this query")

                _exit_requested.clear()
                _profile_switch_requested.clear()
                _compact_session_requested.clear()
                _append_chat("you", prompt)
                print(f"[{_time.strftime('%a %b %d %H:%M:%S %Z %Y')}]")
                print(f"{emoji} Marvin: ", end="", flush=True)
                await _send_prompt(prompt, force_sdk=force_sdk)
                print()

                # If profile was switched, rebuild SDK session if active
                if _profile_switch_requested.is_set():
                    _profile_switch_requested.clear()
                    await mgr.rebuild_sdk_session()
                    print(f"[Profile switched: {_active_profile}]\n")

                    _append_chat("you", prompt)
                    print(f"[{_time.strftime('%a %b %d %H:%M:%S %Z %Y')}]")
                    print(f"{emoji} Marvin: ", end="", flush=True)
                    await _send_prompt(prompt, force_sdk=force_sdk)
                    print()

                if _compact_session_requested.is_set():
                    _compact_session_requested.clear()
                    await mgr.rebuild_sdk_session()
                    print("[Session rebuilt with compacted history]\n")
        finally:
            _save_history()
            _save_last_profile()
            _usage.save()
    else:
        _append_chat("you", prompt)
        print(f"{emoji} Marvin: ", end="", flush=True)
        await _send_prompt(prompt)
        print()
        _usage.save()

    await mgr.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except _CursesRequested:
        import curses as _curses
        import app as _app
        import traceback as _tb
        def _run(stdscr):
            try:
                asyncio.run(_app._run_curses_interactive(stdscr))
            except Exception:
                # Curses swallows errors — save to file and re-raise
                err = _tb.format_exc()
                try:
                    log = os.path.expanduser("~/.config/local-finder/crash.log")
                    os.makedirs(os.path.dirname(log), exist_ok=True)
                    with open(log, "w") as f:
                        f.write(err)
                except Exception:
                    pass
                raise
        try:
            _curses.wrapper(_run)
        except Exception as e:
            crash_log = os.path.expanduser("~/.config/local-finder/crash.log")
            if os.path.exists(crash_log):
                with open(crash_log) as f:
                    print(f.read(), file=sys.stderr)
            else:
                print(f"Crashed: {e}", file=sys.stderr)
                _tb.print_exc()
