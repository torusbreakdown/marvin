import { z } from "zod";
import type { ToolDef } from "../registry";
import { fetchText, stripHtmlToText } from "../net/http";

function decodeEntities(s: string): string {
  return stripHtmlToText(s);
}

export function webSearchTool(): ToolDef<{ query: string; max_results?: number; time_filter?: string }> {
  return {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets.",
    schema: z.object({
      query: z.string(),
      max_results: z.number().int().min(1).max(20).optional().default(5),
      time_filter: z.string().optional().default(""),
    }),
    write: false,
    async run(_ctx, args) {
      // DuckDuckGo has no official API; this scrapes the HTML results page.
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
      const res = await fetchText(url, {
        headers: { "User-Agent": "marvin/1.0 (clean-room Node rewrite)" },
        timeoutMs: 20_000,
      });
      if (!res.ok) return `ERROR: web_search failed (status ${res.status}): ${res.error}`;

      const html = res.text;
      const results: { title: string; url: string; snippet: string }[] = [];

      // Very lightweight parsing for DDG HTML.
      const blocks = html.split(/<div class="result__body">/g).slice(1);
      for (const b of blocks) {
        if (results.length >= (args.max_results ?? 5)) break;
        const mLink = b.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!mLink) continue;
        const url = mLink[1] ?? "";
        const title = decodeEntities(mLink[2] ?? "");

        const mSnip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) || b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/span>/i);
        const snippet = decodeEntities((mSnip?.[1] ?? "").trim());

        if (title && url) results.push({ title, url, snippet });
      }

      return results;
    },
  };
}
