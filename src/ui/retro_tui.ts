import blessed from "blessed";
import chalk from "chalk";
import type { MarvinArgs } from "../core/types";
import { runChatOnce } from "../core/single_shot";
import { createLogger } from "../core/logger";

const COLORS = {
  bg: "#0a0a0a",
  green: "#00ff41",
  amber: "#ffb000",
  cyan: "#00e5ff",
  magenta: "#ff00ff",
  pink: "#ff69b4",
};

export async function runRetroTui(args: MarvinArgs): Promise<number> {
  const log = createLogger();

  const screen = blessed.screen({
    smartCSR: true,
    title: "Marvin",
    fullUnicode: true,
    dockBorders: true,
  });

  screen.key(["C-c"], () => process.exit(1));

  const top = blessed.box({
    top: 0,
    left: 0,
    height: 1,
    width: "100%",
    style: { bg: COLORS.bg, fg: COLORS.cyan },
    tags: false,
    content: ` █ MARVIN █ provider=${args.provider || process.env.LLM_PROVIDER || "copilot"} `,
  });

  const bottom = blessed.box({
    bottom: 0,
    left: 0,
    height: 1,
    width: "100%",
    style: { bg: COLORS.bg, fg: COLORS.amber },
    content: " PgUp/PgDn scroll • ↑/↓ history • ESC quit ",
  });

  const logBox = blessed.log({
    top: 1,
    left: 0,
    bottom: 3,
    width: "100%",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    scrollbar: { ch: "░", track: { bg: COLORS.bg }, style: { fg: COLORS.pink } },
    style: { bg: COLORS.bg, fg: COLORS.green, border: { fg: COLORS.magenta } },
    tags: true,
    label: "{bold} CHAT {/bold}",
  });

  const input = blessed.textbox({
    bottom: 1,
    left: 0,
    height: 2,
    width: "100%",
    border: { type: "line" },
    style: { bg: COLORS.bg, fg: COLORS.green, border: { fg: COLORS.cyan } },
    inputOnFocus: true,
    keys: true,
    mouse: true,
  });

  screen.append(top);
  screen.append(logBox);
  screen.append(input);
  screen.append(bottom);

  const history: string[] = [];
  let histIdx = 0;

  function pushHistory(v: string) {
    history.push(v);
    histIdx = history.length;
  }

  function setInput(v: string) {
    input.setValue(v);
    (input as any).cursor = v.length;
    screen.render();
  }

  input.key(["escape"], () => process.exit(0));
  input.key(["up"], () => {
    if (history.length === 0) return;
    histIdx = Math.max(0, histIdx - 1);
    setInput(history[histIdx] || "");
  });
  input.key(["down"], () => {
    if (history.length === 0) return;
    histIdx = Math.min(history.length, histIdx + 1);
    setInput(history[histIdx] || "");
  });

  logBox.log(chalk.magentaBright(startupLogo()));
  logBox.log(chalk.dim("I've been asked to think about this. I suppose I must."));

  input.on("submit", async (value: string) => {
    const line = (value || "").trim();
    if (!line) {
      input.clearValue();
      screen.render();
      input.focus();
      return;
    }

    pushHistory(line);
    input.clearValue();
    screen.render();

    if (line === "quit" || line === "exit") {
      process.exit(0);
      return;
    }

    logBox.log(chalk.cyanBright(`\nYou: ${line}`));

    try {
      const res = await runChatOnce({
        prompt: line,
        provider: args.provider,
        model: args.model,
        workingDir: args.workingDir || process.cwd(),
        readonly: false,
        log,
      });
      logBox.log(chalk.greenBright(`\nMarvin: ${res.text}`));
    } catch (e) {
      process.stdout.write("\u0007");
      logBox.log(chalk.redBright(`\nError: ${String(e)}`));
    } finally {
      screen.render();
      input.focus();
    }
  });

  input.focus();
  screen.render();

  // Optional single-shot on startup
  if (args.positionalPrompt) {
    input.emit("submit", args.positionalPrompt);
  }

  return await new Promise<number>((resolve) => {
    screen.on("destroy", () => resolve(0));
  });
}

function startupLogo() {
  return [
    "╔══════════════════════════════════════════════╗",
    "║   ███╗   ███╗ █████╗ ██████╗ ██╗   ██╗      ║",
    "║   ████╗ ████║██╔══██╗██╔══██╗██║   ██║      ║",
    "║   ██╔████╔██║███████║██████╔╝██║   ██║      ║",
    "║   ██║╚██╔╝██║██╔══██║██╔══██╗╚██╗ ██╔╝      ║",
    "║   ██║ ╚═╝ ██║██║  ██║██║  ██║ ╚████╔╝       ║",
    "║   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝        ║",
    "║          Retro Terminal Interface            ║",
    "╚══════════════════════════════════════════════╝",
  ].join("\n");
}
