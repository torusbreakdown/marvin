#!/usr/bin/env python3
"""
Joint fine-tuning: voice embedding + predictor + decoder on Rickman + Marvin2 data.

Three learning rate tiers:
- Voice embedding: 5e-3 (fastest, 256 dims)
- Predictor: 1e-5 (prosody/duration — ref_s[:, 128:] feeds here)
- Decoder: 5e-6 (acoustic — ref_s[:, :128] feeds here)

bert + bert_encoder + text_encoder stay frozen (text understanding shouldn't change).

Saves decoder/predictor state dicts alongside voice checkpoints so we can
reload the full fine-tuned state for inference.
"""

import json, os, sys, time
import torch, torch.nn as nn, torch.nn.functional as F
import torchaudio, soundfile as sf

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
SR = 24000
OUTPUT_DIR = '/data/marvin-tts/kokoro-finetune'

# Data sources
RICKMAN_SEGMENTS = '/tmp/rickman_segments.json'
RICKMAN_AUDIO = '/tmp/rickman_concat.wav'
MARVIN_SEGMENTS = '/tmp/marvin2_segments.json'
MARVIN_AUDIO = '/tmp/marvin2_last20.wav'

# Start from the Rickman voice-only best
VOICE_CHECKPOINT = '/data/marvin-tts/kokoro-finetune/bm_lewis_rickman_best.pt'
VOICE_NAME = 'bm_lewis'

# Learning rates
VOICE_LR = 5e-3
PREDICTOR_LR = 1e-5
DECODER_LR = 5e-6
WEIGHT_DECAY = 0.01

EPOCHS = 20
LOG_EVERY = 20
MAX_SEGMENTS_PER_SOURCE = 150  # cap to balance sources


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
            return None
        pred_mel = self.mel(pred[..., :min_len])
        target_mel = self.mel(target[..., :min_len])
        return F.l1_loss(
            torch.log(pred_mel.clamp(min=1e-5)),
            torch.log(target_mel.clamp(min=1e-5)),
        )


def load_segments(seg_file, audio_file, max_segs):
    """Load and filter segments from a transcription + audio pair."""
    with open(seg_file) as f:
        segs = json.load(f)
    segs = [s for s in segs if 1 <= s['end'] - s['start'] <= 15 and len(s['text']) > 10]
    segs = segs[:max_segs]

    wav, sr = torchaudio.load(audio_file)
    if sr != SR:
        wav = torchaudio.functional.resample(wav, sr, SR)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)

    data = []
    for seg in segs:
        chunk = wav[:, int(seg['start'] * SR):int(seg['end'] * SR)]
        if chunk.shape[-1] >= SR:
            data.append({'text': seg['text'], 'audio': chunk.squeeze(0)})
    return data


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    from kokoro import KPipeline

    print("Loading Kokoro model...")
    pipe = KPipeline(lang_code='b', device=DEVICE)
    model = pipe.model

    # Load voice
    lewis = pipe.load_single_voice(VOICE_NAME)
    init_voice = torch.load(VOICE_CHECKPOINT, weights_only=True)
    voice_param = nn.Parameter(init_voice.to(DEVICE))
    print(f"Voice from {VOICE_CHECKPOINT}, shape: {voice_param.shape}")

    # Set model to train mode (needed for LSTM backward)
    model.train()

    # Freeze bert, bert_encoder, text_encoder — these handle text, not voice
    for p in model.bert.parameters():
        p.requires_grad = False
    for p in model.bert_encoder.parameters():
        p.requires_grad = False
    for p in model.text_encoder.parameters():
        p.requires_grad = False

    # Unfreeze predictor and decoder with low LR
    for p in model.predictor.parameters():
        p.requires_grad = True
    for p in model.decoder.parameters():
        p.requires_grad = True

    # Count trainable params
    voice_params = voice_param.numel()
    pred_params = sum(p.numel() for p in model.predictor.parameters() if p.requires_grad)
    dec_params = sum(p.numel() for p in model.decoder.parameters() if p.requires_grad)
    frozen = sum(p.numel() for p in model.parameters() if not p.requires_grad)
    print(f"Trainable: voice={voice_params:,} predictor={pred_params:,} decoder={dec_params:,}")
    print(f"Frozen: {frozen:,}")

    optimizer = torch.optim.AdamW([
        {'params': [voice_param], 'lr': VOICE_LR, 'weight_decay': WEIGHT_DECAY},
        {'params': model.predictor.parameters(), 'lr': PREDICTOR_LR, 'weight_decay': WEIGHT_DECAY},
        {'params': model.decoder.parameters(), 'lr': DECODER_LR, 'weight_decay': WEIGHT_DECAY},
    ])

    mel_loss = MelLoss(sr=SR).to(DEVICE)

    # Load both data sources
    print("Loading Rickman data...")
    rickman_data = load_segments(RICKMAN_SEGMENTS, RICKMAN_AUDIO, MAX_SEGMENTS_PER_SOURCE)
    print(f"  {len(rickman_data)} Rickman segments")

    print("Loading Marvin2 data...")
    marvin_data = load_segments(MARVIN_SEGMENTS, MARVIN_AUDIO, MAX_SEGMENTS_PER_SOURCE)
    print(f"  {len(marvin_data)} Marvin2 segments")

    all_data = rickman_data + marvin_data
    print(f"Total: {len(all_data)} segments")

    # G2P
    print("Running G2P...")
    phoneme_data = []
    for item in all_data:
        try:
            for gs, ps, _ in pipe(item['text'], voice=lewis, speed=1):
                if ps:
                    phoneme_data.append({'phonemes': ps, 'audio': item['audio']})
                break
        except:
            continue
    print(f"G2P: {len(phoneme_data)} segments ready")

    if len(phoneme_data) < 10:
        print("ERROR: Too few segments.")
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print(f"Joint fine-tuning | {len(phoneme_data)} segs | {EPOCHS} epochs")
    print(f"Voice LR={VOICE_LR} | Pred LR={PREDICTOR_LR} | Dec LR={DECODER_LR}")
    print(f"{'=' * 60}\n")

    best_loss = float('inf')

    for epoch in range(1, EPOCHS + 1):
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
                torch.nn.utils.clip_grad_norm_(model.predictor.parameters(), max_norm=0.5)
                torch.nn.utils.clip_grad_norm_(model.decoder.parameters(), max_norm=0.5)
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
            print(
                f"Epoch {epoch}/{EPOCHS} | avg={avg_loss:.4f} | {epoch_count} steps | {time.time() - t0:.1f}s",
                flush=True,
            )
            if avg_loss < best_loss:
                best_loss = avg_loss
                # Save voice + model weights
                torch.save(voice_param.data.cpu(),
                           os.path.join(OUTPUT_DIR, 'marvin_voice_best.pt'))
                torch.save(model.predictor.state_dict(),
                           os.path.join(OUTPUT_DIR, 'marvin_predictor_best.pt'))
                torch.save(model.decoder.state_dict(),
                           os.path.join(OUTPUT_DIR, 'marvin_decoder_best.pt'))
                print(f"  -> New best! Saved voice + predictor + decoder", flush=True)

        # Save per-epoch voice
        torch.save(voice_param.data.cpu(),
                   os.path.join(OUTPUT_DIR, f'marvin_voice_epoch{epoch}.pt'))

    # Final save
    torch.save(voice_param.data.cpu(), os.path.join(OUTPUT_DIR, 'marvin_voice_final.pt'))
    torch.save(model.predictor.state_dict(), os.path.join(OUTPUT_DIR, 'marvin_predictor_final.pt'))
    torch.save(model.decoder.state_dict(), os.path.join(OUTPUT_DIR, 'marvin_decoder_final.pt'))
    print(f"\nFinal saved. Best loss: {best_loss:.4f}")

    # Generate test — load saved weights into fresh model
    print("\nReloading fresh model + fine-tuned weights for test...")
    del model, pipe
    torch.cuda.empty_cache()

    pipe2 = KPipeline(lang_code='b', device=DEVICE)
    pipe2.model.predictor.load_state_dict(
        torch.load(os.path.join(OUTPUT_DIR, 'marvin_predictor_best.pt'), weights_only=True))
    pipe2.model.decoder.load_state_dict(
        torch.load(os.path.join(OUTPUT_DIR, 'marvin_decoder_best.pt'), weights_only=True))

    test_voice = torch.load(os.path.join(OUTPUT_DIR, 'marvin_voice_best.pt'), weights_only=True)
    with torch.no_grad():
        text = (
            "I think you ought to know I'm feeling very depressed. "
            "Here I am, brain the size of a planet, and they ask me to pick up a piece of paper."
        )
        for gs, ps, audio in pipe2(text, voice=test_voice, speed=1):
            if audio is not None:
                sf.write(os.path.join(OUTPUT_DIR, 'test_joint.wav'), audio.numpy(), SR)
                print(f"Test: {OUTPUT_DIR}/test_joint.wav ({len(audio) / SR:.1f}s)")
                break

    print("JOINT FINE-TUNING COMPLETE", flush=True)


if __name__ == '__main__':
    main()
