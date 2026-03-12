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
} from "@vitiate/engine";
import type { FuzzerConfig } from "@vitiate/engine";
import {
  isSupervisorChild,
  getDictionaryPathEnv,
  isDebugMode,
  getCoverageMapSize,
  DEFAULT_MAX_INPUT_LEN,
  type FuzzOptions,
} from "./config.js";
import {
  DetectorManager,
  VulnerabilityError,
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./detectors/index.js";
import {
  loadTestDataCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getTestDataDir,
  discoverDictionaries,
  writeCorpusEntry,
  writeCorpusEntryToDir,
  writeArtifactWithPrefix,
  replaceArtifact,
  type ArtifactKind,
} from "./corpus.js";
import { computeDedupKey } from "./dedup.js";
import {
  createReporter,
  startReporting,
  stopReporting,
  printBanner,
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
  crashCount: number;
  crashArtifactPaths: string[];
  duplicateCrashesSkipped: number;
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

  // No timeout - call target directly
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
 * Returns the artifact path and relevant crash data.
 */
function writeCrashArtifact(
  input: Buffer,
  exitKind: ExitKind,
  error: Error | undefined,
  artifactPrefix: string,
): string {
  const artifactKind: ArtifactKind =
    exitKind === ExitKind.Timeout ? "timeout" : "crash";
  const artifactPath = writeArtifactWithPrefix(
    artifactPrefix,
    input,
    artifactKind,
  );
  printCrash(error ?? new Error("unknown crash"), artifactPath);
  return artifactPath;
}

/**
 * Run calibration iterations for a newly interesting corpus entry.
 * Returns true if calibration completed normally (no crash/timeout).
 */
interface CalibrationResult {
  completed: boolean;
  /** Non-null only for VulnerabilityError crashes (detector findings during calibration). */
  detectorCrash?: { exitKind: ExitKind; error: VulnerabilityError };
}

async function runCalibration(
  target: (data: Buffer) => void | Promise<void>,
  input: Buffer,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  fuzzer: Fuzzer,
  detectorManager: DetectorManager,
): Promise<CalibrationResult> {
  let needsMore = true;
  while (needsMore) {
    const calibrationStartNs = process.hrtime.bigint();

    detectorManager.beforeIteration();
    const calibrationResult = await executeTarget(
      target,
      input,
      watchdog,
      timeoutMs,
    );

    let { exitKind } = calibrationResult;
    const detectorError = detectorManager.endIteration(
      exitKind === ExitKind.Ok,
    );
    if (detectorError) {
      exitKind = ExitKind.Crash;
    }

    if (exitKind !== ExitKind.Ok) {
      // Detector findings during calibration are surfaced as crashes.
      // Regular crashes/timeouts during calibration are silently swallowed
      // (existing behavior - calibration re-runs the same input, crashes
      // indicate instability, not a new finding).
      const vulnError =
        detectorError ??
        (calibrationResult.error instanceof VulnerabilityError
          ? calibrationResult.error
          : undefined);
      if (vulnError) {
        return {
          completed: false,
          detectorCrash: { exitKind, error: vulnError },
        };
      }
      return { completed: false };
    }

    const calibrationTimeNs = Number(
      process.hrtime.bigint() - calibrationStartNs,
    );
    needsMore = fuzzer.calibrateRun(calibrationTimeNs);
  }
  return { completed: true };
}

interface StageCrash {
  input: Buffer;
  exitKind: ExitKind;
  error: Error | undefined;
}

/**
 * Run the post-calibration mutational stage (I2S / Generalization / Grimoire).
 * Returns a StageCrash if a crash was found, or null if the stage
 * completed without crashes.
 */
async function runStage(
  target: (data: Buffer) => void | Promise<void>,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  fuzzer: Fuzzer,
  shmemHandle: ShmemHandle | null,
  detectorManager: DetectorManager,
): Promise<StageCrash | null> {
  let stageResult = fuzzer.beginStage();

  while (stageResult !== null) {
    const stageInput = Buffer.from(stageResult);
    shmemHandle?.stashInput(stageInput);

    const stageStartNs = process.hrtime.bigint();
    detectorManager.beforeIteration();
    let { exitKind: stageExitKind, error: stageCaughtError } =
      await executeTarget(target, stageInput, watchdog, timeoutMs);

    const stageDetectorError = detectorManager.endIteration(
      stageExitKind === ExitKind.Ok,
    );
    if (stageDetectorError) {
      stageExitKind = ExitKind.Crash;
      stageCaughtError = stageDetectorError;
    }

    if (stageExitKind !== ExitKind.Ok) {
      try {
        fuzzer.abortStage(stageExitKind);
      } catch (abortError) {
        // abortStage failure is non-fatal: artifact will be written by the
        // caller. Internal stats bookkeeping is best-effort.
        process.stderr.write(
          `vitiate: warning: abortStage failed: ${abortError instanceof Error ? abortError.message : String(abortError)}\n`,
        );
      }

      return {
        input: stageInput,
        exitKind: stageExitKind,
        error: stageCaughtError,
      };
    }

    const stageExecTimeNs = Number(process.hrtime.bigint() - stageStartNs);
    // Only reached for Ok executions - crashes break above.
    stageResult = fuzzer.advanceStage(ExitKind.Ok, stageExecTimeNs);
  }

  return null;
}

export type DedupAction =
  | { action: "save" }
  | {
      action: "replace";
      dedupKey: string;
      existing: { path: string; size: number };
    }
  | { action: "suppress" };

export function checkDedupPolicy(
  dedupKey: string | undefined,
  inputSize: number,
  crashDedupMap: Map<string, { path: string; size: number }>,
): DedupAction {
  if (dedupKey === undefined) {
    return { action: "save" };
  }

  const existing = crashDedupMap.get(dedupKey);
  if (existing === undefined) {
    return { action: "save" };
  }

  if (inputSize < existing.size) {
    return { action: "replace", dedupKey, existing };
  }

  return { action: "suppress" };
}

export interface FuzzLoopOptions {
  corpusDirs?: string[];
  corpusOutputDir?: string;
  artifactPrefix?: string;
  libfuzzerCompat?: boolean;
  stopOnCrash?: boolean;
  maxCrashes?: number;
}

export async function runFuzzLoop(
  target: (data: Buffer) => void | Promise<void>,
  testName: string,
  relativeTestFilePath: string,
  options: FuzzOptions,
  corpusOptions?: FuzzLoopOptions,
): Promise<FuzzLoopResult> {
  const {
    corpusDirs,
    corpusOutputDir,
    artifactPrefix,
    libfuzzerCompat,
    stopOnCrash = true,
    maxCrashes = 1000,
  } = corpusOptions ?? {};
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

  // Resolve dictionary path: env var (from CLI -dict flag) takes precedence.
  // Convention-based discovery only applies in Vitest mode - CLI mode uses
  // only the explicit -dict flag, never convention-based discovery.
  let dictionaryPath = getDictionaryPathEnv();
  if (!dictionaryPath && !libfuzzerCompat) {
    const dictPaths = discoverDictionaries(relativeTestFilePath, testName);
    if (dictPaths.length > 0) {
      // Use the first discovered dictionary file. Multiple dictionary files
      // per test are not currently supported; only the first is loaded.
      dictionaryPath = dictPaths[0];
    }
  }

  // Install detector hooks (idempotent - no-op if setup.ts already did it).
  // setup.ts calls this early so ESM imports capture patched wrappers.
  installDetectorModuleHooks(options.detectors);
  const detectorManager = getDetectorManager();
  if (!detectorManager) {
    throw new Error(
      "unreachable: installDetectorModuleHooks did not create a manager",
    );
  }

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
  if (dictionaryPath !== undefined) {
    fuzzerConfig.dictionaryPath = dictionaryPath;
  }

  // Collect detector tokens for the mutation dictionary
  const detectorTokens = detectorManager.getTokens();
  if (detectorTokens.length > 0) {
    fuzzerConfig.detectorTokens = detectorTokens;
  }

  const debug = isDebugMode();

  if (debug) {
    process.stderr.write(
      `vitiate[debug]: fuzzerConfig=${JSON.stringify(fuzzerConfig)}\n`,
    );
    process.stderr.write(
      `vitiate[debug]: options=${JSON.stringify(options)}\n`,
    );
  }

  const fuzzer = new Fuzzer(coverageMap, fuzzerConfig);

  // Load seeds from testdata (seeds + crashes + timeouts) and cached corpus
  const testDataCorpus = loadTestDataCorpus(relativeTestFilePath, testName);
  const cachedCorpus = loadCachedCorpus(relativeTestFilePath, testName);
  const extraCorpus = corpusDirs ? loadCorpusFromDirs(corpusDirs) : [];
  for (const seed of [...testDataCorpus, ...cachedCorpus, ...extraCorpus]) {
    fuzzer.addSeed(seed);
  }

  if (debug) {
    process.stderr.write(
      `vitiate[debug]: corpus=${JSON.stringify({ testData: testDataCorpus.length, cached: cachedCorpus.length, extra: extraCorpus.length })}\n`,
    );
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
  // In Vitest mode, use separate prefixes for crashes and timeouts.
  const testDataDir = getTestDataDir(relativeTestFilePath, testName);
  const resolvedArtifactPrefix =
    artifactPrefix ??
    (libfuzzerCompat ? "./" : path.join(testDataDir, "crashes") + path.sep);

  // Separate timeout artifact prefix for Vitest mode
  const timeoutArtifactPrefix =
    artifactPrefix ??
    (libfuzzerCompat ? "./" : path.join(testDataDir, "timeouts") + path.sep);

  if (debug) {
    process.stderr.write(
      `vitiate[debug]: artifactPrefix=${resolvedArtifactPrefix}\n`,
    );
  }

  // Install platform-specific crash handler (Windows SEH; no-op on Unix).
  if (shmemHandle) {
    installExceptionHandler(shmemHandle, resolvedArtifactPrefix);
  }

  // Only create the watchdog when a timeout is configured. Creating a Watchdog
  // spawns a thread, resolves V8 symbols via dlsym - unnecessary overhead when
  // no timeout enforcement is needed. Pass the shmem handle so the watchdog can
  // read from shmem on its _exit path.
  const timeoutMs = options.timeoutMs;
  const watchdog: Watchdog | null =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Watchdog(timeoutArtifactPrefix, shmemHandle)
      : null;

  const quiet = options.quiet === true;
  const showBanner = !quiet && options.banner !== false;
  if (showBanner) {
    const totalCorpusSize =
      testDataCorpus.length + cachedCorpus.length + extraCorpus.length;
    const activeDetectors = detectorManager.activeDetectorNames;
    printBanner({
      testName,
      maxLen: options.maxLen ?? DEFAULT_MAX_INPUT_LEN,
      timeoutMs: options.timeoutMs,
      seed: options.seed,
      corpusSize: totalCorpusSize,
      mapSize: getCoverageMapSize(),
      detectors: activeDetectors.length > 0 ? activeDetectors : undefined,
    });
  }

  const reporter = createReporter(quiet);
  startReporting(reporter, () => fuzzer.stats);

  const startTime = Date.now();
  // `|| Infinity`: 0 means "unlimited" for both fields, matching libFuzzer convention.
  const maxTime = options.fuzzTimeMs || Infinity;
  const maxRuns = options.fuzzExecs || Infinity;
  let iteration = 0;

  // Multi-crash accumulation state
  let crashCount = 0;
  const crashArtifactPaths: string[] = [];
  let firstCrashError: Error | undefined;
  let firstCrashInput: Buffer | undefined;
  let firstCrashArtifactPath: string | undefined;

  // Crash dedup state
  const crashDedupMap = new Map<string, { path: string; size: number }>();
  let duplicateCrashesSkipped = 0;

  /**
   * Record a crash or timeout: check dedup, write artifact, accumulate state,
   * and return whether the loop should terminate.
   */
  const handleCrash = (
    input: Buffer,
    exitKind: ExitKind,
    error: Error | undefined,
  ): boolean => {
    const dedupKey = computeDedupKey(exitKind, error);
    const dedupAction = checkDedupPolicy(dedupKey, input.length, crashDedupMap);

    if (dedupAction.action === "replace") {
      const artifactKind: ArtifactKind =
        exitKind === ExitKind.Timeout ? "timeout" : "crash";
      const newPath = replaceArtifact(
        dedupAction.existing.path,
        input,
        artifactKind,
      );
      crashDedupMap.set(dedupAction.dedupKey, {
        path: newPath,
        size: input.length,
      });
      const idx = crashArtifactPaths.indexOf(dedupAction.existing.path);
      if (idx !== -1) {
        crashArtifactPaths[idx] = newPath;
      }
      if (firstCrashArtifactPath === dedupAction.existing.path) {
        firstCrashArtifactPath = newPath;
      }
      return false;
    }

    if (dedupAction.action === "suppress") {
      duplicateCrashesSkipped++;
      return false;
    }

    // action === "save": new crash or fail-open
    // Use the correct prefix based on artifact kind
    const prefix =
      exitKind === ExitKind.Timeout
        ? timeoutArtifactPrefix
        : resolvedArtifactPrefix;
    const artifactPath = writeCrashArtifact(input, exitKind, error, prefix);

    if (dedupKey !== undefined) {
      crashDedupMap.set(dedupKey, { path: artifactPath, size: input.length });
    }

    crashCount++;
    crashArtifactPaths.push(artifactPath);
    if (crashCount === 1) {
      firstCrashError = error;
      firstCrashInput = input;
      firstCrashArtifactPath = artifactPath;
    }

    if (stopOnCrash) return true;

    if (maxCrashes !== 0 && crashCount >= maxCrashes) {
      process.stderr.write(
        `vitiate: warning: maxCrashes limit reached (${maxCrashes}), stopping\n`,
      );
      return true;
    }
    return false;
  };

  // SIGINT handler: first Ctrl+C triggers graceful shutdown, second force-kills.
  let interrupted = false;
  const sigintHandler = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write(
      "\nvitiate: interrupted, finishing current iteration (may include calibration and stages)...\n",
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
      detectorManager.beforeIteration();
      let { exitKind, error: caughtError } = await executeTarget(
        target,
        input,
        watchdog,
        timeoutMs,
      );

      const detectorError = detectorManager.endIteration(
        exitKind === ExitKind.Ok,
      );
      if (detectorError) {
        exitKind = ExitKind.Crash;
        caughtError = detectorError;
      }

      const execTimeNs = Number(process.hrtime.bigint() - startNs);
      const iterResult = fuzzer.reportResult(exitKind, execTimeNs);
      iteration++;

      if (iterResult === IterationResult.Solution) {
        let crashData: Buffer = input;

        // Minimize crash inputs for JS exceptions (ExitKind.Crash) only.
        // Skip minimization for timeouts - timing-dependent behavior may not
        // reproduce with shorter inputs.
        if (exitKind === ExitKind.Crash) {
          crashData = await minimizeCrashInput(
            input,
            target,
            watchdog,
            timeoutMs,
            shmemHandle,
            options,
            detectorManager,
            caughtError instanceof VulnerabilityError
              ? caughtError.vulnerabilityType
              : undefined,
          );
        }

        if (handleCrash(crashData, exitKind, caughtError)) {
          break;
        }
        continue;
      }

      if (iterResult === IterationResult.Interesting) {
        try {
          if (corpusOutputDir !== undefined) {
            writeCorpusEntryToDir(corpusOutputDir, input);
          } else if (!libfuzzerCompat) {
            writeCorpusEntry(relativeTestFilePath, testName, input);
          }
        } catch (writeError) {
          process.stderr.write(
            `vitiate: warning: failed to write corpus entry: ${writeError instanceof Error ? writeError.message : writeError}\n`,
          );
        }
        // libfuzzerCompat without corpusOutputDir: in-memory only, skip write

        // Calibration loop: re-run target to average timing and detect unstable edges.
        // The original fuzz iteration counts as calibration run #1; additional runs start here.
        const calibrationResult = await runCalibration(
          target,
          input,
          watchdog,
          timeoutMs,
          fuzzer,
          detectorManager,
        );
        fuzzer.calibrateFinish();

        // If calibration found a detector vulnerability, handle it as a crash
        if (calibrationResult.detectorCrash) {
          if (
            handleCrash(
              input,
              calibrationResult.detectorCrash.exitKind,
              calibrationResult.detectorCrash.error,
            )
          ) {
            break;
          }
        }

        // Stage execution loop: run concentrated I2S mutations on the freshly
        // calibrated corpus entry. Only enter if calibration completed normally.
        if (calibrationResult.completed) {
          const stageCrash = await runStage(
            target,
            watchdog,
            timeoutMs,
            fuzzer,
            shmemHandle,
            detectorManager,
          );
          if (stageCrash) {
            // Stage crashes are NOT minimized - write raw input.
            if (
              handleCrash(
                stageCrash.input,
                stageCrash.exitKind,
                stageCrash.error,
              )
            ) {
              break;
            }
          }
        }
      }

      // Yield to event loop periodically
      if (iteration > 0 && iteration % YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }
  } finally {
    resetDetectorHooks();
    stopReporting(reporter);
    printSummary(reporter, fuzzer.stats, duplicateCrashesSkipped);
    watchdog?.shutdown();
    process.removeListener("SIGINT", sigintHandler);
  }

  return {
    crashed: crashCount > 0,
    error: firstCrashError,
    crashInput: firstCrashInput,
    crashArtifactPath: firstCrashArtifactPath,
    crashCount,
    crashArtifactPaths,
    duplicateCrashesSkipped,
    totalExecs: fuzzer.stats.totalExecs,
  };
}

/**
 * Minimize a crashing input using the fuzz loop's execution infrastructure.
 *
 * Creates a testCandidate wrapper around executeTarget() and delegates to
 * the minimization engine. The `originalVulnerabilityType` ensures the minimizer
 * only accepts the same crash kind as the original: matching VulnerabilityError
 * type for detector findings, regular ExitKind.Crash for ordinary exceptions.
 */
async function minimizeCrashInput(
  input: Buffer,
  target: (data: Buffer) => void | Promise<void>,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  shmemHandle: ShmemHandle | null,
  options: FuzzOptions,
  detectorManager: DetectorManager,
  originalVulnerabilityType: string | undefined,
): Promise<Buffer> {
  const testCandidate = async (candidate: Buffer): Promise<boolean> => {
    shmemHandle?.stashInput(candidate);
    detectorManager.beforeIteration();
    const result = await executeTarget(target, candidate, watchdog, timeoutMs);

    const detectorError = detectorManager.endIteration(
      result.exitKind === ExitKind.Ok,
    );
    // If a detector fires, accept iff original was same detector type.
    if (detectorError) {
      return (
        originalVulnerabilityType !== undefined &&
        detectorError.vulnerabilityType === originalVulnerabilityType
      );
    }
    if (result.exitKind === ExitKind.Ok) {
      return false;
    }

    // Target threw (Crash) - accept iff original was also a non-detector crash.
    return (
      result.exitKind === ExitKind.Crash &&
      originalVulnerabilityType === undefined
    );
  };

  return minimize(input, testCandidate, {
    maxIterations: options.minimizeBudget,
    timeLimitMs: options.minimizeTimeLimitMs,
  });
}
