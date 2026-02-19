/**
 * Voice module: STT via faster-whisper (Python) and TTS via espeak-ng.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STT_SCRIPT = join(__dirname, '..', '..', 'src', 'voice', 'stt.py');

// Resolve the venv python — walk up from dist/voice to marvin-ts/.venv
const VENV_PYTHON = join(__dirname, '..', '..', '.venv', 'bin', 'python');

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
  whisperModel: 'small',
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
  recordProc = spawn('arecord', [
    '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', wavPath,
  ], { stdio: 'ignore' });

  return wavPath;
}

/**
 * Stop recording and return the WAV file path.
 */
export function stopRecording(): string | null {
  if (recordProc) {
    recordProc.kill('SIGINT');
    recordProc = null;
  }
  const p = recordPath;
  recordPath = null;
  return p;
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
 * Speak text using espeak-ng. Non-blocking (fire and forget).
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

  const proc = spawn('espeak-ng', [
    '-v', o.ttsVoice,
    '-s', String(o.ttsSpeed),
    '-p', String(o.ttsPitch),
    '--', clean,
  ], { stdio: 'ignore' });

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
 * Check if espeak-ng is available.
 */
export function hasTTS(): boolean {
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
