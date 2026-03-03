/**
 * Full fuzz pipeline integration test.
 *
 * Exercises the complete user-facing pipeline against the example project:
 * vitiatePlugin() → SWC instrumentation → Vitest runner → supervisor →
 * fuzz loop → crash discovery → artifact writing.
 *
 * Uses the parse-url fuzz target which has a planted port-0 bug that
 * CmpLog-guided mutations find reliably within seconds. The port-0 bug uses
 * an integer comparison (portNum === 0) which I2SRandReplace handles well.
 *
 * NOTE: This test is inherently probabilistic — it relies on the fuzzer
 * finding the planted bug within 30 seconds. With CmpLog guidance, this
 * should happen well under 10 seconds. The 30-second budget provides a large
 * safety margin.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const EXAMPLE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../examples/url-parser",
);

const ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "8fcacc40-parse-url",
);

/** Glob crash/timeout artifacts written by the fuzz run. */
function findArtifacts(): string[] {
  if (!existsSync(ARTIFACT_DIR)) return [];
  return readdirSync(ARTIFACT_DIR)
    .filter((f) => f.startsWith("crash-") || f.startsWith("timeout-"))
    .map((f) => path.join(ARTIFACT_DIR, f));
}

afterAll(() => {
  // Clean up any crash artifacts to avoid polluting the git tree
  for (const artifact of findArtifacts()) {
    rmSync(artifact, { force: true });
  }
});

describe("fuzz pipeline: discovers planted bug end-to-end", () => {
  it("finds the parse-url planted bug via instrumented fuzz run", () => {
    let exitCode = 0;

    try {
      execFileSync(
        "npx",
        ["vitest", "run", "--config", "vitest.fuzz-pipeline.config.ts"],
        {
          cwd: EXAMPLE_DIR,
          timeout: 120_000,
          encoding: "utf-8",
          env: {
            ...process.env,
            VITIATE_FUZZ: "1",
          },
        },
      );
    } catch (e: unknown) {
      // execFileSync throws on non-zero exit code — that's expected when a
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

    // The fuzz run should find the planted bug and exit non-zero
    expect(exitCode).toBe(1);

    // A crash artifact should have been written
    const artifacts = findArtifacts();
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
  });
});
