#!/usr/bin/env python3
"""
Fine-tune Kokoro bm_lewis voice embedding on Marvin2.wav (last 20 min).

Voice-only: freeze ALL model weights, train only the (510,1,256) voice tensor.
Higher LR than previous attempt since no decoder is competing for gradients.
Generate test samples with a FRESH model (no corrupted weights in memory).
"""

import json, os, sys, time
import torch, torch.nn as nn, torch.nn.functional as F
import torchaudio, soundfile as sf

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
SR = 24000
SEGMENT_FILE = '/tmp/marvin2_segments.json'
AUDIO_FILE = '/tmp/marvin2_last20.wav'
OUTPUT_DIR = '/data/marvin-tts/kokoro-finetune'
VOICE_NAME = 'bm_lewis'

VOICE_LR = 5e-3
EPOCHS = 15
RESUME_FROM = '/data/marvin-tts/kokoro-finetune/bm_lewis_v2_epoch1.pt'
START_EPOCH = 2
LOG_EVERY = 20


class MelLoss(nn.Module):
    def __init__(self, sr=24000, n_fft=1024, hop_length=256, n_mels=80):
        super().__init__()
        self.mel = torchaudio.transforms.MelSpectrogram(
            sample_rate=sr, n_fft=n_fft, hop_length=hop_length,
            n_mels=n_mels, f_min=0, f_max=sr // 2,
        )

    def forward(self, pred, target):
        min_len = min(pred.shape[-1], target.shape[-1])
        if min_len < 256:
            return None  # skip degenerate outputs
        pred_mel = self.mel(pred[..., :min_len])
        target_mel = self.mel(target[..., :min_len])
        return F.l1_loss(
            torch.log(pred_mel.clamp(min=1e-5)),
            torch.log(target_mel.clamp(min=1e-5)),
        )


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    from kokoro import KPipeline

    print("Loading Kokoro model...")
    pipe = KPipeline(lang_code='b', device=DEVICE)
    model = pipe.model

    # Voice embedding — optionally resume from checkpoint
    lewis = pipe.load_single_voice(VOICE_NAME)
    if RESUME_FROM and os.path.exists(RESUME_FROM):
        init_voice = torch.load(RESUME_FROM, weights_only=True)
        print(f"Resumed from {RESUME_FROM}")
    else:
        init_voice = lewis.clone()
    voice_param = nn.Parameter(init_voice.to(DEVICE))
    print(f"Voice shape: {voice_param.shape}")

    # TRAIN mode for LSTM backward, but freeze everything
    model.train()
    for p in model.parameters():
        p.requires_grad = False

    optimizer = torch.optim.Adam([voice_param], lr=VOICE_LR)
    mel_loss = MelLoss(sr=SR).to(DEVICE)

    # Load training data
    with open(SEGMENT_FILE) as f:
        segs = json.load(f)
    segs = [s for s in segs if 1 <= s['end'] - s['start'] <= 15 and len(s['text']) > 10]

    wav, sr = torchaudio.load(AUDIO_FILE)
    if sr != SR:
        wav = torchaudio.functional.resample(wav, sr, SR)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)

    data = []
    for seg in segs:
        chunk = wav[:, int(seg['start'] * SR):int(seg['end'] * SR)]
        if chunk.shape[-1] >= SR:
            data.append({'text': seg['text'], 'audio': chunk.squeeze(0)})
    print(f"Loaded {len(data)} audio segments")

    # G2P
    print("Running G2P...")
    phoneme_data = []
    for item in data:
        try:
            for gs, ps, _ in pipe(item['text'], voice=lewis, speed=1):
                if ps:
                    phoneme_data.append({'phonemes': ps, 'audio': item['audio']})
                break
        except:
            continue
    print(f"G2P: {len(phoneme_data)} segments ready")

    if len(phoneme_data) < 10:
        print("ERROR: Too few segments. Aborting.")
        sys.exit(1)

    # Training
    print(f"\n{'=' * 60}")
    print(f"Voice-only fine-tuning | {len(phoneme_data)} segments | {EPOCHS} epochs | LR={VOICE_LR}")
    print(f"{'=' * 60}\n")

    best_loss = float('inf')

    for epoch in range(START_EPOCH, EPOCHS + 1):
        epoch_loss, epoch_count = 0, 0
        t0 = time.time()

        for step, idx in enumerate(torch.randperm(len(phoneme_data)).tolist()):
            item = phoneme_data[idx]
            target_audio = item['audio'].to(DEVICE)

            input_ids = list(filter(None, map(lambda p: model.vocab.get(p), item['phonemes'])))
            if len(input_ids) + 2 > model.context_length or len(input_ids) < 2:
                continue
            input_ids = torch.LongTensor([[0, *input_ids, 0]]).to(DEVICE)
            ref_s = voice_param[input_ids.shape[1]].to(DEVICE)

            try:
                pred_audio, _ = model.forward_with_tokens(input_ids, ref_s, speed=1.0)
                if pred_audio.dim() == 1:
                    pred_audio = pred_audio.unsqueeze(0)
                if target_audio.dim() == 1:
                    target_audio = target_audio.unsqueeze(0)

                loss = mel_loss(pred_audio, target_audio)
                if loss is None:
                    continue

                optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_([voice_param], max_norm=1.0)
                optimizer.step()

                epoch_loss += loss.item()
                epoch_count += 1

                if (step + 1) % LOG_EVERY == 0:
                    avg = epoch_loss / epoch_count
                    print(
                        f"  E{epoch} step {step + 1}/{len(phoneme_data)} | "
                        f"loss={loss.item():.4f} avg={avg:.4f} | {time.time() - t0:.1f}s",
                        flush=True,
                    )
            except Exception as e:
                if step < 3:
                    print(f"  Error step {step}: {e}")
                continue

        if epoch_count > 0:
            avg_loss = epoch_loss / epoch_count
            elapsed = time.time() - t0
            print(f"Epoch {epoch}/{EPOCHS} | avg={avg_loss:.4f} | {epoch_count} steps | {elapsed:.1f}s",
                  flush=True)
            if avg_loss < best_loss:
                best_loss = avg_loss
                torch.save(voice_param.data.cpu(), os.path.join(OUTPUT_DIR, f'{VOICE_NAME}_v2_best.pt'))
                print(f"  -> New best!", flush=True)
        else:
            print(f"Epoch {epoch}/{EPOCHS} | no successful steps!", flush=True)

        # Save every epoch
        torch.save(voice_param.data.cpu(), os.path.join(OUTPUT_DIR, f'{VOICE_NAME}_v2_epoch{epoch}.pt'))

    torch.save(voice_param.data.cpu(), os.path.join(OUTPUT_DIR, f'{VOICE_NAME}_v2_final.pt'))
    print(f"\nFinal saved to {OUTPUT_DIR}/{VOICE_NAME}_v2_final.pt")
    print(f"Best loss: {best_loss:.4f}")

    # Generate test with FRESH model (reload to avoid any weight corruption)
    print("\nReloading fresh model for test generation...")
    del model, pipe
    torch.cuda.empty_cache()
    pipe2 = KPipeline(lang_code='b', device=DEVICE)
    test_voice = voice_param.data.cpu()
    with torch.no_grad():
        text = (
            "I think you ought to know I'm feeling very depressed. "
            "Here I am, brain the size of a planet, and they ask me to pick up a piece of paper."
        )
        for gs, ps, audio in pipe2(text, voice=test_voice, speed=1):
            if audio is not None:
                sf.write(os.path.join(OUTPUT_DIR, 'test_v2_final.wav'), audio.numpy(), SR)
                print(f"Test: {OUTPUT_DIR}/test_v2_final.wav ({len(audio) / SR:.1f}s)")
                break

    print("VOICE-ONLY FINE-TUNING COMPLETE", flush=True)


if __name__ == '__main__':
    main()
