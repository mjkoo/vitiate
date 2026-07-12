import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ShmemHandle } from "@vitiate/engine";
import {
  runSupervisor,
  waitForChild,
  WATCHDOG_EXIT_CODE,
  ENGINE_PANIC_EXIT_CODE,
  MAX_RESPAWNS,
  MAX_STARTUP_FAILURES,
} from "./supervisor.js";
import { hashTestPath } from "./nix-base32.js";
import { setDataDir, resetDataDir } from "./config.js";

/**
 * Create a mock ShmemHandle for testing. The supervisor recovers crashing
 * inputs via `readConsistent()`, which returns:
 * - `null` when no input was ever stashed (generation 0) or the write was torn
 *   (the child crashed at startup before the fuzz loop reached its first stash);
 * - a `Buffer` (possibly zero-length) for any valid stash.
 *
 * `consistentInput` models that return value. It may be a `Buffer | null`, or a
 * function (called per read) to vary the result across respawns. `resetGeneration`
 * is tracked for call counting.
 */
function createMockShmem(
  consistentInput: Buffer | null | (() => Buffer | null) = null,
): ShmemHandle & { resetGenerationCount: number } {
  const read = (): Buffer | null =>
    typeof consistentInput === "function" ? consistentInput() : consistentInput;
  const mock = {
    readConsistent: () => read(),
    // Kept for type compatibility; the supervisor no longer calls it.
    readStashedInput: () => read() ?? Buffer.alloc(0),
    resetGeneration: () => {
      mock.resetGenerationCount++;
    },
    resetGenerationCount: 0,
    // Satisfy class type - unused by supervisor
    stashInput: () => {},
  };
  return mock as unknown as ShmemHandle & { resetGenerationCount: number };
}

const TEST_RELATIVE_PATH = "tests/example.fuzz.ts";

describe("runSupervisor", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    resetDataDir();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    tmpDir = mkdirSync(
      path.join(
        tmpdir(),
        `vitiate-supervisor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ),
      { recursive: true },
    ) as string;
    setDataDir(tmpDir);
    return tmpDir;
  }

  it("returns crashed=false with exitCode=0 on normal child exit", async () => {
    const shmem = createMockShmem();
    makeTmpDir();
    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-normal",
      spawnChild: () =>
        spawn(process.execPath, ["-e", "process.exit(0)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.crashArtifactPath).toBeUndefined();
  });

  it("returns crashed=true with exitCode=1 on JS crash exit", async () => {
    const shmem = createMockShmem();
    makeTmpDir();
    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-crash",
      spawnChild: () =>
        spawn(process.execPath, ["-e", "process.exit(1)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(false);
  });

  it("exit code 1 with new crash artifact sets newCrashArtifacts true", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem();
    const testName = "test-new-artifact";

    // The child will write a crash artifact into the crashes dir then exit 1.
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const crashesDir = path.join(dir, "testdata", hashDir, "crashes");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("fs").mkdirSync(${JSON.stringify(crashesDir)}, { recursive: true }); ` +
              `require("fs").writeFileSync(require("path").join(${JSON.stringify(crashesDir)}, "crash-abc123"), "data"); ` +
              `process.exit(1)`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(true);
  });

  it("exit code 1 with new timeout artifact sets newCrashArtifacts true", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem();
    const testName = "test-new-timeout-artifact";

    // A timeout-only finding writes to timeouts/ (not crashes/) and exits 1;
    // it must classify as a crash-with-artifact, not an infrastructure error.
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const timeoutsDir = path.join(dir, "testdata", hashDir, "timeouts");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("fs").mkdirSync(${JSON.stringify(timeoutsDir)}, { recursive: true }); ` +
              `require("fs").writeFileSync(require("path").join(${JSON.stringify(timeoutsDir)}, "timeout-abc123"), "data"); ` +
              `process.exit(1)`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(true);
  });

  it("detects new artifacts under a file-style artifactPrefix (crash)", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem();

    // libFuzzer-style non-directory prefix: artifacts are named
    // <prefix><kind>-<hash>, e.g. bug-crash-abc123. The new-artifact scan
    // must match the prefixed name, or a real finding classifies as a
    // vitest infrastructure failure.
    const artifactDir = path.join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPrefix = path.join(artifactDir, "bug-");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-file-prefix-crash",
      artifactPrefix,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(artifactPrefix + "crash-abc123")}, "data"); ` +
              `process.exit(1)`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(true);
    expect(result.timedOut).toBeFalsy();
  });

  it("classifies timeout-only findings under a file-style artifactPrefix", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem();

    const artifactDir = path.join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPrefix = path.join(artifactDir, "bug-");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-file-prefix-timeout",
      artifactPrefix,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(artifactPrefix + "timeout-abc123")}, "data"); ` +
              `process.exit(1)`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(true);
    expect(result.timedOut).toBe(true);
  });

  it("exit code 1 without new crash artifact sets newCrashArtifacts false", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem();
    const testName = "test-no-new-artifact";

    // Pre-populate the crashes dir with an existing artifact
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const crashesDir = path.join(dir, "testdata", hashDir, "crashes");
    mkdirSync(crashesDir, { recursive: true });
    writeFileSync(path.join(crashesDir, "crash-existing"), "old-data");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      spawnChild: () =>
        // Child exits 1 without writing any new artifacts
        spawn(process.execPath, ["-e", "process.exit(1)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.newCrashArtifacts).toBe(false);
  });

  it("recovers input and respawns on exit 1 with a surviving stash (absorbed worker crash)", async () => {
    const dir = makeTmpDir();
    // Under the forks pool, a pool worker dying abruptly (native crash,
    // SIGKILL) is absorbed by the vitest orchestrator, which exits 1. The
    // surviving shmem stash is the death certificate: the child clears it on
    // orderly shutdown, so a stash outliving the child means it died
    // mid-execution.
    const shmem = createMockShmem(Buffer.from("worker-crash-input"));
    let spawnCount = 0;
    const testName = "test-absorbed-worker-crash";

    const spy = vi.spyOn(process.stderr, "write");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 2,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(1)"], {
          stdio: "ignore",
        });
      },
    });

    // One respawn happened before the limit was hit.
    expect(spawnCount).toBe(2);
    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBeFalsy();
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);
    expect(readFileSync(result.crashArtifactPath!).toString()).toBe(
      "worker-crash-input",
    );
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      true,
    );
    // Generation is reset before each respawned child (and on final exit).
    expect(shmem.resetGenerationCount).toBe(2);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("died abruptly mid-execution"),
    );
  });

  it("recovers a real cross-process stash on an absorbed exit 1", async () => {
    // End-to-end over real shared memory (no mock): the child attaches to
    // the parent's shmem region via VITIATE_SHMEM, stashes an input, and
    // dies with plain exit code 1 without clearing the stash - exactly what
    // an orchestrator-absorbed worker death looks like to the supervisor.
    makeTmpDir();
    const { ShmemHandle } = await import("@vitiate/engine");
    const shmem = ShmemHandle.allocate(256);
    const testName = "test-real-shmem-absorbed";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 1,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `const { ShmemHandle } = require("@vitiate/engine");` +
              `ShmemHandle.attach().stashInput(Buffer.from("real-stash-input"));` +
              `process.exit(1);`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.crashArtifactPath).toBeDefined();
    expect(readFileSync(result.crashArtifactPath!).toString()).toBe(
      "real-stash-input",
    );
    // The recovery path reset the real generation counter: a fresh read
    // finds no stale stash.
    expect(shmem.readConsistent()).toBeNull();
  });

  it("classifies exit 1 + surviving stash + only new timeout artifacts as a hard timeout", async () => {
    const dir = makeTmpDir();
    // An absorbed hard watchdog timeout: the watchdog wrote its timeout-*
    // artifact before `_exit(77)`, the orchestrator absorbed the 77 into a
    // plain exit 1, and the stash survived. Must classify as a timeout (so
    // the exit-code mapping emits timeout_exitcode), not a crash.
    const shmem = createMockShmem(Buffer.from("hard-timeout-input"));
    const testName = "test-absorbed-hard-timeout";

    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const timeoutsDir = path.join(dir, "testdata", hashDir, "timeouts");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 1,
      spawnChild: () =>
        spawn(
          process.execPath,
          [
            "-e",
            `require("fs").mkdirSync(${JSON.stringify(timeoutsDir)}, { recursive: true }); ` +
              `require("fs").writeFileSync(require("path").join(${JSON.stringify(timeoutsDir)}, "timeout-abc123"), "data"); ` +
              `process.exit(1)`,
          ],
          { stdio: "ignore" },
        ),
    });

    expect(result.crashed).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    // The in-flight input is recovered into the timeouts bucket.
    expect(result.crashArtifactPath).toBeDefined();
    expect(result.crashArtifactPath).toContain("timeout-");
    expect(readFileSync(result.crashArtifactPath!).toString()).toBe(
      "hard-timeout-input",
    );
    expect(shmem.resetGenerationCount).toBe(1);
  });

  it("returns crashed=true on unknown exit code and warns to stderr", async () => {
    const shmem = createMockShmem();
    makeTmpDir();

    const spy = vi.spyOn(process.stderr, "write");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-unknown",
      maxRespawns: 1,
      spawnChild: () =>
        spawn(process.execPath, ["-e", "process.exit(42)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(42);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("child exited with unexpected exit code 42"),
    );
  });

  it("recovers the in-flight input and respawns on an unknown exit code", async () => {
    const dir = makeTmpDir();
    // 139 = SIGSEGV surfaced as an exit code (some container/PID-1 setups).
    const shmem = createMockShmem(Buffer.from("segv-input"));
    let spawnCount = 0;
    const testName = "test-unknown-recovery";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 2,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(139)"], {
          stdio: "ignore",
        });
      },
    });

    // One respawn happened before the limit was hit.
    expect(spawnCount).toBe(2);
    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(139);
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);
    expect(readFileSync(result.crashArtifactPath!).toString()).toBe(
      "segv-input",
    );
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      true,
    );
    // Generation is reset before each respawned child (and on final exit).
    expect(shmem.resetGenerationCount).toBe(2);
  });

  it("trips the startup-failure breaker on repeated unknown exits with no input", async () => {
    const dir = makeTmpDir();
    // Child always dies with an unknown code but never stashes an input.
    const shmem = createMockShmem(null);
    let spawnCount = 0;
    const testName = "test-unknown-startup-storm";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      // High respawn budget: the startup breaker must trip well before it.
      maxRespawns: 100,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(42)"], {
          stdio: "ignore",
        });
      },
    });

    expect(result.startupFailure).toBe(true);
    expect(result.crashed).toBe(false);
    expect(spawnCount).toBe(MAX_STARTUP_FAILURES);
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      false,
    );
  });

  it("respawns on watchdog timeout exit (code 77) and eventually hits respawn limit", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(Buffer.from("timeout-input"));
    let spawnCount = 0;
    const testName = "test-timeout";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 3,
      spawnChild: () => {
        spawnCount++;
        return spawn(
          process.execPath,
          ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`],
          { stdio: "ignore" },
        );
      },
    });

    expect(result.crashed).toBe(true);
    expect(result.exitCode).toBe(WATCHDOG_EXIT_CODE);
    expect(spawnCount).toBe(3);
    expect(shmem.resetGenerationCount).toBe(3);

    // Timeout artifact should have been written (3 times, same hash = 1 file)
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const artifactDir = path.join(dir, "testdata", hashDir, "timeouts");
    const files = readdirSync(artifactDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^timeout-/);
  });

  it.skipIf(process.platform === "win32")(
    "respawns on crash-signal death and eventually hits respawn limit",
    async () => {
      makeTmpDir();
      const shmem = createMockShmem(Buffer.from("crash-input"));
      let spawnCount = 0;

      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName: "test-signal",
        maxRespawns: 2,
        spawnChild: () => {
          spawnCount++;
          // SIGABRT is a crash signal (not SIGKILL, which is treated as OOM).
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGABRT')"],
            { stdio: "ignore" },
          );
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.signal).toBe("SIGABRT");
      expect(result.exitCode).toBeUndefined();
      expect(spawnCount).toBe(2);
      expect(shmem.resetGenerationCount).toBe(2);
    },
  );

  it("classifies engine panic exit (78) as engineError without artifact or respawn", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(Buffer.from("in-flight-input"));
    let spawnCount = 0;
    const testName = "test-engine-panic";

    const spy = vi.spyOn(process.stderr, "write");

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 5,
      spawnChild: () => {
        spawnCount++;
        return spawn(
          process.execPath,
          ["-e", `process.exit(${ENGINE_PANIC_EXIT_CODE})`],
          { stdio: "ignore" },
        );
      },
    });

    // Engine panic is an infrastructure error, not a target crash.
    expect(result.engineError).toBe(true);
    expect(result.crashed).toBe(false);
    expect(result.exitCode).toBe(ENGINE_PANIC_EXIT_CODE);

    // No respawn, no generation reset, no crash artifact fabricated.
    expect(spawnCount).toBe(1);
    expect(shmem.resetGenerationCount).toBe(0);
    expect(result.crashArtifactPath).toBeUndefined();
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      false,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("internal engine panic"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "still treats SIGABRT (134) with stashed input as a target crash",
    async () => {
      const dir = makeTmpDir();
      const shmem = createMockShmem(Buffer.from("crash-input"));
      const testName = "test-target-abort";

      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName,
        maxRespawns: 1,
        spawnChild: () =>
          spawn(process.execPath, ["-e", "process.exit(134)"], {
            stdio: "ignore",
          }),
      });

      expect(result.engineError).toBeUndefined();
      expect(result.crashed).toBe(true);
      expect(result.exitCode).toBe(134);
      expect(result.crashArtifactPath).toBeDefined();
      const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
      expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
        true,
      );
    },
  );

  it("writes no artifact when nothing was stashed (readConsistent null)", async () => {
    const dir = makeTmpDir();
    // null = no input was ever stashed (gen 0) or torn write.
    const shmem = createMockShmem(null);
    const testName = "test-empty";

    await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 1,
      spawnChild: () =>
        spawn(process.execPath, ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`], {
          stdio: "ignore",
        }),
    });

    // No artifact directory should be created when no input was recovered.
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const artifactDir = path.join(dir, "testdata", hashDir, "timeouts");
    expect(existsSync(artifactDir)).toBe(false);
  });

  it("writes a 0-byte crash artifact for a genuine empty-input crash", async () => {
    const dir = makeTmpDir();
    // A real empty (zero-length) input WAS stashed: readConsistent returns an
    // empty Buffer (not null), so the crash must still be preserved.
    const shmem = createMockShmem(Buffer.alloc(0));
    const testName = "test-empty-crash";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 1,
      // Exit 134 (SIGABRT-as-code) is a crash exit code - deterministic.
      spawnChild: () =>
        spawn(process.execPath, ["-e", "process.exit(134)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.crashArtifactPath).toBeDefined();
    const artifactPath = result.crashArtifactPath!;
    expect(path.basename(artifactPath)).toMatch(/^crash-[0-9a-f]{64}$/);
    expect(existsSync(artifactPath)).toBe(true);
    // The artifact is a real, zero-length reproducer.
    expect(readFileSync(artifactPath).length).toBe(0);
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      true,
    );
  });

  it("writes a 0-byte timeout artifact for a genuine empty-input timeout", async () => {
    const dir = makeTmpDir();
    // Symmetry with crashes: an empty (zero-length) input that hangs must still
    // be preserved as a 0-byte timeout reproducer, not dropped.
    const shmem = createMockShmem(Buffer.alloc(0));
    const testName = "test-empty-timeout";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 1,
      spawnChild: () =>
        spawn(process.execPath, ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.crashArtifactPath).toBeDefined();
    const artifactPath = result.crashArtifactPath!;
    expect(path.basename(artifactPath)).toMatch(/^timeout-[0-9a-f]{64}$/);
    expect(readFileSync(artifactPath).length).toBe(0);
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "timeouts"))).toBe(
      true,
    );
  });

  it.skipIf(process.platform === "win32")(
    "treats SIGKILL (signal) as an OOM/infra error: no respawn, no crash",
    async () => {
      const dir = makeTmpDir();
      const shmem = createMockShmem(null);
      let spawnCount = 0;
      const testName = "test-sigkill-signal";

      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName,
        maxRespawns: 5,
        spawnChild: () => {
          spawnCount++;
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGKILL')"],
            { stdio: "ignore" },
          );
        },
      });

      expect(result.oomKilled).toBe(true);
      expect(result.crashed).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      // No respawn storm, no fabricated crash.
      expect(spawnCount).toBe(1);
      expect(result.crashArtifactPath).toBeUndefined();
      const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
      expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
        false,
      );
    },
  );

  it("treats exit code 137 (OOM) as an infra error without respawn or crash", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(null);
    let spawnCount = 0;
    const testName = "test-oom-empty";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 5,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(137)"], {
          stdio: "ignore",
        });
      },
    });

    expect(result.oomKilled).toBe(true);
    expect(result.crashed).toBe(false);
    expect(result.exitCode).toBe(137);
    expect(spawnCount).toBe(1);
    expect(result.crashArtifactPath).toBeUndefined();
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      false,
    );
  });

  it("preserves the in-flight input in ooms/ on exit 137 with a stashed input", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(Buffer.from("oom-input"));
    let spawnCount = 0;
    const testName = "test-oom-input";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      maxRespawns: 5,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(137)"], {
          stdio: "ignore",
        });
      },
    });

    expect(result.oomKilled).toBe(true);
    expect(result.crashed).toBe(false);
    expect(spawnCount).toBe(1);
    // Input preserved in the segregated ooms/ bucket, NOT crashes/.
    expect(result.crashArtifactPath).toBeDefined();
    const artifactPath = result.crashArtifactPath!;
    expect(artifactPath).toContain(path.join("testdata") + path.sep);
    expect(artifactPath).toContain(`${path.sep}ooms${path.sep}`);
    expect(path.basename(artifactPath)).toMatch(/^oom-[0-9a-f]{64}$/);
    expect(readFileSync(artifactPath).toString()).toBe("oom-input");
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      false,
    );
  });

  it("bails as a startupFailure after MAX_STARTUP_FAILURES no-input respawns", async () => {
    const dir = makeTmpDir();
    // Child always crashes (exit 134) but never stashes an input (null).
    const shmem = createMockShmem(null);
    let spawnCount = 0;
    const testName = "test-startup-storm";

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName,
      // High respawn budget: the startup breaker must trip well before it.
      maxRespawns: 100,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(134)"], {
          stdio: "ignore",
        });
      },
    });

    expect(result.startupFailure).toBe(true);
    expect(result.crashed).toBe(false);
    expect(spawnCount).toBe(MAX_STARTUP_FAILURES);
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    expect(existsSync(path.join(dir, "testdata", hashDir, "crashes"))).toBe(
      false,
    );
  });

  it("resets the startup-failure counter when an input is recovered", async () => {
    makeTmpDir();
    let spawnCount = 0;
    // Recover an input only on the 2nd spawn; null otherwise. The single
    // recovery resets the breaker, so it should not trip until later.
    const shmem = createMockShmem(() =>
      spawnCount === 2 ? Buffer.from("real-crash") : null,
    );

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-startup-reset",
      maxRespawns: 100,
      spawnChild: () => {
        spawnCount++;
        return spawn(process.execPath, ["-e", "process.exit(134)"], {
          stdio: "ignore",
        });
      },
    });

    expect(result.startupFailure).toBe(true);
    expect(result.crashed).toBe(false);
    // Without the reset on spawn #2 the breaker would trip at spawn #3; the
    // recovered input pushes the trip out to spawn #5.
    expect(spawnCount).toBe(MAX_STARTUP_FAILURES + 2);
  });

  it("respawns correctly then returns clean exit", async () => {
    const shmem = createMockShmem(Buffer.from("input"));
    let spawnCount = 0;
    makeTmpDir();

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-recover",
      maxRespawns: 5,
      spawnChild: () => {
        spawnCount++;
        // First 2 attempts: watchdog timeout, then: clean exit
        const exitCode = spawnCount <= 2 ? WATCHDOG_EXIT_CODE : 0;
        return spawn(process.execPath, ["-e", `process.exit(${exitCode})`], {
          stdio: "ignore",
        });
      },
    });

    expect(result.crashed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(spawnCount).toBe(3);
  });

  it("writes crash artifact with artifactPrefix when set", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(Buffer.from("crash-input"));
    const artifactDir = path.join(dir, "out") + path.sep;

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-prefix",
      artifactPrefix: artifactDir,
      maxRespawns: 1,
      spawnChild: () =>
        spawn(process.execPath, ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.crashArtifactPath).toBeDefined();
    expect(result.crashArtifactPath!.startsWith(artifactDir)).toBe(true);
    expect(path.basename(result.crashArtifactPath!)).toMatch(
      /^timeout-[0-9a-f]{64}$/,
    );
    expect(existsSync(result.crashArtifactPath!)).toBe(true);
    expect(readFileSync(result.crashArtifactPath!).toString()).toBe(
      "crash-input",
    );
  });

  it("writes crash artifact to testdata/ when artifactPrefix is not set", async () => {
    makeTmpDir();
    const shmem = createMockShmem(Buffer.from("crash-input"));

    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-no-prefix",
      maxRespawns: 1,
      spawnChild: () =>
        spawn(process.execPath, ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(true);
    expect(result.crashArtifactPath).toBeDefined();
    expect(result.crashArtifactPath!).toContain(
      path.join("testdata") + path.sep,
    );
    expect(path.basename(result.crashArtifactPath!)).toMatch(
      /^timeout-[0-9a-f]{64}$/,
    );
  });

  it("uses MAX_RESPAWNS default when maxRespawns is not specified", async () => {
    // Just verify the constant is exported and reasonable
    expect(MAX_RESPAWNS).toBe(100);
  });

  it.skipIf(process.platform === "win32")(
    "treats child signal death as non-crash when SIGINT was received",
    async () => {
      const shmem = createMockShmem();
      makeTmpDir();
      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName: "test-sigint",
        spawnChild: () => {
          // Emit SIGINT on the parent to set sigintReceived flag.
          // Uses Node's EventEmitter (no OS signal delivery).
          process.emit("SIGINT");
          // SIGHUP is a non-crash, non-SIGKILL signal, so it falls through to
          // the SIGINT-shutdown check (SIGKILL would short-circuit to OOM).
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGHUP')"],
            { stdio: "ignore" },
          );
        },
      });
      // With the SIGINT flag set, the child's signal death is a clean shutdown.
      expect(result.crashed).toBe(false);
      expect(result.oomKilled).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "still reports a real crash signal even when SIGINT was received (does not swallow it)",
    async () => {
      makeTmpDir();
      const shmem = createMockShmem(Buffer.from("crash-input"));
      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName: "test-crash-during-sigint",
        maxRespawns: 1,
        spawnChild: () => {
          process.emit("SIGINT");
          // SIGABRT is a real crash signal; it must be classified as a crash
          // even though a shutdown was requested (crash check precedes shutdown).
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGABRT')"],
            { stdio: "ignore" },
          );
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.signal).toBe("SIGABRT");
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats SIGKILL during SIGINT shutdown as a clean shutdown, not an OOM",
    async () => {
      makeTmpDir();
      const shmem = createMockShmem(null);
      const result = await runSupervisor({
        shmem,
        relativeTestFilePath: TEST_RELATIVE_PATH,
        testName: "test-sigkill-during-sigint",
        maxRespawns: 5,
        spawnChild: () => {
          process.emit("SIGINT");
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGKILL')"],
            { stdio: "ignore" },
          );
        },
      });

      // Shutdown wins over the OOM classification: not a crash, not oomKilled.
      expect(result.crashed).toBe(false);
      expect(result.oomKilled).toBeUndefined();
    },
  );
});

describe("waitForChild", () => {
  it("resolves with exit code 0 on normal exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const result = await waitForChild(child);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("resolves with exit code 1 on JS crash exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
      stdio: "ignore",
    });
    const result = await waitForChild(child);
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
  });

  it("resolves with watchdog exit code 77", async () => {
    const child = spawn(
      process.execPath,
      ["-e", `process.exit(${WATCHDOG_EXIT_CODE})`],
      { stdio: "ignore" },
    );
    const result = await waitForChild(child);
    expect(result.code).toBe(WATCHDOG_EXIT_CODE);
    expect(result.signal).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "resolves with signal on SIGKILL",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGKILL')"],
        { stdio: "ignore" },
      );
      const result = await waitForChild(child);
      expect(result.code).toBeNull();
      expect(result.signal).toBe("SIGKILL");
    },
  );

  it("rejects when child fails to spawn", async () => {
    const child = spawn("/nonexistent/binary/that/does/not/exist", [], {
      stdio: "ignore",
    });
    await expect(waitForChild(child)).rejects.toThrow();
  });
});
