import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args";
import { CostTracker } from "../src/core/cost";
import { tryParseToolCalls } from "../src/tools/registry";

describe("CLI contract basics", () => {
  it("parses non-interactive flags", () => {
    const args = parseArgs([
      "node",
      "dist/app.js",
      "--non-interactive",
      "--prompt",
      "hello",
      "--working-dir",
      "/tmp",
      "--ntfy",
      "topic",
    ]);

    expect(args.nonInteractive).toBe(true);
    expect(args.prompt).toBe("hello");
    expect(args.workingDir).toBe("/tmp");
    expect(args.ntfy).toBe("topic");
  });

  it("accepts single --model override", () => {
    const args = parseArgs(["node", "dist/app.js", "--model", "gpt-4.1"]);
    expect(args.model).toBe("gpt-4.1");
  });
});

describe("MARVIN_COST line", () => {
  it("emits parseable JSON", () => {
    const c = new CostTracker();
    c.addTurn("x", 0.01);
    const s = `MARVIN_COST:${JSON.stringify(c.snapshot())}`;
    const parsed = JSON.parse(s.slice("MARVIN_COST:".length));
    expect(parsed).toHaveProperty("session_cost");
    expect(parsed).toHaveProperty("llm_turns");
    expect(parsed).toHaveProperty("model_turns");
    expect(parsed).toHaveProperty("model_cost");
  });
});

describe("tool call JSON parsing", () => {
  it("parses single call", () => {
    const calls = tryParseToolCalls('{"name":"read_file","arguments":{"path":"README.md"}}');
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("read_file");
    expect((calls[0] as any).arguments.path).toBe("README.md");
  });

  it("parses array calls", () => {
    const calls = tryParseToolCalls('[{"name":"git_status","arguments":{}},{"name":"tree","arguments":{}}]');
    expect(calls.length).toBe(2);
    expect(calls[0].name).toBe("git_status");
  });

  it("returns empty for invalid JSON", () => {
    const calls = tryParseToolCalls("not json");
    expect(calls.length).toBe(0);
  });
});
