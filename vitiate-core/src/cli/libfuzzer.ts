/**
 * libfuzzer subcommand: parent/child supervisor modes, shmem setup, merge
 * mode, and libFuzzer-compatible flag/exit-code handling.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type InferValue, parseSync } from "@optique/core/parser";
import { formatMessage, text } from "@optique/core/message";
import { runSync, type RunOptions } from "@optique/run";
import escapeStringRegexp from "escape-string-regexp";
import { ShmemHandle } from "@vitiate/engine";
import { vitiatePlugin } from "../plugin.js";
import {
  MAX_RESPAWNS,
  runSupervisor,
  type SupervisorResult,
} from "../supervisor.js";
import {
  DEFAULT_MAX_INPUT_LEN,
  isSupervisorChild,
  getCliIpc,
  setCliIpc,
  warnUnknownVitiateEnvVars,
  getProjectRoot,
  type FuzzOptions,
} from "../config.js";
import { libfuzzerParser, parseDetectorsFlag } from "./parsers.js";

export interface CliArgs {
  testFile: string;
  corpusDirs: readonly string[];
  testName?: string;
  artifactPrefix?: string;
  dictPath?: string;
  merge: boolean;
  fuzzOptions: FuzzOptions;
  forkExplicit?: boolean;
  /** libFuzzer `-error_exitcode` override for the final crash exit code. */
  errorExitcode?: number;
  /** libFuzzer `-timeout_exitcode` override for the final timeout exit code. */
  timeoutExitcode?: number;
}

function warnUnsupportedFlags(
  parsed: InferValue<typeof libfuzzerParser>,
): void {
  // The supervisor spawns a child that re-parses the same args; warn only in
  // the parent so each advisory is printed once (mirrors warnUnknownVitiateEnvVars).
  if (isSupervisorChild()) return;
  if (parsed.fork !== undefined && parsed.fork !== 1) {
    if (parsed.fork === 0) {
      process.stderr.write(
        `vitiate: warning: -fork=0 (in-process mode) is not supported; vitiate always runs the fuzz target in a supervised child process\n`,
      );
    } else {
      process.stderr.write(
        `vitiate: warning: -fork=${parsed.fork} is ignored; vitiate does not support parallel workers and always runs a single supervised child process\n`,
      );
    }
  }
  if (parsed.jobs !== undefined && parsed.jobs !== 1) {
    process.stderr.write(
      `vitiate: warning: -jobs=${parsed.jobs} is ignored; vitiate collects crashes continuously in a single process instead of running independent per-crash sessions. Use VITIATE_MAX_CRASHES to limit crash collection.\n`,
    );
  }
  // Note: -error_exitcode / -timeout_exitcode are honored (see supervisorExitCode),
  // so they are not warned about here.
  if (parsed.closeFdMask !== undefined && parsed.closeFdMask !== 0) {
    process.stderr.write(
      `vitiate: warning: -close_fd_mask=${parsed.closeFdMask} is ignored; vitiate does not suppress target stdout/stderr during execution\n`,
    );
  }
}

function toCliArgs(parsed: InferValue<typeof libfuzzerParser>): CliArgs {
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

  // Parse -detectors flag
  const detectors =
    parsed.detectors !== undefined
      ? parseDetectorsFlag(parsed.detectors)
      : undefined;

  return {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge: parsed.merge !== undefined && parsed.merge !== 0,
    forkExplicit: parsed.fork !== undefined ? true : undefined,
    // libFuzzer exit-code overrides, honored by the parent supervisor.
    errorExitcode: parsed.errorExitcode,
    timeoutExitcode: parsed.timeoutExitcode,
    // CLI flags use seconds (matching libFuzzer convention).
    // Internal FuzzOptions use milliseconds. All conversions happen here.
    fuzzOptions: {
      maxLen,
      timeoutMs: timeout != null ? timeout * 1000 : undefined,
      // libFuzzer semantics: an explicit `-runs=0` means "replay the corpus
      // once and exit" (not unlimited). A positive value caps main-loop
      // iterations; omitting the flag leaves fuzzExecs unset (unlimited).
      fuzzExecs: runs === 0 ? undefined : runs,
      replayOnly: runs === 0 ? true : undefined,
      seed,
      fuzzTimeMs: maxTotalTime != null ? maxTotalTime * 1000 : undefined,
      minimizeBudget,
      minimizeTimeLimitMs:
        minimizeTimeLimit != null ? minimizeTimeLimit * 1000 : undefined,
      detectors,
    },
  };
}

export function parseArgs(argv: string[]): CliArgs {
  const result = parseSync(libfuzzerParser, argv.slice(2));
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
  exitCodeOverrides?: { errorExitcode?: number; timeoutExitcode?: number },
): Promise<void> {
  const shmem = ShmemHandle.allocate(maxInputLen);
  const relativeTestFilePath = path.relative(
    getProjectRoot(),
    path.resolve(testFile),
  );

  // When -test is provided, use it as the test name for artifact paths.
  // Otherwise, fall back to deriving from the filename (correct for the
  // single-test-per-file convention used by libFuzzer-based platforms).
  const resolvedTestName =
    testName ?? path.basename(testFile, path.extname(testFile));

  // Resolve artifact prefix: flag value or CLI default (./)
  const resolvedArtifactPrefix = artifactPrefix ?? "./";

  const result = await runSupervisor({
    shmem,
    relativeTestFilePath,
    testName: resolvedTestName,
    artifactPrefix: resolvedArtifactPrefix,
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: { ...process.env, VITIATE_SUPERVISOR: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      }),
  });

  process.exitCode = supervisorExitCode(result, exitCodeOverrides);
}

/**
 * Default process exit code when a crash is found. Matches libFuzzer's
 * `error_exitcode` default so vitiate is drop-in compatible with fuzzing
 * platforms out of the box; overridable via `-error_exitcode`.
 */
export const DEFAULT_ERROR_EXITCODE = 77;

/**
 * Default process exit code when the finding is a timeout. Matches libFuzzer's
 * `timeout_exitcode` default; overridable via `-timeout_exitcode`.
 */
export const DEFAULT_TIMEOUT_EXITCODE = 70;

/**
 * Map a {@link SupervisorResult} to a process exit code for CLI parent modes,
 * following libFuzzer's exit-code conventions.
 *
 * Distinguishes a crash, a timeout, and infrastructure failures so orchestrators
 * and CI do not mistake an OOM/eviction or a startup failure for a confirmed
 * finding:
 * - timeout -> `timeout_exitcode` (default 70)
 * - crash -> `error_exitcode` (default 77)
 * - SIGKILL / OOM -> 137 (external infra kill, even when reported as a signal)
 * - startup failure / engine panic -> the child's own non-zero exit code
 * - otherwise -> the child's exit code (0 on clean completion)
 *
 * :param overrides: exit codes from `-error_exitcode`/`-timeout_exitcode`.
 */
export function supervisorExitCode(
  result: SupervisorResult,
  overrides: { errorExitcode?: number; timeoutExitcode?: number } = {},
): number {
  const errorCode = overrides.errorExitcode ?? DEFAULT_ERROR_EXITCODE;
  const timeoutCode = overrides.timeoutExitcode ?? DEFAULT_TIMEOUT_EXITCODE;
  // A timeout sets both `timedOut` and `crashed`, so check it first.
  if (result.timedOut) return timeoutCode;
  if (result.crashed) return errorCode;
  if (result.oomKilled) return 137;
  if (result.startupFailure || result.engineError) return result.exitCode ?? 1;
  return result.exitCode ?? 0;
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
  exitCodeOverrides?: { errorExitcode?: number; timeoutExitcode?: number },
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
    `vitiate-merge-${randomUUID()}.jsonl`,
  );

  const result = await runSupervisor({
    shmem,
    relativeTestFilePath: path.relative(
      getProjectRoot(),
      path.resolve(testFile),
    ),
    testName: testName ?? path.basename(testFile, path.extname(testFile)),
    spawnChild: () =>
      spawn(process.execPath, process.argv.slice(1), {
        env: {
          ...process.env,
          VITIATE_SUPERVISOR: "1",
          VITIATE_CLI_IPC: JSON.stringify({
            merge: true,
            mergeControlFile: controlFilePath,
          }),
        },
        stdio: ["ignore", "inherit", "inherit"],
      }),
    maxRespawns: MAX_RESPAWNS,
  });

  // Clean up control file
  try {
    unlinkSync(controlFilePath);
  } catch {
    // Ignore - may not exist if merge had no entries
  }

  process.exitCode = supervisorExitCode(result, exitCodeOverrides);
}

/**
 * Start vitest on the given test file for a supervisor child mode (fuzzing or
 * merge replay) and close it when done. Shared tail of {@link runChildMode}
 * and {@link runMergeChildMode}; callers do their distinct env/IPC setup first.
 */
async function startChildVitest(
  testFile: string,
  testName: string | undefined,
): Promise<void> {
  const { startVitest } = await import("vitest/node");

  const vitest = await startVitest(
    "test",
    [testFile],
    {
      include: [testFile],
      testTimeout: 0,
      // Pin the forks pool so the child runs on a forked pool worker's main
      // thread (`isMainThread === true`, a disposable child process). For the
      // fuzz loop this keeps the topology the supervisor's recovery protocol
      // assumes deterministic and matches the pool `reproduce` replays under;
      // for merge replay it lets the replay watchdog arm (see
      // `makeReplayRunner` in fuzz.ts) - regardless of the user's configured
      // pool. forks is vitest's default, so this is a no-op for the common case.
      pool: "forks",
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
 * Child mode for merge: starts Vitest with instrumentation for merge replay.
 */
async function runMergeChildMode(
  testFile: string,
  corpusDirs: readonly string[],
  fuzzOptions: FuzzOptions,
  testName?: string,
): Promise<void> {
  // Forward CLI options (including detectors) to fuzz targets via env var
  process.env["VITIATE_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Merge into existing IPC blob (parent already set merge+mergeControlFile)
  if (corpusDirs.length > 0) {
    const existing = getCliIpc();
    setCliIpc({ ...existing, corpusDirs: [...corpusDirs] });
  }

  await startChildVitest(testFile, testName);
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
  forkExplicit?: boolean,
): Promise<void> {
  // Activate fuzzing mode
  process.env["VITIATE_FUZZ"] = "1";

  // Forward CLI options to fuzz targets via env var
  process.env["VITIATE_OPTIONS"] = JSON.stringify(fuzzOptions);

  // Forward CLI IPC state to fuzz targets via single JSON blob
  setCliIpc({
    libfuzzerCompat: true,
    corpusDirs: corpusDirs.length > 0 ? [...corpusDirs] : undefined,
    corpusOutputDir: corpusDirs.length > 0 ? corpusDirs[0] : undefined,
    artifactPrefix,
    dictionaryPath: dictPath,
    forkExplicit,
  });

  await startChildVitest(testFile, testName);
}

/**
 * libfuzzer subcommand handler: all existing CLI behavior.
 */
export async function runLibfuzzerSubcommand(
  args: readonly string[],
): Promise<void> {
  const {
    testFile,
    corpusDirs,
    testName,
    artifactPrefix,
    dictPath,
    merge,
    fuzzOptions,
    forkExplicit,
    errorExitcode,
    timeoutExitcode,
  } = toCliArgs(
    runSync(libfuzzerParser, {
      programName: "vitiate libfuzzer",
      args,
      brief: [text("Coverage-guided JavaScript fuzzer (libFuzzer-compatible)")],
      description: [
        text(
          "Instruments JS/TS source with edge coverage counters via SWC and " +
            "drives mutation-based fuzzing via LibAFL. Accepts libFuzzer-compatible " +
            "flags. Configuration via per-test options, VITIATE_OPTIONS JSON " +
            "env var, or CLI flags.",
        ),
      ],
      help: {
        option: { names: ["-help", "--help"] },
      },
    } satisfies RunOptions),
  );

  if (!isSupervisorChild()) {
    warnUnknownVitiateEnvVars();
  }

  if (merge) {
    // Merge mode: corpus minimization via set cover
    if (isSupervisorChild()) {
      await runMergeChildMode(testFile, corpusDirs, fuzzOptions, testName);
    } else {
      const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
      await runMergeParentMode(testFile, corpusDirs, maxInputLen, testName, {
        errorExitcode,
        timeoutExitcode,
      });
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
      forkExplicit,
    );
  } else {
    // Parent mode: allocate shmem, spawn child, supervise
    const maxInputLen = fuzzOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
    await runParentMode(testFile, maxInputLen, testName, artifactPrefix, {
      errorExitcode,
      timeoutExitcode,
    });
  }
}
