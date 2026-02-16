import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function gitDiffTool(): ToolDef<{ staged?: boolean; path?: string | null }> {
  return {
    name: "git_diff",
    description: "Show git diff.",
    schema: z.object({
      staged: z.boolean().optional().default(false),
      path: z.string().nullable().optional().default(null),
    }),
    write: false,
    async run(ctx, args) {
      const staged = args.staged ? "--staged" : "";
      const p = args.path ? ` -- '${args.path.replace(/'/g, "'\\''")}'` : "";
      const { stdout, stderr } = await runShell(`git --no-pager diff ${staged}${p}`, ctx.workingDir, 60_000);
      return (stdout + (stderr ? "\n" + stderr : "")).trim() || "(no diff)";
    },
  };
}
