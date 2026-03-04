/**
 * Full fuzz pipeline integration test.
 *
 * Exercises the complete user-facing pipeline against the example project:
 * vitiatePlugin() → SWC instrumentation → Vitest runner → supervisor →
 * fuzz loop → crash discovery → artifact writing.
 *
 * Tests both fuzz targets:
 * - parse-url: planted port-0 bug found via I2SRandReplace (integer comparison)
 * - validate-scheme: planted "javascript" scheme bug found via CmpLog token
 *   injection (string comparison)
 *
 * NOTE: These tests are inherently probabilistic — they rely on the fuzzer
 * finding planted bugs within a 60-second-per-target budget. With CmpLog
 * guidance, this should happen well under the budget. The beforeAll hook
 * deletes the corpus cache so every run starts from a consistent state
 * (seeds only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const EXAMPLE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../examples/url-parser",
);

const PARSE_URL_ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "8fcacc40-parse-url",
);

const VALIDATE_SCHEME_ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "2269686d-validate-scheme",
);

const CORPUS_CACHE_DIR = path.join(EXAMPLE_DIR, ".vitiate-corpus");

/** Glob crash/timeout artifacts written by the fuzz run. */
function findArtifacts(artifactDir: string): string[] {
  if (!existsSync(artifactDir)) return [];
  return readdirSync(artifactDir)
    .filter((f) => f.startsWith("crash-") || f.startsWith("timeout-"))
    .map((f) => path.join(artifactDir, f));
}

afterAll(() => {
  // Clean up crash artifacts and corpus cache to avoid polluting the git tree
  for (const dir of [PARSE_URL_ARTIFACT_DIR, VALIDATE_SCHEME_ARTIFACT_DIR]) {
    for (const artifact of findArtifacts(dir)) {
      rmSync(artifact, { force: true });
    }
  }
  rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
});

describe("fuzz pipeline: discovers planted bugs end-to-end", () => {
  let exitCode = 0;

  // Each target runs for up to 60s. Two targets run sequentially, so the
  // fuzz run can take up to ~120s plus startup overhead.
  beforeAll(() => {
    // Start from a clean state: remove cached corpus and any leftover crash
    // artifacts so results are not influenced by previous runs.
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    for (const dir of [PARSE_URL_ARTIFACT_DIR, VALIDATE_SCHEME_ARTIFACT_DIR]) {
      for (const artifact of findArtifacts(dir)) {
        rmSync(artifact, { force: true });
      }
    }

    try {
      execSync("pnpm exec vitest run --config vitest.fuzz-pipeline.config.ts", {
        cwd: EXAMPLE_DIR,
        timeout: 300_000,
        encoding: "utf-8",
        env: {
          ...process.env,
          VITIATE_FUZZ: "1",
        },
      });
    } catch (e: unknown) {
      // execSync throws on non-zero exit code — that's expected when a
      // crash is found (vitest exits 1).
      if (
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        typeof (e as { status: unknown }).status === "number"
      ) {
        exitCode = (e as { status: number }).status;
      } else {
        throw e;
      }
    }
  }, 300_000);

  it("finds the parse-url planted bug via instrumented fuzz run", () => {
    // The fuzz run should find at least one planted bug and exit non-zero
    expect(exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts(PARSE_URL_ARTIFACT_DIR);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });

  it("finds the validate-scheme planted bug via CmpLog token injection", () => {
    // The fuzz run should find at least one planted bug and exit non-zero
    expect(exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts(VALIDATE_SCHEME_ARTIFACT_DIR);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });
});
