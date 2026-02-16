import { z } from "zod";
import type { ToolDef } from "../registry";
import { renderProjectTree, resolveSandboxedPath } from "./path_security";

export function treeTool(): ToolDef<{ path?: string; max_depth?: number; respect_gitignore?: boolean }> {
  return {
    name: "tree",
    description: "List directory tree structure.",
    schema: z.object({
      path: z.string().optional().default("."),
      max_depth: z.number().int().min(0).optional().default(3),
      respect_gitignore: z.boolean().optional().default(true),
    }),
    write: false,
    async run(ctx, args) {
      const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: args.path || "." });
      if (!resolved.ok) return resolved.error;
      // respect_gitignore is best-effort; keep it simple here.
      return await renderProjectTree(resolved.absPath, args.max_depth);
    },
  };
}
