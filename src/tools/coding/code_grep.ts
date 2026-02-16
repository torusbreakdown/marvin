import { z } from "zod";
import type { ToolDef } from "../registry";
import { runShell } from "../registry";

export function codeGrepTool(): ToolDef<{ pattern: string; glob_filter?: string; context_lines?: number; max_results?: number }> {
  return {
    name: "code_grep",
    description: "Search for a regex pattern in files within the working directory.",
    schema: z.object({
      pattern: z.string(),
      glob_filter: z.string().optional().default("*"),
      context_lines: z.number().int().min(0).optional().default(2),
      max_results: z.number().int().min(1).optional().default(20),
    }),
    write: false,
    async run(ctx, args) {
      const cmd = [
        "rg",
        "--no-heading",
        "--line-number",
        `-C ${args.context_lines}`,
        `-g '${(args.glob_filter ?? "*").replace(/'/g, "'\\''")}'`,
        `--max-count ${args.max_results}`,
        `'${args.pattern.replace(/'/g, "'\\''")}'`,
        ".",
      ].join(" ");

      const { stdout, stderr, code } = await runShell(cmd, ctx.workingDir, 60_000);
      if (code !== 0 && !stdout.trim()) return stderr.trim() || "No matches";
      return stdout.trim() || "No matches";
    },
  };
}
