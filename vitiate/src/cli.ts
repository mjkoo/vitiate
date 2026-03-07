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
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  artifactPrefix?: string;
  dictPath?: string;
  merge: boolean;
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
  // Artifact prefix
  artifactPrefix: optional(option("-artifact_prefix", string())),
  // Dictionary file
  dict: optional(option("-dict", string())),
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
}

function toCliArgs(parsed: InferValue<typeof cliParser>): CliArgs {
  warnUnsupportedFlags(parsed);
  const {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    maxLen,
    timeout,
    runs,
    seed,
    maxTotalTime,
    minimizeBudget,
    minimizeTimeLimit,
    dict,
  } = parsed;

  // Validate and resolve -dict path
  let dictPath: string | undefined;
  if (dict !== undefined) {
    const resolved = path.resolve(dict);
    if (!existsSync(resolved)) {
      process.stderr.write(
        `vitiate: error: dictionary file not found: ${dict}\n`,
      );
      process.exit(1);
    }
    dictPath = resolved;
  }

  return {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge: parsed.merge !== undefined && parsed.merge !== 0,
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      runs,
      seed,
      fuzzTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
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
  artifactPrefix?: string,
): Promise<void> {
  const shmem = ShmemHandle.allocate(maxInputLen);
  const testDir = path.dirname(path.resolve(testFile));

  // When -test is provided, use it as the test name for artifact paths.
  // Otherwise, fall back to deriving from the filename (correct for the
  // single-test-per-file convention used in libFuzzer/OSS-Fuzz).
  const resolvedTestName =
    testName ?? path.basename(testFile, path.extname(testFile));

  // Resolve artifact prefix: flag value or CLI default (./)
  const resolvedArtifactPrefix = artifactPrefix ?? "./";

  const result = await runSupervisor({
    shmem,
    testDir,
    testName: resolvedTestName,
    artifactPrefix: resolvedArtifactPrefix,
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
 * Parent supervisor for merge mode: allocates shmem, creates control file,
 * spawns child with merge env vars, cleans up after.
 */
async function runMergeParentMode(
  testFile: string,
  corpusDirs: readonly string[],
  maxInputLen: number,
  testName?: string,
): Promise<void> {
  if (corpusDirs.length === 0) {
    process.stderr.write(
      "vitiate: error: -merge=1 requires at least one corpus directory\n",
    );
    process.exitCode = 1;
    return;
  }

  const shmem = ShmemHandle.allocate(maxInputLen);
  const controlFilePath = path.join(
    tmpdir(),
    `vitiate-merge-${process.pid}-${Date.now()}.jsonl`,
  );

  const result = await runSupervisor({
    shmem,
    testDir: path.dirname(path.resolve(testFile)),
    testName: testName ?? path.basename(testFile, path.extname(testFile)),
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: {
          ...process.env,
          VITIATE_SUPERVISOR: "1",
          VITIATE_MERGE: "1",
          VITIATE_MERGE_CONTROL_FILE: controlFilePath,
        },
        stdio: ["ignore", "inherit", "inherit"],
      }),
    // No explicit respawn limit for merge — bounded by corpus size
    maxRespawns: Number.MAX_SAFE_INTEGER,
  });

  // Clean up control file
  try {
    unlinkSync(controlFilePath);
  } catch {
    // Ignore — may not exist if merge had no entries
  }

  process.exitCode = result.exitCode ?? 0;
}

/**
 * Child mode for merge: starts Vitest with instrumentation for merge replay.
 */
async function runMergeChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  testName?: string,
): Promise<void> {
  // Corpus directories are passed via env for the merge loop
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

/**
 * Child mode: starts Vitest in fuzzing mode (existing behavior).
 */
async function runChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  fuzzOptions: FuzzOptions,
  testName?: string,
  artifactPrefix?: string,
  dictPath?: string,
): Promise<void> {
  // Activate fuzzing mode
  process.env["VITIATE_FUZZ"] = "1";

  // Signal libFuzzer path conventions to the fuzz loop
  process.env["VITIATE_LIBFUZZER_COMPAT"] = "1";

  // Forward CLI options to fuzz targets via env var
  process.env["VITIATE_FUZZ_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Forward corpus directories to fuzz targets via env var
  if (corpusDirs.length > 0) {
    process.env["VITIATE_CORPUS_DIRS"] = corpusDirs.join(path.delimiter);
    // First corpus dir is the writable output directory
    process.env["VITIATE_CORPUS_OUTPUT_DIR"] = corpusDirs[0];
  }

  // Forward artifact prefix when explicitly provided. The fuzz loop applies
  // the "./" default when libfuzzerCompat is set and no prefix is given.
  if (artifactPrefix !== undefined) {
    process.env["VITIATE_ARTIFACT_PREFIX"] = artifactPrefix;
  }

  // Forward dictionary path to child process for the fuzz loop to pick up.
  if (dictPath !== undefined) {
    process.env["VITIATE_DICTIONARY_PATH"] = dictPath;
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
  const {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge,
    fuzzOptions,
  } = toCliArgs(
    runSync(cliParser, {
      programName: "vitiate",
      help: "option",
    }),
  );

  if (merge) {
    // Merge mode: corpus minimization via set cover
    if (isSupervisorChild()) {
      await runMergeChildMode(testFile, corpusDirs, testName);
    } else {
      const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
      await runMergeParentMode(testFile, corpusDirs, maxInputLen, testName);
    }
  } else if (isSupervisorChild()) {
    // Child mode: shmem is already set up by the parent
    await runChildMode(
      testFile,
      corpusDirs,
      fuzzOptions,
      testName,
      artifactPrefix,
      dictPath,
    );
  } else {
    // Parent mode: allocate shmem, spawn child, supervise
    const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
    await runParentMode(testFile, maxInputLen, testName, artifactPrefix);
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
