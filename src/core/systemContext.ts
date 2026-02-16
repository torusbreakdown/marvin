import fs from "node:fs/promises";
import path from "node:path";
import { ProfileData } from "./profile";

async function readIfExists(p: string, maxBytes = 50_000): Promise<string> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return "";
    const buf = await fs.readFile(p);
    return buf.slice(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

export async function buildSystemMessage(opts: {
  profile: ProfileData;
  codingMode: boolean;
  workingDir?: string;
}): Promise<string> {
  const { profile, codingMode, workingDir } = opts;

  const parts: string[] = [];
  parts.push(
    "You are Marvin, a helpful local-business and general-purpose assistant. Your name is Marvin — always refer to yourself as Marvin.",
  );

  parts.push(`Active profile: ${profile.activeProfile}`);
  // Keep YAML-ish formatting for compatibility with the upstream spec text.
  parts.push(`User preferences (YAML):\n${JSON.stringify(profile.preferences, null, 2)}`);
  parts.push(`Saved places (JSON):\n${JSON.stringify(profile.savedPlacesRaw, null, 2)}`);
  if (profile.compactHistory) parts.push(`Recent conversation history:\n${profile.compactHistory}`);

  if (codingMode && workingDir) {
    parts.push(`CODING MODE ACTIVE — working dir: ${workingDir}`);

    const marvinDir = path.join(workingDir, ".marvin");
    parts.push(await readIfExists(path.join(workingDir, ".marvin-instructions")));
    parts.push(await readIfExists(path.join(marvinDir, "instructions.md")));
    parts.push(await readIfExists(path.join(marvinDir, "spec.md")));
    parts.push(await readIfExists(path.join(marvinDir, "ux.md")));
    parts.push(await readIfExists(path.join(marvinDir, "design.md")));
  }

  return parts.filter(Boolean).join("\n\n---\n\n");
}
