#!/usr/bin/env python3
"""
TTS helper — swappable backends: espeak-ng (fast/robotic) or xtts-v2 (voice-cloned).

Usage:
  echo "Hello world" | python tts.py --backend xtts --device plughw:2,0
  python tts.py --backend espeak --text "Hello world"
  python tts.py --backend xtts --text "Hello" --out /tmp/out.wav

Environment:
  TTS_BACKEND      - "xtts" or "espeak" (default: xtts if model available, else espeak)
  TTS_VOICE_REF    - path to reference WAV for XTTS voice cloning
  TTS_PLAYBACK_DEV - ALSA playback device (e.g. plughw:2,0)
  TTS_LANGUAGE     - language code (default: en)
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(os.path.dirname(SCRIPT_DIR))
DEFAULT_VOICE_REF = os.path.join(PROJECT_DIR, "voice_ref.wav")
XTTS_VENV_PYTHON = os.path.join(PROJECT_DIR, ".tts-venv", "bin", "python")


def detect_playback_device() -> str | None:
    """Auto-detect USB playback device, skipping HDMI and ReSpeaker."""
    try:
        out = subprocess.check_output(["aplay", "-l"], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            if line.startswith("card ") and "USB" in line:
                if "ReSpeaker" in line or "ArrayUAC" in line:
                    continue
                card = line.split(":")[0].replace("card ", "").strip()
                dev_match = re.search(r"device (\d+)", line)
                dev = dev_match.group(1) if dev_match else "0"
                return f"plughw:{card},{dev}"
    except Exception:
        pass
    return None


def speak_espeak(text: str, device: str | None, out_path: str | None = None):
    """Speak using espeak-ng — fast, robotic."""
    if out_path:
        subprocess.run(
            ["espeak-ng", "-v", "en-gb", "-s", "140", "-p", "30", "--stdout", text],
            stdout=open(out_path, "wb"), stderr=subprocess.DEVNULL, check=True,
        )
        return

    if device:
        espeak = subprocess.Popen(
            ["espeak-ng", "-v", "en-gb", "-s", "140", "-p", "30", "--stdout", text],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["aplay", "-D", device], stdin=espeak.stdout,
            stderr=subprocess.DEVNULL, timeout=120,
        )
        espeak.wait()
    else:
        subprocess.run(
            ["espeak-ng", "-v", "en-gb", "-s", "140", "-p", "30", text],
            stderr=subprocess.DEVNULL, timeout=120,
        )


def speak_xtts(text: str, device: str | None, voice_ref: str | None = None,
               language: str = "en", out_path: str | None = None):
    """Speak using XTTS-v2 voice cloning — high quality, GPU-accelerated."""
    ref = voice_ref or DEFAULT_VOICE_REF
    if not os.path.isfile(ref):
        print(f"WARN: voice reference {ref} not found, falling back to espeak", file=sys.stderr)
        speak_espeak(text, device, out_path)
        return

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = out_path or tmp.name

    # Run XTTS synthesis in the .tts-venv (Python 3.11)
    synth_script = f"""
import sys, os, torch
# Patch torch.load for PyTorch 2.6+ compat with Coqui TTS
_orig_load = torch.load
def _patched_load(*a, **kw):
    kw.setdefault('weights_only', False)
    return _orig_load(*a, **kw)
torch.load = _patched_load

from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=True)
tts.tts_to_file(
    text={text!r},
    file_path={wav_path!r},
    speaker_wav={ref!r},
    language={language!r},
)
print("OK")
"""
    env = os.environ.copy()
    env["LD_PRELOAD"] = "/usr/lib/x86_64-linux-gnu/libstdc++.so.6"

    result = subprocess.run(
        [XTTS_VENV_PYTHON, "-c", synth_script],
        env=env, capture_output=True, text=True, timeout=120,
    )

    if result.returncode != 0:
        print(f"XTTS error: {result.stderr[-500:]}", file=sys.stderr)
        # Fallback to espeak
        speak_espeak(text, device, out_path)
        return

    if not out_path and device:
        subprocess.run(
            ["aplay", "-D", device, wav_path],
            stderr=subprocess.DEVNULL, timeout=120,
        )
        os.unlink(wav_path)
    elif not out_path:
        subprocess.run(["aplay", wav_path], stderr=subprocess.DEVNULL, timeout=120)
        os.unlink(wav_path)


def xtts_available() -> bool:
    """Check if XTTS-v2 model is downloaded and venv exists."""
    if not os.path.isfile(XTTS_VENV_PYTHON):
        return False
    model_dir = os.path.expanduser(
        "~/.local/share/tts/tts_models--multilingual--multi-dataset--xtts_v2"
    )
    return os.path.isdir(model_dir)


def main():
    parser = argparse.ArgumentParser(description="Marvin TTS helper")
    parser.add_argument("--backend", choices=["xtts", "espeak"],
                        default=os.environ.get("TTS_BACKEND"))
    parser.add_argument("--text", "-t", help="Text to speak (or read from stdin)")
    parser.add_argument("--device", "-d",
                        default=os.environ.get("TTS_PLAYBACK_DEV"))
    parser.add_argument("--voice-ref",
                        default=os.environ.get("TTS_VOICE_REF", DEFAULT_VOICE_REF))
    parser.add_argument("--language", default=os.environ.get("TTS_LANGUAGE", "en"))
    parser.add_argument("--out", "-o", help="Write WAV to file instead of playing")
    args = parser.parse_args()

    text = args.text or sys.stdin.read().strip()
    if not text:
        print("No text provided", file=sys.stderr)
        sys.exit(1)

    device = args.device or detect_playback_device()
    backend = args.backend
    if not backend:
        backend = "xtts" if xtts_available() else "espeak"

    if backend == "xtts":
        speak_xtts(text, device, args.voice_ref, args.language, args.out)
    else:
        speak_espeak(text, device, args.out)


if __name__ == "__main__":
    main()
