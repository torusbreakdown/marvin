import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ToolRegistry } from './registry.js';

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
        const outputTemplate = join(outputDir, '%(title)s.%(ext)s');
        const output = execSync(
          `yt-dlp --no-playlist -f ${JSON.stringify(format)} -o ${JSON.stringify(outputTemplate)} ${JSON.stringify(url)}`,
          { stdio: 'pipe', encoding: 'utf-8', timeout: 300_000 },
        );
        return output.trim() || 'Download complete.';
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
