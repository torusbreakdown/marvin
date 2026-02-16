import fs from "node:fs/promises";
import path from "node:path";
import { resolveSandboxedPath } from "./path_security";

export type CodexPatchContext = {
  workingDir: string;
};

type PatchOp =
  | { kind: "update"; relPath: string; body: string }
  | { kind: "add"; relPath: string; body: string }
  | { kind: "delete"; relPath: string; body: string };

export async function applyCodexPatch(ctx: CodexPatchContext, patchText: string): Promise<string> {
  const ops = parseCodexPatch(patchText);
  if (!ops.length) return "ERROR: invalid Codex patch format (no operations found)";

  const changed: string[] = [];

  for (const op of ops) {
    const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: op.relPath });
    if (!resolved.ok) return resolved.error;

    if (op.kind === "delete") {
      await fs.rm(resolved.absPath, { force: true });
      changed.push(op.relPath);
      continue;
    }

    if (op.kind === "add") {
      const content = renderAddedFile(op.body);
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fs.writeFile(resolved.absPath, content, "utf8");
      changed.push(op.relPath);
      continue;
    }

    // update
    const oldText = await fs.readFile(resolved.absPath, "utf8");
    const next = applyUnifiedDiffLikeBody(oldText, op.body);
    if (!next.ok) return `ERROR: failed to apply patch to ${op.relPath}: ${next.error}`;
    await fs.writeFile(resolved.absPath, next.text, "utf8");
    changed.push(op.relPath);
  }

  return `Applied patch to ${changed.length} file(s): ${changed.join(", ")}`;
}

function parseCodexPatch(text: string): PatchOp[] {
  const t = text.trim();
  if (!t.startsWith("*** Begin Patch")) return [];
  if (!t.includes("*** End Patch")) return [];

  const lines = t.split(/\r?\n/);
  const ops: PatchOp[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      i++;
      continue;
    }

    const m = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (!m) {
      i++;
      continue;
    }

    const kindWord = m[1];
    const relPath = (m[2] ?? "").trim();
    const kind = kindWord === "Update" ? "update" : kindWord === "Add" ? "add" : "delete";

    i++;
    const bodyLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith("*** ") || l === "*** End Patch") break;
      bodyLines.push(l);
      i++;
    }

    ops.push({ kind, relPath, body: bodyLines.join("\n") });
  }

  return ops;
}

function renderAddedFile(body: string): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("+")) out.push(line.slice(1));
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

function applyUnifiedDiffLikeBody(text: string, body: string): { ok: true; text: string } | { ok: false; error: string } {
  const hunks = splitHunks(body);
  if (!hunks.length) return { ok: false, error: "no hunks found" };

  let cur = text;
  for (const hunk of hunks) {
    const { before, after } = hunkToBeforeAfter(hunk);
    if (!before.length) return { ok: false, error: "hunk has no context/removals to anchor" };

    const idx = cur.indexOf(before);
    if (idx === -1) return { ok: false, error: "could not find hunk context in file" };
    if (cur.indexOf(before, idx + before.length) !== -1) return { ok: false, error: "hunk context is not unique" };

    cur = cur.slice(0, idx) + after + cur.slice(idx + before.length);
  }

  return { ok: true, text: cur };
}

function splitHunks(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const hunks: string[] = [];
  let cur: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (cur.length) hunks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    cur.push(line);
  }
  if (cur.length) hunks.push(cur.join("\n"));

  // If there were no @@ markers, treat the whole body as a single hunk.
  if (!hunks.length && body.trim()) return [body];

  return hunks;
}

function hunkToBeforeAfter(hunk: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];

  for (const raw of hunk.split(/\r?\n/)) {
    if (!raw.length) continue;
    const ch = raw[0];
    const line = raw.slice(1);

    if (ch === " ") {
      before.push(line);
      after.push(line);
      continue;
    }
    if (ch === "-") {
      before.push(line);
      continue;
    }
    if (ch === "+") {
      after.push(line);
      continue;
    }

    // Unknown prefix: treat it as context.
    before.push(raw);
    after.push(raw);
  }

  return { before: before.join("\n"), after: after.join("\n") };
}
