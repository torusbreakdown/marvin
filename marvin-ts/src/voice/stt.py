#!/usr/bin/env python3
"""STT helper: transcribe WAV with faster-whisper (CUDA/batched)."""
import sys
import json
import os


def main():
    wav_path = sys.argv[1] if len(sys.argv) > 1 else None
    model_size = os.environ.get("WHISPER_MODEL", "small")
    device = os.environ.get("WHISPER_DEVICE", "cuda")
    compute_type = os.environ.get("WHISPER_COMPUTE", "float16")

    if not wav_path:
        print(json.dumps({"error": "usage: stt.py <wav_path>"}))
        sys.exit(1)

    if not os.path.isfile(wav_path):
        print(json.dumps({"error": f"file not found: {wav_path}"}))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel, BatchedInferencePipeline

        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        batched = BatchedInferencePipeline(model=model)
        segments, info = batched.transcribe(wav_path, batch_size=16)

        text_parts = []
        for seg in segments:
            text_parts.append(seg.text)
        text = " ".join(text_parts).strip()

        print(json.dumps({
            "text": text,
            "language": info.language,
            "language_probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
