import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function gitStatusTool(): ToolDef<{}> {
  return {
    name: "git_status",
    description: "Show git status of the working directory.",
    schema: z.object({}).default({}) as unknown as z.ZodType<{}>,
    write: false,
    async run(ctx) {
      const { stdout, stderr } = await runShell("git --no-pager status", ctx.workingDir, 60_000);
      return (stdout + (stderr ? "\n" + stderr : "")).trim();
    },
  };
}
