import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function gitLogTool(): ToolDef<{ max_count?: number; oneline?: boolean }> {
  return {
    name: "git_log",
    description: "Show recent git commits.",
    schema: z.object({
      max_count: z.number().int().min(1).optional().default(10),
      oneline: z.boolean().optional().default(true),
    }),
    write: false,
    async run(ctx, args) {
      const fmt = args.oneline ? "--oneline" : "";
      const { stdout, stderr } = await runShell(`git --no-pager log -n ${args.max_count} ${fmt}`, ctx.workingDir, 60_000);
      return (stdout + (stderr ? "\n" + stderr : "")).trim();
    },
  };
}
