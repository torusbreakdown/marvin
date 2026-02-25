#!/usr/bin/env bash
# Train a custom "hey marvin" wake word model using openWakeWord's automated training.
#
# Prerequisites: CUDA-capable GPU, ~10GB free disk space
# Takes ~30-60 minutes on a modern GPU.
#
# Usage:
#   cd marvin-ts/src/wakeword
#   ./train-model.sh
#
# Output: ./hey_marvin_model/hey_marvin.onnx and .tflite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$SCRIPT_DIR/training"
MODEL_NAME="hey_marvin"
# Training needs Python ≤3.12 for piper-phonemize; use a separate venv
TRAIN_VENV="$WORK_DIR/.venv"

echo "=== openWakeWord 'Hey Marvin' Model Training ==="
echo "Work dir: $WORK_DIR"
echo ""

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# ── 1. Set up venv with training dependencies ──
echo "[1/6] Installing training dependencies…"
if [ ! -d "$TRAIN_VENV" ]; then
    echo "Creating Python 3.11 training venv…"
    uv venv --python python3.11 "$TRAIN_VENV"
fi
PYTHON="$TRAIN_VENV/bin/python"

uv pip install --python "$PYTHON" \
    openwakeword \
    torch torchinfo torchmetrics \
    piper-phonemize \
    webrtcvad \
    mutagen==1.47.0 \
    speechbrain==0.5.14 \
    audiomentations==0.33.0 \
    torch-audiomentations==0.11.0 \
    acoustics==0.2.6 \
    pronouncing==0.2.0 \
    datasets==2.14.6 \
    deep-phonemizer==0.0.19 \
    tensorflow-cpu \
    tensorflow_probability \
    onnx_tf \
    scipy tqdm pyyaml

# ── 2. Clone piper-sample-generator if needed ──
echo "[2/6] Setting up piper-sample-generator…"
if [ ! -d piper-sample-generator ]; then
    git clone https://github.com/rhasspy/piper-sample-generator
fi
if [ ! -f piper-sample-generator/models/en_US-libritts_r-medium.pt ]; then
    wget -O piper-sample-generator/models/en_US-libritts_r-medium.pt \
        'https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt'
fi

# ── 3. Download background/negative data ──
echo "[3/6] Downloading background and validation data…"
# Validation features (pre-computed by openWakeWord project)
if [ ! -f validation_set_features.npy ]; then
    "$PYTHON" -c "
import openwakeword
openwakeword.utils.download_models()
# Download the validation features
import urllib.request
url = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/validation_set_features.npy'
urllib.request.urlretrieve(url, 'validation_set_features.npy')
print('Downloaded validation features')
"
fi

# Negative data — use ACAV100M sample (pre-extracted features)
if [ ! -f openwakeword_features_ACAV100M_2000_hrs_16bit.npy ]; then
    echo "Downloading ACAV100M negative features (~1.5GB)…"
    "$PYTHON" -c "
import urllib.request
url = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/openwakeword_features_ACAV100M_2000_hrs_16bit.npy'
urllib.request.urlretrieve(url, 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy')
print('Downloaded ACAV100M features')
"
fi

# Background audio — download a sample from FMA if not present
if [ ! -d audioset_16k ]; then
    echo "Creating minimal background audio dir (you can add more .wav files here for better results)…"
    mkdir -p audioset_16k
    # Generate some noise clips as minimal background data
    "$PYTHON" -c "
import numpy as np, scipy.io.wavfile, os
for i in range(100):
    noise = (np.random.randn(16000 * 5) * 3000).astype(np.int16)
    scipy.io.wavfile.write(f'audioset_16k/noise_{i:03d}.wav', 16000, noise)
print('Generated 100 noise clips as background data')
"
fi

# ── 4. Generate YAML training config ──
echo "[4/6] Writing training config…"
cat > hey_marvin_config.yaml << 'YAML'
target_phrase:
  - "hey marvin"
model_name: hey_marvin
n_samples: 3000
n_samples_val: 500
steps: 15000
target_accuracy: 0.7
target_recall: 0.4
target_false_positives_per_hour: 0.2
max_negative_weight: 100
batch_n_per_class: 512
layer_size: 128
model_type: dnn
total_length: 2.0
background_paths:
  - ./audioset_16k
false_positive_validation_data_path: validation_set_features.npy
feature_data_files:
  ACAV100M_sample: openwakeword_features_ACAV100M_2000_hrs_16bit.npy
piper_sample_generator_path: ./piper-sample-generator
output_dir: ./hey_marvin_model
YAML

mkdir -p hey_marvin_model

# ── 5. Run the 3-step training pipeline ──
echo "[5/6] Generating synthetic speech clips…"
"$PYTHON" -m openwakeword.train \
    --training_config hey_marvin_config.yaml \
    --generate_clips

echo "[5/6] Augmenting clips…"
"$PYTHON" -m openwakeword.train \
    --training_config hey_marvin_config.yaml \
    --augment_clips

echo "[5/6] Training model…"
"$PYTHON" -m openwakeword.train \
    --training_config hey_marvin_config.yaml \
    --train_model \
    --convert_to_tflite

# ── 6. Done ──
echo ""
echo "=========================================="
echo "✅ Model trained!"
echo ""
if [ -f "hey_marvin_model/hey_marvin.tflite" ]; then
    MODEL_PATH="$(realpath hey_marvin_model/hey_marvin.tflite)"
    echo "  Model: $MODEL_PATH"
    echo ""
    echo "To use with the wake word service, set:"
    echo "  MARVIN_WAKE_MODEL=$MODEL_PATH"
    echo "  MARVIN_WAKE_NAME=hey_marvin"
    echo ""
    echo "Or update the systemd service:"
    echo "  systemctl --user edit marvin-wakeword"
    echo "  [Service]"
    echo "  Environment=MARVIN_WAKE_MODEL=$MODEL_PATH"
    echo "  Environment=MARVIN_WAKE_NAME=hey_marvin"
elif [ -f "hey_marvin_model/hey_marvin.onnx" ]; then
    MODEL_PATH="$(realpath hey_marvin_model/hey_marvin.onnx)"
    echo "  Model (ONNX): $MODEL_PATH"
    echo "  (tflite conversion may have failed — ONNX works too)"
    echo ""
    echo "  MARVIN_WAKE_MODEL=$MODEL_PATH"
    echo "  MARVIN_WAKE_NAME=hey_marvin"
else
    echo "⚠️  Model files not found in hey_marvin_model/. Check training logs above."
fi
echo "=========================================="
