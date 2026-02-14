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
from copilot import CopilotClient, define_tool

GOOGLE_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")


# ── Usage tracking ──────────────────────────────────────────────────────────

class UsageTracker:
    """Tracks estimated API costs. Prints a summary every N paid calls."""

    COST_PER_CALL = {
        "places_text_search": 0.032,
        "places_nearby_search": 0.032,
        "estimate_travel_time": 0.0,       # OSRM is free
        "estimate_traffic_adjusted_time": 0.0,  # OSRM + Open-Meteo, both free
        "web_search": 0.0,                 # DuckDuckGo, free
        "get_my_location": 0.0,
        "setup_google_auth": 0.0,
        "set_alarm": 0.0,
        "list_alarms": 0.0,
        "cancel_alarm": 0.0,
        "switch_profile": 0.0,
        "exit_app": 0.0,
        "get_usage": 0.0,
        "_llm_turn": 0.003,               # rough per-turn LLM cost
    }
    REPORT_INTERVAL = 10

    def __init__(self):
        self.calls: dict[str, int] = {}
        self.total_paid_calls = 0
        self.session_cost = 0.0
        self.llm_turns = 0
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

    def should_report(self) -> bool:
        return self.total_paid_calls > 0 and self.total_paid_calls % self.REPORT_INTERVAL == 0

    def summary(self) -> str:
        lines = [f"📊 Usage — {self.total_paid_calls} paid API calls, ~${self.session_cost:.3f} this session"]
        lines.append(f"   LLM turns: {self.llm_turns} (~${self.llm_turns * self.COST_PER_CALL['_llm_turn']:.3f})")
        for name, count in sorted(self.calls.items()):
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
            calls = cumulative.get("total_calls", {})
            for name, count in self.calls.items():
                calls[name] = calls.get(name, 0) + count
            cumulative["total_calls"] = calls
            with open(self._log_path, "w") as f:
                json.dump(cumulative, f, indent=2)
        except Exception:
            pass

    def summary_oneline(self) -> str:
        return f"${self.session_cost:.3f} | {self.llm_turns} turns | {self.total_paid_calls} paid"

    def lifetime_summary(self) -> str:
        try:
            if not os.path.exists(self._log_path):
                return "No lifetime usage data yet."
            with open(self._log_path) as f:
                data = json.load(f)
            lines = [f"📊 Lifetime usage — ~${data.get('total_cost', 0):.3f} total"]
            lines.append(f"   LLM turns: {data.get('total_llm_turns', 0)}")
            for name, count in sorted(data.get("total_calls", {}).items()):
                lines.append(f"   {name}: {count}x")
            return "\n".join(lines)
        except Exception:
            return "Could not read usage data."


_usage = UsageTracker()


def _get_google_headers() -> dict:
    """Build auth headers: use API key if set, otherwise gcloud access token."""
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
        raise RuntimeError(
            "No GOOGLE_PLACES_API_KEY set and gcloud auth failed. "
            "Set the env var or run 'gcloud auth login'."
        )
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
        "Search for movies and TV shows using OMDB. Returns titles, year, "
        "IMDb/Rotten Tomatoes/Metacritic ratings, plot, and more. "
        "Set OMDB_API_KEY env var (free at omdbapi.com/apikey.aspx). "
        "Use this when users ask about film reviews, movie ratings, "
        "or 'is X movie good'."
    )
)
async def search_movies(params: SearchMoviesParams) -> str:
    if not OMDB_API_KEY:
        return (
            "OMDB_API_KEY not set. Get a free key at https://www.omdbapi.com/apikey.aspx "
            "and set it: export OMDB_API_KEY=your_key"
        )

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
        return "OMDB_API_KEY not set. Get a free key at https://www.omdbapi.com/apikey.aspx"

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
        "Search for video games using RAWG. Returns titles, platforms, "
        "ratings, Metacritic scores, and release dates. "
        "Set RAWG_API_KEY env var (free at rawg.io/apidocs). "
        "Use when users ask about game reviews or 'is X game good'."
    )
)
async def search_games(params: SearchGamesParams) -> str:
    if not RAWG_API_KEY:
        return (
            "RAWG_API_KEY not set. Get a free key at https://rawg.io/apidocs "
            "and set it: export RAWG_API_KEY=your_key"
        )

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
        return "RAWG_API_KEY not set. Get a free key at https://rawg.io/apidocs"

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
        "Search for places using a natural-language query via Google Places API. "
        "Use this when the user describes what they want in plain English, "
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

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://places.googleapis.com/v1/places:searchText",
            headers=headers,
            content=json.dumps(body),
        )
        if resp.status_code != 200:
            hint = ""
            if resp.status_code in (401, 403):
                hint = " Call setup_google_auth to fix authentication and enable the API."
            return f"Google Places API error {resp.status_code}: {resp.text}{hint}"
        return _format_places(resp.json())


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
        "Search for nearby places by type and coordinates via Google Places API. "
        "Use this when you know the exact location (lat/lng) and the type of "
        "place the user wants, e.g. restaurants, gyms, gas stations near a point."
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

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            "https://places.googleapis.com/v1/places:searchNearby",
            headers=headers,
            content=json.dumps(body),
        )
        if resp.status_code != 200:
            hint = ""
            if resp.status_code in (401, 403):
                hint = " Call setup_google_auth to fix authentication and enable the API."
            return f"Google Places API error {resp.status_code}: {resp.text}{hint}"
        return _format_places(resp.json())


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
    """Read the last N readline history entries and format as prior context."""
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
    return "\n".join(f"  - {l}" for l in recent)


def _build_system_message() -> str:
    prefs = _load_prefs()
    base = (
        "You are a helpful local-business and general-purpose assistant. "
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
        "If a Places API call fails with a permissions, auth, or quota error, "
        "call setup_google_auth to fix it, then retry the search. "
        "If the user tells you their name (e.g. 'I'm Alex', 'my name is Alex', "
        "'this is Alex'), call switch_profile with that name to load their profile. "
        "If the user expresses a food preference, dislike, allergy, dietary "
        "restriction, or lifestyle constraint (e.g. 'I hate sushi', 'I'm vegan', "
        "'I can't eat gluten', 'I don't have a car'), call update_preferences "
        "to save it to their profile so future recommendations respect it."
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
    rel = params.path.lstrip("/")
    if ".." in rel:
        return "Path cannot contain '..'."
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
    rel = params.path.lstrip("/")
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
    rel = params.path.lstrip("/")
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
    rel = params.path.strip().lstrip("/") if params.path else ""
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


class _CursesRequested(Exception):
    def __init__(self, app_module):
        self.app_module = app_module


async def main():
    global _profile_switch_requested

    # Curses is default; --plain disables it
    use_plain = "--plain" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--plain", "--curses")]

    if not GOOGLE_API_KEY and not shutil.which("gcloud"):
        print("Error: Set GOOGLE_PLACES_API_KEY or authenticate with 'gcloud auth login'.")
        sys.exit(1)

    _ensure_prefs_file()
    _profile_switch_requested = asyncio.Event()

    prompt = " ".join(args) if args else None
    interactive = prompt is None

    if not use_plain and interactive:
        import curses as _curses
        import curses_ui
        import app as _self_module
        # Must run curses outside the async context — handled by __main__
        raise _CursesRequested(_self_module)

    all_tools = [
        get_my_location, setup_google_auth,
        places_text_search, places_nearby_search,
        estimate_travel_time, estimate_traffic_adjusted_time,
        web_search, get_usage,
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
    ]

    client = CopilotClient()
    await client.start()

    session = await client.create_session({
        "model": "gpt-5.2",
        "tools": all_tools,
        "system_message": {"content": _build_system_message()},
    })

    done = asyncio.Event()
    chunks: list[str] = []

    def on_event(event):
        etype = event.type.value
        if etype == "assistant.message_delta":
            delta = event.data.delta_content or ""
            print(delta, end="", flush=True)
            chunks.append(delta)
        elif etype == "assistant.message":
            _usage.record_llm_turn()
            if not chunks:
                print(event.data.content)
            else:
                print()
            # Auto-report usage every N paid calls
            if _usage.should_report():
                print(f"\n{_usage.summary()}\n")
        elif etype == "session.idle":
            done.set()

    session.on(on_event)

    if interactive:
        _setup_readline()
        history = _compact_history()
        if history:
            print(f"Welcome back! Profile: {_active_profile}")
            print(f"Recent history:\n{history}")
        else:
            print("Local Finder — interactive mode")
            print(f"Profile: {_active_profile} | Preferences: {_prefs_path()}")
        print("Tab to complete, Ctrl+R to search history, 'quit' to exit.\n")
        try:
            while True:
                if _exit_requested.is_set():
                    break
                try:
                    prompt = input(f"[{_active_profile}] You: ").strip()
                except (EOFError, KeyboardInterrupt):
                    print()
                    break
                if not prompt:
                    continue
                if prompt.lower() == "preferences":
                    print(f"Opening {_prefs_path()}")
                    editor = os.environ.get("EDITOR", "nano")
                    subprocess.call([editor, _prefs_path()])
                    session._system_message = {"content": _build_system_message()}
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

                done.clear()
                chunks.clear()
                _exit_requested.clear()
                _profile_switch_requested.clear()
                print(f"[{_time.strftime('%a %b %d %H:%M:%S %Z %Y')}]")
                print("Assistant: ", end="", flush=True)
                await session.send({"prompt": prompt})
                await done.wait()
                print()

                # If profile was switched, rebuild session with new prefs
                if _profile_switch_requested.is_set():
                    _profile_switch_requested.clear()
                    await session.destroy()
                    session = await client.create_session({
                        "model": "gpt-5.2",
                        "tools": all_tools,
                        "system_message": {"content": _build_system_message()},
                    })
                    session.on(on_event)
                    print(f"[Session rebuilt for profile: {_active_profile}]\n")

                    # Re-send the prompt so the LLM can finish processing
                    # (e.g. updating preferences after a profile switch)
                    done.clear()
                    chunks.clear()
                    _profile_switch_requested.clear()
                    print(f"[{_time.strftime('%a %b %d %H:%M:%S %Z %Y')}]")
                    print("Assistant: ", end="", flush=True)
                    await session.send({"prompt": prompt})
                    await done.wait()
                    print()
        finally:
            _save_history()
            _save_last_profile()
            _usage.save()
    else:
        await session.send({"prompt": prompt})
        await done.wait()
        _usage.save()

    await session.destroy()
    await client.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except _CursesRequested as req:
        import curses as _curses
        import curses_ui
        def _run(stdscr):
            asyncio.run(curses_ui.curses_main(stdscr, req.app_module))
        _curses.wrapper(_run)
