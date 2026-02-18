import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerDownloadsTools(registry: ToolRegistry): void {
  registry.registerTool(
    'download_file',
    'Download a file from a URL to ~/Downloads/',
    z.object({
      url: z.string().describe('URL to download'),
      filename: z.string().default('').describe('Optional filename'),
    }),
    async () => 'Not yet implemented',
    'always',
  );

  registry.registerTool(
    'yt_dlp_download',
    'Download video/audio from YouTube or other sites',
    z.object({
      url: z.string().describe('Video URL'),
      audio_only: z.boolean().default(false).describe('Download audio only'),
    }),
    async () => 'Not yet implemented',
    'always',
  );
}
