#!/usr/bin/env python3
"""
marvin-wakeword — "Hey Marvin" wake word detector using openWakeWord.

Listens on the microphone for the wake phrase. When detected:
  1. If Marvin is already running (IPC socket exists), sends "wake" command
     to enable interactive voice input mode.
  2. Otherwise, records a short utterance, transcribes it, runs Marvin in
     non-interactive mode, and speaks the response via espeak-ng.

Designed to run as a systemd user service.

Requirements:
  pip install openwakeword numpy
"""

import os
import sys
import json
import time
import signal
import socket
import logging
import subprocess
import tempfile
from pathlib import Path

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

# Wake word detection threshold (0-1). Lower = more sensitive, higher = fewer false positives.
THRESHOLD = float(os.environ.get("MARVIN_WAKE_THRESHOLD", "0.5"))

# Cooldown period after activation (seconds) to avoid repeated triggers
COOLDOWN = float(os.environ.get("MARVIN_WAKE_COOLDOWN", "3.0"))

# Path to custom wake word model; if not set, uses "hey_jarvis" (closest built-in to "hey marvin")
WAKEWORD_MODEL = os.environ.get("MARVIN_WAKE_MODEL", "")

# The wake word name to monitor in predictions dict
WAKEWORD_NAME = os.environ.get("MARVIN_WAKE_NAME", "")

# Marvin launch command (headless query mode — non-interactive with TTS)
MARVIN_DIR = os.environ.get(
    "MARVIN_DIR",
    str(Path(__file__).resolve().parent.parent.parent),  # marvin-ts/
)


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


def record_utterance(alsa_device: str, duration: float = 6.0) -> str | None:
    """Record a short utterance after the wake word using arecord. Returns path to WAV or None."""
    wav_path = os.path.join(tempfile.gettempdir(), f"marvin-wake-{int(time.time())}.wav")
    log.info("Recording %.1fs of speech on %s…", duration, alsa_device)
    try:
        subprocess.run(
            ["arecord", "-D", alsa_device, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
             "-c", str(CHANNELS), "-t", "wav", "-d", str(int(duration)), wav_path],
            timeout=duration + 5,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        log.error("Recording failed: %s", e)
        return None

    if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 1000:
        log.error("Recording too short or missing")
        return None

    log.info("Saved recording to %s", wav_path)
    return wav_path


def transcribe_wav(wav_path: str) -> str | None:
    """Transcribe a WAV file using the same faster-whisper helper Marvin uses."""
    stt_script = os.path.join(MARVIN_DIR, "src", "voice", "stt.py")
    venv_python = os.path.join(MARVIN_DIR, ".venv", "bin", "python")
    python = venv_python if os.path.exists(venv_python) else "python3"

    try:
        out = subprocess.check_output(
            [python, stt_script, wav_path],
            encoding="utf-8",
            timeout=60,
            env={**os.environ, "LD_PRELOAD": os.environ.get("LD_PRELOAD", "")},
        ).strip()
        result = json.loads(out)
        if result.get("error"):
            log.error("STT error: %s", result["error"])
            return None
        return result.get("text", "").strip() or None
    except Exception as e:
        log.error("Transcription failed: %s", e)
        return None
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def query_marvin_headless(prompt: str) -> str | None:
    """Run Marvin in non-interactive mode and capture the response."""
    try:
        out = subprocess.check_output(
            ["node", "dist/main.js", "--non-interactive", "--prompt", prompt],
            cwd=MARVIN_DIR,
            encoding="utf-8",
            timeout=120,
            stderr=subprocess.DEVNULL,
        ).strip()
        return out or None
    except Exception as e:
        log.error("Marvin query failed: %s", e)
        return None


def speak_text(text: str):
    """Speak text using espeak-ng (blocking)."""
    try:
        subprocess.run(
            ["espeak-ng", "-v", "en-gb", "-s", "140", "-p", "30", text],
            timeout=120,
        )
    except FileNotFoundError:
        log.error("espeak-ng not found — cannot speak response")
    except Exception as e:
        log.error("TTS failed: %s", e)


def on_wake(alsa_device: str):
    """Called when the wake word is detected."""
    log.info("🎙️  Wake word detected!")

    if is_marvin_running():
        log.info("Marvin is running — sending wake command via IPC")
        try:
            resp = send_ipc_command("wake")
            log.info("IPC response: %s", resp)
        except Exception as e:
            log.error("IPC failed: %s", e)
    else:
        # Headless mode: record → transcribe → query Marvin → speak response
        log.info("Marvin not running — headless voice query")
        # Brief chime/beep to signal listening
        speak_text("Yes?")

        wav_path = record_utterance(alsa_device)
        if not wav_path:
            return

        text = transcribe_wav(wav_path)
        if not text:
            speak_text("Sorry, I didn't catch that.")
            return

        log.info("Transcribed: %s", text)
        response = query_marvin_headless(text)
        if response:
            log.info("Response: %s", response[:200])
            speak_text(response)
        else:
            speak_text("Sorry, I couldn't come up with a response.")


def main():
    # Import openWakeWord here so startup errors are clear
    try:
        import openwakeword
        from openwakeword.model import Model
    except ImportError:
        log.error("openwakeword not installed. Run: pip install openwakeword")
        sys.exit(1)

    # Download models if needed (v0.6+ has download_models, earlier versions ship built-in models)
    log.info("Initializing openWakeWord…")
    if hasattr(openwakeword, 'utils') and hasattr(openwakeword.utils, 'download_models'):
        openwakeword.utils.download_models()

    # Load model
    model_kwargs = {}
    if WAKEWORD_MODEL:
        model_kwargs["wakeword_model_paths"] = [WAKEWORD_MODEL]
        log.info("Using custom model: %s", WAKEWORD_MODEL)
    else:
        # v0.4 ships hey_marvin_v0.1.onnx bundled; use it directly
        import openwakeword as _oww
        pkg_dir = os.path.dirname(_oww.__file__)
        hey_marvin_path = os.path.join(pkg_dir, "resources", "models", "hey_marvin_v0.1.onnx")
        if os.path.exists(hey_marvin_path):
            model_kwargs["wakeword_model_paths"] = [hey_marvin_path]
            log.info("Using bundled model: hey_marvin_v0.1.onnx")
        else:
            # Fallback to hey_jarvis
            hey_jarvis_path = os.path.join(pkg_dir, "resources", "models", "hey_jarvis_v0.1.onnx")
            model_kwargs["wakeword_model_paths"] = [hey_jarvis_path]
            log.info("Using bundled model: hey_jarvis_v0.1.onnx (hey_marvin not found)")

    try:
        model = Model(**model_kwargs, enable_speex_noise_suppression=True)
    except (ImportError, ModuleNotFoundError):
        log.warning("Speex noise suppression unavailable — running without it")
        model = Model(**model_kwargs)

    # Determine which prediction key to watch
    wakeword_key = WAKEWORD_NAME
    if not wakeword_key:
        # Auto-detect from loaded models
        keys = list(model.models.keys())
        if keys:
            wakeword_key = keys[0]
            log.info("Watching model key: %s", wakeword_key)
        else:
            log.error("No wake word models loaded!")
            sys.exit(1)

    # Set up audio — use arecord to capture directly from ALSA (bypasses PulseAudio)
    # PyAudio often can't see ALSA hw devices when PulseAudio is running
    import re as _re

    alsa_device = os.environ.get("MARVIN_ALSA_DEVICE", "")
    if not alsa_device:
        try:
            cards = open("/proc/asound/cards").read()
            m = _re.search(r"^\s*(\d+)\s+\[.*(?:ReSpeaker|ArrayUAC)", cards, _re.MULTILINE | _re.IGNORECASE)
            if m:
                alsa_device = f"plughw:{m.group(1)},0"
        except Exception:
            pass
    if not alsa_device:
        alsa_device = "default"

    log.info("Audio capture device: %s", alsa_device)

    # arecord streams raw S16_LE 16kHz mono PCM to stdout
    arecord_cmd = [
        "arecord", "-D", alsa_device, "-f", "S16_LE", "-r", str(SAMPLE_RATE),
        "-c", str(CHANNELS), "-t", "raw", "--buffer-size", str(CHUNK_SAMPLES * 4),
    ]
    arecord_proc = subprocess.Popen(
        arecord_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    assert arecord_proc.stdout is not None

    bytes_per_chunk = CHUNK_SAMPLES * 2  # 16-bit = 2 bytes per sample

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
            audio_bytes = arecord_proc.stdout.read(bytes_per_chunk)
            if not audio_bytes or len(audio_bytes) < bytes_per_chunk:
                if running:
                    log.error("arecord stream ended unexpectedly")
                break
            audio_np = np.frombuffer(audio_bytes, dtype=np.int16)

            predictions = model.predict(audio_np)

            score = predictions.get(wakeword_key, 0.0)
            if score >= THRESHOLD:
                now = time.monotonic()
                if now - last_trigger >= COOLDOWN:
                    last_trigger = now
                    # Kill arecord while handling wake (free the mic)
                    arecord_proc.terminate()
                    arecord_proc.wait()
                    on_wake(alsa_device)
                    # Restart arecord
                    arecord_proc = subprocess.Popen(
                        arecord_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    )
                    assert arecord_proc.stdout is not None
    finally:
        arecord_proc.terminate()
        arecord_proc.wait()
        log.info("Stopped.")


if __name__ == "__main__":
    main()
