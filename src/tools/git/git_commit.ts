import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function gitCommitTool(): ToolDef<{ message: string; add_all?: boolean }> {
  return {
    name: "git_commit",
    description: "Stage and commit changes.",
    schema: z.object({
      message: z.string(),
      add_all: z.boolean().optional().default(true),
    }),
    write: true,
    async run(ctx, args) {
      if (args.add_all) {
        await runShell("git add -A", ctx.workingDir, 60_000);
      }
      const msg = args.message.replace(/"/g, "\\\"");
      const { stdout, stderr, code } = await runShell(`git commit -m "${msg}"`, ctx.workingDir, 60_000);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return out || `git commit exited with code ${code}`;
    },
  };
}
