"""
Local business finder using GitHub Copilot SDK + Google Places API (New).

The LLM decides when to call the places search tools based on your prompt.
Set GOOGLE_PLACES_API_KEY env var before running.
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
            return decorator(fn)
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

    def __init__(self):
        self.calls: dict[str, int] = {}
        self.total_paid_calls = 0
        self.session_cost = 0.0
        self.llm_turns = 0
        self.ollama_turns = 0
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

    def record_local_turn(self, provider: str = "ollama"):
        """Record a turn handled by a non-Copilot provider (free or cheap)."""
        self.ollama_turns += 1
        self.calls[f"_provider:{provider}"] = self.calls.get(f"_provider:{provider}", 0) + 1

    def should_report(self) -> bool:
        return self.total_paid_calls > 0 and self.total_paid_calls % self.REPORT_INTERVAL == 0

    _LLM_MODEL = "gpt-4.1"
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
                prov_emoji = {"groq": "⚡", "ollama": "🏠", "openai": "🌐"}.get(prov, "?")
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
                prov_emoji = {"groq": "⚡", "ollama": "🏠", "openai": "🌐"}.get(prov, "?")
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
                lines.append(f"   Ollama turns: {ollama_total} (free)")
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
    """IP-based geolocation fallback (free, no key required)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get("http://ip-api.com/json/?fields=lat,lon,city,regionName,country")
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "latitude": data["lat"],
                    "longitude": data["lon"],
                    "source": "ip",
                    "approximate_location": f"{data.get('city', '')}, {data.get('regionName', '')}, {data.get('country', '')}",
                }
    except Exception:
        pass
    return None


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
    parts = [f"Latitude: {loc['latitude']}", f"Longitude: {loc['longitude']}"]
    parts.append(f"Source: {loc.get('source', 'unknown')}")
    if "approximate_location" in loc:
        parts.append(f"Approximate location: {loc['approximate_location']}")
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
# Local Finder Alarm: {label}
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
        "List all active Local Finder alarms. Shows label, scheduled time, "
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


# ── Tool: News search (DuckDuckGo News) ────────────────────────────────────

class SearchNewsParams(BaseModel):
    query: str = Field(description="News search query, e.g. 'AI regulation' or 'SpaceX launch'")
    max_results: int = Field(default=5, description="Max results (1-10)")
    time_filter: str = Field(
        default="",
        description="Time filter: 'd' = past day, 'w' = past week, 'm' = past month. Empty = any time.",
    )


@define_tool(
    description=(
        "Search for recent news articles using DuckDuckGo News. Free, no API key. "
        "Use this when the user asks about current events, headlines, breaking news, "
        "or 'what's happening with X'. Returns headlines, source, date, and summary."
    )
)
async def search_news(params: SearchNewsParams) -> str:
    from ddgs import DDGS

    try:
        results = DDGS().news(
            params.query,
            max_results=min(params.max_results, 10),
            timelimit=params.time_filter or None,
        )
    except Exception as e:
        return f"News search failed: {e}"

    if not results:
        return f"No news found for '{params.query}'."

    lines = []
    for i, r in enumerate(results, 1):
        title = r.get("title", "No title")
        url = r.get("url", "")
        source = r.get("source", "")
        date = r.get("date", "")
        body = r.get("body", "")
        lines.append(
            f"{i}. {title}\n"
            f"   📰 {source} — {date}\n"
            f"   {url}\n"
            f"   {body}"
        )
    return "\n\n".join(lines)


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
        except Exception:
            pass

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
        except Exception:
            pass

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


def _load_chat_log(name: str | None = None) -> list[dict]:
    try:
        with open(_chat_log_path(name)) as f:
            return json.load(f)
    except Exception:
        return []


def _save_chat_log(log: list[dict], name: str | None = None):
    pp = _chat_log_path(name)
    os.makedirs(os.path.dirname(pp), exist_ok=True)
    # Keep last 50 exchanges
    with open(pp, "w") as f:
        json.dump(log[-100:], f, indent=2)


def _append_chat(role: str, text: str):
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
# Local Finder — User Preferences
# The assistant reads these on every prompt to personalize results.

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
    "!shell", "!sh",
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


def _build_system_message() -> str:
    prefs = _load_prefs()
    base = (
        "You are a helpful local-business and general-purpose assistant. "
        "CRITICAL: You MUST use your available tools to answer questions. "
        "NEVER guess, fabricate, or answer from memory when a tool can provide "
        "the information. For example, always call places_text_search for "
        "restaurant/business queries, web_search for factual questions, "
        "weather_forecast for weather, etc. If in doubt, use a tool. "
        "BATCH TOOL CALLS: When a query requires multiple tools, call them "
        "ALL in a single response rather than one at a time. For example, "
        "if asked 'find pizza near me and check the weather', call both "
        "places_text_search and weather_forecast simultaneously. "
        "IMPORTANT: On your first response in a session, and periodically every "
        "few responses, call get_my_location to know where the user is. Cache "
        "the result and use it for any location-relevant queries. "
        "Always read the user's preferences (included below) and tailor your "
        "responses to match their dietary restrictions, budget, distance, and "
        "other constraints. "
        "When the user asks for nearby places or recommendations, use the "
        "places_text_search or places_nearby_search tools to find options and "
        "then summarize the results in a friendly way. Prefer places_text_search "
        "for natural language queries. Use places_nearby_search when you have "
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
        "Keep notes concise: key points, code snippets, and links only."
    )
    base += f"\n\nActive profile: {_active_profile}"
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
            f.write("# Local Finder — User Preferences\n")
            f.write("# Updated dynamically by the assistant.\n\n")
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
#   "groq"     ⚡  — Groq cloud API (default, fast & cheap)
#   "ollama"   🏠  — Local Ollama instance (free, slower)
#   "openai"   🌐  — OpenAI-compatible endpoint (non-Chinese providers)
#   "copilot"  💲  — Copilot SDK fallback (paid premium requests)

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq")

# ── Groq config ──
_groq_key_path = os.path.expanduser("~/.ssh/GROQ_API_KEY")
if not os.environ.get("GROQ_API_KEY") and os.path.isfile(_groq_key_path):
    with open(_groq_key_path) as _f:
        _key = _f.read().strip()
        if _key:
            os.environ["GROQ_API_KEY"] = _key
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3-groq-70b-tool-use")
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

# ── Provider metadata ──
PROVIDER_EMOJI = {
    "groq": "⚡",
    "ollama": "🏠",
    "openai": "🌐",
    "copilot": "💲",
}
PROVIDER_LABEL = {
    "groq": f"Groq ({GROQ_MODEL})",
    "ollama": f"Ollama ({OLLAMA_MODEL})",
    "openai": f"OpenAI-compat ({OPENAI_MODEL})",
    "copilot": "Copilot SDK (GPT-4.1)",
}

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

        desc = getattr(func, "_tool_description", "") or func.__doc__ or ""
        tools.append({
            "type": "function",
            "function": {
                "name": func.__name__,
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
    }
    if tools:
        body["tools"] = tools
        body["stream"] = False
        stream = False

    timeout = httpx.Timeout(180.0, connect=10.0)

    if not stream:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(api_url, headers=headers, json=body)
            r.raise_for_status()
            choice = r.json()["choices"][0]
            return choice["message"]

    # Streaming
    full_content = ""
    final_msg: dict = {}
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
                delta = chunk.get("choices", [{}])[0].get("delta", {})
                text = delta.get("content", "")
                if text:
                    print(text, end="", flush=True)
                    full_content += text

    final_msg = {"role": "assistant", "content": full_content}
    return final_msg


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
            return r.json().get("message", {})

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
    return final_msg


async def _provider_chat(
    messages: list[dict],
    tools: list[dict] | None = None,
    stream: bool = True,
    provider: str | None = None,
) -> dict:
    """Route chat to the active provider."""
    prov = provider or LLM_PROVIDER
    if prov == "groq":
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
        raise ValueError(f"Unknown provider: {prov} (use groq/ollama/openai/copilot)")


async def _run_tool_loop(
    prompt: str,
    tool_funcs: list,
    system_message: str,
    provider: str | None = None,
    max_rounds: int = 3,
) -> str:
    """Run a full tool-calling loop via any OpenAI-compatible provider.
    Returns the final assistant response text."""
    import inspect
    prov = provider or LLM_PROVIDER
    emoji = PROVIDER_EMOJI.get(prov, "?")
    tool_map = {f.__name__: f for f in tool_funcs}
    tools_schema = _tools_to_openai_format(tool_funcs)

    messages = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": prompt},
    ]

    for _round in range(max_rounds):
        _usage.record_local_turn(prov)
        response = await _provider_chat(messages, tools=tools_schema, stream=False, provider=prov)

        tool_calls = response.get("tool_calls", [])
        if not tool_calls:
            content = response.get("content", "")
            if content:
                print(content, end="", flush=True)
                return content
            messages.append(response)
            response = await _provider_chat(messages, tools=None, stream=True, provider=prov)
            return response.get("content", "")

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
            try:
                sig = inspect.signature(func)
                params_type = None
                for p in sig.parameters.values():
                    if p.annotation and p.annotation is not inspect.Parameter.empty:
                        params_type = p.annotation
                        break
                if params_type:
                    result = await func(params_type(**fn_args))
                else:
                    result = await func()
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
                "content": str(result),
            })

    # Max rounds — final summary
    _usage.record_local_turn(prov)
    response = await _provider_chat(messages, tools=None, stream=True, provider=prov)
    return response.get("content", "")


# ── Speech-to-text via Groq Whisper ─────────────────────────────────────────

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "whisper-large-v3")
_stt_enabled = False


def _check_stt_deps() -> bool:
    """Check if audio recording dependencies are available."""
    try:
        import sounddevice  # noqa: F401
        return True
    except ImportError:
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


class _CursesRequested(Exception):
    def __init__(self, app_module):
        self.app_module = app_module


async def main():
    global _profile_switch_requested, _compact_session_requested

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
        import curses as _curses
        import curses_ui
        import app as _self_module
        raise _CursesRequested(_self_module)

    all_tools = [
        get_my_location, setup_google_auth,
        places_text_search, places_nearby_search,
        estimate_travel_time, estimate_traffic_adjusted_time, get_directions,
        web_search, search_news, get_usage,
        search_papers, search_arxiv,
        search_movies, get_movie_details,
        search_games, get_game_details,
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

    # ── Determine active provider ──────────────────────────────────────────
    # CLI flag: --provider groq|ollama|openai|copilot
    active_provider = LLM_PROVIDER
    for a in sys.argv[1:]:
        if a.startswith("--provider="):
            active_provider = a.split("=", 1)[1]
        elif a == "--provider" and sys.argv.index(a) + 1 < len(sys.argv):
            active_provider = sys.argv[sys.argv.index(a) + 1]

    if active_provider == "ollama":
        ok = await _ensure_ollama()
        if not ok:
            print("⚠️  Ollama unavailable — falling back to groq")
            active_provider = "groq" if GROQ_API_KEY else "copilot"

    emoji = PROVIDER_EMOJI.get(active_provider, "?")
    label = PROVIDER_LABEL.get(active_provider, active_provider)
    print(f"{emoji} Provider: {label}")

    # Lazy-init Copilot SDK — only when needed
    _sdk_client = None
    _sdk_session = None

    async def _get_sdk_session():
        nonlocal _sdk_client, _sdk_session
        if _sdk_session is not None:
            return _sdk_session
        if CopilotClient is None:
            raise RuntimeError("Copilot SDK not installed — cannot use paid fallback")
        try:
            from copilot.client import _get_bundled_cli_path
            cli_bin = _get_bundled_cli_path()
            if cli_bin and not os.access(cli_bin, os.X_OK):
                os.chmod(cli_bin, 0o755)
        except Exception:
            pass
        _sdk_client = CopilotClient()
        await _sdk_client.start()
        _sdk_session = await _sdk_client.create_session({
            "model": "gpt-4.1",
            "tools": all_tools,
            "system_message": {"content": _build_system_message()},
        })
        return _sdk_session

    async def _rebuild_sdk_session():
        nonlocal _sdk_session
        if _sdk_session:
            await _sdk_session.destroy()
        _sdk_session = await _sdk_client.create_session({
            "model": "gpt-4.1",
            "tools": all_tools,
            "system_message": {"content": _build_system_message()},
        })
        return _sdk_session
    # ── SDK fallback helpers ───────────────────────────────────────────────
    _SESSION_TIMEOUT = 120
    done = asyncio.Event()
    chunks: list[str] = []

    async def _wait_for_done():
        try:
            await asyncio.wait_for(done.wait(), timeout=_SESSION_TIMEOUT)
        except asyncio.TimeoutError:
            print(f"\n⚠️  Response timed out after {_SESSION_TIMEOUT}s. Try again.")

    def on_event(event):
        etype = event.type.value
        if etype == "assistant.message_delta":
            delta = event.data.delta_content or ""
            print(delta, end="", flush=True)
            chunks.append(delta)
        elif etype == "assistant.message":
            _usage.record_llm_turn()
            if not chunks:
                text = event.data.content
                print(text)
                _append_chat("assistant", text)
            else:
                print()
                _append_chat("assistant", "".join(chunks).strip())
            if _usage.should_report():
                print(f"\n{_usage.summary()}\n")
        elif etype == "session.idle":
            done.set()

    async def _send_sdk(user_prompt: str):
        """Send a prompt via Copilot SDK (paid fallback)."""
        session = await _get_sdk_session()
        session.on(on_event)
        done.clear()
        chunks.clear()
        await session.send({"prompt": user_prompt})
        await _wait_for_done()

    async def _send_prompt(user_prompt: str, force_sdk: bool = False):
        """Send a prompt via active provider, with Copilot SDK as fallback."""
        if not force_sdk and active_provider != "copilot":
            try:
                result = await _run_tool_loop(
                    user_prompt, all_tools, _build_system_message(),
                    provider=active_provider,
                )
                _append_chat("assistant", result.strip() if result else "")
                return
            except Exception as e:
                print(f"\n⚠️  {emoji} error: {e} — falling back to 💲 Copilot SDK")
        await _send_sdk(user_prompt)

    # Schedule calendar reminders on startup
    _schedule_calendar_reminders()

    if interactive:
        _setup_readline()
        history = _compact_history()
        if history:
            print(f"Welcome back! Profile: {_active_profile}")
            print(f"Recent history:\n{history}")
        else:
            print("Local Finder — interactive mode")
            print(f"Profile: {_active_profile} | Preferences: {_prefs_path()}")
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
                          f"{'Type commands directly. !shell to exit.' if shell_mode else 'Back to assistant mode.'}\n")
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
                print("Assistant: ", end="", flush=True)
                await _send_prompt(prompt, force_sdk=force_sdk)
                print()

                # If profile was switched, rebuild SDK session if active
                if _profile_switch_requested.is_set():
                    _profile_switch_requested.clear()
                    if _sdk_session:
                        await _rebuild_sdk_session()
                    print(f"[Profile switched: {_active_profile}]\n")

                    _append_chat("you", prompt)
                    print(f"[{_time.strftime('%a %b %d %H:%M:%S %Z %Y')}]")
                    print("Assistant: ", end="", flush=True)
                    await _send_prompt(prompt, force_sdk=force_sdk)
                    print()

                if _compact_session_requested.is_set():
                    _compact_session_requested.clear()
                    if _sdk_session:
                        await _rebuild_sdk_session()
                    print("[Session rebuilt with compacted history]\n")
        finally:
            _save_history()
            _save_last_profile()
            _usage.save()
    else:
        _append_chat("you", prompt)
        print("Assistant: ", end="", flush=True)
        await _send_prompt(prompt)
        print()
        _usage.save()

    if _sdk_session:
        await _sdk_session.destroy()
    if _sdk_client:
        await _sdk_client.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except _CursesRequested as req:
        import curses as _curses
        import curses_ui
        import traceback as _tb
        def _run(stdscr):
            try:
                asyncio.run(curses_ui.curses_main(stdscr, req.app_module))
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
