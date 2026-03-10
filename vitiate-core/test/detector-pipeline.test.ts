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
 * **Fuzz mode**: Runs the full fuzzer pipeline with detector-guided seeds.
 * The initial seed evaluation phase replays seeds verbatim (no mutation),
 * so exact trigger inputs fire detectors on the first pass. With
 * `stopOnCrash: true`, the fuzzer exits after the first crash artifact.
 *
 * Seed files:
 * - seed-proto: "proto __proto__" → prototype pollution detector (snapshot diff)
 * - seed-exec: "exec vitiate_cmd_inject" → command injection detector (module hook)
 * - seed-read: "read /etc/passwd" → path traversal detector (module hook)
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

interface SubprocessResult {
  exitCode: number;
  output: string;
}

function runVitest(
  config: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SubprocessResult> {
  return new Promise<SubprocessResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("pnpm", ["exec", "vitest", "run", "--config", config], {
      cwd: EXAMPLE_DIR,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, ...env },
    });
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
}

afterAll(() => {
  for (const artifact of findArtifacts(ARTIFACT_DIR)) {
    rmSync(artifact, { force: true });
  }
  rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
});

/** Log subprocess output to stderr for diagnostic visibility. */
function dumpOutput(label: string, output: string): void {
  if (output.length > 0) {
    process.stderr.write(`\n── ${label} subprocess output ──\n${output}\n`);
  }
}

describe("detector pipeline: regression mode (deterministic)", () => {
  let result: SubprocessResult;

  // Regression replays seeds with detector lifecycle active.
  // The seed files contain exact trigger inputs, so detectors fire
  // deterministically on every replay — no fuzzer discovery needed.
  beforeAll(async () => {
    result = await runVitest("vitest.config.ts", {}, 60_000);
  }, 60_000);

  it("regression replay catches detector-flagged inputs", () => {
    if (result.exitCode !== 1) dumpOutput("regression", result.output);
    expect(result.exitCode).toBe(1);
  });
});

describe("detector pipeline: fuzz mode", () => {
  let result: SubprocessResult;

  // The initial seed evaluation phase replays seeds verbatim, so the first
  // seed that triggers a detector produces a crash on the first iteration.
  // With stopOnCrash: true, the fuzz run exits immediately after one crash.
  beforeAll(async () => {
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    for (const artifact of findArtifacts(ARTIFACT_DIR)) {
      rmSync(artifact, { force: true });
    }

    result = await runVitest(
      "vitest.fuzz-pipeline.config.ts",
      { VITIATE_FUZZ: "1" },
      60_000,
    );
  }, 60_000);

  it("exits non-zero when crashes are found", () => {
    if (result.exitCode !== 1) dumpOutput("fuzz", result.output);
    expect(result.exitCode).toBe(1);
  });

  it("produces a crash artifact", () => {
    if (findArtifacts(ARTIFACT_DIR).length !== 1)
      dumpOutput("fuzz", result.output);
    const artifacts = findArtifacts(ARTIFACT_DIR);
    expect(artifacts.length).toBe(1);
  });
});
