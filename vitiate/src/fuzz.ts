/**
 * fuzz() test registrar - like Vitest's bench() but for fuzz testing.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "vitest";
import { getCurrentTest } from "vitest/suite";
import escapeStringRegexp from "escape-string-regexp";
import { ShmemHandle } from "vitiate-napi";
import type { FuzzOptions } from "./config.js";
import {
  isFuzzingMode,
  getCliOptions,
  DEFAULT_MAX_INPUT_LEN,
} from "./config.js";
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getCacheDir,
  getFuzzTestDataDir,
} from "./corpus.js";
import { runFuzzLoop } from "./loop.js";
import { runSupervisor, type SupervisorResult } from "./supervisor.js";

let cachedCliOptions: FuzzOptions | undefined;
function getCachedCliOptions(): FuzzOptions {
  return (cachedCliOptions ??= getCliOptions());
}

function getCorpusDirs(): string[] | undefined {
  const raw = process.env["VITIATE_CORPUS_DIRS"];
  if (!raw) return undefined;
  const dirs = raw.split(path.delimiter).filter((d) => d.length > 0);
  return dirs.length > 0 ? dirs : undefined;
}

type FuzzTarget = (data: Buffer) => void | Promise<void>;

function getTestDir(): string {
  const current = getCurrentTest();
  const filepath = current?.file?.filepath;
  if (filepath) {
    return path.dirname(filepath);
  }
  return process.cwd();
}

function getTestFilePath(): string {
  const current = getCurrentTest();
  const filepath = current?.file?.filepath;
  if (!filepath) {
    throw new Error(
      "vitiate: could not determine test file path. Ensure fuzz() is called inside a test callback.",
    );
  }
  return filepath;
}

function getRelativeTestFilePath(): string {
  const absolutePath = getTestFilePath();
  const projectRoot = process.env["VITIATE_PROJECT_ROOT"] ?? process.cwd();
  return path.relative(projectRoot, absolutePath);
}

/** Resolve the vitest CLI entry point from the current module context. */
export function resolveVitestCli(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("vitest/vitest.mjs");
}

/**
 * Build a --test-name-pattern regex string from a hierarchy of suite/test
 * names. Vitest's internal `getTaskFullName` (used by `interpretTaskModes` for
 * `--test-name-pattern` matching) produces `"<suite1> <suite2> <testName>"`
 * with space separators — it does NOT include the file path. The supervisor
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
 * up the suite chain from `getCurrentTest()`.
 */
function buildTestNamePattern(): string {
  const current = getCurrentTest();
  if (!current) {
    throw new Error(
      "vitiate: could not determine test context. " +
        "Ensure fuzz() is called inside a test callback.",
    );
  }

  // Collect describe/test names, walking up the suite chain.
  // Stop before the File node (where suite.suite is undefined).
  const names: string[] = [current.name];
  let suite = current.suite;
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
  testDir: string,
  testName: string,
): void {
  if (!result.crashed) return;

  const artifactDir = getFuzzTestDataDir(testDir, testName);

  if (result.crashArtifactPath) {
    throw new Error(`Crash found, artifact: ${result.crashArtifactPath}`);
  } else if (result.signal) {
    throw new Error(
      `Crash found (signal ${result.signal}), check ${artifactDir}`,
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
  const mergedOptions = { ...options, ...getCachedCliOptions() };
  if (isFuzzingMode()) {
    if (process.env["VITIATE_SUPERVISOR"]) {
      // Child mode: supervised — enter the fuzz loop directly
      register(
        name,
        async () => {
          const testDir = getTestDir();
          const relativeTestFilePath = getRelativeTestFilePath();
          const result = await runFuzzLoop(
            target,
            testDir,
            name,
            relativeTestFilePath,
            mergedOptions,
            getCorpusDirs(),
          );
          if (result.crashed) {
            throw (
              result.error ??
              new Error(`Crash found, artifact: ${result.crashArtifactPath}`)
            );
          }
        },
        2_147_483_647, // disable vitest timeout; fuzz loop manages its own termination
      );
    } else {
      // Parent mode: become a supervisor for this fuzz test
      register(
        name,
        async () => {
          const testDir = getTestDir();
          const testFilePath = getTestFilePath();
          const maxInputLen = mergedOptions.maxLen ?? DEFAULT_MAX_INPUT_LEN;
          const shmem = ShmemHandle.allocate(maxInputLen);

          const vitestCli = resolveVitestCli();
          const testNamePattern = buildTestNamePattern();

          const result = await runSupervisor({
            shmem,
            testDir,
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

          translateSupervisorResult(result, testDir, name);
        },
        2_147_483_647, // disable vitest timeout; supervisor manages its own lifecycle
      );
    }
  } else {
    // Regression mode: replay corpus entries
    register(name, async () => {
      const testDir = getTestDir();
      const cacheDir = getCacheDir();
      const relativeTestFilePath = getRelativeTestFilePath();
      const seeds = loadSeedCorpus(testDir, name);
      const cached = loadCachedCorpus(cacheDir, relativeTestFilePath, name);
      const extraDirs = getCorpusDirs();
      const extra = extraDirs ? loadCorpusFromDirs(extraDirs) : [];
      const corpus = [...seeds, ...cached, ...extra];

      if (corpus.length === 0) {
        // Smoke test with empty buffer
        await target(Buffer.alloc(0));
      } else {
        for (const [i, entry] of corpus.entries()) {
          try {
            await target(entry);
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            throw new Error(`Corpus entry ${i} failed: ${err.message}`, {
              cause: e,
            });
          }
        }
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
