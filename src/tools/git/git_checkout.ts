import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function gitCheckoutTool(): ToolDef<{ target: string; create_branch?: boolean }> {
  return {
    name: "git_checkout",
    description: "Checkout a branch, commit, or file.",
    schema: z.object({
      target: z.string(),
      create_branch: z.boolean().optional().default(false),
    }),
    write: true,
    async run(ctx, args) {
      const flag = args.create_branch ? "-b" : "";
      const t = args.target.replace(/"/g, "\\\"");
      const { stdout, stderr, code } = await runShell(`git checkout ${flag} "${t}"`, ctx.workingDir, 60_000);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return out || `git checkout exited with code ${code}`;
    },
  };
}
