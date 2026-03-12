/**
 * Full fuzz pipeline integration test.
 *
 * Exercises the complete user-facing pipeline against the example project:
 * vitiatePlugin() → SWC instrumentation → Vitest runner → supervisor →
 * fuzz loop → crash discovery → artifact writing.
 *
 * Tests all three fuzz targets:
 * - parse-url: planted port-0 bug found via I2SRandReplace (integer comparison)
 * - parse-url-async: same planted bug discovered through an async fuzz target
 * - validate-scheme: planted "javascript" scheme bug found via CmpLog token
 *   injection (string comparison)
 *
 * NOTE: These tests are inherently probabilistic - they rely on the fuzzer
 * finding planted bugs within a 60-second-per-target budget. With CmpLog
 * guidance, this should happen well under the budget. The beforeAll hook
 * deletes the corpus cache so every run starts from a consistent state
 * (seeds only).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/url-parser",
);

const PARSE_URL_ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "8fcacc40-parse-url",
);

const PARSE_URL_ASYNC_ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "2ed41517-parse-url-async",
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
  for (const dir of [
    PARSE_URL_ARTIFACT_DIR,
    PARSE_URL_ASYNC_ARTIFACT_DIR,
    VALIDATE_SCHEME_ARTIFACT_DIR,
  ]) {
    for (const artifact of findArtifacts(dir)) {
      rmSync(artifact, { force: true });
    }
  }
  rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
});

interface SubprocessResult {
  exitCode: number;
  output: string;
}

/** Log subprocess output to stderr for diagnostic visibility. */
function dumpOutput(label: string, output: string): void {
  if (output.length > 0) {
    process.stderr.write(`\n── ${label} subprocess output ──\n${output}\n`);
  }
}

describe("fuzz pipeline: discovers planted bugs end-to-end", () => {
  let result: SubprocessResult;

  // Each target runs for up to 60s. Three targets run sequentially, so the
  // fuzz run can take up to ~180s plus startup overhead.
  //
  // Uses async spawn instead of execSync so the outer vitest worker's event
  // loop stays unblocked - this prevents birpc RPC timeouts (e.g.
  // "Timeout calling onTaskUpdate") that occur when execSync blocks for
  // longer than birpc's 60-second default timeout.
  beforeAll(async () => {
    // Start from a clean state: remove cached corpus and any leftover crash
    // artifacts so results are not influenced by previous runs.
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    for (const dir of [
      PARSE_URL_ARTIFACT_DIR,
      PARSE_URL_ASYNC_ARTIFACT_DIR,
      VALIDATE_SCHEME_ARTIFACT_DIR,
    ]) {
      for (const artifact of findArtifacts(dir)) {
        rmSync(artifact, { force: true });
      }
    }

    result = await new Promise<SubprocessResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const child = spawn(
        "pnpm",
        ["exec", "vitest", "run", "--config", "vitest.fuzz.config.ts"],
        {
          cwd: EXAMPLE_DIR,
          timeout: 300_000,
          stdio: ["ignore", "pipe", "pipe"],
          // On Windows, spawn can't resolve .cmd shims (e.g. pnpm.cmd)
          // without a shell. Harmless on Unix.
          shell: true,
          env: {
            ...process.env,
            VITIATE_FUZZ: "1",
          },
        },
      );
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("close", (code) =>
        resolve({
          exitCode: code ?? 1,
          output: Buffer.concat(chunks).toString(),
        }),
      );
      child.on("error", reject);
    });
  }, 300_000);

  it("finds the parse-url planted bug via instrumented fuzz run", () => {
    // The fuzz run should find at least one planted bug and exit non-zero
    if (result.exitCode !== 1) dumpOutput("e2e-fuzz", result.output);
    expect(result.exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts(PARSE_URL_ARTIFACT_DIR);
    if (artifacts.length < 1) dumpOutput("e2e-fuzz", result.output);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });

  it("finds the parse-url-async planted bug via async fuzz target", () => {
    // The fuzz run should find at least one planted bug and exit non-zero
    if (result.exitCode !== 1) dumpOutput("e2e-fuzz", result.output);
    expect(result.exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts(PARSE_URL_ASYNC_ARTIFACT_DIR);
    if (artifacts.length < 1) dumpOutput("e2e-fuzz", result.output);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });

  it("finds the validate-scheme planted bug via CmpLog token injection", () => {
    // The fuzz run should find at least one planted bug and exit non-zero
    if (result.exitCode !== 1) dumpOutput("e2e-fuzz", result.output);
    expect(result.exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts(VALIDATE_SCHEME_ARTIFACT_DIR);
    if (artifacts.length < 1) dumpOutput("e2e-fuzz", result.output);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });
});
