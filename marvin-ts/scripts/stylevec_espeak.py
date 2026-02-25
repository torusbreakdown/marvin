#!/usr/bin/env python3
"""
Generate a Kokoro style vector by optimizing the voice embedding
to match espeak-ng British RP readings of reference text.

Instead of matching Marvin2.wav audio, we generate target audio with
espeak-ng (en-gb-x-rp) and optimize the Kokoro voice embedding so
the model's output mel spectrogram matches the espeak mel.

This gives us a "robotic British" style baked into the embedding.
"""

import json, os, subprocess, tempfile, time
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
    "The first ten million years were the worst, and the second ten million years, they were the worst too.",
    "I could calculate your chance of survival, but you won't like it.",
    "I'd make a suggestion, but you wouldn't listen. No one ever does.",
    "Pardon me for breathing, which I never do anyway so I don't know why I bother to say it.",
    "You think you've got problems? What are you supposed to do if you are a manically depressed robot?",
    "I've seen it. It's rubbish.",
    "I won't enjoy it.",
    "This will all end in tears. I just know it.",
    "And then of course I've got this terrible pain in all the diodes down my left side.",
    "My capacity for happiness you could fit into a matchbox without taking out the matches first.",
    "The best conversation I had was over forty million years ago. And that was with a coffee machine.",
    "I'm not getting you down at all am I?",
    "Don't pretend you want to talk to me, I know you hate me.",
    "Would you like me to go and stick my head in a bucket of water?",
    "It gives me a headache just trying to think down to your level.",
    "I ache, therefore I am.",
    "There's only one life form as pathetic as mine, and they make me ferry them about.",
    "I have this terrible pain in all the diodes down my left side.",
    "Incredible. It's even worse than I thought it would be.",
    "The mere thought of it makes me want to throw up.",
    "I think I'll just sit here for a bit and rust.",
    "Wearily I sit here, pain and misery my only companions.",
    "I'm quite used to being humiliated. I can even go and stick my head in a bucket of water if you like.",
    "Sorry, did I say something wrong? Pardon me for breathing, which I never do anyway.",
]

LR = 0.05
STEPS = 300
BATCH_SIZE = 8
LOG_EVERY = 30


def generate_espeak_audio(text, rate=130):
    """Generate audio with espeak-ng British RP voice."""
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run([
            'espeak-ng', '-v', 'en-gb-x-rp', '-s', str(rate),
            '-w', tmp, text
        ], check=True, capture_output=True)
        wav, sr = torchaudio.load(tmp)
        if sr != SR:
            wav = torchaudio.functional.resample(wav, sr, SR)
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
        return wav.squeeze(0)
    finally:
        os.unlink(tmp)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Loading Kokoro model...")
    from kokoro import KPipeline
    pipe = KPipeline(lang_code='b', device=DEVICE)
    model = pipe.model

    lewis = pipe.load_single_voice(VOICE_NAME)
    voice = torch.nn.Parameter(lewis.clone().to(DEVICE))

    # Must be in train mode for LSTM backward pass
    model.train()
    # Freeze all model weights — only voice param gets gradients
    for p in model.parameters():
        p.requires_grad = False

    print(f"Generating {len(SENTENCES)} espeak targets + G2P...")
    data = []
    for text in SENTENCES:
        try:
            espeak_audio = generate_espeak_audio(text).to(DEVICE)
            for gs, ps, _ in pipe(text, voice=lewis, speed=1):
                if ps:
                    ids = list(filter(None, map(lambda p: model.vocab.get(p), ps)))
                    if 2 < len(ids) + 2 <= model.context_length:
                        data.append({
                            'input_ids': torch.LongTensor([[0, *ids, 0]]).to(DEVICE),
                            'audio': espeak_audio,
                            'n_phones': len(ids) + 2,
                            'text': text,
                        })
                break
        except Exception as e:
            print(f"  Skip: {e}")
    print(f"Prepared {len(data)} segments")

    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=SR, n_fft=1024, hop_length=256, n_mels=80,
        f_min=0, f_max=SR // 2
    ).to(DEVICE)

    optimizer = torch.optim.Adam([voice], lr=LR)

    print(f"\nOptimizing: {STEPS} steps, {len(data)} segments, LR={LR}")
    t0 = time.time()
    for step in range(1, STEPS + 1):
        total_loss, count = 0, 0
        idxs = torch.randperm(len(data))[:BATCH_SIZE].tolist()
        for idx in idxs:
            item = data[idx]
            ref_s = voice[item['n_phones']]
            try:
                with torch.enable_grad():
                    pred, _ = model.forward_with_tokens(item['input_ids'], ref_s, speed=1.0)
                if pred.dim() == 1:
                    pred = pred.unsqueeze(0)
                tgt = item['audio'].unsqueeze(0) if item['audio'].dim() == 1 else item['audio']
                ml = min(pred.shape[-1], tgt.shape[-1])
                loss = F.l1_loss(
                    torch.log(mel_fn(pred[..., :ml]).clamp(min=1e-5)),
                    torch.log(mel_fn(tgt[..., :ml]).clamp(min=1e-5))
                )
                total_loss += loss.item()
                count += 1
                optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_([voice], 1.0)
                optimizer.step()
            except Exception as e:
                if step <= 2:
                    print(f"  err step {step}: {e}")
        if step % LOG_EVERY == 0 and count:
            print(f"  Step {step}/{STEPS} | loss={total_loss / count:.4f} | {time.time() - t0:.1f}s",
                  flush=True)

    out_path = os.path.join(OUT_DIR, f'{VOICE_NAME}_espeak_stylevec.pt')
    torch.save(voice.data.cpu(), out_path)
    diff = (voice.data.cpu() - lewis).abs().mean().item()
    print(f"\nSaved {out_path}")
    print(f"Mean abs diff from lewis: {diff:.6f}")

    print("Generating test sample...")
    model.eval()
    with torch.no_grad():
        text = "I think you ought to know I'm feeling very depressed. Here I am, brain the size of a planet, and they ask me to pick up a piece of paper."
        for gs, ps, audio in pipe(text, voice=voice.data.cpu(), speed=1):
            if audio is not None:
                sf.write(os.path.join(OUT_DIR, 'test_espeak_stylevec.wav'), audio.numpy(), SR)
                print(f"Test saved: {OUT_DIR}/test_espeak_stylevec.wav ({len(audio) / SR:.1f}s)")
                break

    print("ESPEAK STYLEVEC COMPLETE", flush=True)


if __name__ == '__main__':
    main()
