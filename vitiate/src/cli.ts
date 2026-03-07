/**
 * Standalone CLI: npx vitiate <test-file> [corpus_dirs...] [flags]
 *
 * Operates in two modes:
 * - **Parent mode** (default): Allocates shmem, spawns itself as a child with
 *   `VITIATE_SUPERVISOR` set, and enters a wait loop. On native crash, reads
 *   the crashing input from shmem, writes a crash artifact, and respawns.
 * - **Child mode** (`VITIATE_SUPERVISOR` set): Attaches to shmem, starts Vitest
 *   in fuzzing mode, and runs the fuzz loop.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { object } from "@optique/core/constructs";
import { option, argument } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";
import { optional, multiple, withDefault } from "@optique/core/modifiers";
import { type InferValue, parseSync } from "@optique/core/parser";
import { formatMessage } from "@optique/core/message";
import { runSync } from "@optique/run";
import escapeStringRegexp from "escape-string-regexp";
import { ShmemHandle } from "vitiate-napi";
import { vitiatePlugin } from "./plugin.js";
import { runSupervisor } from "./supervisor.js";
import {
  DEFAULT_MAX_INPUT_LEN,
  isSupervisorChild,
  type FuzzOptions,
} from "./config.js";

export interface CliArgs {
  testFile: string;
  corpusDirs: readonly string[];
  testName?: string;
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
  // Test targeting
  testName: optional(option("-test", string())),
  // Minimization config
  minimizeBudget: optional(option("-minimize_budget", integer({ min: 0 }))),
  minimizeTimeLimit: optional(
    option("-minimize_time_limit", integer({ min: 0 })),
  ),
  // libFuzzer-compatible flags: accepted for OSS-Fuzz compatibility
  fork: optional(option("-fork", integer({ min: 0 }))),
  jobs: optional(option("-jobs", integer({ min: 0 }))),
  merge: optional(option("-merge", integer({ min: 0 }))),
});

function warnUnsupportedFlags(parsed: InferValue<typeof cliParser>): void {
  if (parsed.fork !== undefined && parsed.fork !== 1) {
    if (parsed.fork === 0) {
      process.stderr.write(
        `vitiate: warning: -fork=0 (non-fork mode) is not supported; vitiate always uses fork mode (equivalent to -fork=1)\n`,
      );
    } else {
      process.stderr.write(
        `vitiate: warning: -fork=${parsed.fork} is ignored; vitiate runs a single supervised worker (equivalent to -fork=1)\n`,
      );
    }
  }
  if (parsed.jobs !== undefined && parsed.jobs !== 1) {
    process.stderr.write(
      `vitiate: warning: -jobs=${parsed.jobs} is ignored; vitiate runs a single job at a time (equivalent to -jobs=1)\n`,
    );
  }
  if (parsed.merge !== undefined && parsed.merge !== 0) {
    process.stderr.write(
      `vitiate: warning: -merge=${parsed.merge} is not yet supported; corpus merge mode is ignored\n`,
    );
  }
}

function toCliArgs(parsed: InferValue<typeof cliParser>): CliArgs {
  warnUnsupportedFlags(parsed);
  const {
    testFile,
    corpusDirs,
    testName,
    maxLen,
    timeout,
    runs,
    seed,
    maxTotalTime,
    minimizeBudget,
    minimizeTimeLimit,
  } = parsed;
  return {
    testFile,
    corpusDirs,
    testName,
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      runs,
      seed,
      maxTotalTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
      minimizeBudget,
      minimizeTimeLimitMs:
        minimizeTimeLimit != null ? minimizeTimeLimit * 1000 : undefined,
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

/**
 * Parent supervisor: allocates shmem, spawns the child, enters the
 * shared supervisor wait/respawn loop.
 */
async function runParentMode(
  testFile: string,
  maxInputLen: number,
  testName?: string,
): Promise<void> {
  const shmem = ShmemHandle.allocate(maxInputLen);
  const testDir = path.dirname(path.resolve(testFile));

  // When -test is provided, use it as the test name for artifact paths.
  // Otherwise, fall back to deriving from the filename (correct for the
  // single-test-per-file convention used in libFuzzer/OSS-Fuzz).
  const resolvedTestName =
    testName ?? path.basename(testFile, path.extname(testFile));

  const result = await runSupervisor({
    shmem,
    testDir,
    testName: resolvedTestName,
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: { ...process.env, VITIATE_SUPERVISOR: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      }),
  });

  if (result.crashed) {
    process.exitCode = 1;
  } else {
    process.exitCode = result.exitCode ?? 0;
  }
}

/**
 * Child mode: starts Vitest in fuzzing mode (existing behavior).
 */
async function runChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  fuzzOptions: FuzzOptions,
  testName?: string,
): Promise<void> {
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
      ...(testName
        ? { testNamePattern: `^${escapeStringRegexp(testName)}$` }
        : {}),
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

async function main(): Promise<void> {
  const { testFile, corpusDirs, testName, fuzzOptions } = toCliArgs(
    runSync(cliParser, {
      programName: "vitiate",
      help: "option",
    }),
  );

  if (isSupervisorChild()) {
    // Child mode: shmem is already set up by the parent
    await runChildMode(testFile, corpusDirs, fuzzOptions, testName);
  } else {
    // Parent mode: allocate shmem, spawn child, supervise
    const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
    await runParentMode(testFile, maxInputLen, testName);
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
