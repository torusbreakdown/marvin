import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDef } from "../registry";
import { resolveSandboxedPath } from "./path_security";

export function applyPatchTool(): ToolDef<{ path: string; old_str: string; new_str: string }> {
  return {
    name: "apply_patch",
    description: "Edit a file by replacing an exact string match with new content.",
    schema: z.object({
      path: z.string(),
      old_str: z.string(),
      new_str: z.string(),
    }),
    write: true,
    async run(ctx, args) {
      const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: args.path });
      if (!resolved.ok) return resolved.error;

      const text = await fs.readFile(resolved.absPath, "utf8");
      const idx = text.indexOf(args.old_str);
      if (idx === -1) return `ERROR: old_str not found in ${args.path}`;
      if (text.indexOf(args.old_str, idx + args.old_str.length) !== -1) {
        return `ERROR: old_str is not unique in ${args.path}`;
      }

      const next = text.replace(args.old_str, args.new_str);
      await fs.writeFile(resolved.absPath, next, "utf8");
      return `Updated ${args.path}`;
    },
  };
}
