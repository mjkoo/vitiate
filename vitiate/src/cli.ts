/**
 * Standalone CLI: npx vitiate <test-file> [corpus_dirs...] [flags]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { object } from "@optique/core/constructs";
import { option, argument } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { optional, multiple, withDefault } from "@optique/core/modifiers";
import { type InferValue, parseSync } from "@optique/core/parser";
import { formatMessage } from "@optique/core/message";
import { runSync } from "@optique/run";
import { vitiatePlugin } from "./plugin.js";
import type { FuzzOptions } from "./config.js";

export interface CliArgs {
  testFile: string;
  corpusDirs: string[];
  fuzzOptions: FuzzOptions;
}

export const cliParser = object({
  testFile: argument(string({ metavar: "TEST_FILE" })),
  corpusDirs: withDefault(
    multiple(argument(string({ metavar: "CORPUS_DIR", pattern: /^[^-]/ }))),
    [],
  ),
  maxLen: optional(option("-max_len", integer({ min: 1 }))),
  timeout: optional(option("-timeout", integer({ min: 0 }))),
  runs: optional(option("-runs", integer({ min: 0 }))),
  seed: optional(option("-seed", integer())),
  maxTotalTime: optional(option("-max_total_time", integer({ min: 0 }))),
});

function toCliArgs(parsed: InferValue<typeof cliParser>): CliArgs {
  const { testFile, corpusDirs, maxLen, timeout, runs, seed, maxTotalTime } =
    parsed;
  return {
    testFile,
    corpusDirs: [...corpusDirs],
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      runs,
      seed,
      maxTotalTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
    },
  };
}

export function parseArgs(argv: string[]): CliArgs {
  const result = parseSync(cliParser, argv.slice(2));
  if (!result.success) {
    throw new Error(formatMessage(result.error));
  }
  return toCliArgs(result.value);
}

async function main(): Promise<void> {
  const { testFile, corpusDirs, fuzzOptions } = toCliArgs(
    runSync(cliParser, {
      programName: "vitiate",
      help: "option",
    }),
  );

  // Activate fuzzing mode
  process.env["VITIATE_FUZZ"] = "1";

  // Forward CLI options to fuzz targets via env var
  process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Forward corpus directories to fuzz targets via env var
  if (corpusDirs.length > 0) {
    process.env["VITIATE_CORPUS_DIRS"] = corpusDirs.join(path.delimiter);
  }

  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest(
    "test",
    [testFile],
    {
      include: [testFile],
      testTimeout: 0,
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  if (vitest) {
    await vitest.close();
  } else {
    process.stderr.write("vitiate: vitest failed to start\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
