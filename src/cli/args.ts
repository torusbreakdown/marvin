import yargs from "yargs";
import type { MarvinArgs, ProviderName } from "../core/types";

export function parseArgs(argv: string[] = process.argv): MarvinArgs {
  const parsed = yargs(argv.slice(2))
    .scriptName("marvin")
    .usage("$0 [prompt] [options]")
    .option("non-interactive", {
      type: "boolean",
      default: false,
      describe: "Enables single-shot integration mode",
    })
    .option("prompt", {
      type: "string",
      describe: "The user's message (or read from stdin in --non-interactive mode)",
    })
    .option("working-dir", { type: "string", describe: "Sets coding working directory" })
    .option("design-first", { type: "boolean", default: false, describe: "Triggers design-first TDD pipeline" })
    .option("ntfy", { type: "string", describe: "Push notification topic for pipeline alerts" })
    .option("plain", { type: "boolean", default: false, describe: "Readline-based plain terminal UI" })
    .option("curses", { type: "boolean", default: false, describe: "Rich terminal UI (default)" })
    .option("provider", { type: "string", describe: "Override LLM provider (interactive per spec)" })
    .option("model", {
      type: "array",
      describe: "Override model tiers: --model high=... --model low=... (repeatable)",
    })
    .help()
    .version(false)
    .parseSync();

  const positionalPrompt = typeof parsed._[0] === "string" ? parsed._[0] : undefined;

  const rawModelArgs = (parsed.model ?? []) as unknown[];
  const modelArgsStr = rawModelArgs.filter((v): v is string => typeof v === "string");

  // Support either a direct model override (`--model gpt-4.1`) or tier overrides
  // (`--model high=... --model low=...`). If multiple direct overrides are
  // provided, first wins.
  let model: string | undefined;
  const tierArgs: string[] = [];
  for (const a of modelArgsStr) {
    if (a.includes("=")) tierArgs.push(a);
    else if (!model) model = a;
    else tierArgs.push(a);
  }

  return {
    nonInteractive: Boolean(parsed["non-interactive"]),
    designFirst: Boolean(parsed["design-first"]),
    prompt: parsed.prompt,
    positionalPrompt,
    workingDir: parsed["working-dir"],
    ntfy: parsed.ntfy,
    provider: parsed.provider as ProviderName | undefined,
    model,
    modelArgs: tierArgs,
    plain: Boolean(parsed.plain),
    curses: Boolean(parsed.curses),
  };
}
