import type { MarvinArgs } from "./types";
import { runInteractive as runUiInteractive } from "../ui/interactive";

// Back-compat wrapper (core module); the real implementation lives under src/ui/.
export async function runInteractive(args: MarvinArgs): Promise<number> {
  return runUiInteractive(args);
}
