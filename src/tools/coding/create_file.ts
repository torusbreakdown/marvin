import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDef } from "../registry";
import { resolveSandboxedPath } from "./path_security";

export function createFileTool(): ToolDef<{ path: string; content: string }> {
  return {
    name: "create_file",
    description: "Create a new file with the given content. Fails if the file already exists.",
    schema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    write: true,
    async run(ctx, args) {
      const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: args.path });
      if (!resolved.ok) return resolved.error;

      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });

      try {
        await fs.stat(resolved.absPath);
        return `ERROR: file already exists: ${args.path}`;
      } catch {
        // ok
      }

      await fs.writeFile(resolved.absPath, args.content, "utf8");
      return `Created ${args.path} (${Buffer.byteLength(args.content, "utf8")} bytes)`;
    },
  };
}
