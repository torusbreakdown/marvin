import type { MarvinArgs } from "./types";
import { runNonInteractive } from "./run_non_interactive";
import { runInteractive } from "../ui/interactive";

export async function run(args: MarvinArgs): Promise<number> {
  if (args.nonInteractive || args.designFirst) {
    return runNonInteractive(args);
  }

  return runInteractive(args);
}
