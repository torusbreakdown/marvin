import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ToolRegistry } from './registry.js';

/** Deterministic filename from URL + format: first 8 chars of sha256 */
function ytFilenamePrefix(url: string, format: string): string {
  const hash = createHash('sha256').update(`${url}::${format}`).digest('hex').slice(0, 8);
  // Extract video ID if YouTube
  const match = url.match(/(?:v=|youtu\.be\/)([\w-]{11})/);
  const id = match ? match[1] : hash;
  const fmt = format.includes('audio') ? 'audio' : 'video';
  return `${id}-${fmt}-${hash}`;
}

export function registerDownloadsTools(registry: ToolRegistry): void {
  registry.registerTool(
    'download_file',
    'Download a file from a URL to ~/Downloads/',
    z.object({
      url: z.string().describe('URL to download'),
      filename: z.string().default('').describe('Optional filename'),
    }),
    async ({ url, filename }) => {
      try {
        const downloadDir = join(homedir(), 'Downloads');
        if (!existsSync(downloadDir)) {
          mkdirSync(downloadDir, { recursive: true });
        }
        const resolvedFilename = filename || basename(new URL(url).pathname) || 'download';
        const filePath = join(downloadDir, resolvedFilename);
        if (existsSync(filePath)) {
          const stats = statSync(filePath);
          return `File already exists: ${filePath} (${stats.size} bytes). No need to download again.`;
        }
        execSync(`curl -fSL -o ${JSON.stringify(filePath)} ${JSON.stringify(url)}`, {
          stdio: 'pipe',
        });
        const stats = statSync(filePath);
        return `Downloaded to ${filePath} (${stats.size} bytes)`;
      } catch (error) {
        return `Download failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    'always',
  );

  registry.registerTool(
    'yt_dlp_download',
    'Download video/audio using yt-dlp (installed and ready). Supports YouTube, Vimeo, SoundCloud, and 1000+ sites. Just call this tool with the URL.',
    z.object({
      url: z.string().describe('Video/audio URL'),
      format: z.string().default('bestvideo+bestaudio/best').describe('Format: "bestvideo+bestaudio/best" for video, "bestaudio" for audio only'),
      output_dir: z.string().default('').describe('Output directory (default: ~/Downloads/)'),
    }),
    async ({ url, format, output_dir }) => {
      try {
        const outputDir = output_dir || join(homedir(), 'Downloads');
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }
        const prefix = ytFilenamePrefix(url, format);
        // Check if we already downloaded this exact URL+format
        const existing = readdirSync(outputDir).find(f => f.startsWith(prefix));
        if (existing) {
          const fullPath = join(outputDir, existing);
          const stats = statSync(fullPath);
          return `Already downloaded: ${fullPath} (${stats.size} bytes)`;
        }
        // Download to temp name, then rename with our prefix
        const tmpTemplate = join(outputDir, '%(title)s.%(ext)s');
        const output = execSync(
          `yt-dlp --no-playlist --print filename -f ${JSON.stringify(format)} -o ${JSON.stringify(tmpTemplate)} ${JSON.stringify(url)}`,
          { stdio: 'pipe', encoding: 'utf-8', timeout: 10_000, env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
        ).trim();
        // output is the filename yt-dlp would use — now actually download
        const actualTemplate = join(outputDir, `${prefix}-%(title).50s.%(ext)s`);
        const dlOutput = execSync(
          `yt-dlp --no-playlist -f ${JSON.stringify(format)} -o ${JSON.stringify(actualTemplate)} ${JSON.stringify(url)}`,
          { stdio: 'pipe', encoding: 'utf-8', timeout: 300_000, env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } },
        );
        // Find the file we just created
        const downloaded = readdirSync(outputDir).find(f => f.startsWith(prefix));
        if (downloaded) {
          const fullPath = join(outputDir, downloaded);
          const stats = statSync(fullPath);
          return `Downloaded: ${fullPath} (${stats.size} bytes)`;
        }
        return dlOutput.trim() || 'Download complete.';
      } catch (error: unknown) {
        if (error instanceof Error && 'stderr' in error) {
          const stderr = (error as { stderr: string }).stderr;
          if (stderr?.includes('command not found') || stderr?.includes('No such file')) {
            return 'yt-dlp is not installed. Install it with: pip install --user --break-system-packages yt-dlp';
          }
          return `yt-dlp failed: ${stderr.slice(0, 500)}`;
        }
        return `yt-dlp download failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    'always',
  );
}
