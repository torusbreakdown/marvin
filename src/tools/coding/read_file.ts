import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDef } from "../registry";
import { countLines, resolveSandboxedPath } from "./path_security";

export function readFileTool(): ToolDef<{ path: string; start_line?: number | null; end_line?: number | null }> {
  return {
    name: "read_file",
    description: "Read a file's contents with line numbers.",
    schema: z.object({
      path: z.string(),
      start_line: z.number().int().positive().nullable().optional(),
      end_line: z.number().int().positive().nullable().optional(),
    }),
    write: false,
    async run(ctx, args) {
      const resolved = await resolveSandboxedPath({ workingDir: ctx.workingDir, relPath: args.path });
      if (!resolved.ok) return resolved.error;

      const st = await fs.stat(resolved.absPath);
      const large = st.size > 10 * 1024;
      const hasRange = typeof args.start_line === "number" || typeof args.end_line === "number";
      if (large && !hasRange) {
        const total = await countLines(resolved.absPath);
        return [
          `ERROR: file is large (${st.size} bytes). Provide start_line/end_line.`,
          `Total lines: ${total}`,
          "Examples:",
          `  read_file { path: \"${args.path}\", start_line: 1, end_line: 120 }`,
          `  read_file { path: \"${args.path}\", start_line: 121, end_line: 240 }`,
        ].join("\n");
      }

      const text = await fs.readFile(resolved.absPath, "utf8");
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, args.start_line ?? 1);
      const end = Math.min(lines.length, args.end_line ?? lines.length);
      const out: string[] = [];
      for (let i = start; i <= end; i++) {
        out.push(`${i}. ${lines[i - 1] ?? ""}`);
      }
      return out.join("\n");
    },
  };
}
