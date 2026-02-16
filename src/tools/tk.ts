import { z } from "zod";
import type { ToolDef } from "./registry";
import { runShell } from "./registry";

export function tkTool(): ToolDef<{ args: string }> {
  return {
    name: "tk",
    description: "Run the tk ticket CLI.",
    schema: z.object({ args: z.string() }),
    write: false,
    async run(ctx, args) {
      const { stdout, stderr, code } = await runShell(`tk ${args.args}`, ctx.workingDir, 60_000);
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return out || `tk exited with code ${code}`;
    },
  };
}
