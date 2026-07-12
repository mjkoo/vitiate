/**
 * Shared test helpers.
 *
 * `makeTestDataDir` centralizes the tmp-dir + `setDataDir`/`resetDataDir` dance
 * that the test suites otherwise repeat verbatim in their `beforeEach`/
 * `afterEach` (or `beforeAll`/`afterAll`) hooks.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resetDataDir,
  resetProjectRoot,
  setDataDir,
  setProjectRoot,
} from "./config.js";

/**
 * A temporary data directory for a test, together with its teardown.
 *
 * `dir` is the absolute path to the created directory. `cleanup` resets the
 * config module state (the resolved data dir, and the project root if it was
 * set) and removes the directory; call it once, from the suite's teardown hook.
 */
export interface TestDataDir {
  dir: string;
  cleanup: () => void;
}

/**
 * Create a unique temporary directory and point the config module's resolved
 * data dir at it. Mirrors the `mkdirSync` + `setDataDir` setup and the
 * `resetDataDir` + `rmSync` teardown that the test suites repeat.
 *
 * The helper is lifecycle-agnostic: it does not register any Vitest hooks, so
 * wire the returned `cleanup` into whichever hook the suite uses. `label` is a
 * short slug embedded in the directory name for debuggability. Pass
 * `{ setProjectRoot: true }` for suites that also resolve paths relative to the
 * project root; `cleanup` then resets the project root too.
 */
export function makeTestDataDir(
  label: string,
  opts: { setProjectRoot?: boolean } = {},
): TestDataDir {
  const dir = path.join(
    tmpdir(),
    `vitiate-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  setDataDir(dir);
  if (opts.setProjectRoot) {
    setProjectRoot(dir);
  }

  const cleanup = (): void => {
    resetDataDir();
    if (opts.setProjectRoot) {
      resetProjectRoot();
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}
