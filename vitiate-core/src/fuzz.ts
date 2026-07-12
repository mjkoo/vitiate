/**
 * fuzz() test registrar - like Vitest's bench() but for fuzz testing.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { test } from "vitest";
import escapeStringRegexp from "escape-string-regexp";
import { ExitKind, ShmemHandle, Watchdog } from "@vitiate/engine";
import type { FuzzOptions } from "./config.js";
import {
  isFuzzingMode,
  isOptimizeMode,
  isMergeMode,
  checkModeExclusion,
  isSupervisorChild,
  isLibfuzzerCompat,
  getCorpusOutputDir,
  getArtifactPrefix,
  getCorpusDirs,
  getMergeControlFile,
  getReproduceInputFile,
  getCliOptions,
  getCliIpc,
  getProjectRoot,
  getConfigFile,
  resolveStopOnCrash,
  resolveVitestCli,
  DEFAULT_MAX_INPUT_LEN,
} from "./config.js";
import {
  loadTestDataCorpusWithPaths,
  loadCachedCorpusWithPaths,
  loadCorpusDirsWithPaths,
  getTestDataDir,
  type CorpusEntryWithPath,
} from "./corpus.js";
import {
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
  type DetectorManager,
} from "./detectors/manager.js";
import { getCoverageMap } from "./globals.js";
import {
  asWatchdogRunner,
  executeTarget,
  runFuzzLoop,
  type WatchdogRunner,
} from "./loop.js";
import { runMergeMode, runOptimizeMode } from "./merge.js";
import { runSupervisor, type SupervisorResult } from "./supervisor.js";

let cachedCliOptions: FuzzOptions | undefined;
function getCachedCliOptions(): FuzzOptions {
  return (cachedCliOptions ??= getCliOptions());
}

type FuzzTarget = (data: Buffer) => unknown | Promise<unknown>;

/** INT32_MAX - disables Vitest's built-in timeout so vitiate manages its own. */
const VITEST_NO_TIMEOUT = 2_147_483_647;

// Vitest coupling: the test callback receives a TestContext with a `task`
// property. We use task.file.filepath and the task.suite chain. We define a
// minimal structural type instead of importing from vitest/suite to avoid
// module identity issues when vitiate is file-linked into a consumer project
// (the consumer's vitest and vitiate's vitest would be separate instances).
interface VitestTask {
  name: string;
  file: { filepath: string };
  suite?: VitestTask;
}

function getTestFilePath(task: VitestTask): string {
  const filepath = task.file?.filepath;
  if (!filepath) {
    throw new Error(
      "vitiate: could not determine test file path. Ensure fuzz() is called inside a test callback.",
    );
  }
  return filepath;
}

function getRelativeTestFilePath(task: VitestTask): string {
  const absolutePath = getTestFilePath(task);
  const projectRoot = getProjectRoot();
  return path.relative(projectRoot, absolutePath);
}

/**
 * Build a --test-name-pattern regex string from a hierarchy of suite/test
 * names. Vitest's internal `getTaskFullName` (used by `interpretTaskModes` for
 * `--test-name-pattern` matching) produces `"<suite1> <suite2> <testName>"`
 * with space separators - it does NOT include the file path. The supervisor
 * already restricts the child vitest to the correct file via a positional
 * argument, so the pattern only needs to match the test hierarchy.
 */
export function buildTestNamePatternFromNames(
  hierarchyNames: string[],
): string {
  const full = hierarchyNames.join(" ");
  return `^${escapeStringRegexp(full)}$`;
}

/**
 * Build the --test-name-pattern for the currently executing test by walking
 * up the suite chain from the provided task.
 */
function buildTestNamePattern(task: VitestTask): string {
  // Collect describe/test names, walking up the suite chain.
  // Stop before the File node (where suite.suite is undefined).
  const names: string[] = [task.name];
  let suite = task.suite;
  while (suite?.suite) {
    names.unshift(suite.name);
    suite = suite.suite;
  }

  return buildTestNamePatternFromNames(names);
}

/**
 * Translate a SupervisorResult into Vitest test semantics.
 * Throws on crash (test fails), returns normally on success (test passes).
 */
function translateSupervisorResult(
  result: SupervisorResult,
  relativeTestFilePath: string,
  testName: string,
): void {
  if (result.engineError) {
    // The fuzzing engine itself panicked - an infrastructure failure, not a
    // crash in the code under test. Fail the test loudly rather than letting
    // the `!result.crashed` early return pass it silently.
    throw new Error(
      `vitiate engine error (exit code ${result.exitCode}): the fuzzing ` +
        `engine panicked. This is a bug in vitiate, not a crash in the code ` +
        `under test. See the panic message in the output above.`,
    );
  }

  if (result.oomKilled) {
    // SIGKILL (exit 137): ambiguous between an environmental kill and a
    // memory-exhaustion input. Surface as an infrastructure failure, distinct
    // from a confirmed crash, and point at the preserved input if there is one.
    const preserved = result.crashArtifactPath
      ? ` The in-flight input was preserved at ${result.crashArtifactPath}.`
      : "";
    throw new Error(
      `vitiate: child killed by SIGKILL (exit code 137). This is typically ` +
        `the OS OOM-killer, a container/cgroup memory limit, a k8s eviction, ` +
        `or a CI step timeout - not a confirmed crash in the code under test. ` +
        `If you suspect a memory-exhaustion bug, investigate the input; ` +
        `otherwise raise the available memory.${preserved}`,
    );
  }

  if (result.startupFailure) {
    // The child crashed repeatedly without ever stashing an input - it is
    // failing before the fuzz loop runs (instrumentation/setup), or being
    // killed externally. Not a crash in the code under test.
    throw new Error(
      `vitiate: the fuzz child crashed repeatedly at startup before any input ` +
        `was run (exit code ${result.exitCode}${
          result.signal ? `, signal ${result.signal}` : ""
        }). This usually indicates an instrumentation, module-load, or setup ` +
        `failure rather than a crash in the code under test. Check the output ` +
        `above for details.`,
    );
  }

  if (!result.crashed) return;

  const artifactDir = getTestDataDir(relativeTestFilePath, testName);

  if (result.crashArtifactPath) {
    throw new Error(`Crash found, artifact: ${result.crashArtifactPath}`);
  } else if (result.signal) {
    throw new Error(
      `Crash found (signal ${result.signal}), check ${artifactDir}`,
    );
  } else if (result.newCrashArtifacts === false) {
    throw new Error(
      `Child process failed (exit code ${result.exitCode}) ` +
        `but no crash artifact was written. This usually indicates ` +
        `a vitest infrastructure error (e.g., worker timeout, module ` +
        `resolution failure). Check the output above for details.`,
    );
  } else {
    throw new Error(
      `Crash found (exit code ${result.exitCode}), check ${artifactDir}`,
    );
  }
}

/**
 * Construct a standalone watchdog runner for replaying corpus entries
 * (regression, optimize, and merge modes), or null when no timeout is
 * configured or the watchdog cannot be used safely.
 *
 * The watchdog terminates via the V8 isolate cached at first construction,
 * so it is only safe on a process main thread (forks pool, the vitest
 * default) - under pool:'threads' callers fall back to unprotected replay.
 * The artifact prefix is unused with a null shmem (the watchdog's _exit
 * fallback skips input capture without a shmem view); pass the test's
 * timeouts dir for consistency. Callers must `watchdog.shutdown()` in a
 * finally block.
 */
function makeReplayRunner(
  timeoutMs: number | undefined,
  artifactPrefix: string,
): { watchdog: Watchdog; runner: WatchdogRunner } | null {
  if (timeoutMs === undefined || timeoutMs <= 0 || !isMainThread) {
    return null;
  }
  const watchdog = new Watchdog(artifactPrefix, null);
  return { watchdog, runner: asWatchdogRunner(watchdog) };
}

/** The `timeouts/` artifact dir prefix for a test, used by replay watchdogs. */
function timeoutsDirPrefix(relativeTestFilePath: string, name: string): string {
  return (
    path.join(getTestDataDir(relativeTestFilePath, name), "timeouts") + path.sep
  );
}

/**
 * Replay a single corpus entry in regression mode.
 *
 * With a `runner` (watchdog-backed), the entry executes under the same
 * timeout protection as fuzz mode: a synchronous hang is terminated via V8
 * and reported as a timeout instead of hanging the worker. Without a runner,
 * the entry runs bare (no `timeoutMs` configured, or non-main thread).
 *
 * Throws on target error, detector finding, or timeout; the message carries
 * `label` so failures are attributable to a corpus file.
 */
export async function replayCorpusEntry(
  target: FuzzTarget,
  entry: Buffer,
  label: string,
  detectorManager:
    | Pick<DetectorManager, "beforeIteration" | "endIteration">
    | null
    | undefined,
  runner: WatchdogRunner | null,
  timeoutMs: number | undefined,
): Promise<void> {
  detectorManager?.beforeIteration();

  if (runner === null) {
    let targetError: unknown;
    let targetCompletedOk = true;
    let targetReturnValue: unknown;
    try {
      targetReturnValue = await target(entry);
    } catch (e) {
      targetError = e;
      targetCompletedOk = false;
    }
    const detectorError = detectorManager?.endIteration(
      targetCompletedOk,
      targetReturnValue,
    );
    const failure = detectorError ?? targetError;
    if (failure !== undefined) {
      const err =
        failure instanceof Error ? failure : new Error(String(failure));
      throw new Error(`Corpus ${label} failed: ${err.message}`, {
        cause: failure,
      });
    }
    return;
  }

  // Known limitation: when an async target times out, its promise is left
  // pending (JS promises cannot be cancelled); a late rejection surfaces as
  // an unhandled rejection that can fail a later test in this worker. This
  // matches fuzz-mode behavior.
  let res: Awaited<ReturnType<typeof executeTarget>>;
  try {
    res = await executeTarget(target, entry, runner, timeoutMs);
  } catch (e) {
    // executeTarget only throws on an engine-internal failure (NAPI marshaling
    // or an unexpected exitKind), not on target exceptions (those come back as
    // ExitKind.Crash). Still balance the detector pair before re-throwing so a
    // snapshot taken in beforeIteration is restored.
    detectorManager?.endIteration(false, undefined);
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Corpus ${label} failed: ${err.message}`, { cause: e });
  }
  // Always call endIteration so detector state resets even on timeout
  // (endIteration(false) skips afterIteration but still restores snapshots).
  const detectorError = detectorManager?.endIteration(
    res.exitKind === ExitKind.Ok,
    res.result,
  );
  if (res.exitKind === ExitKind.Timeout) {
    if (detectorError) {
      throw new Error(
        `Corpus ${label} failed: ${detectorError.message} ` +
          `(entry also timed out after ${timeoutMs}ms)`,
        { cause: detectorError },
      );
    }
    throw new Error(
      `Corpus ${label} timed out after ${timeoutMs}ms ` +
        `(replayed under the vitiate watchdog)`,
    );
  }
  const failure =
    detectorError ?? (res.exitKind === ExitKind.Ok ? undefined : res.error);
  if (failure !== undefined) {
    throw new Error(`Corpus ${label} failed: ${failure.message}`, {
      cause: failure,
    });
  }
}

function registerFuzzTest(
  register: typeof test | typeof test.only,
  name: string,
  target: FuzzTarget,
  options?: FuzzOptions,
): void {
  checkModeExclusion();
  if (isOptimizeMode()) {
    // Optimize mode: replay corpus, run set cover, delete non-survivors
    register(
      name,
      async ({ task }) => {
        const relativeTestFilePath = getRelativeTestFilePath(task);
        const seedEntries = loadTestDataCorpusWithPaths(
          relativeTestFilePath,
          name,
        );
        const cachedEntries = loadCachedCorpusWithPaths(
          relativeTestFilePath,
          name,
        );
        const coverageMap = getCoverageMap();

        // Replay under the watchdog when the test has a timeoutMs, so a
        // hanging corpus entry is skipped instead of hanging optimize mode
        // (which registers with VITEST_NO_TIMEOUT).
        const timeoutMs = options?.timeoutMs;
        const replay = makeReplayRunner(
          timeoutMs,
          timeoutsDirPrefix(relativeTestFilePath, name),
        );
        try {
          await runOptimizeMode({
            target,
            testName: name,
            seedEntries,
            cachedEntries,
            coverageMap,
            detectorConfig: options?.detectors,
            runner: replay?.runner ?? null,
            timeoutMs,
          });
        } finally {
          replay?.watchdog.shutdown();
        }
      },
      VITEST_NO_TIMEOUT,
    );
  } else if (isMergeMode()) {
    // Merge mode: replay corpus dirs, run set cover, write survivors
    register(
      name,
      async ({ task }) => {
        const mergedOptions = { ...options, ...getCachedCliOptions() };
        const corpusDirs = getCorpusDirs();
        const controlFilePath = getMergeControlFile();
        if (!controlFilePath) {
          throw new Error(
            "vitiate: mergeControlFile is required in merge mode",
          );
        }
        const coverageMap = getCoverageMap();

        // Same watchdog protection as optimize mode; the libfuzzer -timeout
        // flag flows in via getCachedCliOptions().
        const timeoutMs = mergedOptions.timeoutMs;
        const replay = makeReplayRunner(
          timeoutMs,
          timeoutsDirPrefix(getRelativeTestFilePath(task), name),
        );
        try {
          await runMergeMode({
            target,
            corpusDirs: corpusDirs ?? [],
            controlFilePath,
            coverageMap,
            detectorConfig: mergedOptions.detectors,
            runner: replay?.runner ?? null,
            timeoutMs,
          });
        } finally {
          replay?.watchdog.shutdown();
        }
      },
      VITEST_NO_TIMEOUT,
    );
  } else if (isFuzzingMode()) {
    // CLI options (env-based) take precedence over per-test options
    const mergedOptions = { ...options, ...getCachedCliOptions() };
    if (isSupervisorChild()) {
      // Child mode: supervised - enter the fuzz loop directly
      register(
        name,
        async ({ task }) => {
          const relativeTestFilePath = getRelativeTestFilePath(task);
          const libfuzzerCompat = isLibfuzzerCompat();
          const corpusOutputDir = getCorpusOutputDir();
          const artifactPrefix = getArtifactPrefix();
          const cliIpc = getCliIpc();
          const resolvedStopOnCrash = resolveStopOnCrash(
            mergedOptions.stopOnCrash,
            libfuzzerCompat,
            cliIpc.forkExplicit,
          );
          const result = await runFuzzLoop(
            target,
            name,
            relativeTestFilePath,
            mergedOptions,
            {
              corpusDirs: getCorpusDirs(),
              corpusOutputDir: libfuzzerCompat ? corpusOutputDir : undefined,
              artifactPrefix: libfuzzerCompat ? artifactPrefix : undefined,
              libfuzzerCompat,
              stopOnCrash: resolvedStopOnCrash,
              maxCrashes: mergedOptions.maxCrashes,
            },
          );
          if (result.crashed) {
            const crashError =
              result.error ??
              new Error(
                `Crash found${result.crashArtifactPath ? `, artifact: ${result.crashArtifactPath}` : ""}`,
              );
            if (result.crashCount > 1) {
              throw new Error(
                `${crashError.message}\n\n--- ${result.crashCount} crashes found in total ---`,
                { cause: crashError },
              );
            }
            throw crashError;
          }
        },
        VITEST_NO_TIMEOUT,
      );
    } else {
      // Parent mode: become a supervisor for this fuzz test
      register(
        name,
        async ({ task }) => {
          const relativeTestFilePath = getRelativeTestFilePath(task);
          const testFilePath = getTestFilePath(task);
          const maxInputLen = mergedOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
          const shmem = ShmemHandle.allocate(maxInputLen);

          const vitestCli = resolveVitestCli();
          const testNamePattern = buildTestNamePattern(task);
          const configFile = getConfigFile();

          const result = await runSupervisor({
            shmem,
            relativeTestFilePath,
            testName: name,
            // Pin the forks pool so the fuzz loop runs in a forked pool
            // worker (a disposable child process) rather than a worker
            // thread sharing the orchestrator. This keeps the topology the
            // supervisor's recovery protocol assumes deterministic
            // regardless of the user's configured pool, and matches the
            // pool `reproduce` replays under so findings reproduce in the
            // same environment they were found in. forks is vitest's
            // default, so this is a no-op for the common case.
            spawnChild: () =>
              spawn(
                process.execPath,
                [
                  vitestCli,
                  "run",
                  testFilePath,
                  "--test-name-pattern",
                  testNamePattern,
                  "--pool=forks",
                  ...(configFile ? ["--config", configFile] : []),
                ],
                {
                  env: {
                    ...process.env,
                    VITIATE_SUPERVISOR: "1",
                    VITIATE_FUZZ: "1",
                  },
                  stdio: ["ignore", "inherit", "inherit"],
                },
              ),
          });

          translateSupervisorResult(result, relativeTestFilePath, name);
        },
        VITEST_NO_TIMEOUT,
      );
    }
  } else {
    // Regression mode: replay corpus entries with detector lifecycle.
    // Detectors are installed so that snapshot-based detectors (prototype
    // pollution) and module-hook detectors (command injection, path
    // traversal) catch the same vulnerabilities they would in fuzz mode.
    //
    // When the test has a timeoutMs, entries (including saved timeout-*
    // artifacts) replay under a standalone Watchdog so a hung entry fails
    // with an attributable timeout instead of hanging the worker. The
    // watchdog terminates via the V8 isolate cached at first construction,
    // so it is only safe on a process main thread (forks pool, the vitest
    // default) - under pool:'threads' fall back to unprotected replay.
    // Merge CLI options (env-based) so the libfuzzer-style `-timeout` flag,
    // passed by the `reproduce` subcommand via VITIATE_OPTIONS, reaches the
    // replay watchdog. Per-test options still apply when no CLI option is set.
    const timeoutMs = { ...options, ...getCachedCliOptions() }.timeoutMs;
    const useWatchdog =
      timeoutMs !== undefined && timeoutMs > 0 && isMainThread;
    register(
      name,
      async ({ task }) => {
        const relativeTestFilePath = getRelativeTestFilePath(task);

        // Install detector hooks, reconfiguring if the user specified
        // per-test detector options that differ from setup.ts defaults.
        const detectorConfig = options?.detectors;
        installDetectorModuleHooks(detectorConfig);
        const detectorManager = getDetectorManager();

        const replay = makeReplayRunner(
          timeoutMs,
          timeoutsDirPrefix(relativeTestFilePath, name),
        );

        try {
          // `reproduce` subcommand: replay exactly one input file (the
          // absolute path arrives via CliIpc), skipping corpus loading. A
          // crash/detector-finding/timeout throws and vitest prints the
          // stack; a clean run passes.
          const reproduceFile = getReproduceInputFile();
          if (reproduceFile !== undefined) {
            await replayCorpusEntry(
              target,
              readFileSync(reproduceFile),
              `input ${reproduceFile}`,
              detectorManager,
              replay?.runner ?? null,
              timeoutMs,
            );
            return;
          }

          const extraDirs = getCorpusDirs();
          const corpus: CorpusEntryWithPath[] = [
            ...loadTestDataCorpusWithPaths(relativeTestFilePath, name),
            ...loadCachedCorpusWithPaths(relativeTestFilePath, name),
            ...(extraDirs ? loadCorpusDirsWithPaths(extraDirs) : []),
          ];

          if (corpus.length === 0) {
            await replayCorpusEntry(
              target,
              Buffer.alloc(0),
              "entry 0",
              detectorManager,
              replay?.runner ?? null,
              timeoutMs,
            );
          } else {
            for (const [i, entry] of corpus.entries()) {
              await replayCorpusEntry(
                target,
                entry.data,
                `entry ${i} (${entry.path})`,
                detectorManager,
                replay?.runner ?? null,
                timeoutMs,
              );
            }
          }
        } finally {
          replay?.watchdog.shutdown();
          resetDetectorHooks();
        }
      },
      useWatchdog ? VITEST_NO_TIMEOUT : undefined,
    );
  }
}

type FuzzFn = {
  (name: string, target: FuzzTarget, options?: FuzzOptions): void;
  skip: (name: string, target?: FuzzTarget, options?: FuzzOptions) => void;
  only: (name: string, target: FuzzTarget, options?: FuzzOptions) => void;
  todo: (name: string) => void;
};

/**
 * Register a fuzz test. Works like Vitest's `test()` but drives the target
 * with coverage-guided mutations instead of static inputs.
 *
 * In fuzzing mode (`VITIATE_FUZZ=1`), the target is fed mutated `Buffer`
 * inputs by LibAFL. In regression mode (default), saved crash/corpus
 * entries are replayed deterministically.
 *
 * @example
 * ```ts
 * import { fuzz } from "@vitiate/core";
 *
 * fuzz("parses without crashing", (data) => {
 *   JSON.parse(data.toString());
 * });
 * ```
 */
export const fuzz: FuzzFn = Object.assign(
  function fuzzImpl(
    name: string,
    target: FuzzTarget,
    options?: FuzzOptions,
  ): void {
    registerFuzzTest(test, name, target, options);
  },
  {
    skip(name: string, _target?: FuzzTarget, _options?: FuzzOptions): void {
      test.skip(name, () => {});
    },
    only(name: string, target: FuzzTarget, options?: FuzzOptions): void {
      registerFuzzTest(test.only, name, target, options);
    },
    todo(name: string): void {
      test.todo(name);
    },
  },
);
