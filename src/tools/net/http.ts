export type HttpResult = { ok: true; status: number; text: string } | { ok: false; status: number; error: string };

export async function fetchText(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<HttpResult> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers: opts?.headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 1000) };
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

export function stripHtmlToText(html: string): string {
  // Minimal HTML→text for tool output; not meant to be perfect.
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?p\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/\s+\n/g, "\n");
  s = s.replace(/\n\s+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}
