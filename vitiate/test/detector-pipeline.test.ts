/**
 * Detector pipeline integration test.
 *
 * Validates that vulnerability detectors work end-to-end in both modes:
 *
 * **Regression mode** (deterministic): Replays seed corpus through the target
 * with the detector lifecycle active. Seed files contain exact trigger inputs
 * that fire each detector type on every replay. This is the primary
 * correctness signal — if detectors intercept the right calls and the
 * snapshot-diff catches prototype mutations, the regression test fails.
 *
 * **Fuzz mode** (probabilistic): Runs the full fuzzer pipeline with
 * detector-guided seeds. The fuzzer mutates seeds, so the exact trigger
 * inputs may not be replayed verbatim — but CmpLog guidance and detector
 * tokens in the dictionary should guide mutations back toward the triggers
 * within the time budget. Validates crash artifact writing and dedupe.
 *
 * Seed files:
 * - seed-proto: "proto __proto__" → prototype pollution detector (snapshot diff)
 * - seed-exec: "exec vitiate_cmd_inject" → command injection detector (module hook)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../examples/detectors",
);

const ARTIFACT_DIR = path.join(
  EXAMPLE_DIR,
  "test",
  "testdata",
  "fuzz",
  "a546d302-detect-vulnerabilities",
);

const CORPUS_CACHE_DIR = path.join(EXAMPLE_DIR, ".vitiate-corpus");

/** Find crash/timeout artifacts written by the fuzz run. */
function findArtifacts(artifactDir: string): string[] {
  if (!existsSync(artifactDir)) return [];
  return readdirSync(artifactDir)
    .filter((f) => f.startsWith("crash-") || f.startsWith("timeout-"))
    .map((f) => path.join(artifactDir, f));
}

function runVitest(
  config: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vitest", "run", "--config", config], {
      cwd: EXAMPLE_DIR,
      timeout: timeoutMs,
      stdio: ["ignore", "inherit", "inherit"],
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });
}

afterAll(() => {
  for (const artifact of findArtifacts(ARTIFACT_DIR)) {
    rmSync(artifact, { force: true });
  }
  rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
});

describe("detector pipeline: regression mode (deterministic)", () => {
  let exitCode = 0;

  // Regression replays seeds with detector lifecycle active.
  // The seed files contain exact trigger inputs, so detectors fire
  // deterministically on every replay — no fuzzer discovery needed.
  beforeAll(async () => {
    exitCode = await runVitest("vitest.config.ts", {}, 60_000);
  }, 60_000);

  it("regression replay catches detector-flagged inputs", () => {
    expect(exitCode).toBe(1);
  });
});

describe("detector pipeline: fuzz mode", () => {
  let exitCode = 0;

  // Seeds guide the fuzzer toward detector triggers. With CmpLog and
  // detector tokens, crashes should be found well under the time budget.
  // This test is inherently probabilistic — see CLAUDE.md fuzz-pipeline
  // exception for test determinism policy.
  beforeAll(async () => {
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    for (const artifact of findArtifacts(ARTIFACT_DIR)) {
      rmSync(artifact, { force: true });
    }

    exitCode = await runVitest(
      "vitest.fuzz-pipeline.config.ts",
      { VITIATE_FUZZ: "1" },
      120_000,
    );
  }, 120_000);

  it("exits non-zero when crashes are found", () => {
    expect(exitCode).toBe(1);
  });

  it("produces crash artifacts with bounded dedupe", () => {
    const artifacts = findArtifacts(ARTIFACT_DIR);
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts.length).toBeLessThanOrEqual(10);
  });
});
