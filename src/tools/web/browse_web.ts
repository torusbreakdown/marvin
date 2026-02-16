import { z } from "zod";
import type { ToolDef } from "../registry";
import { fetchText, stripHtmlToText } from "../net/http";

export function browseWebTool(): ToolDef<{ url: string; max_length?: number }> {
  return {
    name: "browse_web",
    description: "Read a specific web page URL (text-only).",
    schema: z.object({
      url: z.string(),
      max_length: z.number().int().min(1).max(8000).optional().default(4000),
    }),
    write: false,
    async run(_ctx, args) {
      const res = await fetchText(args.url, {
        headers: { "User-Agent": "marvin/1.0 (clean-room Node rewrite)" },
        timeoutMs: 20_000,
      });
      if (!res.ok) return `ERROR: browse_web failed (status ${res.status}): ${res.error}`;

      const text = stripHtmlToText(res.text);
      return text.slice(0, args.max_length ?? 4000);
    },
  };
}
