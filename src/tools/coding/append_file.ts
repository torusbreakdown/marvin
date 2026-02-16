import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDef } from "../registry";
import { resolveSandboxedPath } from "./path_security";

export function appendFileTool(): ToolDef<{ path: string; content: string }> {
  return {
    name: "append_file",
    description: "Append content to an existing file.",
    schema: z.object({
      path: z.string(),
      content: z.string().min(1),
    }),
    write: true,
    async run(ctx, args) {
      const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: args.path });
      if (!resolved.ok) return resolved.error;

      await fs.appendFile(resolved.absPath, args.content, "utf8");
      return `Appended ${args.path} (${Buffer.byteLength(args.content, "utf8")} bytes)`;
    },
  };
}
