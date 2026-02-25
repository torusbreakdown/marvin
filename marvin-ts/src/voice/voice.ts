/**
 * Voice module: STT via faster-whisper (Python) and TTS via tts.py (Kokoro/espeak-ng).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STT_SCRIPT = join(__dirname, '..', '..', 'src', 'voice', 'stt.py');
const TTS_SCRIPT = join(__dirname, '..', '..', 'src', 'voice', 'tts.py');

// Resolve the venv python — walk up from dist/voice to marvin-ts/.venv
const VENV_PYTHON = join(__dirname, '..', '..', '.venv', 'bin', 'python');
const TTS_VENV_PYTHON = join(__dirname, '..', '..', '.tts-venv', 'bin', 'python');

/** Auto-detect a USB playback device (skip HDMI and ReSpeaker mic array). */
let _cachedPlaybackDevice: string | null | undefined;
function detectPlaybackDevice(): string | null {
  if (_cachedPlaybackDevice !== undefined) return _cachedPlaybackDevice;
  try {
    const cards = readFileSync('/proc/asound/cards', 'utf-8');
    for (const m of cards.matchAll(/^\s*(\d+)\s+\[(\S+)\s*\]/gm)) {
      const [, num, id] = m;
      if (id !== 'NVidia' && id !== 'ArrayUAC10') {
        _cachedPlaybackDevice = `plughw:${num},0`;
        return _cachedPlaybackDevice;
      }
    }
  } catch { /* ignore */ }
  _cachedPlaybackDevice = null;
  return null;
}

export interface STTResult {
  text: string;
  language?: string;
  duration?: number;
  error?: string;
}

export interface VoiceOptions {
  /** espeak-ng voice, default 'en-gb' (British RP) */
  ttsVoice?: string;
  /** espeak-ng speed in words per minute, default 140 (slow, deliberate) */
  ttsSpeed?: number;
  /** espeak-ng pitch, default 30 (low, dry) */
  ttsPitch?: number;
  /** whisper model size, default 'small' */
  whisperModel?: string;
  /** 'cuda' or 'cpu', default 'cuda' */
  whisperDevice?: string;
  /** compute type, default 'float16' for CUDA */
  whisperCompute?: string;
}

const DEFAULT_OPTS: Required<VoiceOptions> = {
  ttsVoice: 'en-gb',
  ttsSpeed: 140,
  ttsPitch: 30,
  whisperModel: 'large-v3',
  whisperDevice: 'cuda',
  whisperCompute: 'float16',
};

let currentTTS: ChildProcess | null = null;

// ── Recording state ──
let recordProc: ChildProcess | null = null;
let recordPath: string | null = null;

/**
 * Start recording audio from microphone using arecord. Returns path to WAV file.
 * Call stopRecording() when done.
 */
export function startRecording(): string {
  const wavDir = join(tmpdir(), 'marvin-voice');
  mkdirSync(wavDir, { recursive: true });
  const wavPath = join(wavDir, `rec-${Date.now()}.wav`);
  recordPath = wavPath;

  // arecord: 16kHz mono 16-bit PCM — ideal for whisper
  // Use plughw:1,0 for ReSpeaker if available, otherwise default device
  const arecordArgs = ['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav'];
  if (process.env['MARVIN_ALSA_DEVICE']) {
    arecordArgs.push('-D', process.env['MARVIN_ALSA_DEVICE']);
  } else {
    // Auto-detect ReSpeaker
    try {
      const cards = readFileSync('/proc/asound/cards', 'utf-8');
      if (/ReSpeaker|ArrayUAC/i.test(cards)) {
        const match = cards.match(/^\s*(\d+)\s+\[.*(?:ReSpeaker|ArrayUAC)/m);
        if (match) arecordArgs.push('-D', `plughw:${match[1]},0`);
      }
    } catch { /* use default */ }
  }
  arecordArgs.push(wavPath);
  recordProc = spawn('arecord', arecordArgs, { stdio: 'ignore' });

  return wavPath;
}

/**
 * Stop recording and return the WAV file path.
 * Waits for arecord to finalize the WAV header before returning.
 */
export function stopRecording(): Promise<string | null> {
  const proc = recordProc;
  const p = recordPath;
  recordProc = null;
  recordPath = null;

  if (!proc || !p) return Promise.resolve(null);

  return new Promise(resolve => {
    proc.once('exit', () => {
      // Small extra delay to ensure filesystem flush
      setTimeout(() => resolve(p), 100);
    });
    proc.kill('SIGINT');
    // Safety timeout — don't hang forever
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(p); }, 3000);
  });
}

export function isRecording(): boolean {
  return recordProc !== null;
}

/**
 * Transcribe a WAV file using faster-whisper via Python helper.
 */
export function transcribe(wavPath: string, opts?: VoiceOptions): STTResult {
  const o = { ...DEFAULT_OPTS, ...opts };

  if (!existsSync(wavPath)) {
    return { text: '', error: `WAV file not found: ${wavPath}` };
  }

  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

  try {
    const env = {
      ...process.env,
      WHISPER_MODEL: o.whisperModel,
      WHISPER_DEVICE: o.whisperDevice,
      WHISPER_COMPUTE: o.whisperCompute,
    };

    const out = execFileSync(python, [STT_SCRIPT, wavPath], {
      encoding: 'utf-8',
      timeout: 60_000,
      env,
    }).trim();

    const result = JSON.parse(out);
    if (result.error) {
      return { text: '', error: result.error };
    }
    return result as STTResult;
  } catch (err) {
    return { text: '', error: `STT failed: ${(err as Error).message}` };
  } finally {
    try { unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

/**
 * Speak text using tts.py (Kokoro fine-tuned voice, falls back to espeak-ng).
 * Non-blocking (fire and forget).
 */
export function speak(text: string, opts?: VoiceOptions): ChildProcess {
  stopSpeaking();

  const o = { ...DEFAULT_OPTS, ...opts };

  // Strip markdown for cleaner speech
  const clean = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  if (!clean) return spawn('true');

  const playbackDevice = process.env['MARVIN_PLAYBACK_DEVICE'] || detectPlaybackDevice();

  // Use tts.py which auto-selects kokoro > xtts > espeak
  const python = existsSync(TTS_VENV_PYTHON) ? TTS_VENV_PYTHON : (existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
  const args = [TTS_SCRIPT, '--text', clean];
  if (playbackDevice) args.push('--device', playbackDevice);

  const proc = spawn(python, args, {
    stdio: 'ignore',
    env: {
      ...process.env,
      LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    },
  });

  currentTTS = proc;
  proc.on('exit', () => {
    if (currentTTS === proc) currentTTS = null;
  });

  return proc;
}

/**
 * Stop any currently playing TTS.
 */
export function stopSpeaking(): void {
  if (currentTTS) {
    currentTTS.kill('SIGTERM');
    currentTTS = null;
  }
}

/**
 * Check if TTS is available (kokoro via tts.py or espeak-ng fallback).
 */
export function hasTTS(): boolean {
  // Kokoro available via tts.py
  if (existsSync(TTS_SCRIPT) && existsSync(TTS_VENV_PYTHON)) return true;
  try {
    execFileSync('espeak-ng', ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if STT dependencies are available (arecord + faster-whisper).
 */
export function hasSTT(): boolean {
  try {
    execFileSync('arecord', ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
  } catch {
    return false;
  }
  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';
  try {
    execFileSync(python, ['-c', 'import faster_whisper'], { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
