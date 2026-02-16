import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function runCommandTool(): ToolDef<{ command: string; timeout?: number }> {
  return {
    name: "run_command",
    description: "Execute a shell command in the working directory.",
    schema: z.object({
      command: z.string(),
      timeout: z.number().int().min(1).optional().default(60),
    }),
    write: true,
    async run(ctx, args) {
      const timeoutSec = args.timeout ?? 60;
      const { stdout, stderr, code } = await runShell(args.command, ctx.workingDir, timeoutSec * 1000);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return out || `Command exited with code ${code}`;
    },
  };
}
