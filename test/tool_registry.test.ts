import { describe, expect, it } from "vitest";
import pino from "pino";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolRunner, tryParseToolCalls } from "../src/tools/registry";
import { applyPatchTool } from "../src/tools/coding/apply_patch";

describe("tool parsing", () => {
  it("parses tool call JSON inside code fences", () => {
    const calls = tryParseToolCalls('```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```');
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("read_file");
    expect((calls[0] as any).arguments.path).toBe("a.txt");
  });
});

describe("ToolRunner sharp edges", () => {
  it("returns helpful error when arguments is a non-JSON string", async () => {
    const log = pino({ level: "silent" });
    const runner = new ToolRunner([applyPatchTool()], { workingDir: process.cwd(), readonly: false, interactive: false, log });

    const res = await runner.execute("apply_patch", "not json");
    expect(String(res)).toContain("not valid JSON");
    expect(String(res)).toContain("Expected a JSON object");
  });

  it("routes Codex diff-format apply_patch strings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marvin-"));
    await fs.writeFile(path.join(dir, "hello.txt"), "hello\n", "utf8");

    const log = pino({ level: "silent" });
    const runner = new ToolRunner([applyPatchTool()], { workingDir: dir, readonly: false, interactive: false, log });

    const patch = [
      "*** Begin Patch",
      "*** Update File: hello.txt",
      "@@",
      "-hello",
      "+hi",
      "*** End Patch",
    ].join("\n");

    const res = await runner.execute("apply_patch", patch);
    expect(String(res)).toContain("Applied patch");

    const next = await fs.readFile(path.join(dir, "hello.txt"), "utf8");
    expect(next).toBe("hi\n");
  });
});
