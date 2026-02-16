import fs from "node:fs/promises";
import path from "node:path";

export type SandboxResult = { ok: true; absPath: string } | { ok: false; error: string };

export async function resolveSandboxedPath(params: {
  workingDir: string;
  relPath: string;
}): Promise<SandboxResult> {
  const relPath = params.relPath;
  if (!relPath) return { ok: false, error: await pathError(params.workingDir, relPath, "Empty path") };

  if (path.isAbsolute(relPath)) {
    return { ok: false, error: await pathError(params.workingDir, relPath, "Absolute paths are not allowed") };
  }

  if (relPath.split(/[\\/]/).includes("..")) {
    return { ok: false, error: await pathError(params.workingDir, relPath, "Path traversal ('..') is not allowed") };
  }

  const absPath = path.resolve(params.workingDir, relPath);
  const wd = path.resolve(params.workingDir);
  if (!(absPath === wd || absPath.startsWith(wd + path.sep))) {
    return { ok: false, error: await pathError(params.workingDir, relPath, "Path escapes working directory") };
  }

  const relNorm = relPath.replace(/\\/g, "/");
  if (relNorm === ".tickets" || relNorm.startsWith(".tickets/")) {
    return { ok: false, error: await pathError(params.workingDir, relPath, "Direct access to .tickets/ is blocked; use tk tool") };
  }

  return { ok: true, absPath };
}

export async function renderProjectTree(workingDir: string, maxDepth = 3): Promise<string> {
  const lines: string[] = [];
  await walk(workingDir, 0, maxDepth, lines);
  return lines.join("\n");
}

async function walk(dir: string, depth: number, maxDepth: number, lines: string[]) {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).sort();
  } catch {
    return;
  }

  for (const name of entries) {
    if (name === ".git" || name === "node_modules" || name === "dist") continue;
    const fp = path.join(dir, name);
    let st;
    try {
      st = await fs.stat(fp);
    } catch {
      continue;
    }
    const indent = "  ".repeat(depth);
    lines.push(`${indent}${name}${st.isDirectory() ? "/" : ""}`);
    if (st.isDirectory()) await walk(fp, depth + 1, maxDepth, lines);
  }
}

async function pathError(workingDir: string, relPath: string, reason: string): Promise<string> {
  const tree = await renderProjectTree(workingDir, 2);
  return [
    `ERROR: ${reason}`,
    `Working directory: ${workingDir}`,
    `You tried to access: ${relPath}`,
    "",
    `Here is your project tree:\n${tree}`,
  ].join("\n");
}

export async function countLines(fp: string): Promise<number> {
  const buf = await fs.readFile(fp, "utf8");
  if (!buf) return 0;
  return buf.split(/\r?\n/).length;
}
