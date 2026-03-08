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
import { runFuzzLoop, checkDedupPolicy } from "./loop.js";
import { initGlobals } from "./globals.js";
import { sanitizeTestName } from "./corpus.js";
import { setCacheDir, resetCacheDir } from "./config.js";

describe("fuzz loop", () => {
  let tmpDir: string;
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCliIpc = process.env["VITIATE_CLI_IPC"];
  const originalCov = globalThis.__vitiate_cov;
  const originalTrace = globalThis.__vitiate_trace_cmp;

  afterEach(() => {
    if (originalFuzz === undefined) {
      delete process.env["VITIATE_FUZZ"];
    } else {
      process.env["VITIATE_FUZZ"] = originalFuzz;
    }
    resetCacheDir();
    if (originalCliIpc === undefined) {
      delete process.env["VITIATE_CLI_IPC"];
    } else {
      process.env["VITIATE_CLI_IPC"] = originalCliIpc;
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
    setCacheDir(path.join(tmpDir, ".cache"));
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
      { runs: 100, grimoire: false, unicode: false },
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

    // Verify crash artifact contains the triggering byte
    const crashData = readFileSync(result.crashArtifactPath!);
    expect(crashData[0]).toBe(0x42);
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
        grimoire: false,
        unicode: false,
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
      { corpusDirs: [extraDir] },
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
        fuzzTimeMs: 30_000,
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

    // runs=0 should mean unlimited; fuzzTimeMs is the safety net
    const result = await runFuzzLoop(
      target,
      tmpDir,
      "runs-zero",
      "test.fuzz.ts",
      {
        runs: 0,
        fuzzTimeMs: 30_000,
      },
    );

    // The loop should not exit immediately at iteration 0;
    // it should keep going and eventually find the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.totalExecs).toBeGreaterThan(0);
  });

  // Tests below use `grimoire: false`, `unicode: false`, and `redqueen: false`
  // to ensure deterministic totalExecs counts. These options disable mutational
  // stages that run extra iterations beyond the `runs` limit.
  // Grimoire/REDQUEEN integration is tested at the engine level (Rust unit tests).
  // A full TypeScript pipeline test for these features would be
  // non-deterministic and belongs in fuzz-pipeline.test.ts if needed.

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
        grimoire: false,
        unicode: false,
        redqueen: false,
      },
    );

    expect(result.crashed).toBe(false);
    expect(result.totalExecs).toBe(50);
    // Calibration re-runs the target 3 additional times per interesting input.
    // With auto-seeds providing diverse first bytes, at least a few interesting
    // inputs are discovered, so total target calls exceed the iteration count.
    expect(callCount).toBeGreaterThan(50);
  });

  it("collects coverage from async target continuations and runs calibration", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const covMap = globalThis.__vitiate_cov as Buffer;
    const target = async (data: Buffer): Promise<void> => {
      callCount++;
      await Promise.resolve();
      if (data.length > 0) {
        covMap[data[0]!] = 1;
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "async-cov",
      "test.fuzz.ts",
      {
        runs: 50,
        grimoire: false,
        unicode: false,
        redqueen: false,
      },
    );

    expect(result.crashed).toBe(false);
    expect(result.totalExecs).toBe(50);
    // Calibration re-runs the target 3 additional times per interesting input.
    // Coverage written after `await` must be detected as interesting for this
    // to hold — if async coverage collection were broken, callCount === 50.
    expect(callCount).toBeGreaterThan(50);
  });

  it("collects coverage from async target with timeout configured", async () => {
    await setupFuzzingMode();
    let callCount = 0;
    const covMap = globalThis.__vitiate_cov as Buffer;
    const target = async (data: Buffer): Promise<void> => {
      callCount++;
      await Promise.resolve();
      if (data.length > 0) {
        covMap[data[0]!] = 1;
      }
    };

    const result = await runFuzzLoop(
      target,
      tmpDir,
      "async-cov-timeout",
      "test.fuzz.ts",
      {
        runs: 50,
        timeoutMs: 5000,
        grimoire: false,
        unicode: false,
        redqueen: false,
      },
    );

    expect(result.crashed).toBe(false);
    expect(result.totalExecs).toBe(50);
    // Same calibration assertion as the non-timeout variant, but exercises the
    // watchdog arm/disarm path during both the main loop and calibration.
    expect(callCount).toBeGreaterThan(50);
  });

  it("fuzzTimeMs=0 means unlimited total time (runs until crash or runs limit)", async () => {
    await setupFuzzingMode();
    const target = (data: Buffer): void => {
      if (data.length > 0 && data[0] === 0x42) {
        throw new Error("found the bug!");
      }
    };

    // fuzzTimeMs=0 should mean unlimited; runs is the safety net
    const result = await runFuzzLoop(
      target,
      tmpDir,
      "time-zero",
      "test.fuzz.ts",
      {
        fuzzTimeMs: 0,
        runs: 1_000_000,
      },
    );

    // The loop should not exit immediately at time 0;
    // it should keep going and eventually find the crash
    expect(result.crashed).toBe(true);
    expect(result.error!.message).toBe("found the bug!");
    expect(result.totalExecs).toBeGreaterThan(0);
  });

  describe("I2S stage execution", () => {
    it("runs I2S stage and counts stage executions in totalExecs", async () => {
      await setupFuzzingMode();
      let callCount = 0;
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        callCount++;
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        globalThis.__vitiate_trace_cmp(
          data.toString(),
          "target_value",
          0,
          "===",
        );
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-execs",
        "test.fuzz.ts",
        { runs: 50, timeoutMs: 5000, grimoire: false },
      );

      expect(result.crashed).toBe(false);
      // I2S stage iterations increment totalExecs beyond the main-loop count.
      expect(result.totalExecs).toBeGreaterThan(50);
      // callCount additionally includes calibration re-runs.
      expect(callCount).toBeGreaterThan(result.totalExecs);
    });

    it("no stages run when CmpLog data is absent and Grimoire is disabled", async () => {
      await setupFuzzingMode();
      let callCount = 0;
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        callCount++;
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-no-cmp",
        "test.fuzz.ts",
        { runs: 50, grimoire: false, unicode: false, redqueen: false },
      );

      expect(result.crashed).toBe(false);
      // Without CmpLog data (no I2S) and with Grimoire/REDQUEEN disabled, totalExecs === runs.
      expect(result.totalExecs).toBe(50);
      // callCount > totalExecs due to calibration re-runs.
      expect(callCount).toBeGreaterThan(result.totalExecs);
    });

    it("writes crash artifact when target crashes during I2S stage", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        // Record comparison; I2S mutator will try to splice "DEAD" into inputs.
        if (data.length >= 4) {
          globalThis.__vitiate_trace_cmp(
            data.subarray(0, 4).toString(),
            "DEAD",
            0,
            "===",
          );
        }
        // Crash when I2S produces the exact bytes "DEAD" at the start.
        // Havoc alone is extremely unlikely to produce this 4-byte sequence
        // (~2e-10 per iteration), but I2S specifically tries it.
        if (data.length >= 4 && data.subarray(0, 4).toString() === "DEAD") {
          throw new Error("I2S stage crash!");
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-crash",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000, grimoire: false },
      );

      expect(result.crashed).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe("I2S stage crash!");
      expect(result.crashArtifactPath).toBeDefined();
      expect(existsSync(result.crashArtifactPath!)).toBe(true);

      // Verify the artifact contains the I2S-produced crash trigger.
      const artifactData = readFileSync(result.crashArtifactPath!);
      expect(artifactData.subarray(0, 4).toString()).toBe("DEAD");
    });

    it("runs I2S stage with async target", async () => {
      await setupFuzzingMode();
      let callCount = 0;
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = async (data: Buffer): Promise<void> => {
        callCount++;
        await Promise.resolve();
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        globalThis.__vitiate_trace_cmp(data.toString(), "async_val", 0, "===");
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-async",
        "test.fuzz.ts",
        { runs: 50, timeoutMs: 5000, grimoire: false },
      );

      expect(result.crashed).toBe(false);
      // Stage ran: totalExecs > runs
      expect(result.totalExecs).toBeGreaterThan(50);
      // Calibration + stage: callCount > totalExecs
      expect(callCount).toBeGreaterThan(result.totalExecs);
    });

    it("writes timeout artifact when I2S stage execution times out", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        if (data.length >= 4) {
          globalThis.__vitiate_trace_cmp(
            data.subarray(0, 4).toString(),
            "HANG",
            0,
            "===",
          );
        }
        // Infinite loop when I2S produces "HANG" at the start.
        if (data.length >= 4 && data.subarray(0, 4).toString() === "HANG") {
          for (;;) {
            /* intentionally empty */
          }
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-timeout",
        "test.fuzz.ts",
        {
          runs: 1_000_000,
          timeoutMs: 200,
          fuzzTimeMs: 30_000,
          grimoire: false,
        },
      );

      expect(result.crashed).toBe(true);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toContain("timed out");
      expect(result.crashArtifactPath).toBeDefined();
      expect(existsSync(result.crashArtifactPath!)).toBe(true);

      // Verify timeout artifact naming
      expect(path.basename(result.crashArtifactPath!)).toMatch(/^timeout-/);
    });

    it("totalExecs includes aborted stage execution", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        if (data.length >= 4) {
          globalThis.__vitiate_trace_cmp(
            data.subarray(0, 4).toString(),
            "DEAD",
            0,
            "===",
          );
        }
        if (data.length >= 4 && data.subarray(0, 4).toString() === "DEAD") {
          throw new Error("stage crash for execs count");
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-execs-abort",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000, grimoire: false },
      );

      expect(result.crashed).toBe(true);
      // At least 1 main-loop iteration (Interesting) + 1 stage execution (the
      // aborted crash). totalExecs must reflect the aborted stage work.
      expect(result.totalExecs).toBeGreaterThan(1);
      // Confirm the crash originated from the I2S stage (not the main loop).
      const artifactData = readFileSync(result.crashArtifactPath!);
      expect(artifactData.subarray(0, 4).toString()).toBe("DEAD");
    });

    it("adds stage-discovered interesting inputs to corpus without calibration", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      const { Fuzzer } = await import("vitiate-napi");
      const fuzzer = new Fuzzer(covMap, {});

      // Step 1: Execute first input with new coverage + CmpLog data
      fuzzer.getNextInput();
      covMap[10] = 1;
      globalThis.__vitiate_trace_cmp("hello", "world", 0, "===");
      // ExitKind.Ok = 0, IterationResult.Interesting = 1
      const iterResult = fuzzer.reportResult(0, 1000);
      expect(iterResult).toBe(1);

      // Step 2: Run calibration to completion
      covMap[10] = 1;
      while (fuzzer.calibrateRun(1000)) {
        covMap[10] = 1;
      }
      fuzzer.calibrateFinish();

      const corpusBefore = fuzzer.stats.corpusSize;

      // Step 3: Begin I2S stage
      const stageInput = fuzzer.beginStage();
      expect(stageInput).not.toBeNull();

      // Step 4: Simulate stage execution with NEW coverage edge
      covMap[20] = 1;
      // ExitKind.Ok = 0
      const nextInput = fuzzer.advanceStage(0, 1000);

      // Verify corpus grew from the stage-discovered coverage
      expect(fuzzer.stats.corpusSize).toBeGreaterThan(corpusBefore);

      // Drain remaining stage iterations
      let next = nextInput;
      while (next !== null) {
        // No new coverage for remaining iterations
        next = fuzzer.advanceStage(0, 1000);
      }
    });

    it("beginStage returns null without preceding interesting input", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      const { Fuzzer } = await import("vitiate-napi");
      const fuzzer = new Fuzzer(covMap, {});

      // No inputs processed yet — beginStage should return null
      expect(fuzzer.beginStage()).toBeNull();

      // Process a non-interesting input (no coverage written)
      fuzzer.getNextInput();
      // ExitKind.Ok = 0, IterationResult.None = 0
      const iterResult = fuzzer.reportResult(0, 1000);
      expect(iterResult).toBe(0);

      // Still no interesting input — beginStage should return null
      expect(fuzzer.beginStage()).toBeNull();
    });

    it("runs I2S stage without watchdog when no timeout configured", async () => {
      await setupFuzzingMode();
      let callCount = 0;
      const covMap = globalThis.__vitiate_cov as Buffer;
      const target = (data: Buffer): void => {
        callCount++;
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        globalThis.__vitiate_trace_cmp(data.toString(), "no_wd", 0, "===");
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-no-wd",
        "test.fuzz.ts",
        { runs: 50, grimoire: false, unicode: false },
      );

      expect(result.crashed).toBe(false);
      // Stage ran without watchdog: totalExecs > runs
      expect(result.totalExecs).toBeGreaterThan(50);
      expect(callCount).toBeGreaterThan(result.totalExecs);
    });

    it("skips stage when calibration is interrupted by crash", async () => {
      await setupFuzzingMode();
      let callCount = 0;
      const covMap = globalThis.__vitiate_cov as Buffer;
      let lastExecutedInput: string | null = null;
      const target = (data: Buffer): void => {
        callCount++;
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        globalThis.__vitiate_trace_cmp(
          data.toString(),
          "calib_crash",
          0,
          "===",
        );
        // Crash when the same input runs back-to-back (calibration re-run).
        // This relies on calibration re-executing the same input consecutively;
        // unlike a Set, it avoids false positives from historical collisions
        // when havoc mutations happen to produce identical short byte sequences.
        const key = data.toString("hex");
        if (key === lastExecutedInput) {
          throw new Error("calibration crash!");
        }
        lastExecutedInput = key;
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-cal-crash",
        "test.fuzz.ts",
        { runs: 50, grimoire: false, unicode: false, redqueen: false },
      );

      expect(result.crashed).toBe(false);
      // No stage ran: calibration crashed before any stage could start.
      expect(result.totalExecs).toBe(50);
      // callCount > runs because of calibration attempts (even though they crash).
      expect(callCount).toBeGreaterThan(50);
    });
  });

  describe("multi-crash support (stopOnCrash=false)", () => {
    it("loop continues after crash when stopOnCrash=false", async () => {
      await setupFuzzingMode();
      let crashCount = 0;
      // Use different throw sites so each crash gets a unique dedup key
      function crashSiteA(): never {
        crashCount++;
        throw new Error(`crash #${crashCount}`);
      }
      function crashSiteB(): never {
        crashCount++;
        throw new Error(`crash #${crashCount}`);
      }
      function crashSiteC(): never {
        crashCount++;
        throw new Error(`crash #${crashCount}`);
      }
      const sites = [crashSiteA, crashSiteB, crashSiteC];
      const target = (data: Buffer): void => {
        if (data.length > 1 && data[0] === 0x42) {
          sites[data[1]! % 3]!();
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "multi-crash",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000 },
        { stopOnCrash: false, maxCrashes: 3 },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(3);
      expect(result.crashArtifactPaths.length).toBe(3);
      // First crash data preserved
      expect(result.error).toBeInstanceOf(Error);
      expect(result.crashArtifactPath).toBe(result.crashArtifactPaths[0]);
    });

    it("loop stops on crash when stopOnCrash=true (default)", async () => {
      await setupFuzzingMode();
      const target = (data: Buffer): void => {
        if (data.length > 0 && data[0] === 0x42) {
          throw new Error("crash!");
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stop-first",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000 },
        { stopOnCrash: true },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(1);
      expect(result.crashArtifactPaths.length).toBe(1);
    });

    it("maxCrashes=0 means unlimited (no limit enforcement)", async () => {
      await setupFuzzingMode();
      let _crashCount = 0;
      // Use different throw sites based on second byte so each crash has a
      // unique dedup key (different stack traces).
      const throwers: Record<number, () => never> = {
        0: () => {
          throw new Error("crash-site-0");
        },
        1: () => {
          throw new Error("crash-site-1");
        },
        2: () => {
          throw new Error("crash-site-2");
        },
        3: () => {
          throw new Error("crash-site-3");
        },
      };
      const target = (data: Buffer): void => {
        if (data.length > 1 && data[0] === 0x42) {
          _crashCount++;
          const site = data[1]! % 4;
          throwers[site]!();
        }
      };

      // Use runs limit (not time) to keep test fast.
      // If maxCrashes=0 triggered a limit, the loop would stop early.
      const result = await runFuzzLoop(
        target,
        tmpDir,
        "unlimited-crash",
        "test.fuzz.ts",
        { runs: 5000 },
        { stopOnCrash: false, maxCrashes: 0 },
      );

      // Should find multiple unique crashes and NOT stop at any crash limit —
      // only the runs limit terminates
      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBeGreaterThan(1);
    });

    it("maxCrashes limit triggers warning on stderr", async () => {
      await setupFuzzingMode();
      const chunks: string[] = [];
      const originalWrite = process.stderr.write;
      // Capture stderr but still call original for non-warning output
      process.stderr.write = ((chunk: string) => {
        chunks.push(chunk);
        return originalWrite.call(process.stderr, chunk);
      }) as typeof process.stderr.write;

      try {
        // Use different throw sites so dedup doesn't suppress the second crash
        function crashSiteA(): never {
          throw new Error("crash A!");
        }
        function crashSiteB(): never {
          throw new Error("crash B!");
        }
        const target = (data: Buffer): void => {
          if (data.length > 1 && data[0] === 0x42) {
            if (data[1]! % 2 === 0) crashSiteA();
            else crashSiteB();
          }
        };

        const result = await runFuzzLoop(
          target,
          tmpDir,
          "limit-warn",
          "test.fuzz.ts",
          { runs: 1_000_000, fuzzTimeMs: 30_000 },
          { stopOnCrash: false, maxCrashes: 2 },
        );

        expect(result.crashCount).toBe(2);
        expect(chunks.some((c) => c.includes("maxCrashes limit reached"))).toBe(
          true,
        );
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it("no crashes found returns crashCount 0 and empty crashArtifactPaths", async () => {
      await setupFuzzingMode();
      const target = (_data: Buffer): void => {};

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "no-crash",
        "test.fuzz.ts",
        { runs: 50, grimoire: false, unicode: false },
        { stopOnCrash: false },
      );

      expect(result.crashed).toBe(false);
      expect(result.crashCount).toBe(0);
      expect(result.crashArtifactPaths).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(result.crashInput).toBeUndefined();
      expect(result.crashArtifactPath).toBeUndefined();
    });

    it("stage crash continues when stopOnCrash=false", async () => {
      await setupFuzzingMode();
      const covMap = globalThis.__vitiate_cov as Buffer;
      let crashCount = 0;
      const target = (data: Buffer): void => {
        if (data.length > 0) {
          covMap[data[0]!] = 1;
        }
        if (data.length >= 4) {
          globalThis.__vitiate_trace_cmp(
            data.subarray(0, 4).toString(),
            "DEAD",
            0,
            "===",
          );
        }
        if (data.length >= 4 && data.subarray(0, 4).toString() === "DEAD") {
          crashCount++;
          throw new Error(`stage crash #${crashCount}`);
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "stage-continue",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000, grimoire: false },
        { stopOnCrash: false, maxCrashes: 5 },
      );

      expect(result.crashed).toBe(true);
      // At least one crash should be from a stage
      expect(result.crashCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("crash dedup", () => {
    it("first crash is saved and dedup map is populated", async () => {
      await setupFuzzingMode();
      const target = (data: Buffer): void => {
        if (data.length > 0 && data[0] === 0x42) {
          throw new Error("first crash");
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "dedup-first",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000 },
        { stopOnCrash: true },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(1);
      expect(result.crashArtifactPaths.length).toBe(1);
      expect(result.duplicateCrashesSkipped).toBe(0);
    });

    it("duplicate crash is suppressed (not counted toward maxCrashes)", async () => {
      await setupFuzzingMode();
      let crashCount = 0;

      // Separate function so the stack trace is stable across invocations
      function throwCrash(): never {
        throw new Error("same bug");
      }

      const target = (data: Buffer): void => {
        // Always throw the same error from the same function — same dedup key
        if (data.length > 0 && data[0] === 0x42) {
          crashCount++;
          throwCrash();
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "dedup-suppress",
        "test.fuzz.ts",
        { runs: 5000 },
        { stopOnCrash: false, maxCrashes: 0 },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(1);
      // Multiple crashes found by fuzzer, but only 1 unique
      expect(crashCount).toBeGreaterThan(1);
      expect(result.duplicateCrashesSkipped).toBeGreaterThan(0);
      // Suppressed crashes don't count toward maxCrashes
      expect(result.crashArtifactPaths.length).toBe(1);
    });

    it("crash with unknown dedup key always saves (fail open)", async () => {
      await setupFuzzingMode();
      let _crashCount = 0;
      // Use different throw sites so each crash produces a unique dedup key,
      // but also use errors with no parseable stack to test fail-open behavior.
      const target = (data: Buffer): void => {
        if (data.length > 0 && data[0] === 0x42) {
          _crashCount++;
          const err = new Error("unparseable");
          err.stack = "no parseable frames here";
          throw err;
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "dedup-failopen",
        "test.fuzz.ts",
        { runs: 1_000_000, fuzzTimeMs: 30_000 },
        { stopOnCrash: false, maxCrashes: 3 },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(3);
      // All crashes saved — no dedup possible (stack is unparseable)
      expect(result.duplicateCrashesSkipped).toBe(0);
    });

    it("duplicate crashes are suppressed after minimization", async () => {
      await setupFuzzingMode();
      let _crashCount = 0;
      const target = (data: Buffer): void => {
        // Crash when first byte is 0x42 — same bug regardless of input size
        if (data.length > 0 && data[0] === 0x42) {
          _crashCount++;
          throwSameBug();
        }
      };

      function throwSameBug(): never {
        throw new Error("same bug for replacement");
      }

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "dedup-replace",
        "test.fuzz.ts",
        { runs: 5000 },
        { stopOnCrash: false, maxCrashes: 0 },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(1);
      expect(result.duplicateCrashesSkipped).toBeGreaterThan(0);
      // Only 1 unique crash saved
      expect(result.crashArtifactPaths.length).toBe(1);
      // The artifact should be the minimized version (1 byte)
      const artifactData = readFileSync(result.crashArtifactPaths[0]!);
      expect(artifactData.length).toBe(1);
      expect(artifactData[0]).toBe(0x42);
    });

    it("duplicateCrashesSkipped is 0 when no duplicates found", async () => {
      await setupFuzzingMode();
      const target = (_data: Buffer): void => {};

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "dedup-zero",
        "test.fuzz.ts",
        { runs: 50, grimoire: false, unicode: false },
        { stopOnCrash: false },
      );

      expect(result.crashed).toBe(false);
      expect(result.duplicateCrashesSkipped).toBe(0);
    });
  });

  describe("FuzzLoopResult fields", () => {
    it("includes crashCount and crashArtifactPaths on crash", async () => {
      await setupFuzzingMode();
      const target = (data: Buffer): void => {
        if (data.length > 0 && data[0] === 0x42) {
          throw new Error("found the bug!");
        }
      };

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "result-fields",
        "test.fuzz.ts",
        { runs: 1_000_000 },
      );

      expect(result.crashed).toBe(true);
      expect(result.crashCount).toBe(1);
      expect(result.crashArtifactPaths.length).toBe(1);
      expect(result.crashArtifactPath).toBe(result.crashArtifactPaths[0]);
    });

    it("includes crashCount=0 and empty crashArtifactPaths on no crash", async () => {
      await setupFuzzingMode();
      const target = (_data: Buffer): void => {};

      const result = await runFuzzLoop(
        target,
        tmpDir,
        "no-crash-fields",
        "test.fuzz.ts",
        { runs: 10, grimoire: false, unicode: false },
      );

      expect(result.crashed).toBe(false);
      expect(result.crashCount).toBe(0);
      expect(result.crashArtifactPaths).toEqual([]);
    });
  });

  describe("convention-based dictionary discovery", () => {
    it("libfuzzerCompat mode does not load convention-based dictionary", async () => {
      await setupFuzzingMode();
      delete process.env["VITIATE_CLI_IPC"];

      // Place a malformed .dict file at the convention path. If loaded, it
      // would cause a parse error. In libfuzzerCompat mode it must be ignored.
      const testName = "dict-compat-test";
      const dictDir = path.join(tmpDir, "testdata", "fuzz");
      mkdirSync(dictDir, { recursive: true });
      writeFileSync(
        path.join(dictDir, `${sanitizeTestName(testName)}.dict`),
        "not a valid line",
      );

      const target = (_data: Buffer): void => {};
      const result = await runFuzzLoop(
        target,
        tmpDir,
        testName,
        "test.fuzz.ts",
        { runs: 10, grimoire: false, unicode: false, redqueen: false },
        { libfuzzerCompat: true },
      );

      expect(result.crashed).toBe(false);
      expect(result.totalExecs).toBe(10);
    });

    it("vitest mode loads convention-based dictionary", async () => {
      await setupFuzzingMode();
      delete process.env["VITIATE_CLI_IPC"];

      // Same malformed .dict file. In Vitest mode (no libfuzzerCompat),
      // convention-based discovery should find it and fail to parse.
      const testName = "dict-vitest-test";
      const dictDir = path.join(tmpDir, "testdata", "fuzz");
      mkdirSync(dictDir, { recursive: true });
      writeFileSync(
        path.join(dictDir, `${sanitizeTestName(testName)}.dict`),
        "not a valid line",
      );

      const target = (_data: Buffer): void => {};
      await expect(
        runFuzzLoop(target, tmpDir, testName, "test.fuzz.ts", {
          runs: 10,
          grimoire: false,
          unicode: false,
          redqueen: false,
        }),
      ).rejects.toThrow("Failed to load dictionary file");
    });
  });
}, 60000);

describe("checkDedupPolicy", () => {
  it("returns save when dedupKey is undefined (fail-open)", () => {
    const map = new Map<string, { path: string; size: number }>();
    expect(checkDedupPolicy(undefined, 100, map)).toEqual({ action: "save" });
  });

  it("returns save when dedupKey is not in the map (new crash)", () => {
    const map = new Map<string, { path: string; size: number }>();
    expect(checkDedupPolicy("key-abc", 100, map)).toEqual({ action: "save" });
  });

  it("returns suppress when input is same size as existing", () => {
    const map = new Map([["key-abc", { path: "/tmp/crash-abc", size: 100 }]]);
    expect(checkDedupPolicy("key-abc", 100, map)).toEqual({
      action: "suppress",
    });
  });

  it("returns suppress when input is larger than existing", () => {
    const map = new Map([["key-abc", { path: "/tmp/crash-abc", size: 50 }]]);
    expect(checkDedupPolicy("key-abc", 100, map)).toEqual({
      action: "suppress",
    });
  });

  it("returns replace with dedupKey and existing when input is smaller", () => {
    const existing = { path: "/tmp/crash-abc", size: 100 };
    const map = new Map([["key-abc", existing]]);
    expect(checkDedupPolicy("key-abc", 50, map)).toEqual({
      action: "replace",
      dedupKey: "key-abc",
      existing,
    });
  });

  it("returns replace when input is 1 byte smaller", () => {
    const existing = { path: "/tmp/crash-abc", size: 10 };
    const map = new Map([["key-abc", existing]]);
    expect(checkDedupPolicy("key-abc", 9, map)).toEqual({
      action: "replace",
      dedupKey: "key-abc",
      existing,
    });
  });
});
