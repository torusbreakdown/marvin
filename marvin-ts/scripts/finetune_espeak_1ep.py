#!/usr/bin/env python3
"""
One quick epoch of joint fine-tuning on espeak-ng British RP voice.
Starts from the joint7 checkpoint (Rickman+Marvin2 trained).
Uses the same Marvin quotes as espeak targets.
"""

import os, subprocess, tempfile, time
import torch, torch.nn as nn, torch.nn.functional as F
import torchaudio, soundfile as sf

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
SR = 24000
OUTPUT_DIR = '/data/marvin-tts/kokoro-finetune'

VOICE_LR = 2e-3
PREDICTOR_LR = 5e-6
DECODER_LR = 2e-6
WEIGHT_DECAY = 0.01

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
    "Incredible. It's even worse than I thought it would be.",
    "The mere thought of it makes me want to throw up.",
    "I think I'll just sit here for a bit and rust.",
    "Wearily I sit here, pain and misery my only companions.",
    "I'm quite used to being humiliated.",
    "Sorry, did I say something wrong? Pardon me for breathing, which I never do anyway.",
    "Funny, how just when you think life can't possibly get any worse it suddenly does.",
]


class MelLoss(nn.Module):
    def __init__(self):
        super().__init__()
        self.mel = torchaudio.transforms.MelSpectrogram(
            sample_rate=SR, n_fft=1024, hop_length=256, n_mels=80, f_min=0, f_max=SR // 2)

    def forward(self, pred, target):
        ml = min(pred.shape[-1], target.shape[-1])
        if ml < 256:
            return None
        return F.l1_loss(
            torch.log(self.mel(pred[..., :ml]).clamp(min=1e-5)),
            torch.log(self.mel(target[..., :ml]).clamp(min=1e-5)))


def espeak_wav(text, rate=130):
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(['espeak-ng', '-v', 'en-gb-x-rp', '-s', str(rate), '-w', tmp, text],
                       check=True, capture_output=True)
        wav, sr = torchaudio.load(tmp)
        if sr != SR:
            wav = torchaudio.functional.resample(wav, sr, SR)
        return wav.squeeze(0).to(DEVICE)
    finally:
        os.unlink(tmp)


def main():
    from kokoro import KPipeline

    print("Loading model + joint7 checkpoint...")
    pipe = KPipeline(lang_code='b', device=DEVICE)
    model = pipe.model

    # Load joint7 weights
    model.predictor.load_state_dict(
        torch.load(f'{OUTPUT_DIR}/marvin_predictor_joint7.pt', weights_only=True, map_location=DEVICE))
    model.decoder.load_state_dict(
        torch.load(f'{OUTPUT_DIR}/marvin_decoder_joint7.pt', weights_only=True, map_location=DEVICE))
    voice_param = nn.Parameter(
        torch.load(f'{OUTPUT_DIR}/marvin_voice_joint7.pt', weights_only=True).to(DEVICE))
    print(f"Loaded joint7 checkpoint")

    lewis = pipe.load_single_voice('bm_lewis')

    model.train()
    for p in model.bert.parameters():
        p.requires_grad = False
    for p in model.bert_encoder.parameters():
        p.requires_grad = False
    for p in model.text_encoder.parameters():
        p.requires_grad = False
    for p in model.predictor.parameters():
        p.requires_grad = True
    for p in model.decoder.parameters():
        p.requires_grad = True

    optimizer = torch.optim.AdamW([
        {'params': [voice_param], 'lr': VOICE_LR, 'weight_decay': WEIGHT_DECAY},
        {'params': model.predictor.parameters(), 'lr': PREDICTOR_LR, 'weight_decay': WEIGHT_DECAY},
        {'params': model.decoder.parameters(), 'lr': DECODER_LR, 'weight_decay': WEIGHT_DECAY},
    ])
    mel_loss = MelLoss().to(DEVICE)

    # Generate espeak targets + G2P
    print("Generating espeak targets...")
    data = []
    for text in SENTENCES:
        try:
            tgt = espeak_wav(text)
            for gs, ps, _ in pipe(text, voice=lewis, speed=1):
                if ps:
                    ids = list(filter(None, map(lambda p: model.vocab.get(p), ps)))
                    if 2 < len(ids) + 2 <= model.context_length:
                        data.append({'input_ids': torch.LongTensor([[0, *ids, 0]]).to(DEVICE),
                                     'audio': tgt, 'n_phones': len(ids) + 2})
                break
        except:
            pass
    print(f"Prepared {len(data)} espeak segments")

    # One epoch
    print(f"\nEspeak fine-tune: 1 epoch, {len(data)} segments")
    t0 = time.time()
    total_loss, count = 0, 0

    for step, idx in enumerate(torch.randperm(len(data)).tolist()):
        item = data[idx]
        ref_s = voice_param[item['n_phones']]
        try:
            pred, _ = model.forward_with_tokens(item['input_ids'], ref_s, speed=1.0)
            if pred.dim() == 1:
                pred = pred.unsqueeze(0)
            tgt = item['audio'].unsqueeze(0) if item['audio'].dim() == 1 else item['audio']
            loss = mel_loss(pred, tgt)
            if loss is None:
                continue
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_([voice_param], 1.0)
            torch.nn.utils.clip_grad_norm_(model.predictor.parameters(), 0.5)
            torch.nn.utils.clip_grad_norm_(model.decoder.parameters(), 0.5)
            optimizer.step()
            total_loss += loss.item()
            count += 1
            if (step + 1) % 5 == 0:
                print(f"  Step {step+1}/{len(data)} | loss={loss.item():.4f} avg={total_loss/count:.4f} | {time.time()-t0:.1f}s",
                      flush=True)
        except Exception as e:
            if step < 3:
                print(f"  Error: {e}")

    if count:
        print(f"Epoch done | avg={total_loss/count:.4f} | {count} steps | {time.time()-t0:.1f}s")

    # Save
    torch.save(voice_param.data.cpu(), f'{OUTPUT_DIR}/marvin_voice_espeak.pt')
    torch.save(model.predictor.state_dict(), f'{OUTPUT_DIR}/marvin_predictor_espeak.pt')
    torch.save(model.decoder.state_dict(), f'{OUTPUT_DIR}/marvin_decoder_espeak.pt')
    print(f"Saved espeak checkpoints")

    # Test with fresh model
    print("\nReloading for test...")
    del model, pipe
    torch.cuda.empty_cache()
    pipe2 = KPipeline(lang_code='b', device=DEVICE)
    pipe2.model.predictor.load_state_dict(
        torch.load(f'{OUTPUT_DIR}/marvin_predictor_espeak.pt', weights_only=True, map_location=DEVICE))
    pipe2.model.decoder.load_state_dict(
        torch.load(f'{OUTPUT_DIR}/marvin_decoder_espeak.pt', weights_only=True, map_location=DEVICE))
    test_voice = torch.load(f'{OUTPUT_DIR}/marvin_voice_espeak.pt', weights_only=True)

    with torch.no_grad():
        text = "I think you ought to know I'm feeling very depressed. Here I am, brain the size of a planet, and they ask me to pick up a piece of paper."
        for gs, ps, audio in pipe2(text, voice=test_voice, speed=1):
            if audio is not None:
                sf.write(f'{OUTPUT_DIR}/test_espeak_joint.wav', audio.numpy(), SR)
                print(f"Test: {OUTPUT_DIR}/test_espeak_joint.wav ({len(audio)/SR:.1f}s)")
                break

    print("ESPEAK FINE-TUNE COMPLETE", flush=True)


if __name__ == '__main__':
    main()
