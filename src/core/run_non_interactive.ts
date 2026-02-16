import type { MarvinArgs } from "./types";
import { createLogger } from "./logger";
import { getProvider } from "../llm";
import { CostTracker } from "./cost";
import { readProfileData } from "./profile";
import { buildSystemMessage } from "./systemContext";
import { buildToolPrompt, buildToolRunner } from "../tools";
import { runAgent } from "./agent";
import { readStdinToString } from "./stdin";

export async function runNonInteractive(args: MarvinArgs): Promise<number> {
  const log = createLogger();
  const cost = new CostTracker();

  try {
    if (args.designFirst) {
      process.stderr.write("Error: --design-first pipeline is not implemented in this Node rewrite yet\n");
      cost.emitToStderr();
      return 1;
    }

    let prompt = args.prompt;
    if (!prompt) {
      const stdinText = await readStdinToString().catch(() => "");
      prompt = stdinText.trim();
    }

    if (!prompt) {
      process.stderr.write("Error: --prompt is required in --non-interactive mode (or provide prompt via stdin)\n");
      cost.emitToStderr();
      return 1;
    }

    // Spec: provider set via LLM_PROVIDER env var in non-interactive mode.
    const providerName = String(process.env.LLM_PROVIDER || "copilot").toLowerCase();
    const model = args.model || process.env.MARVIN_MODEL || "";

    const workingDir = args.workingDir || process.cwd();
    const readonly = process.env.MARVIN_READONLY === "1";

    const provider = getProvider(providerName, log);
    const profile = await readProfileData();

    const system = [await buildSystemMessage({ profile, codingMode: true, workingDir }), buildToolPrompt()].join("\n\n");

    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: prompt },
    ];

    const tools = buildToolRunner({ workingDir, readonly, interactive: false, log });

    const res = await runAgent({
      provider,
      model,
      messages,
      tools,
      maxRounds: Number(process.env.MARVIN_TOOL_ROUNDS || 50),
      log,
      onMarker: (line) => process.stdout.write(line + "\n"),
      onToken: (chunk) => process.stdout.write(chunk),
    });

    cost.addTurn(model || providerName);
    // Count additional turns (tool loop rounds) as additional turns.
    for (let i = 1; i < res.llmTurns; i++) cost.addTurn(model || providerName);

    cost.emitToStderr();
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${String(err)}\n`);
    cost.emitToStderr();
    return 1;
  }
}
