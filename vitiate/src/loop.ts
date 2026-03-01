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
import type { FuzzOptions } from "./config.js";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getCacheDir,
  writeCorpusEntry,
  writeCrashArtifact,
  sanitizeTestName,
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function runFuzzLoop(
  target: (data: Buffer) => void | Promise<void>,
  testDir: string,
  testName: string,
  options: FuzzOptions,
  corpusDirs?: string[],
): Promise<FuzzLoopResult> {
  const rawCoverageMap = globalThis.__vitiate_cov;
  if (!rawCoverageMap) {
    throw new Error(
      "vitiate: coverage map not initialized. Ensure the vitiate setup file is loaded.",
    );
  }
  if (!Buffer.isBuffer(rawCoverageMap)) {
    throw new Error(
      "vitiate: coverage map must be a Buffer (fuzzing mode). Ensure VITIATE_FUZZ=1 is set.",
    );
  }
  const coverageMap = rawCoverageMap;
  const cacheDir = getCacheDir();

  const fuzzerConfig: FuzzerConfig = {};
  if (options.maxLen !== undefined) {
    fuzzerConfig.maxInputLen = options.maxLen;
  }
  if (options.seed !== undefined) {
    fuzzerConfig.seed = options.seed;
  }

  const fuzzer = new Fuzzer(coverageMap, fuzzerConfig);

  // Load seeds
  const seedCorpus = loadSeedCorpus(testDir, testName);
  const cachedCorpus = loadCachedCorpus(cacheDir, testName);
  const extraCorpus = corpusDirs ? loadCorpusFromDirs(corpusDirs) : [];
  for (const seed of [...seedCorpus, ...cachedCorpus, ...extraCorpus]) {
    fuzzer.addSeed(seed);
  }

  // In supervisor (child) mode, attach to the parent's shared memory region
  // for cross-process input stashing. The shmem allows the parent to read the
  // crashing input after the child dies, and the watchdog to read it before
  // calling _exit for timeout artifacts.
  const shmemHandle: ShmemHandle | null = process.env["VITIATE_SUPERVISOR"]
    ? ShmemHandle.attach()
    : null;

  const artifactDir = path.join(
    testDir,
    "testdata",
    "fuzz",
    sanitizeTestName(testName),
  );

  // Install platform-specific crash handler (Windows SEH; no-op on Unix).
  if (shmemHandle) {
    installExceptionHandler(shmemHandle, artifactDir);
  }

  // Only create the watchdog when a timeout is configured. Creating a Watchdog
  // spawns a thread, resolves V8 symbols via dlsym — unnecessary overhead when
  // no timeout enforcement is needed. Pass the shmem handle so the watchdog can
  // read from shmem on its _exit path.
  const timeoutMs = options.timeoutMs;
  const watchdog: Watchdog | null =
    timeoutMs !== undefined && timeoutMs > 0
      ? new Watchdog(artifactDir, shmemHandle)
      : null;

  const reporter = createReporter();
  startReporting(reporter, () => fuzzer.stats);

  const startTime = Date.now();
  const maxTime = options.maxTotalTimeMs || Infinity;
  const maxRuns = options.runs || Infinity;
  let iteration = 0;
  let result: FuzzLoopResult = { crashed: false, totalExecs: 0 };

  // SIGINT handler for graceful termination
  let interrupted = false;
  const sigintHandler = () => {
    interrupted = true;
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

      let exitKind = ExitKind.Ok;
      let caughtError: Error | undefined;

      if (timeoutMs !== undefined && timeoutMs > 0) {
        if (!watchdog) {
          throw new Error(
            "unreachable: watchdog is null with timeout configured",
          );
        }
        const wd = watchdog;

        // Why a watchdog thread instead of setTimeout/Promise.race:
        // The fuzz target may block the event loop (infinite loop, CPU-bound
        // code), which prevents setTimeout callbacks from firing. The watchdog
        // thread is immune to event loop starvation and can call
        // V8::TerminateExecution from outside the JS context.

        // runTarget: arms watchdog, calls target at the NAPI C level, disarms.
        // V8 TerminateExecution bypasses JavaScript try/catch, so runTarget
        // intercepts at the C level and calls CancelTerminateExecution before
        // returning to JavaScript.
        const targetResult = wd.runTarget(target, input, timeoutMs);

        if (targetResult.exitKind === 2) {
          // Sync timeout: V8 termination was intercepted at NAPI level
          exitKind = ExitKind.Timeout;
          caughtError =
            targetResult.error instanceof Error
              ? targetResult.error
              : new Error("fuzz target timed out");
        } else if (targetResult.exitKind === 1) {
          // Sync crash
          exitKind = ExitKind.Crash;
          caughtError =
            targetResult.error instanceof Error
              ? targetResult.error
              : new Error(String(targetResult.error));
        } else if (targetResult.result instanceof Promise) {
          // Async target returned a Promise - re-arm and await.
          // The input was stashed to shmem before runTarget() and remains valid
          // for the entire iteration including this async continuation, so
          // re-arming without re-stashing is correct.
          // If the async code hangs, V8 TerminateExecution cascades through
          // all JS frames and the _exit fallback terminates the process.
          wd.arm(timeoutMs);
          try {
            await targetResult.result;
          } catch (e) {
            if (wd.didFire) {
              exitKind = ExitKind.Timeout;
              caughtError = new Error("fuzz target timed out");
            } else {
              exitKind = ExitKind.Crash;
              caughtError = e instanceof Error ? e : new Error(String(e));
            }
          } finally {
            wd.disarm();
          }
        }
      } else {
        // No timeout - call target directly
        try {
          const maybePromise = target(input);
          if (maybePromise instanceof Promise) {
            await maybePromise;
          }
        } catch (e) {
          caughtError = e instanceof Error ? e : new Error(String(e));
          exitKind = ExitKind.Crash;
        }
      }

      const iterResult = fuzzer.reportResult(exitKind);
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
            options,
          );
        }

        const artifactPath = writeCrashArtifact(testDir, testName, crashData);
        printCrash(caughtError ?? new Error("unknown crash"), artifactPath);
        result = {
          crashed: true,
          error: caughtError,
          crashInput: crashData,
          crashArtifactPath: artifactPath,
          totalExecs: fuzzer.stats.totalExecs,
        };
        break;
      }

      if (iterResult === IterationResult.Interesting) {
        writeCorpusEntry(cacheDir, testName, input);
      }

      // Yield to event loop periodically
      if (iteration % YIELD_INTERVAL === 0) {
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
 * Creates a testCandidate wrapper around Watchdog.runTarget() (or direct
 * target invocation when no watchdog is configured) and delegates to the
 * minimization engine.
 */
async function minimizeCrashInput(
  input: Buffer,
  target: (data: Buffer) => void | Promise<void>,
  watchdog: Watchdog | null,
  timeoutMs: number | undefined,
  options: FuzzOptions,
): Promise<Buffer> {
  const testCandidate = async (candidate: Buffer): Promise<boolean> => {
    if (watchdog && timeoutMs !== undefined && timeoutMs > 0) {
      const targetResult = watchdog.runTarget(target, candidate, timeoutMs);
      if (targetResult.exitKind === 1) {
        // Sync crash — candidate reproduces
        return true;
      }
      if (targetResult.result instanceof Promise) {
        // Async target — await and check for rejection
        try {
          watchdog.arm(timeoutMs);
          await targetResult.result;
          watchdog.disarm();
          return false; // Resolved normally — no crash
        } catch {
          const crashed = !watchdog.didFire;
          watchdog.disarm();
          return crashed; // Rejection = crash, but timeout = not a crash
        }
      }
      return false; // exitKind 0 (Ok) or 2 (Timeout) — not a crash
    }

    // No watchdog — call target directly
    try {
      const maybePromise = target(candidate);
      if (maybePromise instanceof Promise) {
        await maybePromise;
      }
      return false; // No crash
    } catch {
      return true; // Exception = crash
    }
  };

  return minimize(input, testCandidate, {
    maxIterations: options.minimizeBudget,
    timeLimitMs: options.minimizeTimeLimitMs,
  });
}
