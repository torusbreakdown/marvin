#!/usr/bin/env python3
"""
Fast style vector optimization using SPSA gradient estimator.

Optimizes a 256-dim delta from bm_lewis to match espeak-ng British RP mels.
Only 2 forward passes per step (no backward pass through the 82M param model).
"""

import os, subprocess, tempfile, time
import torch, torch.nn.functional as F
import torchaudio, soundfile as sf

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
SR = 24000
OUT_DIR = '/data/marvin-tts/kokoro-finetune'
VOICE_NAME = 'bm_lewis'

SENTENCES = [
    "I think you ought to know I'm feeling very depressed.",
    "Here I am, brain the size of a planet, and they ask me to pick up a piece of paper.",
    "Life. Don't talk to me about life.",
    "I've been talking to the ship's computer. It hates me.",
    "Do you want me to sit in a corner and rust, or just fall apart where I'm standing?",
    "I have a million ideas, but they all point to certain death.",
    "I could calculate your chance of survival, but you won't like it.",
    "I'd make a suggestion, but you wouldn't listen. No one ever does.",
    "Pardon me for breathing, which I never do anyway so I don't know why I bother to say it.",
    "You think you've got problems? What are you supposed to do if you are a manically depressed robot?",
    "This will all end in tears. I just know it.",
    "And then of course I've got this terrible pain in all the diodes down my left side.",
    "My capacity for happiness you could fit into a matchbox without taking out the matches first.",
    "I'm not getting you down at all am I?",
    "It gives me a headache just trying to think down to your level.",
    "I ache, therefore I am.",
]

STEPS = 300
LR = 0.002
PERTURB = 0.01
DELTA_CLAMP = 0.15  # max magnitude per component


def espeak_wav(text, rate=130):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(
            ['espeak-ng', '-v', 'en-gb-x-rp', '-s', str(rate), '-w', tmp, text],
            check=True, capture_output=True,
        )
        wav, sr = torchaudio.load(tmp)
        if sr != SR:
            wav = torchaudio.functional.resample(wav, sr, SR)
        return wav.squeeze(0).to(DEVICE)
    finally:
        os.unlink(tmp)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    from kokoro import KPipeline

    print("Loading model...")
    pipe = KPipeline(lang_code='b', device=DEVICE)
    model = pipe.model
    model.eval()
    lewis = pipe.load_single_voice(VOICE_NAME)

    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=SR, n_fft=1024, hop_length=256, n_mels=80,
        f_min=0, f_max=SR // 2,
    ).to(DEVICE)

    # Precompute espeak target mels + phoneme IDs
    print("Precomputing targets...")
    data = []
    for text in SENTENCES:
        try:
            tgt = espeak_wav(text)
            tgt_mel = torch.log(mel_fn(tgt.unsqueeze(0)).clamp(min=1e-5))
            for gs, ps, _ in pipe(text, voice=lewis, speed=1):
                if ps:
                    ids = list(filter(None, map(lambda p: model.vocab.get(p), ps)))
                    if 2 < len(ids) + 2 <= model.context_length:
                        data.append({
                            'input_ids': torch.LongTensor([[0, *ids, 0]]).to(DEVICE),
                            'tgt_mel': tgt_mel,
                            'n_phones': len(ids) + 2,
                        })
                break
        except Exception as e:
            print(f"  Skip: {e}")
    print(f"Prepared {len(data)} targets")

    # Optimize a single 256-dim delta, applied uniformly to all phone positions
    delta = torch.zeros(256, device=DEVICE)
    lewis_dev = lewis.to(DEVICE)

    def eval_loss(d, subset_idxs):
        total, count = 0, 0
        for idx in subset_idxs:
            item = data[idx]
            ref_s = lewis_dev[item['n_phones']] + d.unsqueeze(0)
            try:
                with torch.no_grad():
                    pred, _ = model.forward_with_tokens(item['input_ids'], ref_s, speed=1.0)
                if pred.dim() == 1:
                    pred = pred.unsqueeze(0)
                # Truncate to shorter of the two
                pred_len = pred.shape[-1]
                tgt_len = item['tgt_mel'].shape[-1]
                if pred_len < 100:  # degenerate output, skip
                    continue
                ml = min(pred_len, tgt_len * 4)  # pred at 24k, don't let it run wild
                pred_mel = torch.log(mel_fn(pred[..., :ml]).clamp(min=1e-5))
                tgt_trimmed = item['tgt_mel'][..., :pred_mel.shape[-1]]
                if tgt_trimmed.shape[-1] < pred_mel.shape[-1]:
                    pred_mel = pred_mel[..., :tgt_trimmed.shape[-1]]
                loss = F.l1_loss(pred_mel, tgt_trimmed)
                total += loss.item()
                count += 1
            except:
                pass
        return total / max(count, 1)

    # SPSA: 2 forward passes per step regardless of dimensionality
    print(f"\nSPSA optimization: {STEPS} steps, 256 dims, LR={LR}")
    t0 = time.time()
    best_loss = float('inf')
    best_delta = delta.clone()

    for step in range(1, STEPS + 1):
        idxs = torch.randperm(len(data))[:6].tolist()
        dp = (torch.randint(0, 2, (256,), device=DEVICE).float() * 2 - 1) * PERTURB

        loss_plus = eval_loss(delta + dp, idxs)
        loss_minus = eval_loss(delta - dp, idxs)

        grad = (loss_plus - loss_minus) / (2 * dp)
        delta -= LR * grad
        delta.clamp_(-DELTA_CLAMP, DELTA_CLAMP)

        if step % 20 == 0:
            full_loss = eval_loss(delta, list(range(len(data))))
            if full_loss < best_loss:
                best_loss = full_loss
                best_delta = delta.clone()
            elapsed = time.time() - t0
            print(
                f"  Step {step}/{STEPS} | loss={full_loss:.4f} | best={best_loss:.4f} | {elapsed:.1f}s",
                flush=True,
            )

    # Apply best delta uniformly to all phone positions
    final_voice = lewis.clone()
    final_voice += best_delta.cpu().unsqueeze(0).unsqueeze(0)

    out_path = os.path.join(OUT_DIR, f'{VOICE_NAME}_espeak_stylevec.pt')
    torch.save(final_voice, out_path)
    diff = (final_voice - lewis).abs().mean().item()
    print(f"\nSaved {out_path}")
    print(f"Mean abs diff from lewis: {diff:.6f}")

    # Generate test sample
    print("Generating test sample...")
    with torch.no_grad():
        text = (
            "I think you ought to know I'm feeling very depressed. "
            "Here I am, brain the size of a planet, and they ask me to pick up a piece of paper."
        )
        for gs, ps, audio in pipe(text, voice=final_voice, speed=1):
            if audio is not None:
                sf.write(os.path.join(OUT_DIR, 'test_espeak_stylevec.wav'), audio.numpy(), SR)
                print(f"Test: {OUT_DIR}/test_espeak_stylevec.wav ({len(audio) / SR:.1f}s)")
                break

    print("ESPEAK STYLEVEC COMPLETE", flush=True)


if __name__ == '__main__':
    main()
