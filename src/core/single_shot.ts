import type { Logger } from "pino";
import { getProvider } from "../llm";
import type { ProviderName } from "./types";
import { readProfileData } from "./profile";
import { buildSystemMessage } from "./systemContext";
import { buildToolPrompt, buildToolRunner } from "../tools";
import { runAgent } from "./agent";

export type ChatOnceArgs = {
  prompt: string;
  provider?: ProviderName;
  model?: string;
  workingDir: string;
  readonly: boolean;
  log: Logger;
};

export async function runChatOnce(args: ChatOnceArgs): Promise<{
  text: string;
  cost: { session_cost: number; llm_turns: number; model_turns: Record<string, number>; model_cost: Record<string, number> };
}> {
  const providerName = String(args.provider || process.env.LLM_PROVIDER || "copilot").toLowerCase();
  const model = args.model || process.env.MARVIN_MODEL || "";

  const provider = getProvider(providerName, args.log);

  const profile = await readProfileData();
  const system = [await buildSystemMessage({ profile, codingMode: false, workingDir: args.workingDir }), buildToolPrompt()].join("\n\n");

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: args.prompt },
  ];

  const tools = buildToolRunner({ workingDir: args.workingDir, readonly: args.readonly, interactive: true, log: args.log });

  let text = "";
  const res = await runAgent({
    provider,
    model,
    messages,
    tools,
    maxRounds: 50,
    log: args.log,
    onToken: (chunk) => (text += chunk),
  });
  text = res.text;

  return {
    text,
    cost: {
      session_cost: 0,
      llm_turns: res.llmTurns,
      model_turns: { [model || providerName]: res.llmTurns },
      model_cost: { [model || providerName]: 0 },
    },
  };
}
