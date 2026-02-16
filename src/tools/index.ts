import { z } from "zod";
import type { Logger } from "pino";
import type { ToolDef } from "./registry";
import { ToolRunner } from "./registry";
import { createFileTool } from "./coding/create_file";
import { appendFileTool } from "./coding/append_file";
import { applyPatchTool } from "./coding/apply_patch";
import { readFileTool } from "./coding/read_file";
import { codeGrepTool } from "./coding/code_grep";
import { treeTool } from "./coding/tree";
import { runCommandTool } from "./coding/run_command";
import { gitStatusTool } from "./git/git_status";
import { gitDiffTool } from "./git/git_diff";
import { gitCommitTool } from "./git/git_commit";
import { gitLogTool } from "./git/git_log";
import { gitCheckoutTool } from "./git/git_checkout";
import { tkTool } from "./tk";

export function buildToolRunner(params: {
  workingDir: string;
  readonly: boolean;
  interactive: boolean;
  log: Logger;
}): ToolRunner {
  const tools: ToolDef<any>[] = [
    readFileTool(),
    createFileTool(),
    appendFileTool(),
    applyPatchTool(),
    codeGrepTool(),
    treeTool(),
    runCommandTool(),
    gitStatusTool(),
    gitDiffTool(),
    gitCommitTool(),
    gitLogTool(),
    gitCheckoutTool(),
    tkTool(),
  ];

  return new ToolRunner(tools, {
    workingDir: params.workingDir,
    readonly: params.readonly,
    interactive: params.interactive,
    log: params.log,
  });
}

export function buildToolPrompt(): string {
  // Keep concise; models will see detailed guidance in upstream TOOLS.md when available.
  const tools = [
    "read_file(path,start_line?,end_line?)",
    "create_file(path,content)",
    "append_file(path,content)",
    "apply_patch(path,old_str,new_str)",
    "code_grep(pattern,glob_filter?,context_lines?,max_results?)",
    "tree(path?,max_depth?,respect_gitignore?)",
    "run_command(command,timeout?)",
    "git_status()",
    "git_diff(staged?,path?)",
    "git_commit(message,add_all?)",
    "git_log(max_count?,oneline?)",
    "git_checkout(target,create_branch?)",
    "tk(args)",
  ];

  return [
    "TOOL CALLING:",
    "- If you need tools, respond with ONLY JSON (no prose) as either a single object or an array.",
    "- The JSON MUST be one of:",
    '  {"name":"tool_name","arguments":{...}}',
    '  [{"name":"tool_name","arguments":{...}}, ...]',
    "- Arguments must be an object (not a raw string).",
    "- If no tools are needed, output ONLY the final user-facing response text.",
    "\nAVAILABLE TOOLS:",
    ...tools.map((t) => `- ${t}`),
  ].join("\n");
}

export const ToolJsonCallSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});
