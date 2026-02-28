/**
 * Core fuzzing loop: drives the LibAFL engine.
 */
import { Fuzzer, ExitKind, IterationResult } from "vitiate-napi";
import type { FuzzerConfig } from "vitiate-napi";
import type { FuzzOptions } from "./config.js";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getCacheDir,
  writeCorpusEntry,
  writeCrashArtifact,
} from "./corpus.js";
import {
  createReporter,
  startReporting,
  stopReporting,
  printCrash,
  printSummary,
} from "./reporter.js";

const YIELD_INTERVAL = 1000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`fuzz target timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timerId);
    promise.catch(() => {}); // suppress unhandled rejection from losing promise
  });
}

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

  const reporter = createReporter();
  startReporting(reporter, () => fuzzer.stats);

  const timeoutMs = options.timeoutMs;
  const startTime = Date.now();
  const maxTime = options.maxTotalTimeMs ?? Infinity;
  const maxRuns = options.runs ?? Infinity;
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

      let exitKind = ExitKind.Ok;
      let caughtError: Error | undefined;
      try {
        const maybePromise = target(input);
        if (maybePromise instanceof Promise) {
          if (timeoutMs !== undefined && timeoutMs > 0) {
            await withTimeout(maybePromise, timeoutMs);
          } else {
            await maybePromise;
          }
        }
      } catch (e) {
        caughtError = e instanceof Error ? e : new Error(String(e));
        exitKind = caughtError.message.includes("fuzz target timed out")
          ? ExitKind.Timeout
          : ExitKind.Crash;
      }

      const iterResult = fuzzer.reportResult(exitKind);
      iteration++;

      if (iterResult === IterationResult.Solution) {
        const artifactPath = writeCrashArtifact(testDir, testName, input);
        printCrash(caughtError ?? new Error("unknown crash"), artifactPath);
        result = {
          crashed: true,
          error: caughtError,
          crashInput: input,
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
    process.removeListener("SIGINT", sigintHandler);
  }

  return result;
}
