/**
 * fuzz() test registrar - like Vitest's bench() but for fuzz testing.
 */
import { test } from "vitest";
import { getCurrentTest } from "vitest/suite";
import type { FuzzOptions } from "./config.js";
import { isFuzzingMode, getFuzzPattern, getCliOptions } from "./config.js";

let cachedCliOptions: FuzzOptions | undefined;
function getCachedCliOptions(): FuzzOptions {
  return (cachedCliOptions ??= getCliOptions());
}
import {
  loadSeedCorpus,
  loadCachedCorpus,
  loadCorpusFromDirs,
  getCacheDir,
} from "./corpus.js";
import { runFuzzLoop } from "./loop.js";
import path from "node:path";

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

export function shouldEnterFuzzLoop(testName: string): boolean {
  if (!isFuzzingMode()) return false;
  const pattern = getFuzzPattern();
  if (pattern === null) return true;
  try {
    return new RegExp(pattern).test(testName);
  } catch {
    // Invalid regex - treat as literal substring match
    return testName.includes(pattern);
  }
}

function registerFuzzTest(
  register: typeof test | typeof test.only,
  name: string,
  target: FuzzTarget,
  options?: FuzzOptions,
): void {
  const mergedOptions = { ...options, ...getCachedCliOptions() };
  if (shouldEnterFuzzLoop(name)) {
    // Fuzzing mode: enter the mutation loop
    register(
      name,
      async () => {
        const testDir = getTestDir();
        const result = await runFuzzLoop(
          target,
          testDir,
          name,
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
    // Regression mode: replay corpus entries
    register(name, async () => {
      const testDir = getTestDir();
      const cacheDir = getCacheDir();
      const seeds = loadSeedCorpus(testDir, name);
      const cached = loadCachedCorpus(cacheDir, name);
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
