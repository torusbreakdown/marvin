#!/usr/bin/env bash
# Install the marvin-wakeword systemd user service.
# Run from marvin-ts/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/.venv"
SERVICE_NAME="marvin-wakeword"

echo "=== Marvin Wake Word Service Installer ==="

# 1. Install Python dependencies into the project venv
echo "Installing Python dependencies…"
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv at $VENV_DIR…"
    uv venv "$VENV_DIR"
fi
uv pip install --python "$VENV_DIR/bin/python" openwakeword pyaudio

# 2. Install systemd user service
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"
cp "$SCRIPT_DIR/$SERVICE_NAME.service" "$SYSTEMD_DIR/"
echo "Installed service to $SYSTEMD_DIR/$SERVICE_NAME.service"

# 3. Reload and enable
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

echo ""
echo "✅ Service installed and enabled."
echo ""
echo "Commands:"
echo "  systemctl --user start $SERVICE_NAME     # Start now"
echo "  systemctl --user stop $SERVICE_NAME      # Stop"
echo "  systemctl --user status $SERVICE_NAME    # Check status"
echo "  journalctl --user -u $SERVICE_NAME -f    # Follow logs"
echo ""
echo "Configuration (environment variables in service file or env overrides):"
echo "  MARVIN_WAKE_THRESHOLD  Detection threshold (0-1, default 0.5)"
echo "  MARVIN_WAKE_COOLDOWN   Seconds between activations (default 3.0)"
echo "  MARVIN_WAKE_MODEL      Path to custom .tflite model"
echo "  MARVIN_WAKE_NAME       Prediction key name for custom model"
echo "  MARVIN_TERMINAL        Terminal emulator (default: kitty)"
