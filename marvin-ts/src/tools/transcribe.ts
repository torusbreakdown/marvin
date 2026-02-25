import { z } from 'zod';
import { exec } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolRegistry } from './registry.js';

export function registerTranscribeTools(registry: ToolRegistry): void {
  registry.registerTool(
    'transcribe_audio',
    'Transcribe audio or video files to text using Whisper. Accepts any format ffmpeg can handle (mp3, wav, mp4, mkv, etc). Extracts audio, runs whisper-large, saves transcription to a text file.',
    z.object({
      input_path: z.string().describe('Path to audio or video file to transcribe'),
      output_path: z.string().optional().describe('Path to save transcription text file. Defaults to input_path with .txt extension'),
      language: z.string().default('en').describe('Language code (e.g. en, fr, de)'),
    }),
    async (args, ctx) => {
      const inputPath = args.input_path;
      const outputPath = args.output_path || inputPath.replace(/\.[^.]+$/, '.txt');

      // Step 1: Extract audio to wav via ffmpeg
      const tempDir = await mkdtemp(join(tmpdir(), 'transcribe-'));
      const tempWav = join(tempDir, 'audio.wav');

      const ffmpegResult = await new Promise<string>((resolve) => {
        exec(
          `ffmpeg -y -i "${inputPath}" -vn -ac 1 -ar 16000 -acodec pcm_s16le "${tempWav}"`,
          { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              resolve(`Error extracting audio: ${error.message}\n${stderr}`);
            } else {
              resolve('ok');
            }
          },
        );
      });

      if (ffmpegResult !== 'ok') return ffmpegResult;

      // Step 2: Get audio duration for progress info
      const durationResult = await new Promise<string>((resolve) => {
        exec(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${tempWav}"`,
          (error, stdout) => {
            resolve(error ? 'unknown' : `${Math.round(parseFloat(stdout.trim()))}s`);
          },
        );
      });

      // Step 3: Run faster-whisper via Python
      const ttsVenv = join(ctx.workingDir || '.', '.tts-venv', 'bin', 'python');
      const whisperScript = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel("large-v3", device="cuda", compute_type="float16")
segments, info = model.transcribe(sys.argv[1], language=sys.argv[2], vad_filter=True)
lines = []
for s in segments:
    lines.append(s.text.strip())
text = "\\n".join(lines)
with open(sys.argv[3], "w") as f:
    f.write(text)
print(json.dumps({"chars": len(text), "lines": len(lines)}))
`;

      const result = await new Promise<string>((resolve) => {
        exec(
          `${ttsVenv} -c ${JSON.stringify(whisperScript)} "${tempWav}" "${args.language}" "${outputPath}"`,
          { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              // GPU might be busy, try CPU fallback
              exec(
                `${ttsVenv} -c ${JSON.stringify(whisperScript.replace('device="cuda", compute_type="float16"', 'device="cpu", compute_type="int8"'))} "${tempWav}" "${args.language}" "${outputPath}"`,
                { timeout: 1200_000, maxBuffer: 10 * 1024 * 1024 },
                (error2, stdout2, stderr2) => {
                  if (error2) {
                    resolve(`Error running whisper: ${error2.message}\n${stderr2}`);
                  } else {
                    resolve(stdout2.trim());
                  }
                },
              );
            } else {
              resolve(stdout.trim());
            }
          },
        );
      });

      // Cleanup temp file
      exec(`rm -rf "${tempDir}"`);

      if (result.startsWith('Error')) return result;

      try {
        const info = JSON.parse(result);
        return `Transcription saved to ${outputPath}\nAudio duration: ${durationResult}\nTranscribed ${info.lines} lines (${info.chars} characters).\nUse read_file to view the contents.`;
      } catch {
        return `Transcription saved to ${outputPath}\nAudio duration: ${durationResult}\n${result}`;
      }
    },
    'always',
  );
}
