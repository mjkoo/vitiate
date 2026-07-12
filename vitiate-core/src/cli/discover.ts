/**
 * Fuzz-test discovery: glob `*.fuzz.*` files via vitest and map each
 * discovered test to its on-disk testdata/corpus directories.
 */
import path from "node:path";
import { vitiatePlugin } from "../plugin.js";
import { getProjectRoot } from "../config.js";
import { hashTestPath } from "../nix-base32.js";
import {
  getTestDataDir,
  getCorpusDir,
  getTestPathStats,
  type TestPathStats,
} from "../corpus.js";

/** Glob matching all fuzz test file extensions supported by vitest. */
const FUZZ_FILE_GLOB = "**/*.fuzz.{ts,tsx,js,jsx,mts,mjs,cts,cjs}";

/** Regex matching fuzz test file suffixes across all vitest-supported extensions. */
const FUZZ_FILE_SUFFIX_RE = /\.fuzz\.[cm]?[jt]sx?$/;

/**
 * Print the standard error for a missing vitest installation to stderr.
 * Callers own the surrounding `process.exitCode` / return handling.
 */
export function reportVitestMissing(): void {
  process.stderr.write(
    "vitiate: error: vitest is required but not installed. Run `npm install -D vitest` first.\n",
  );
}

/**
 * Discover all `fuzz()` tests in the project by globbing `*.fuzz.*` files and
 * collecting their fully-qualified test names via vitest.
 *
 * :returns: the list of discovered `{ file, name }` pairs (`file` relative to
 *   the project root), or `null` if vitest is not installed (an error is
 *   printed to stderr in that case). An empty array means no fuzz tests found.
 */
export async function discoverFuzzTests(): Promise<
  { file: string; name: string }[] | null
> {
  let createVitest: (typeof import("vitest/node"))["createVitest"];
  try {
    ({ createVitest } = await import("vitest/node"));
  } catch {
    reportVitestMissing();
    return null;
  }

  const vitest = await createVitest(
    "test",
    {
      include: [FUZZ_FILE_GLOB],
    },
    {
      plugins: [vitiatePlugin({ instrument: {} })],
    },
  );

  try {
    const specs = await vitest.globTestSpecifications();
    if (specs.length === 0) return [];

    // Collect test specifications to discover test names
    await vitest.collectTests(specs);

    const projectRoot = getProjectRoot();
    const tests: { file: string; name: string }[] = [];
    for (const module of vitest.state.getTestModules()) {
      const filePath = module.moduleId;
      if (!FUZZ_FILE_SUFFIX_RE.test(filePath)) continue;
      const relativeFile = path.relative(projectRoot, filePath);
      for (const testCase of module.children.allTests()) {
        tests.push({ file: relativeFile, name: testCase.fullName });
      }
    }
    return tests;
  } finally {
    await vitest.close();
  }
}

/** One fuzz test mapped to its on-disk directories and corpus counts. */
export interface TestManifestRow {
  file: string;
  name: string;
  hashDir: string;
  testDataDir: string;
  corpusDir: string;
  stats: TestPathStats;
}

/**
 * Map discovered `{ file, name }` pairs to their hash dir, testdata/corpus
 * directories, and per-bucket counts. Pure and read-only (creates nothing);
 * shared by the `init` and `paths` subcommands.
 */
export function buildTestManifest(
  discovered: { file: string; name: string }[],
): TestManifestRow[] {
  return discovered.map(({ file, name }) => ({
    file,
    name,
    hashDir: hashTestPath(file, name),
    testDataDir: getTestDataDir(file, name),
    corpusDir: getCorpusDir(file, name),
    stats: getTestPathStats(file, name),
  }));
}
