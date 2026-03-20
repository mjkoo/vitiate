/**
 * fuzz() test registrar - like Vitest's bench() but for fuzz testing.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import escapeStringRegexp from "escape-string-regexp";
import { ShmemHandle } from "@vitiate/engine";
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
  getCliOptions,
  getCliIpc,
  getProjectRoot,
  getConfigFile,
  resolveStopOnCrash,
  resolveVitestCli,
  DEFAULT_MAX_INPUT_LEN,
} from "./config.js";
import {
  loadTestDataCorpus,
  loadCachedCorpus,
  loadCachedCorpusWithPaths,
  loadCorpusFromDirs,
  getTestDataDir,
} from "./corpus.js";
import {
  installDetectorModuleHooks,
  getDetectorManager,
  resetDetectorHooks,
} from "./detectors/manager.js";
import { getCoverageMap } from "./globals.js";
import { runFuzzLoop } from "./loop.js";
import { runMergeMode, runOptimizeMode } from "./merge.js";
import { runSupervisor, type SupervisorResult } from "./supervisor.js";

let cachedCliOptions: FuzzOptions | undefined;
function getCachedCliOptions(): FuzzOptions {
  return (cachedCliOptions ??= getCliOptions());
}

type FuzzTarget = (data: Buffer) => void | Promise<void>;

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
        const seedEntries = loadTestDataCorpus(relativeTestFilePath, name).map(
          (data, i) => ({
            path: `seed-${i}`,
            data,
          }),
        );
        const cachedEntries = loadCachedCorpusWithPaths(
          relativeTestFilePath,
          name,
        );
        const coverageMap = getCoverageMap();

        await runOptimizeMode({
          target,
          testName: name,
          seedEntries,
          cachedEntries,
          coverageMap,
          detectorConfig: options?.detectors,
        });
      },
      VITEST_NO_TIMEOUT,
    );
  } else if (isMergeMode()) {
    // Merge mode: replay corpus dirs, run set cover, write survivors
    register(
      name,
      async ({ task: _task }) => {
        const mergedOptions = { ...options, ...getCachedCliOptions() };
        const corpusDirs = getCorpusDirs();
        const controlFilePath = getMergeControlFile();
        if (!controlFilePath) {
          throw new Error(
            "vitiate: mergeControlFile is required in merge mode",
          );
        }
        const coverageMap = getCoverageMap();

        await runMergeMode({
          target,
          corpusDirs: corpusDirs ?? [],
          controlFilePath,
          coverageMap,
          detectorConfig: mergedOptions.detectors,
        });
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
            spawnChild: () =>
              spawn(
                process.execPath,
                [
                  vitestCli,
                  "run",
                  testFilePath,
                  "--test-name-pattern",
                  testNamePattern,
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
    register(name, async ({ task }) => {
      const relativeTestFilePath = getRelativeTestFilePath(task);
      const testDataEntries = loadTestDataCorpus(relativeTestFilePath, name);
      const cached = loadCachedCorpus(relativeTestFilePath, name);
      const extraDirs = getCorpusDirs();
      const extra = extraDirs ? loadCorpusFromDirs(extraDirs) : [];
      const corpus = [...testDataEntries, ...cached, ...extra];

      // Install detector hooks, reconfiguring if the user specified
      // per-test detector options that differ from setup.ts defaults.
      const detectorConfig = options?.detectors;
      installDetectorModuleHooks(detectorConfig);
      const detectorManager = getDetectorManager();

      async function replayEntry(entry: Buffer, index: number): Promise<void> {
        detectorManager?.beforeIteration();
        let targetError: unknown;
        let targetCompletedOk = true;
        try {
          await target(entry);
        } catch (e) {
          targetError = e;
          targetCompletedOk = false;
        }
        const detectorError = detectorManager?.endIteration(targetCompletedOk);
        const failure = detectorError ?? targetError;
        if (failure !== undefined) {
          const err =
            failure instanceof Error ? failure : new Error(String(failure));
          throw new Error(`Corpus entry ${index} failed: ${err.message}`, {
            cause: failure,
          });
        }
      }

      try {
        if (corpus.length === 0) {
          await replayEntry(Buffer.alloc(0), 0);
        } else {
          for (const [i, entry] of corpus.entries()) {
            await replayEntry(entry, i);
          }
        }
      } finally {
        resetDetectorHooks();
      }
    });
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
 * import { fuzz } from "vitiate";
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
