import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runFuzzLoop } from "./loop.js";
import { initGlobals } from "./globals.js";

describe("fuzz loop", () => {
  let tmpDir: string;
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCacheDir = process.env["VITIATE_CACHE_DIR"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    if (originalCacheDir === undefined) {
      delete process.env["VITIATE_CACHE_DIR"];
    } else {
      process.env["VITIATE_CACHE_DIR"] = originalCacheDir;
    }
    globalThis.__vitiate_cov = originalCov;
    globalThis.__vitiate_trace_cmp = originalTrace;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupFuzzingMode(): Promise<void> {
    process.env["VITIATE_FUZZ"] = "1";
    await initGlobals();
    tmpDir = path.join(
      tmpdir(),
      `vitiate-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    process.env["VITIATE_CACHE_DIR"] = path.join(tmpDir, ".cache");
  }

  it("runs against a trivial target and terminates after runs limit", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const target = (_data: Buffer): void => {
      callCount++;
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "trivial",
      "test.fuzz.ts",
      { runs: 100 },
    );

    expect(result.crashed).toBe(false);
    expect(callCount).toBe(100);
    expect(result.totalExecs).toBe(100);
  });

  it("detects a crash and writes crash artifact", async () => {
    await setupFuzzingMode();
    const target = (data: Buffer): void => {
      // Crash when we get input with first byte 0x42
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("found the bug!");
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "crashme",
      "test.fuzz.ts",
      {
        runs: 1_000_000,
      },
    );

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);

    // Verify crash artifact is in the testdata dir (hash-prefixed)
    expect(result.crashArtifactPath!).toContain(path.join("testdata", "fuzz"));
    expect(result.crashArtifactPath!).toContain("crashme");
    expect(path.basename(result.crashArtifactPath!)).toMatch(/^crash-/);
  });
  it("runs an async target and terminates after runs limit", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const target = async (_data: Buffer): Promise<void> => {
      callCount++;
      await Promise.resolve();
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "async-trivial",
      "test.fuzz.ts",
      {
        runs: 100,
      },
    );

    expect(result.crashed).toBe(false);
    expect(callCount).toBe(100);
    expect(result.totalExecs).toBe(100);
  });

  it("detects a crash from an async target", async () => {
    await setupFuzzingMode();
    const target = async (data: Buffer): Promise<void> => {
      await Promise.resolve();
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("async crash!");
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "async-crash",
      "test.fuzz.ts",
      {
        runs: 1_000_000,
      },
    );

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("async crash!");
    expect(result.crashArtifactPath).toBeDefined();
  });

  it("times out a synchronous target that blocks the event loop", async () => {
    await setupFuzzingMode();
    const target = (_data: Buffer): void => {
      // Infinite synchronous loop - only interruptible via V8 TerminateExecution
      for (;;) {
        /* intentionally empty */
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "sync-timeout",
      "test.fuzz.ts",
      {
        runs: 1,
        timeoutMs: 200,
      },
    );

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toContain("timed out");
  });

  // NOTE: Async timeout (busy microtask loop) is enforced by the _exit
  // fallback at 5× timeout - V8 TerminateExecution cascades through all JS
  // frames and cannot be caught, so the process terminates. This is tested
  // as an integration test rather than in-process.

  it("does not time out a fast async target", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const target = async (_data: Buffer): Promise<void> => {
      callCount++;
      await Promise.resolve();
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "no-timeout",
      "test.fuzz.ts",
      {
        runs: 10,
        timeoutMs: 5000,
      },
    );

    expect(result.crashed).toBe(false);
    expect(callCount).toBe(10);
  });

  it("does not produce unhandled rejections for fast async targets with timeout", async () => {
    await setupFuzzingMode();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      let callCount = 0;
      const target = async (_data: Buffer): Promise<void> => {
        callCount++;
        await Promise.resolve();
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "no-leak",
        "test.fuzz.ts",
        {
          runs: 50,
          timeoutMs: 5000,
        },
      );

      // Flush pending event-loop callbacks (setImmediate fires on the next
      // event-loop turn without relying on wall-clock timing).
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.crashed).toBe(false);
      expect(callCount).toBe(50);
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onRejection);
    }
  });

  it("does not misclassify a normal crash as a timeout", async () => {
    await setupFuzzingMode();
    const target = (data: Buffer): void => {
      // Crash on any non-empty input - this is a regular throw, not a timeout
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("regular crash, not a timeout");
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "not-timeout",
      "test.fuzz.ts",
      {
        runs: 1_000_000,
        timeoutMs: 5000, // Long timeout - should never fire
      },
    );

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("regular crash, not a timeout");
  });

  it("throws when coverage map is not initialized", async () => {
    await setupFuzzingMode();
    // Unset the coverage map to simulate missing setup
    const saved = globalThis.__vitiate_cov;
    delete (globalThis as Record<string, unknown>)["__vitiate_cov"];

    try {
      await expect(
        runFuzzLoop((_data: Buffer) => {}, tmpDir, "no-cov", "test.fuzz.ts", {
          runs: 1,
        }),
      ).rejects.toThrow("coverage map not initialized");
    } finally {
      globalThis.__vitiate_cov = saved;
    }
  });

  it("loads extra corpus dirs as seeds", async () => {
    await setupFuzzingMode();
    const extraDir = path.join(tmpDir, "extra-corpus");
    mkdirSync(extraDir, { recursive: true });
    // Use a 5-byte seed that triggers the crash condition
    writeFileSync(path.join(extraDir, "seed-crash"), "GET!");

    const target = (data: Buffer): void => {
      // Crash when we see the exact seed from the extra corpus dir
      if (data.length >= 4 && data.subarray(0, 4).toString() === "GET!") {
        throw new Error("extra corpus seed hit");
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "corpus-dirs-test",
      "test.fuzz.ts",
      { runs: 1_000_000 },
      [extraDir],
    );

    // The seed from the extra corpus dir should trigger the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("extra corpus seed hit");
  });

  it("minimizes crash artifact to smaller than the original mutated input", async () => {
    await setupFuzzingMode();

    // Target crashes on any input containing the byte sequence [0xDE, 0xAD].
    // The fuzzer will find this with a larger input; minimization should
    // shrink it to exactly 2 bytes.
    const target = (data: Buffer): void => {
      for (let i = 0; i < data.length - 1; i++) {
        if (data[i] === 0xde && data[i + 1] === 0xad) {
          throw new Error("found DEAD pattern");
        }
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "minimize-test",
      "test.fuzz.ts",
      {
        runs: 1_000_000,
        maxTotalTimeMs: 30_000,
      },
    );

    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("found DEAD pattern");
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);

    // The minimized artifact should be exactly 2 bytes: [0xDE, 0xAD]
    const artifactData = readFileSync(result.crashArtifactPath!);
    expect(artifactData.length).toBe(2);
    expect(artifactData[0]).toBe(0xde);
    expect(artifactData[1]).toBe(0xad);
  });
  it("runs=0 means unlimited iterations (runs until crash or other limit)", async () => {
    await setupFuzzingMode();
    const target = (data: Buffer): void => {
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("found the bug!");
      }
    };

    // runs=0 should mean unlimited; maxTotalTimeMs is the safety net
    const result = await runFuzzLoop(
      target,
      tmpDir,
      "runs-zero",
      "test.fuzz.ts",
      {
        runs: 0,
        maxTotalTimeMs: 30_000,
      },
    );

    // The loop should not exit immediately at iteration 0;
    // it should keep going and eventually find the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.totalExecs).toBeGreaterThan(0);
  });

  it("runs calibration loop after interesting inputs", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const covMap = globalThis.__vitiate_cov as Buffer;
    const target = (data: Buffer): void => {
      callCount++;
      // Set a unique coverage edge per distinct first byte value.
      // This guarantees new coverage (interesting) for early iterations with
      // diverse auto-seeds, triggering the calibration loop.
      if (data.length > 0) {
        covMap[data[0]!] = 1;
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "cal-loop",
      "test.fuzz.ts",
      {
        runs: 50,
      },
    );

    expect(result.crashed).toBe(false);
    expect(result.totalExecs).toBe(50);
    // Calibration re-runs the target 3 additional times per interesting input.
    // With auto-seeds providing diverse first bytes, at least a few interesting
    // inputs are discovered, so total target calls exceed the iteration count.
    expect(callCount).toBeGreaterThan(50);
  });

  it("maxTotalTimeMs=0 means unlimited total time (runs until crash or runs limit)", async () => {
    await setupFuzzingMode();
    const target = (data: Buffer): void => {
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("found the bug!");
      }
    };

    // maxTotalTimeMs=0 should mean unlimited; runs is the safety net
    const result = await runFuzzLoop(
      target,
      tmpDir,
      "time-zero",
      "test.fuzz.ts",
      {
        maxTotalTimeMs: 0,
        runs: 1_000_000,
      },
    );

    // The loop should not exit immediately at time 0;
    // it should keep going and eventually find the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.totalExecs).toBeGreaterThan(0);
  });
}, 30000);
