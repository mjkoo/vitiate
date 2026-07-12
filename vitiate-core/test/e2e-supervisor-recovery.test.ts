/**
 * End-to-end tests for the `vitiate libfuzzer` parent/child/supervisor flow.
 *
 * These drive the built CLI as a real process so the whole topology exists: the
 * parent supervisor spawns a vitest orchestrator (the direct child), which runs
 * the fuzz loop in a forks pool worker one process level below. That is the
 * exact topology the supervisor's abrupt-death recovery targets, and the only
 * one the unit tests (mock `spawnChild`) cannot reproduce.
 *
 * Both tests are fully deterministic:
 * - Recovery: a seeded input makes the forks worker die abruptly (SIGSEGV) on
 *   generation 0. The orchestrator absorbs it to exit code 1; the supervisor
 *   detects the surviving shmem stash, recovers the input to a crash artifact,
 *   and respawns. Generation 1 re-finds the same input in-band, so the campaign
 *   exits with the crash exit code (77). A filesystem marker makes the abrupt
 *   crash a one-shot, so there is no respawn storm.
 * - Merge: `-merge=1` runs the forks-pinned merge child to completion over a
 *   seeded corpus, writing survivors to the output directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const EXAMPLE_DIR = path.resolve(TEST_DIR, "../../examples/url-parser");

/** The built CLI entry point (e2e runs post-build). */
const CLI_PATH = path.resolve(TEST_DIR, "../dist/cli.js");

const CORPUS_CACHE_DIR = path.join(EXAMPLE_DIR, ".vitiate", "corpus");

interface SubprocessResult {
  exitCode: number;
  output: string;
}

/** Run `vitiate libfuzzer ...args` in the example project and capture output. */
function runLibfuzzer(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(process.execPath, [CLI_PATH, "libfuzzer", ...args], {
      cwd: EXAMPLE_DIR,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
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

/** Log subprocess output to stderr for diagnostic visibility. */
function dumpOutput(label: string, output: string): void {
  if (output.length > 0) {
    process.stderr.write(`\n── ${label} subprocess output ──\n${output}\n`);
  }
}

/** List crash artifact filenames in a crashes directory. */
function findCrashArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("crash-"));
}

// The recovery fixture fakes an uncatchable abrupt worker death with
// `process.kill(process.pid, "SIGSEGV")`. Windows has no POSIX signals, so
// Node throws `kill ENOSYS` instead of faulting the process; the throw is
// caught as an ordinary in-band crash and the stash-recovery path never fires.
// There is no Windows equivalent for a process self-delivering an uncatchable
// fault, so this topology is Unix-only. The merge suite below stays portable.
describe.skipIf(process.platform === "win32")(
  "libfuzzer supervisor: recovers an absorbed abrupt worker death",
  () => {
    let tmpDir: string;
    let corpusDir: string;
    let artifactDir: string;
    let markerPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "vitiate-recovery-"));
      corpusDir = path.join(tmpDir, "corpus");
      // The fixture crashes on inputs beginning with "BOOM"; seed one so it
      // replays on generation 0 (seeds replay before mutation).
      writeFileSync(path.join(mkdirp(corpusDir), "trigger"), "BOOM!");
      // Direct crash artifacts into the temp dir (libFuzzer defaults to the cwd,
      // which is the tracked example dir) so the assertion has a deterministic
      // location and the example dir stays clean.
      artifactDir = mkdirp(path.join(tmpDir, "artifacts"));
      // A non-existent marker path: the fixture creates it on the first crash.
      markerPath = path.join(tmpDir, "marker");
      rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
    });

    it("detects the surviving stash, recovers the input, and reports the crash", async () => {
      const result = await runLibfuzzer(
        [
          "test/abrupt-crash.fuzz.ts",
          corpusDir,
          "-test",
          "abrupt-crash",
          "-runs",
          "200",
          `-artifact_prefix=${artifactDir}${path.sep}`,
        ],
        { ...process.env, E2E_ABRUPT_CRASH_MARKER: markerPath },
      );

      if (
        result.exitCode !== 77 ||
        !result.output.includes("died abruptly mid-execution")
      ) {
        dumpOutput("supervisor-recovery", result.output);
      }

      // The stash-recovery branch fired end-to-end (generation 0), then the
      // supervisor respawned to continue fuzzing.
      expect(result.output).toContain(
        "child worker died abruptly mid-execution",
      );
      expect(result.output).toContain("respawning child to continue fuzzing");

      // Generation 1 re-found the input in-band, so the campaign exits with the
      // libFuzzer crash exit code.
      expect(result.exitCode).toBe(77);

      // The in-flight input was recovered to a crash artifact, not discarded.
      expect(findCrashArtifacts(artifactDir).length).toBeGreaterThanOrEqual(1);
    }, 120_000);
  },
);

describe("libfuzzer merge: runs the forks-pinned merge child to completion", () => {
  let tmpDir: string;
  let outputDir: string;
  let inputDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vitiate-merge-"));
    // corpusDirs[0] is the merge output/destination; the rest are inputs.
    outputDir = mkdirp(path.join(tmpDir, "out"));
    inputDir = mkdirp(path.join(tmpDir, "in"));
    // Two distinct benign inputs the parse-url target accepts, so replay covers
    // edges and set cover keeps at least one survivor.
    writeFileSync(path.join(inputDir, "a"), "http://host:8080/path");
    writeFileSync(path.join(inputDir, "b"), "https://example.com/a?x=1");
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(CORPUS_CACHE_DIR, { recursive: true, force: true });
  });

  it("replays the seed corpus and writes survivors to the output dir", async () => {
    const result = await runLibfuzzer([
      "test/url-parser.fuzz.ts",
      outputDir,
      inputDir,
      "-merge=1",
      "-test",
      "parse-url",
    ]);

    if (result.exitCode !== 0 || !result.output.includes("merge: wrote")) {
      dumpOutput("merge", result.output);
    }

    expect(result.exitCode).toBe(0);
    // The merge pipeline ran through the forks child to completion.
    expect(result.output).toContain("vitiate: merge: wrote");
    // Survivors were written to the output directory.
    expect(readdirSync(outputDir).length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

/** Create an empty directory at exactly `dir` (and parents) and return it. */
function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
