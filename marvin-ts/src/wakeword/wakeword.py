#!/usr/bin/env python3
"""
marvin-wakeword — "Hey Marvin" wake word detector using openWakeWord.

Listens on the default microphone for the wake phrase. When detected:
  1. If Marvin is already running (IPC socket exists), sends "wake" command.
  2. Otherwise, launches Marvin in curses mode with voice enabled.

Designed to run as a systemd user service.

Requirements:
  pip install openwakeword pyaudio
"""

import os
import sys
import json
import time
import signal
import socket
import struct
import logging
import subprocess
import tempfile
from pathlib import Path

import pyaudio
import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("marvin-wakeword")

# ── Configuration ──

SOCK_DIR = Path(tempfile.gettempdir()) / "marvin"
SOCK_PATH = SOCK_DIR / "marvin.sock"
PID_PATH = SOCK_DIR / "marvin.pid"

# Audio params matching openWakeWord expectations
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SAMPLES = 1280  # 80ms at 16kHz — recommended by openWakeWord
FORMAT = pyaudio.paInt16

# Wake word detection threshold (0-1). Lower = more sensitive, higher = fewer false positives.
THRESHOLD = float(os.environ.get("MARVIN_WAKE_THRESHOLD", "0.5"))

# Cooldown period after activation (seconds) to avoid repeated triggers
COOLDOWN = float(os.environ.get("MARVIN_WAKE_COOLDOWN", "3.0"))

# Path to custom wake word model; if not set, uses "hey_jarvis" (closest built-in to "hey marvin")
WAKEWORD_MODEL = os.environ.get("MARVIN_WAKE_MODEL", "")

# The wake word name to monitor in predictions dict
WAKEWORD_NAME = os.environ.get("MARVIN_WAKE_NAME", "")

# Marvin launch command (when not already running)
MARVIN_CMD = os.environ.get(
    "MARVIN_CMD",
    "node dist/main.js --curses",
)
MARVIN_DIR = os.environ.get(
    "MARVIN_DIR",
    str(Path(__file__).resolve().parent.parent.parent),  # marvin-ts/
)

# Terminal emulator to launch Marvin in (when starting fresh)
TERMINAL = os.environ.get("MARVIN_TERMINAL", "kitty")


def is_marvin_running() -> bool:
    """Check if a Marvin instance is running and listening on the IPC socket."""
    if not SOCK_PATH.exists():
        return False
    if PID_PATH.exists():
        try:
            pid = int(PID_PATH.read_text().strip())
            os.kill(pid, 0)  # check if process exists
            return True
        except (ValueError, ProcessLookupError, PermissionError):
            return False
    return False


def send_ipc_command(cmd: str, timeout: float = 2.0) -> str:
    """Send a command to Marvin via the IPC socket and return the response."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(SOCK_PATH))
        sock.sendall((cmd + "\n").encode())
        return sock.recv(1024).decode().strip()
    finally:
        sock.close()


def launch_marvin():
    """Launch Marvin in a new terminal window."""
    log.info("Launching Marvin in %s…", TERMINAL)
    # Build the shell command that cd's to Marvin dir and runs it
    shell_cmd = f"cd {MARVIN_DIR} && {MARVIN_CMD}"

    try:
        if TERMINAL == "kitty":
            subprocess.Popen(["kitty", "--title", "Marvin", "bash", "-c", shell_cmd])
        elif TERMINAL == "gnome-terminal":
            subprocess.Popen(["gnome-terminal", "--title", "Marvin", "--", "bash", "-c", shell_cmd])
        elif TERMINAL == "alacritty":
            subprocess.Popen(["alacritty", "--title", "Marvin", "-e", "bash", "-c", shell_cmd])
        elif TERMINAL == "xterm":
            subprocess.Popen(["xterm", "-title", "Marvin", "-e", "bash", "-c", shell_cmd])
        else:
            # Generic: try the terminal name directly
            subprocess.Popen([TERMINAL, "-e", "bash", "-c", shell_cmd])
    except FileNotFoundError:
        log.error("Terminal %r not found. Set MARVIN_TERMINAL env var.", TERMINAL)


def on_wake():
    """Called when the wake word is detected."""
    log.info("🎙️  Wake word detected!")

    if is_marvin_running():
        log.info("Marvin is running — sending wake command via IPC")
        try:
            resp = send_ipc_command("wake")
            log.info("IPC response: %s", resp)
        except Exception as e:
            log.error("IPC failed: %s — launching new instance", e)
            launch_marvin()
    else:
        log.info("Marvin not running — launching new instance")
        launch_marvin()
        # Wait for Marvin to start and set up IPC, then send wake
        for _ in range(20):  # up to 10 seconds
            time.sleep(0.5)
            if is_marvin_running():
                try:
                    send_ipc_command("wake")
                    log.info("Sent wake command to newly launched Marvin")
                except Exception:
                    pass
                break


def main():
    # Import openWakeWord here so startup errors are clear
    try:
        import openwakeword
        from openwakeword.model import Model
    except ImportError:
        log.error("openwakeword not installed. Run: pip install openwakeword")
        sys.exit(1)

    # Download models if needed
    log.info("Initializing openWakeWord…")
    openwakeword.utils.download_models()

    # Load model
    model_kwargs = {}
    if WAKEWORD_MODEL:
        model_kwargs["wakeword_models"] = [WAKEWORD_MODEL]
        log.info("Using custom model: %s", WAKEWORD_MODEL)
    else:
        model_kwargs["wakeword_models"] = ["hey_jarvis"]
        log.info("Using built-in model: hey_jarvis (closest to 'hey marvin')")

    model = Model(**model_kwargs, enable_speex_noise_suppression=True)

    # Determine which prediction key to watch
    wakeword_key = WAKEWORD_NAME
    if not wakeword_key:
        # Auto-detect from model
        keys = list(model.prediction_buffer.keys())
        if keys:
            wakeword_key = keys[0]
            log.info("Watching prediction key: %s", wakeword_key)
        else:
            log.error("No wake word models loaded!")
            sys.exit(1)

    # Set up audio
    pa = pyaudio.PyAudio()
    stream = pa.open(
        rate=SAMPLE_RATE,
        channels=CHANNELS,
        format=FORMAT,
        input=True,
        frames_per_buffer=CHUNK_SAMPLES,
    )

    log.info(
        "Listening for wake word (threshold=%.2f, cooldown=%.1fs)… Press Ctrl+C to stop.",
        THRESHOLD,
        COOLDOWN,
    )

    last_trigger = 0.0
    running = True

    def handle_signal(signum, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        while running:
            audio_bytes = stream.read(CHUNK_SAMPLES, exception_on_overflow=False)
            audio_np = np.frombuffer(audio_bytes, dtype=np.int16)

            predictions = model.predict(audio_np)

            score = predictions.get(wakeword_key, 0.0)
            if score >= THRESHOLD:
                now = time.monotonic()
                if now - last_trigger >= COOLDOWN:
                    last_trigger = now
                    on_wake()
    finally:
        stream.stop_stream()
        stream.close()
        pa.terminate()
        log.info("Stopped.")


if __name__ == "__main__":
    main()
