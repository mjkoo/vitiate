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
import { sanitizeTestName } from "./corpus.js";

describe("fuzz loop", () => {
  let tmpDir: string;
  const originalFuzz = process.env["VITIATE_FUZZ"];
  const originalCacheDir = process.env["VITIATE_CACHE_DIR"];
  const originalDictPath = process.env["VITIATE_DICTIONARY_PATH"];
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
    if (originalDictPath === undefined) {
      delete process.env["VITIATE_DICTIONARY_PATH"];
    } else {
      process.env["VITIATE_DICTIONARY_PATH"] = originalDictPath;
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

  describe("convention-based dictionary discovery", () => {
    it("libfuzzerCompat mode does not load convention-based dictionary", async () => {
      await setupFuzzingMode();
      delete process.env["VITIATE_DICTIONARY_PATH"];

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
      delete process.env["VITIATE_DICTIONARY_PATH"];

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
