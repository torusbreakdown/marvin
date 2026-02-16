import type { MarvinArgs } from "../core/types";
import { runPlainRepl } from "./plain_repl";
import { runRetroTui } from "./retro_tui";

export async function runInteractive(args: MarvinArgs): Promise<number> {
  const wantsPlain = Boolean(args.plain);
  const wantsCurses = Boolean(args.curses);

  // Spec: curses is default.
  if (wantsPlain) return runPlainRepl(args);
  if (wantsCurses || !wantsPlain) return runRetroTui(args);
  return runPlainRepl(args);
}
