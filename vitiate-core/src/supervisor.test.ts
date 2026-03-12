import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ShmemHandle } from "@vitiate/engine";
import {
  runSupervisor,
  waitForChild,
  WATCHDOG_EXIT_CODE,
  MAX_RESPAWNS,
} from "./supervisor.js";
import { hashTestPath } from "./nix-base32.js";
import { setDataDir, resetDataDir } from "./config.js";

/**
 * Create a mock ShmemHandle for testing. The supervisor calls:
 * - readStashedInput(): returns the mocked input buffer
 * - resetGeneration(): tracked for call counting
 */
function createMockShmem(
  stashedInput: Buffer = Buffer.alloc(0),
): ShmemHandle & { resetGenerationCount: number } {
  const mock = {
    readStashedInput: () => stashedInput,
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
  });

  it("returns crashed=false on unknown exit code", async () => {
    const shmem = createMockShmem();
    makeTmpDir();
    const result = await runSupervisor({
      shmem,
      relativeTestFilePath: TEST_RELATIVE_PATH,
      testName: "test-unknown",
      spawnChild: () =>
        spawn(process.execPath, ["-e", "process.exit(42)"], {
          stdio: "ignore",
        }),
    });

    expect(result.crashed).toBe(false);
    expect(result.exitCode).toBe(42);
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
    "respawns on signal death and eventually hits respawn limit",
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
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGKILL')"],
            { stdio: "ignore" },
          );
        },
      });

      expect(result.crashed).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(result.exitCode).toBeUndefined();
      expect(spawnCount).toBe(2);
      expect(shmem.resetGenerationCount).toBe(2);
    },
  );

  it("writes no crash artifact when shmem has empty input", async () => {
    const dir = makeTmpDir();
    const shmem = createMockShmem(Buffer.alloc(0));
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

    // No artifact directory should be created when shmem is empty
    const hashDir = hashTestPath(TEST_RELATIVE_PATH, testName);
    const artifactDir = path.join(dir, "testdata", hashDir, "timeouts");
    expect(existsSync(artifactDir)).toBe(false);
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
          return spawn(
            process.execPath,
            ["-e", "process.kill(process.pid, 'SIGKILL')"],
            { stdio: "ignore" },
          );
        },
      });
      // Without SIGINT flag, SIGKILL death -> crash. With flag -> clean exit.
      expect(result.crashed).toBe(false);
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
