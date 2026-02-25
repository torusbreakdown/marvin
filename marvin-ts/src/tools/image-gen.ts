import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSecret } from '../secrets.js';
import { randomUUID } from 'node:crypto';
import type { ToolRegistry } from './registry.js';

const NCPURE_DEFAULT_URL = 'http://localhost:9850';

function getOutputDir(): string {
  const dir = process.env.NCPURE_IMAGE_DIR || join(homedir(), 'ncpure', 'images');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function ncpureUrl(): string {
  return process.env.NCPURE_URL || NCPURE_DEFAULT_URL;
}

/** Push an image file to ncpure board via its REST API (best-effort). */
async function pushToNcpure(filePath: string, tags: string[], query: string): Promise<string | null> {
  try {
    const url = `${ncpureUrl()}/api/images/upload`;
    const fileBytes = readFileSync(filePath);
    const boundary = `----marvin${Date.now()}`;
    const filename = filePath.split('/').pop() || 'image.png';
    const ext = filename.split('.').pop() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';

    const parts: Buffer[] = [];
    // file part
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    parts.push(fileBytes);
    parts.push(Buffer.from('\r\n'));
    // tags part
    if (tags.length) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\n${tags.join(',')}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const data = await resp.json() as { id: string };
      return data.id;
    }
    return null;
  } catch {
    return null;
  }
}

export function registerImageGenTools(registry: ToolRegistry): void {
  registry.registerTool(
    'generate_image',
    'Generate an image from a text prompt using AI (Gemini 2.5 Flash or SDXL). ' +
    'Saves to ~/ncpure/images/ and optionally pushes to a running ncpure board. ' +
    'Set GEMINI_API_KEY or use SDXL_API_URL for Stable Diffusion.',
    z.object({
      prompt: z.string().describe('Text description of the image to generate'),
      model: z.enum(['gemini', 'sdxl']).default('gemini').describe("Model: 'gemini' for Gemini 2.5 Flash, 'sdxl' for Stable Diffusion XL"),
      width: z.number().default(1024).describe('Image width in pixels'),
      height: z.number().default(1024).describe('Image height in pixels'),
      add_to_ncpure: z.boolean().default(true).describe('Push the generated image to a running ncpure board'),
      tags: z.array(z.string()).default([]).describe('Tags for the generated image'),
    }),
    async (args) => {
      const { prompt, model, width, height, add_to_ncpure, tags } = args;
      const outDir = getOutputDir();
      const id = randomUUID();

      try {
        let filePath: string;

        if (model === 'gemini') {
          filePath = await generateWithGemini(prompt, width, height, id, outDir);
        } else {
          filePath = await generateWithSDXL(prompt, width, height, id, outDir);
        }

        let ncpureId: string | null = null;
        if (add_to_ncpure) {
          ncpureId = await pushToNcpure(filePath, [...tags, 'ai-generated'], prompt);
        }

        const ncpureMsg = ncpureId
          ? ` Added to ncpure board (id: ${ncpureId}).`
          : add_to_ncpure ? ' (ncpure not running — saved locally only)' : '';

        return `Image generated: ${filePath}${ncpureMsg}`;
      } catch (error) {
        return `Image generation failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    'always',
  );
}

// ── Gemini 2.5 Flash (native image generation) ─────────────────────

async function generateWithGemini(
  prompt: string, width: number, height: number, id: string, outDir: string,
): Promise<string> {
  const apiKey = getSecret('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set. Add with: pass insert marvin/GEMINI_API_KEY');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-image-generation:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: `Generate an image: ${prompt}` }],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageDimension: dimensionTag(width, height),
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as any;

  // Extract inline image data from response
  const candidates = data.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
        const filePath = join(outDir, `${id}.${ext}`);
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        writeFileSync(filePath, buffer);
        return filePath;
      }
    }
  }

  throw new Error('Gemini returned no image data. The model may have refused the prompt.');
}

/** Map dimensions to Gemini's supported aspect ratio tags */
function dimensionTag(w: number, h: number): string | undefined {
  const ratio = w / h;
  if (Math.abs(ratio - 1) < 0.1) return 'SQUARE_1024';
  if (ratio > 1.3) return 'LANDSCAPE_1024_768';
  if (ratio < 0.77) return 'PORTRAIT_768_1024';
  return undefined;
}

// ── SDXL (via ComfyUI / Stable Diffusion WebUI / generic API) ──────

async function generateWithSDXL(
  prompt: string, width: number, height: number, id: string, outDir: string,
): Promise<string> {
  const apiUrl = process.env.SDXL_API_URL;
  if (!apiUrl) throw new Error('SDXL_API_URL not set. Point it at a ComfyUI or SD WebUI endpoint.');

  // Try Stable Diffusion WebUI API (AUTOMATIC1111 / Forge)
  const body = {
    prompt,
    negative_prompt: 'low quality, blurry, deformed',
    width,
    height,
    steps: 30,
    cfg_scale: 7,
    sampler_name: 'DPM++ 2M Karras',
  };

  const resp = await fetch(`${apiUrl}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SDXL API error (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as any;
  const images: string[] = data.images || [];
  if (!images.length) throw new Error('SDXL returned no images.');

  const filePath = join(outDir, `${id}.png`);
  const buffer = Buffer.from(images[0], 'base64');
  writeFileSync(filePath, buffer);
  return filePath;
}
