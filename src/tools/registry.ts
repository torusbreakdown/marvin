import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import type { Logger } from "pino";
import { applyCodexPatch } from "./coding/codex_patch";

export type ToolContext = {
  workingDir: string;
  readonly: boolean;
  interactive: boolean;
  log: Logger;
};

export type ToolDef<A> = {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  write?: boolean;
  run: (ctx: ToolContext, args: A) => Promise<unknown>;
};

export class ToolRunner {
  private readonly byName = new Map<string, ToolDef<any>>();

  // Ticket gating (sub-agent only)
  private tkCreateAttempts = 0;
  private ticketCreated = false;

  constructor(private readonly tools: ToolDef<any>[], private readonly ctx: ToolContext) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  list(): ToolDef<any>[] {
    return [...this.tools];
  }

  async execute(name: string, rawArgs: unknown): Promise<unknown> {
    const tool = this.byName.get(name);
    if (!tool) return `ERROR: unknown tool: ${name}`;

    if (this.ctx.readonly && tool.write) {
      return `ERROR: tool '${name}' is disabled in MARVIN_READONLY=1 mode`;
    }

    if (this.isTicketGatedWrite(tool.name)) {
      return [
        `ERROR: write tools are gated until a ticket is created via 'tk create'.`,
        `Parent ticket: ${process.env.MARVIN_TICKET}`,
        `Call: tk { args: 'create "<title>" -t task --parent ${process.env.MARVIN_TICKET} ...' }`,
      ].join("\n");
    }

    if (tool.name === "tk") {
      const gate = this.maybeGateTkCreate(rawArgs);
      if (gate) return gate;
    }

    // Some models (Codex variants) bypass the structured schema and send a
    // diff-format patch as the entire arguments string.
    if (tool.name === "apply_patch" && typeof rawArgs === "string" && rawArgs.trimStart().startsWith("*** Begin Patch")) {
      const started = Date.now();
      let result: unknown;
      try {
        result = await applyCodexPatch(this.ctx, rawArgs);
      } catch (e) {
        result = `ERROR: ${String(e)}`;
      }
      await this.maybeLogToolCall(tool.name, rawArgs, result, Date.now() - started);
      return result;
    }

    const { args, argsPreview, parseError } = coerceArgs(rawArgs);

    let parsed: any;
    try {
      parsed = tool.schema.parse(args);
    } catch (e) {
      const msg = zodErrorToMessage(e, tool.name, parseError, argsPreview);
      return msg;
    }

    const started = Date.now();
    let result: unknown;
    try {
      result = await tool.run(this.ctx, parsed);
    } catch (e) {
      result = `ERROR: ${String(e)}`;
    }

    await this.maybeLogToolCall(tool.name, argsPreview, result, Date.now() - started);
    return result;
  }

  private isTicketGatedWrite(toolName: string): boolean {
    const parent = process.env.MARVIN_TICKET;
    if (!parent) return false;
    if (process.env.MARVIN_READONLY === "1") return false;

    const writeTools = new Set(["create_file", "append_file", "apply_patch", "run_command", "git_commit", "git_checkout"]);
    if (!writeTools.has(toolName)) return false;

    return !this.ticketCreated;
  }

  private maybeGateTkCreate(rawArgs: unknown): string | null {
    const parent = process.env.MARVIN_TICKET;
    if (!parent) return null;
    if (process.env.MARVIN_READONLY === "1") return null;

    const { args } = coerceArgs(rawArgs);
    const s = typeof (args as any)?.args === "string" ? (args as any).args.trim() : "";
    if (!s.startsWith("create")) return null;

    if (!s.includes("--parent")) {
      return `ERROR: tk create must include --parent ${parent}`;
    }

    this.tkCreateAttempts += 1;
    if (this.tkCreateAttempts === 1) {
      return "ERROR: tk create rejected intentionally (first-rejection rule). Retry with a thorough description + acceptance criteria.";
    }

    this.ticketCreated = true;
    return null;
  }

  private async maybeLogToolCall(tool: string, argsPreview: string, result: unknown, elapsedMs: number) {
    const fp = process.env.MARVIN_SUBAGENT_LOG;
    if (!fp) return;

    const line = {
      ts: new Date().toISOString(),
      tool,
      args: truncate(argsPreview, 200),
      result: truncate(typeof result === "string" ? result : JSON.stringify(result), 400),
      elapsed_ms: elapsedMs,
    };

    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.appendFile(fp, JSON.stringify(line) + "\n", "utf8");
  }
}

export const ToolCallSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional().default({}),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

export function tryParseToolCalls(text: string): ToolCall[] {
  const trimmed = stripCodeFences(text).trim();
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) {
      return v
        .map((x) => ToolCallSchema.safeParse(x))
        .filter((r) => r.success)
        .map((r) => (r as any).data);
    }
    const one = ToolCallSchema.safeParse(v);
    return one.success ? [one.data] : [];
  } catch {
    return [];
  }
}

function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) return (m[1] ?? "").trim();
  return t;
}

function coerceArgs(rawArgs: unknown): { args: unknown; argsPreview: string; parseError?: string } {
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") return { args: parsed, argsPreview: rawArgs };
      return { args: {}, argsPreview: rawArgs, parseError: "arguments parsed to a non-object JSON value" };
    } catch (e) {
      return {
        args: {},
        argsPreview: rawArgs,
        parseError: `arguments was a string but not valid JSON: ${String(e)}`,
      };
    }
  }

  return { args: rawArgs ?? {}, argsPreview: safePreview(rawArgs) };
}

function safePreview(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function zodErrorToMessage(e: unknown, toolName: string, parseError?: string, rawPreview?: string): string {
  if (parseError) {
    return [
      `ERROR: invalid arguments for ${toolName}: ${parseError}`,
      `Expected a JSON object in the 'arguments' field (not a raw string).`,
      rawPreview ? `Raw arguments (preview): ${truncate(rawPreview, 400)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!(e instanceof ZodError)) return `ERROR: invalid arguments for ${toolName}`;
  const details = e.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
  return `ERROR: invalid arguments for ${toolName}: ${details}`;
}

export async function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.GIT_DIR;

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderrChunks.push(Buffer.from(d)));

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") });
    });
  });
}
