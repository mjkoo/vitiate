/**
 * Standalone CLI: npx vitiate <subcommand> [args...]
 *
 * Subcommands:
 * - **init**: Discover fuzz tests, create seed directories, manage .gitignore.
 * - **fuzz**: Set VITIATE_FUZZ=1, spawn vitest run with fuzz test filter.
 * - **regression**: Spawn vitest run with fuzz test filter (no special env vars).
 * - **optimize**: Set VITIATE_OPTIMIZE=1, spawn vitest run with fuzz test filter.
 * - **libfuzzer**: All existing CLI behavior (parent/child supervisor, shmem, libFuzzer flags).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { text } from "@optique/core/message";
import { runSync, type RunOptions } from "@optique/run";
import { cliParser } from "./cli/parsers.js";
import { runLibfuzzerSubcommand } from "./cli/libfuzzer.js";
import {
  runFuzzSubcommand,
  runRegressionSubcommand,
  runOptimizeSubcommand,
} from "./cli/vitest-run.js";
import { runReproduceSubcommand } from "./cli/reproduce.js";
import { runInitSubcommand } from "./cli/init.js";
import { runPathsSubcommand } from "./cli/paths.js";

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Show help and exit 0 when no subcommand is given
  if (rawArgs.length === 0) {
    rawArgs.push("--help");
  }

  const result = runSync(cliParser, {
    programName: "vitiate",
    args: rawArgs,
    brief: [text("Coverage-guided JavaScript fuzzer")],
    help: "option",
  } satisfies RunOptions);

  switch (result.subcommand) {
    case "fuzz":
      runFuzzSubcommand(result);
      return;
    case "regression":
      runRegressionSubcommand(result);
      return;
    case "reproduce":
      await runReproduceSubcommand(result);
      return;
    case "optimize":
      runOptimizeSubcommand(result);
      return;
    case "libfuzzer":
      await runLibfuzzerSubcommand(result.rest);
      return;
    case "init":
      await runInitSubcommand();
      return;
    case "paths":
      await runPathsSubcommand(result);
      return;
    default:
      result satisfies never;
  }
}

// Resolve symlinks so `pnpm exec vitiate` (which uses a symlinked bin) matches
// the real path that `import.meta.url` resolves to.
const resolvedArgv1 = (() => {
  try {
    return realpathSync(process.argv[1]!);
  } catch {
    return process.argv[1];
  }
})();

if (resolvedArgv1 === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
