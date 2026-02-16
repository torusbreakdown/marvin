import { parseArgs } from "./cli/args";
import { run } from "./core/run";

async function main() {
  const args = parseArgs(process.argv);
  process.exitCode = await run(args);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
