import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ToolRegistry } from './registry.js';

const OCR_API_URL = 'https://api.ocr.space/parse/image';

export function registerOcrTools(registry: ToolRegistry): void {
  registry.registerTool(
    'ocr',
    'Extract text from an image or PDF using OCR. Supports jpg, png, gif, bmp, tiff, pdf. Returns raw extracted text — the LLM can clean up any OCR artifacts.',
    z.object({
      file_path: z.string().describe('Path to the image or PDF file'),
      language: z.string().default('eng').describe('OCR language code (eng, spa, fra, deu, jpn, kor, chi_sim, etc.)'),
      page: z.number().default(1).describe('For multi-page PDFs, which page to OCR (1-indexed)'),
    }),
    async (args) => {
      const { file_path, language, page } = args;

      if (!existsSync(file_path)) {
        return `File not found: ${file_path}`;
      }

      const ext = extname(file_path).toLowerCase();
      const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.tif', '.pdf', '.webp'];
      if (!allowedExts.includes(ext)) {
        return `Unsupported file type: ${ext}. Supported: ${allowedExts.join(', ')}`;
      }

      const apiKey = process.env.OCR_SPACE_API_KEY || 'helloworld'; // free tier default key
      const fileData = readFileSync(file_path);
      const base64 = fileData.toString('base64');
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
        '.tif': 'image/tiff', '.pdf': 'application/pdf', '.webp': 'image/webp',
      };
      const mime = mimeTypes[ext] || 'application/octet-stream';
      const dataUri = `data:${mime};base64,${base64}`;

      // OCR.space has a 1MB limit on free tier
      if (fileData.length > 1024 * 1024) {
        return `File too large for OCR (${(fileData.length / 1024 / 1024).toFixed(1)}MB). Free tier limit is 1MB. Resize or compress the image first.`;
      }

      try {
        const form = new URLSearchParams();
        form.set('base64Image', dataUri);
        form.set('language', language);
        form.set('isOverlayRequired', 'false');
        form.set('filetype', ext.replace('.', ''));
        form.set('detectOrientation', 'true');
        form.set('scale', 'true');
        form.set('OCREngine', '2'); // Engine 2 is better for most cases
        if (ext === '.pdf') {
          form.set('isTable', 'true');
        }

        const resp = await fetch(OCR_API_URL, {
          method: 'POST',
          headers: {
            'apikey': apiKey,
          },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
          return `OCR API error: ${resp.status} ${resp.statusText}`;
        }

        const data = await resp.json() as any;

        if (data.IsErroredOnProcessing) {
          const errMsg = data.ErrorMessage?.join('; ') || data.ErrorDetails || 'Unknown error';
          return `OCR failed: ${errMsg}`;
        }

        const results = data.ParsedResults;
        if (!results?.length) {
          return 'No text detected in the image.';
        }

        // For PDFs with multiple pages, select the requested page
        const pageIdx = Math.min(page - 1, results.length - 1);
        const text = results[pageIdx]?.ParsedText?.trim();

        if (!text) {
          return 'No text detected in the image.';
        }

        const header = `OCR result from ${basename(file_path)}` +
          (results.length > 1 ? ` (page ${pageIdx + 1} of ${results.length})` : '') +
          ':\n\n';

        return header + text;
      } catch (err) {
        return `OCR error: ${(err as Error).message}`;
      }
    },
    'always',
  );
}
