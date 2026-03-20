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
import type { FuzzerConfig, FuzzerStats, BatchResult } from "@vitiate/engine";
import {
  isSupervisorChild,
  getDictionaryPathEnv,
  isDebugMode,
  getCoverageMapSize,
  getResultsFilePath,
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
  writeResultsFile,
} from "./reporter.js";
import { minimize } from "./minimize.js";

/** Seconds between periodic status line updates printed to stderr. */
const REPORT_INTERVAL_SECONDS = 3;

/** Minimum batch size passed to `runBatch()`. Avoids per-batch overhead dominating. */
const MIN_BATCH_SIZE = 16;

/** Maximum batch size passed to `runBatch()`. Caps latency before yielding to the event loop. */
const MAX_BATCH_SIZE = 1024;

/**
 * Compute the adaptive batch size for runBatch based on recent throughput.
 *
 * Targets approximately REPORT_INTERVAL_SECONDS per batch for responsive
 * stats reporting and signal handling. Clamped to [MIN_BATCH_SIZE, MAX_BATCH_SIZE].
 * Returns MIN_BATCH_SIZE when execsPerSec is 0 (first batch).
 */
export function computeBatchSize(execsPerSec: number): number {
  if (execsPerSec <= 0) return MIN_BATCH_SIZE;
  return Math.max(
    MIN_BATCH_SIZE,
    Math.min(MAX_BATCH_SIZE, Math.floor(execsPerSec * REPORT_INTERVAL_SECONDS)),
  );
}

/**
 * Reset per-site CmpLog counts and run detector pre-iteration hooks.
 * Called at the start of every target execution (batch, calibration, stage,
 * replay, minimize, and per-iteration fallback paths).
 */
function beginIteration(
  detectorManager: Pick<DetectorManager, "beforeIteration">,
): void {
  globalThis.__vitiate_cmplog_reset_counts();
  detectorManager.beforeIteration();
}

/**
 * Create a batch callback that wraps detector lifecycle hooks around
 * target execution. Returns ExitKind number: 0 = Ok, 1 = Crash.
 *
 * The target MUST be synchronous. Async targets (returning a Promise)
 * will have their Promise silently dropped - the batch loop cannot await.
 * Async targets must use the per-iteration fallback path instead.
 *
 * The callback catches all target exceptions and returns 1. It never
 * re-throws, because the batch callback returns a numeric ExitKind to
 * Rust and cannot carry error context. handleSolution replays the crash
 * to recover the error for the artifact.
 */
export function makeBatchCallback(
  target: (data: Buffer) => unknown,
  detectorManager: Pick<DetectorManager, "beforeIteration" | "endIteration">,
): (inputBuffer: Buffer, inputLength: number) => number {
  return (inputBuffer: Buffer, inputLength: number): number => {
    const input = inputBuffer.subarray(0, inputLength);
    beginIteration(detectorManager);
    try {
      const returnValue = target(input);
      const vuln = detectorManager.endIteration(true, returnValue);
      if (vuln) return 1; // ExitKind.Crash (detector finding)
      return 0; // ExitKind.Ok
    } catch {
      // Error is intentionally discarded: the batch callback returns a numeric
      // ExitKind to Rust and cannot carry error context. handleSolution replays
      // the crash to recover the error for the artifact.
      detectorManager.endIteration(false);
      return 1; // ExitKind.Crash (all target exceptions are crashes)
    }
  };
}

export interface FuzzLoopResult {
  crashed: boolean;
  error?: Error;
  crashInput?: Buffer;
  crashArtifactPath?: string;
  crashCount: number;
  crashArtifactPaths: string[];
  duplicateCrashesSkipped: number;
  totalExecs: number;
  calibrationExecs: number;
}

interface TargetExecutionResult {
  exitKind: ExitKind;
  error?: Error;
  /** True when the target returned a Promise (async target). */
  isAsync?: boolean;
  /** The target's return value (sync: direct return, async: resolved Promise value). */
  result?: unknown;
}

/**
 * Run the fuzz target with optional watchdog timeout protection.
 *
 * Uses fuzzer.runTarget() which delegates to the owned Watchdog (or
 * calls directly if no Watchdog). Handles async targets via arm/disarm.
 */
async function executeTarget(
  target: (data: Buffer) => unknown | Promise<unknown>,
  input: Buffer,
  fuzzer: Fuzzer,
  timeoutMs: number | undefined,
): Promise<TargetExecutionResult> {
  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;

  // fuzzer.runTarget: arms watchdog (if owned), calls target at the NAPI
  // C level, disarms. If no watchdog, calls directly without timeout.
  // Cast: the NAPI .d.ts declares void|Promise<void> because it is
  // auto-generated from Rust #[napi] annotations and not manually patched.
  // At runtime the callback's return value is captured in
  // targetResult.result regardless of the declared type.
  const targetResult = fuzzer.runTarget(
    target as (data: Buffer) => void | Promise<void>,
    input,
    timeoutMs ?? 0,
  );

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
      `unreachable: unexpected exitKind from runTarget: ${targetResult.exitKind}`,
    );
  }
  if (targetResult.result instanceof Promise) {
    // Async target returned a Promise - re-arm watchdog and await.
    if (hasTimeout) {
      fuzzer.armWatchdog(timeoutMs);
    }
    let resolvedValue: unknown;
    try {
      resolvedValue = await targetResult.result;
    } catch (e) {
      if (hasTimeout && fuzzer.didWatchdogFire) {
        return {
          exitKind: ExitKind.Timeout,
          error: new Error("fuzz target timed out"),
          isAsync: true,
        };
      }
      return {
        exitKind: ExitKind.Crash,
        error: e instanceof Error ? e : new Error(String(e)),
        isAsync: true,
      };
    } finally {
      if (hasTimeout) {
        fuzzer.disarmWatchdog();
      }
    }
    return { exitKind: ExitKind.Ok, isAsync: true, result: resolvedValue };
  }

  return { exitKind: ExitKind.Ok, result: targetResult.result };
}

/**
 * Wrap `fuzzer.getNextInput()` to catch engine errors and re-throw with
 * a `vitiate:` prefix for cleaner user-facing diagnostics.
 */
function getNextInputOrThrow(fuzzer: Fuzzer): Buffer {
  try {
    return fuzzer.getNextInput();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`vitiate: ${message}`, { cause: error });
  }
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
  target: (data: Buffer) => unknown | Promise<unknown>,
  input: Buffer,
  fuzzer: Fuzzer,
  timeoutMs: number | undefined,
  detectorManager: DetectorManager,
): Promise<CalibrationResult> {
  let needsMore = true;
  while (needsMore) {
    const calibrationStartNs = process.hrtime.bigint();

    beginIteration(detectorManager);
    const calibrationResult = await executeTarget(
      target,
      input,
      fuzzer,
      timeoutMs,
    );

    let { exitKind } = calibrationResult;
    const detectorError = detectorManager.endIteration(
      exitKind === ExitKind.Ok,
      calibrationResult.result,
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
  target: (data: Buffer) => unknown | Promise<unknown>,
  fuzzer: Fuzzer,
  timeoutMs: number | undefined,
  detectorManager: DetectorManager,
): Promise<StageCrash | null> {
  let stageResult = fuzzer.beginStage();

  while (stageResult !== null) {
    const stageInput = Buffer.from(stageResult);
    fuzzer.stashInput(stageInput);

    const stageStartNs = process.hrtime.bigint();
    beginIteration(detectorManager);
    const stageExecResult = await executeTarget(
      target,
      stageInput,
      fuzzer,
      timeoutMs,
    );
    let { exitKind: stageExitKind, error: stageCaughtError } = stageExecResult;

    const stageDetectorError = detectorManager.endIteration(
      stageExitKind === ExitKind.Ok,
      stageExecResult.result,
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
  target: (data: Buffer) => unknown | Promise<unknown>,
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
      "unreachable: installDetectorModuleHooks must create a DetectorManager - hooks should have been installed before reaching the fuzz loop",
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
  if (options.jsonMutations !== undefined) {
    fuzzerConfig.jsonMutations = options.jsonMutations;
  }
  if (options.autoSeed !== undefined) {
    fuzzerConfig.autoSeed = options.autoSeed;
  }
  if (dictionaryPath !== undefined) {
    fuzzerConfig.dictionaryPath = dictionaryPath;
  }

  // Collect detector tokens for the mutation dictionary
  const detectorTokens = detectorManager.getTokens();
  if (detectorTokens.length > 0) {
    fuzzerConfig.detectorTokens = detectorTokens;
  }

  // Collect detector seeds for corpus pre-seeding.
  // detectorManager.getSeeds() already returns Buffer[], no re-wrapping needed.
  const detectorSeeds =
    options.autoSeed !== false ? detectorManager.getSeeds() : [];
  if (detectorSeeds.length > 0) {
    fuzzerConfig.detectorSeeds = detectorSeeds;
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

  // Resolve artifact prefixes before creating watchdog/shmem (needed by Watchdog constructor).
  const testDataDir = getTestDataDir(relativeTestFilePath, testName);
  const resolvedArtifactPrefix =
    artifactPrefix ??
    (libfuzzerCompat ? "./" : path.join(testDataDir, "crashes") + path.sep);
  const timeoutArtifactPrefix =
    artifactPrefix ??
    (libfuzzerCompat ? "./" : path.join(testDataDir, "timeouts") + path.sep);

  if (debug) {
    process.stderr.write(
      `vitiate[debug]: artifactPrefix=${resolvedArtifactPrefix}\n`,
    );
  }

  // Create shmem handle and watchdog BEFORE Fuzzer construction because
  // the Fuzzer takes ownership of both. After construction, the original
  // JS objects are inert (their internal state was transferred).
  const shmemHandle: ShmemHandle | null = isSupervisorChild()
    ? ShmemHandle.attach()
    : null;

  // Install platform-specific crash handler (Windows SEH; no-op on Unix).
  // Must happen before Fuzzer takes ownership of shmemHandle.
  if (shmemHandle) {
    installExceptionHandler(shmemHandle, resolvedArtifactPrefix);
  }

  const timeoutMs = options.timeoutMs;
  const watchdog: Watchdog | null =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Watchdog(timeoutArtifactPrefix, shmemHandle)
      : null;

  const fuzzer = new Fuzzer(coverageMap, fuzzerConfig, watchdog, shmemHandle);

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

  const resultsFilePath = getResultsFilePath();
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
  let finalStats: FuzzerStats;

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

  const batchCallback = makeBatchCallback(target, detectorManager);

  /**
   * Handle a batch result where exitReason is "interesting":
   * write corpus entry, run calibration loop, then run stage loop.
   */
  const handleInteresting = async (
    batchResult: BatchResult,
  ): Promise<boolean> => {
    if (!batchResult.triggeringInput) {
      throw new Error(
        "unreachable: missing triggeringInput for interesting batch result",
      );
    }
    const input = batchResult.triggeringInput;
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

    // Calibration loop using fuzzer.runTarget (JS-orchestrated).
    const calibrationResult = await runCalibration(
      target,
      input,
      fuzzer,
      timeoutMs,
      detectorManager,
    );
    fuzzer.calibrateFinish();

    if (calibrationResult.detectorCrash) {
      if (
        handleCrash(
          input,
          calibrationResult.detectorCrash.exitKind,
          calibrationResult.detectorCrash.error,
        )
      ) {
        return true;
      }
    }

    if (calibrationResult.completed) {
      const stageCrash = await runStage(
        target,
        fuzzer,
        timeoutMs,
        detectorManager,
      );
      if (stageCrash) {
        if (
          handleCrash(stageCrash.input, stageCrash.exitKind, stageCrash.error)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Handle a batch result where exitReason is "solution":
   * replay crash for error classification, minimize, write artifact.
   */
  const handleSolution = async (batchResult: BatchResult): Promise<boolean> => {
    if (!batchResult.triggeringInput) {
      throw new Error(
        "unreachable: missing triggeringInput for solution batch result",
      );
    }
    const input = batchResult.triggeringInput;

    if (batchResult.solutionExitKind === ExitKind.Timeout) {
      // Timeout - write artifact directly without replay or minimization.
      return handleCrash(
        input,
        ExitKind.Timeout,
        new Error("fuzz target timed out"),
      );
    }

    // Crash (solutionExitKind === 1) - replay with detectors to classify.
    fuzzer.stashInput(input);
    beginIteration(detectorManager);
    const replayResult = await executeTarget(target, input, fuzzer, timeoutMs);
    let { exitKind: replayExitKind, error: replayError } = replayResult;
    const detectorError = detectorManager.endIteration(
      replayExitKind === ExitKind.Ok,
      replayResult.result,
    );
    if (detectorError) {
      replayExitKind = ExitKind.Crash;
      replayError = detectorError;
    }

    // Track whether the crash reproduced before any overrides.
    const replayReproduced = replayExitKind !== ExitKind.Ok;

    if (!replayReproduced) {
      // Crash did not reproduce on replay - non-deterministic target behavior.
      // Override to Crash so the artifact is still written, but skip
      // minimization since the minimizer cannot reliably shrink a
      // non-reproducible crash.
      replayExitKind = ExitKind.Crash;
      replayError = new Error(
        "crash not reproduced on replay (non-deterministic target behavior)",
      );
    }

    // Minimize crash inputs (both JS crashes and detector findings).
    // Skip minimization for non-reproducible crashes and timeouts
    // (timing-dependent behavior may not reproduce with shorter inputs).
    let crashData: Buffer = input;
    if (replayReproduced && replayExitKind === ExitKind.Crash) {
      crashData = await minimizeCrashInput(
        input,
        target,
        fuzzer,
        timeoutMs,
        options,
        detectorManager,
        replayError instanceof VulnerabilityError
          ? replayError.vulnerabilityType
          : undefined,
      );
    }

    return handleCrash(crashData, replayExitKind, replayError);
  };

  try {
    // Async target detection: run first iteration via per-iteration path.
    // If target returns a Promise, use per-iteration fallback for all
    // subsequent iterations.
    let isAsyncTarget = false;
    let shouldStop = false;
    if (
      !interrupted &&
      iteration < maxRuns &&
      Date.now() - startTime < maxTime
    ) {
      const rawInput = getNextInputOrThrow(fuzzer);
      const input = Buffer.from(rawInput);
      fuzzer.stashInput(input);

      const startNs = process.hrtime.bigint();
      beginIteration(detectorManager);
      const firstResult = await executeTarget(target, input, fuzzer, timeoutMs);
      isAsyncTarget = firstResult.isAsync === true;

      let exitKind: ExitKind = firstResult.exitKind;

      const detectorError = detectorManager.endIteration(
        exitKind === ExitKind.Ok,
        firstResult.result,
      );
      if (detectorError) {
        exitKind = ExitKind.Crash;
      }

      const execTimeNs = Number(process.hrtime.bigint() - startNs);
      const iterResult = fuzzer.reportResult(exitKind, execTimeNs);
      iteration++;

      if (iterResult === IterationResult.Solution) {
        let crashData: Buffer = input;
        const caughtError =
          detectorError ??
          (firstResult.error instanceof Error ? firstResult.error : undefined);
        if (exitKind === ExitKind.Crash) {
          crashData = await minimizeCrashInput(
            input,
            target,
            fuzzer,
            timeoutMs,
            options,
            detectorManager,
            caughtError instanceof VulnerabilityError
              ? caughtError.vulnerabilityType
              : undefined,
          );
        }
        if (handleCrash(crashData, exitKind, caughtError)) {
          shouldStop = true;
        }
      } else if (iterResult === IterationResult.Interesting) {
        if (
          await handleInteresting({
            executionsCompleted: 1,
            exitReason: "interesting",
            triggeringInput: input,
          })
        ) {
          shouldStop = true;
        }
      }
    }

    if (isAsyncTarget) {
      // Per-iteration fallback for async targets.
      while (!interrupted && !shouldStop) {
        if (iteration >= maxRuns) break;
        if (Date.now() - startTime >= maxTime) break;

        const rawInput = getNextInputOrThrow(fuzzer);
        const input = Buffer.from(rawInput);
        fuzzer.stashInput(input);

        const startNs = process.hrtime.bigint();
        beginIteration(detectorManager);
        const asyncExecResult = await executeTarget(
          target,
          input,
          fuzzer,
          timeoutMs,
        );
        let { exitKind, error: caughtError } = asyncExecResult;

        const detectorError = detectorManager.endIteration(
          exitKind === ExitKind.Ok,
          asyncExecResult.result,
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
          if (exitKind === ExitKind.Crash) {
            crashData = await minimizeCrashInput(
              input,
              target,
              fuzzer,
              timeoutMs,
              options,
              detectorManager,
              caughtError instanceof VulnerabilityError
                ? caughtError.vulnerabilityType
                : undefined,
            );
          }
          if (handleCrash(crashData, exitKind, caughtError)) break;
          continue;
        }

        if (iterResult === IterationResult.Interesting) {
          if (
            await handleInteresting({
              executionsCompleted: 1,
              exitReason: "interesting",
              triggeringInput: input,
            })
          )
            break;
        }

        // Yield to the macrotask queue every iteration for async targets.
        // The target's `await Promise.resolve()` resolves as a microtask,
        // which never yields to the macrotask queue where vitest's birpc
        // IPC lives. Without this, fast iterations starve IPC and vitest
        // kills the fork worker as "exited unexpectedly."
        await yieldToEventLoop();
      }
    } else {
      // Batched path for synchronous targets.
      while (!interrupted && !shouldStop) {
        if (iteration >= maxRuns) break;
        if (Date.now() - startTime >= maxTime) break;

        // Adaptive batch size: target approximately 3 seconds per batch
        // for responsive stats reporting.
        const stats = fuzzer.stats;
        let batchSize = computeBatchSize(stats.execsPerSec);

        // Clamp to remaining iteration budget to avoid overshooting fuzzExecs.
        const remainingRuns = maxRuns - iteration;
        if (remainingRuns < batchSize) {
          batchSize = Math.max(1, remainingRuns);
        }

        const batchResult = fuzzer.runBatch(
          batchCallback,
          batchSize,
          timeoutMs ?? 0,
        );
        iteration += batchResult.executionsCompleted;

        if (batchResult.exitReason === "interesting") {
          if (await handleInteresting(batchResult)) break;
        } else if (batchResult.exitReason === "solution") {
          if (await handleSolution(batchResult)) break;
        } else if (batchResult.exitReason === "error") {
          // Batch errors typically mean generate_input() failed (e.g., empty
          // corpus with no seeds producing coverage). Re-attempt via
          // getNextInput() to surface the actual error with its message.
          getNextInputOrThrow(fuzzer);
        }

        // Check termination conditions between batches.
        if (stopOnCrash && crashCount > 0) break;
        if (maxCrashes !== 0 && crashCount >= maxCrashes) break;

        // Yield to event loop between batches.
        await yieldToEventLoop();
      }
    }
  } finally {
    resetDetectorHooks();
    stopReporting(reporter);
    finalStats = fuzzer.stats;
    printSummary(reporter, finalStats, duplicateCrashesSkipped);
    if (resultsFilePath) {
      try {
        writeResultsFile(resultsFilePath, {
          crashed: crashCount > 0,
          crashCount,
          crashArtifactPaths,
          duplicateCrashesSkipped,
          totalExecs: finalStats.totalExecs,
          calibrationExecs: finalStats.calibrationExecs,
          corpusSize: finalStats.corpusSize,
          solutionCount: finalStats.solutionCount,
          coverageEdges: finalStats.coverageEdges,
          coverageFeatures: finalStats.coverageFeatures,
          execsPerSec: finalStats.execsPerSec,
          elapsedMs: Date.now() - startTime,
          error: firstCrashError?.message,
        });
      } catch (writeError) {
        process.stderr.write(
          `vitiate: warning: failed to write results file: ${writeError instanceof Error ? writeError.message : writeError}\n`,
        );
      }
    }
    fuzzer.shutdown();
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
    totalExecs: finalStats.totalExecs,
    calibrationExecs: finalStats.calibrationExecs,
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
  target: (data: Buffer) => unknown | Promise<unknown>,
  fuzzer: Fuzzer,
  timeoutMs: number | undefined,
  options: FuzzOptions,
  detectorManager: DetectorManager,
  originalVulnerabilityType: string | undefined,
): Promise<Buffer> {
  const testCandidate = async (candidate: Buffer): Promise<boolean> => {
    fuzzer.stashInput(candidate);
    beginIteration(detectorManager);
    const result = await executeTarget(target, candidate, fuzzer, timeoutMs);

    const detectorError = detectorManager.endIteration(
      result.exitKind === ExitKind.Ok,
      result.result,
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
