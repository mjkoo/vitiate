import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
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

    const result = await runFuzzLoop(target, tmpDir, "trivial", { runs: 100 });

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

    const result = await runFuzzLoop(target, tmpDir, "crashme", {
      runs: 1_000_000,
    });

    expect(result.crashed).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.crashArtifactPath).toBeDefined();
    expect(existsSync(result.crashArtifactPath!)).toBe(true);

    // Verify crash artifact is in the testdata dir
    const crashDir = path.join(tmpDir, "testdata", "fuzz", "crashme");
    expect(existsSync(crashDir)).toBe(true);
    const files = readdirSync(crashDir);
    expect(files.some((f) => f.startsWith("crash-"))).toBe(true);
  });
  it("runs an async target and terminates after runs limit", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const target = async (_data: Buffer): Promise<void> => {
      callCount++;
      await Promise.resolve();
    };

    const result = await runFuzzLoop(target, tmpDir, "async-trivial", {
      runs: 100,
    });

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

    const result = await runFuzzLoop(target, tmpDir, "async-crash", {
      runs: 1_000_000,
    });

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

    const result = await runFuzzLoop(target, tmpDir, "sync-timeout", {
      runs: 1,
      timeoutMs: 200,
    });

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

    const result = await runFuzzLoop(target, tmpDir, "no-timeout", {
      runs: 10,
      timeoutMs: 5000,
    });

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

      const result = await runFuzzLoop(target, tmpDir, "no-leak", {
        runs: 50,
        timeoutMs: 5000,
      });

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

    const result = await runFuzzLoop(target, tmpDir, "not-timeout", {
      runs: 1_000_000,
      timeoutMs: 5000, // Long timeout - should never fire
    });

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
        runFuzzLoop((_data: Buffer) => {}, tmpDir, "no-cov", { runs: 1 }),
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
      { runs: 1_000_000 },
      [extraDir],
    );

    // The seed from the extra corpus dir should trigger the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("extra corpus seed hit");
  });
}, 30000);
