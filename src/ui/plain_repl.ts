import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { MarvinArgs } from "../core/types";
import { runChatOnce } from "../core/single_shot";
import { createLogger } from "../core/logger";

export async function runPlainRepl(args: MarvinArgs): Promise<number> {
  const log = createLogger();
  renderBanner();

  const rl = readline.createInterface({ input, output });
  try {
    if (args.positionalPrompt) {
      const res = await runChatOnce({
        prompt: args.positionalPrompt,
        provider: args.provider,
        model: args.model,
        workingDir: args.workingDir || process.cwd(),
        readonly: false,
        log,
      });
      output.write(chalk.cyanBright("\n") + res.text + "\n\n");
    }

    while (true) {
      const line = (await rl.question(chalk.greenBright("marvin> "))).trim();
      if (!line) continue;
      if (line === "quit" || line === "exit") break;

      const res = await runChatOnce({
        prompt: line,
        provider: args.provider,
        model: args.model,
        workingDir: args.workingDir || process.cwd(),
        readonly: false,
        log,
      });
      output.write(chalk.cyanBright("\n") + res.text + "\n\n");
    }

    return 0;
  } finally {
    rl.close();
  }
}

function renderBanner() {
  const logo = [
    "╔══════════════════════════════════════╗",
    "║        MARVIN // Paranoid CLI        ║",
    "║  brain the size of a planet, etc.    ║",
    "╚══════════════════════════════════════╝",
  ].join("\n");

  output.write(chalk.magentaBright(logo) + "\n\n");
}
