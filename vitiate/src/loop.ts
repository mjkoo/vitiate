/**
 * Core fuzzing loop: drives the LibAFL engine.
 */
import path from "node:path";
import {
  Fuzzer,
  Watchdog,
  ShmemHandle,
  ExitKind,
  IterationResult,
  installExceptionHandler,
} from "vitiate-napi";
import type { FuzzerConfig } from "vitiate-napi";
import { isSupervisorChild, type FuzzOptions } from "./config.js";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getCacheDir,
  writeCorpusEntry,
  writeCorpusEntryToDir,
  writeArtifactWithPrefix,
  sanitizeTestName,
  type ArtifactKind,
} from "./corpus.js";
import {
  createReporter,
  startReporting,
  stopReporting,
  printCrash,
  printSummary,
} from "./reporter.js";
import { minimize } from "./minimize.js";

const YIELD_INTERVAL = 1000;

export interface FuzzLoopResult {
  crashed: boolean;
  error?: Error;
  crashInput?: Buffer;
  crashArtifactPath?: string;
  totalExecs: number;
}

interface TargetExecutionResult {
  exitKind: ExitKind;
  error?: Error;
}

/**
 * Run the fuzz target with optional watchdog timeout protection.
 *
 * Handles both sync and async targets. When a watchdog is configured,
 * uses runTarget() for sync execution and arm()/disarm() for async
 * continuations. Guarantees disarm() via finally for async paths.
 */
async function executeTarget(
  target: (data: Buffer) => void | Promise<void>,
  input: Buffer,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
): Promise<TargetExecutionResult> {
  if (timeoutMs !== undefined && timeoutMs > 0) {
    if (!watchdog) {
      throw new Error("unreachable: watchdog is null with timeout configured");
    }

    // Why a watchdog thread instead of setTimeout/Promise.race:
    // The fuzz target may block the event loop (infinite loop, CPU-bound
    // code), which prevents setTimeout callbacks from firing. The watchdog
    // thread is immune to event loop starvation and can call
    // V8::TerminateExecution from outside the JS context.

    // runTarget: arms watchdog, calls target at the NAPI C level, disarms.
    // V8 TerminateExecution bypasses JavaScript try/catch, so runTarget
    // intercepts at the C level and calls CancelTerminateExecution before
    // returning to JavaScript.
    const targetResult = watchdog.runTarget(target, input, timeoutMs);

    if (targetResult.exitKind === ExitKind.Timeout) {
      return {
        exitKind: ExitKind.Timeout,
        error:
          targetResult.error instanceof Error
            ? targetResult.error
            : new Error("fuzz target timed out"),
      };
    }
    if (targetResult.exitKind === ExitKind.Crash) {
      return {
        exitKind: ExitKind.Crash,
        error:
          targetResult.error instanceof Error
            ? targetResult.error
            : new Error(String(targetResult.error)),
      };
    }
    if (targetResult.exitKind !== ExitKind.Ok) {
      throw new Error(
        `unreachable: unexpected exitKind from watchdog: ${targetResult.exitKind}`,
      );
    }
    if (targetResult.result instanceof Promise) {
      // Async target returned a Promise - re-arm and await.
      // If the async code hangs, V8 TerminateExecution cascades through
      // all JS frames and the _exit fallback terminates the process.
      watchdog.arm(timeoutMs);
      try {
        await targetResult.result;
      } catch (e) {
        if (watchdog.didFire) {
          return {
            exitKind: ExitKind.Timeout,
            error: new Error("fuzz target timed out"),
          };
        }
        return {
          exitKind: ExitKind.Crash,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      } finally {
        watchdog.disarm();
      }
    }

    return { exitKind: ExitKind.Ok };
  }

  // No timeout — call target directly
  try {
    const maybePromise = target(input);
    if (maybePromise instanceof Promise) {
      await maybePromise;
    }
  } catch (e) {
    return {
      exitKind: ExitKind.Crash,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
  return { exitKind: ExitKind.Ok };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Write a crash/timeout artifact and print the crash message.
 * Returns the constructed FuzzLoopResult.
 */
function recordCrash(
  input: Buffer,
  exitKind: ExitKind,
  error: Error | undefined,
  artifactPrefix: string,
  totalExecs: number,
): FuzzLoopResult {
  const artifactKind: ArtifactKind =
    exitKind === ExitKind.Timeout ? "timeout" : "crash";
  const artifactPath = writeArtifactWithPrefix(
    artifactPrefix,
    input,
    artifactKind,
  );
  printCrash(error ?? new Error("unknown crash"), artifactPath);
  return {
    crashed: true,
    error,
    crashInput: input,
    crashArtifactPath: artifactPath,
    totalExecs,
  };
}

/**
 * Run calibration iterations for a newly interesting corpus entry.
 * Returns true if calibration completed normally (no crash/timeout).
 */
async function runCalibration(
  target: (data: Buffer) => void | Promise<void>,
  input: Buffer,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  fuzzer: Fuzzer,
): Promise<boolean> {
  let needsMore = true;
  while (needsMore) {
    const calibrationStartNs = process.hrtime.bigint();

    const calibrationResult = await executeTarget(
      target,
      input,
      watchdog,
      timeoutMs,
    );

    if (calibrationResult.exitKind !== ExitKind.Ok) {
      return false;
    }

    const calibrationTimeNs = Number(
      process.hrtime.bigint() - calibrationStartNs,
    );
    needsMore = fuzzer.calibrateRun(calibrationTimeNs);
  }
  return true;
}

/**
 * Run the post-calibration mutational stage (I2S / Generalization / Grimoire).
 * Returns a FuzzLoopResult if a crash was found, or null if the stage
 * completed without crashes.
 */
async function runStage(
  target: (data: Buffer) => void | Promise<void>,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  fuzzer: Fuzzer,
  shmemHandle: ShmemHandle | null,
  artifactPrefix: string,
): Promise<FuzzLoopResult | null> {
  let stageResult = fuzzer.beginStage();

  while (stageResult !== null) {
    const stageInput = Buffer.from(stageResult);
    shmemHandle?.stashInput(stageInput);

    const stageStartNs = process.hrtime.bigint();
    const { exitKind: stageExitKind, error: stageCaughtError } =
      await executeTarget(target, stageInput, watchdog, timeoutMs);

    if (stageExitKind !== ExitKind.Ok) {
      // Write artifact BEFORE abortStage — abortStage can throw if the
      // solutions corpus add() fails, and artifact preservation is more
      // important than internal stats bookkeeping.
      // Stage crashes are NOT minimized.
      const result = recordCrash(
        stageInput,
        stageExitKind,
        stageCaughtError,
        artifactPrefix,
        fuzzer.stats.totalExecs,
      );

      try {
        fuzzer.abortStage(stageExitKind);
      } catch (abortError) {
        // abortStage failure is non-fatal: the crash artifact is already
        // written to disk. Internal stats bookkeeping is best-effort.
        process.stderr.write(
          `vitiate: warning: abortStage failed after artifact was written: ${abortError instanceof Error ? abortError.message : String(abortError)}\n`,
        );
      }

      return result;
    }

    const stageExecTimeNs = Number(process.hrtime.bigint() - stageStartNs);
    // Only reached for Ok executions — crashes break above.
    stageResult = fuzzer.advanceStage(ExitKind.Ok, stageExecTimeNs);
  }

  return null;
}

export interface CorpusOptions {
  corpusDirs?: string[];
  corpusOutputDir?: string;
  artifactPrefix?: string;
  libfuzzerCompat?: boolean;
}

export async function runFuzzLoop(
  target: (data: Buffer) => void | Promise<void>,
  testDir: string,
  testName: string,
  testFilePath: string,
  options: FuzzOptions,
  corpusOptions?: CorpusOptions,
): Promise<FuzzLoopResult> {
  const { corpusDirs, corpusOutputDir, artifactPrefix, libfuzzerCompat } =
    corpusOptions ?? {};
  const coverageMap = globalThis.__vitiate_cov;
  if (!coverageMap) {
    throw new Error(
      "vitiate: coverage map not initialized. Ensure the vitiate setup file is loaded.",
    );
  }
  if (!Buffer.isBuffer(coverageMap)) {
    throw new Error(
      "vitiate: coverage map must be a Buffer (fuzzing mode). Ensure VITIATE_FUZZ=1 is set.",
    );
  }
  const cacheDir = getCacheDir();

  const fuzzerConfig: FuzzerConfig = {};
  if (options.maxLen !== undefined) {
    fuzzerConfig.maxInputLen = options.maxLen;
  }
  if (options.seed !== undefined) {
    fuzzerConfig.seed = options.seed;
  }
  if (options.grimoire !== undefined) {
    fuzzerConfig.grimoire = options.grimoire;
  }
  if (options.unicode !== undefined) {
    fuzzerConfig.unicode = options.unicode;
  }
  if (options.redqueen !== undefined) {
    fuzzerConfig.redqueen = options.redqueen;
  }

  const fuzzer = new Fuzzer(coverageMap, fuzzerConfig);

  // Load seeds
  const seedCorpus = loadSeedCorpus(testDir, testName);
  const cachedCorpus = loadCachedCorpus(cacheDir, testFilePath, testName);
  const extraCorpus = corpusDirs ? loadCorpusFromDirs(corpusDirs) : [];
  for (const seed of [...seedCorpus, ...cachedCorpus, ...extraCorpus]) {
    fuzzer.addSeed(seed);
  }

  // In supervisor (child) mode, attach to the parent's shared memory region
  // for cross-process input stashing. The shmem allows the parent to read the
  // crashing input after the child dies, and the watchdog to read it before
  // calling _exit for timeout artifacts.
  const shmemHandle: ShmemHandle | null = isSupervisorChild()
    ? ShmemHandle.attach()
    : null;

  // Resolve the artifact prefix for the watchdog and exception handler.
  // In libFuzzer-compat mode, default to "./" (cwd) matching libFuzzer behavior.
  // In Vitest mode, use testdata/fuzz/{sanitizedName}/ (trailing slash = directory).
  const resolvedArtifactPrefix =
    artifactPrefix ??
    (libfuzzerCompat
      ? "./"
      : path.join(testDir, "testdata", "fuzz", sanitizeTestName(testName)) +
        path.sep);

  // Install platform-specific crash handler (Windows SEH; no-op on Unix).
  if (shmemHandle) {
    installExceptionHandler(shmemHandle, resolvedArtifactPrefix);
  }

  // Only create the watchdog when a timeout is configured. Creating a Watchdog
  // spawns a thread, resolves V8 symbols via dlsym — unnecessary overhead when
  // no timeout enforcement is needed. Pass the shmem handle so the watchdog can
  // read from shmem on its _exit path.
  const timeoutMs = options.timeoutMs;
  const watchdog: Watchdog | null =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Watchdog(resolvedArtifactPrefix, shmemHandle)
      : null;

  const reporter = createReporter();
  startReporting(reporter, () => fuzzer.stats);

  const startTime = Date.now();
  // `|| Infinity`: 0 means "unlimited" for both fields, matching libFuzzer convention.
  const maxTime = options.maxTotalTimeMs || Infinity;
  const maxRuns = options.runs || Infinity;
  let iteration = 0;
  let result: FuzzLoopResult = { crashed: false, totalExecs: 0 };

  // SIGINT handler: first Ctrl+C triggers graceful shutdown, second force-kills.
  let interrupted = false;
  const sigintHandler = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write(
      "\nvitiate: interrupted, finishing current iteration...\n",
    );
  };
  process.on("SIGINT", sigintHandler);

  try {
    while (!interrupted) {
      if (iteration >= maxRuns) break;
      if (Date.now() - startTime >= maxTime) break;

      const rawInput = fuzzer.getNextInput();
      const input = Buffer.from(rawInput); // safe copy before engine mutations

      // Stash the current input to shmem before executing the target.
      // This allows the parent supervisor to read the crashing input after
      // child death, and the watchdog to read it before _exit.
      shmemHandle?.stashInput(input);

      const startNs = process.hrtime.bigint();
      const { exitKind, error: caughtError } = await executeTarget(
        target,
        input,
        watchdog,
        timeoutMs,
      );
      const execTimeNs = Number(process.hrtime.bigint() - startNs);
      const iterResult = fuzzer.reportResult(exitKind, execTimeNs);
      iteration++;

      if (iterResult === IterationResult.Solution) {
        let crashData: Buffer = input;

        // Minimize crash inputs for JS exceptions (ExitKind.Crash) only.
        // Skip minimization for timeouts — timing-dependent behavior may not
        // reproduce with shorter inputs.
        if (exitKind === ExitKind.Crash) {
          crashData = await minimizeCrashInput(
            input,
            target,
            watchdog,
            timeoutMs,
            shmemHandle,
            options,
          );
        }

        result = recordCrash(
          crashData,
          exitKind,
          caughtError,
          resolvedArtifactPrefix,
          fuzzer.stats.totalExecs,
        );
        break;
      }

      if (iterResult === IterationResult.Interesting) {
        if (corpusOutputDir !== undefined) {
          writeCorpusEntryToDir(corpusOutputDir, input);
        } else if (!libfuzzerCompat) {
          writeCorpusEntry(cacheDir, testFilePath, testName, input);
        }
        // libfuzzerCompat without corpusOutputDir: in-memory only, skip write

        // Calibration loop: re-run target to average timing and detect unstable edges.
        // The original fuzz iteration counts as calibration run #1; additional runs start here.
        const calibrationCompleted = await runCalibration(
          target,
          input,
          watchdog,
          timeoutMs,
          fuzzer,
        );
        fuzzer.calibrateFinish();

        // Stage execution loop: run concentrated I2S mutations on the freshly
        // calibrated corpus entry. Only enter if calibration completed normally.
        if (calibrationCompleted) {
          const stageResult = await runStage(
            target,
            watchdog,
            timeoutMs,
            fuzzer,
            shmemHandle,
            resolvedArtifactPrefix,
          );
          if (stageResult) {
            result = stageResult;
            break;
          }
        }
      }

      // Yield to event loop periodically
      if (iteration > 0 && iteration % YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    if (!result.crashed) {
      result = { crashed: false, totalExecs: fuzzer.stats.totalExecs };
    }
  } finally {
    stopReporting(reporter);
    printSummary(reporter, fuzzer.stats);
    watchdog?.shutdown();
    process.removeListener("SIGINT", sigintHandler);
  }

  return result;
}

/**
 * Minimize a crashing input using the fuzz loop's execution infrastructure.
 *
 * Creates a testCandidate wrapper around executeTarget() and delegates to
 * the minimization engine.
 */
async function minimizeCrashInput(
  input: Buffer,
  target: (data: Buffer) => void | Promise<void>,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  shmemHandle: ShmemHandle | null,
  options: FuzzOptions,
): Promise<Buffer> {
  const testCandidate = async (candidate: Buffer): Promise<boolean> => {
    shmemHandle?.stashInput(candidate);
    const result = await executeTarget(target, candidate, watchdog, timeoutMs);
    return result.exitKind === ExitKind.Crash;
  };

  return minimize(input, testCandidate, {
    maxIterations: options.minimizeBudget,
    timeLimitMs: options.minimizeTimeLimitMs,
  });
}
