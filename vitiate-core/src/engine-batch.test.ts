import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Fuzzer, Watchdog, ShmemHandle, ExitKind } from "@vitiate/engine";
import type { FuzzerConfig } from "@vitiate/engine";

describe("engine batch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      tmpdir(),
      `vitiate-batch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Create a Fuzzer with a seed that produces coverage at index 0.
   * After this call, the fuzzer's corpus has one entry and coverage
   * history knows about edge 0. Subsequent callbacks writing only
   * cov[0] = 1 will not trigger "interesting".
   */
  function createFuzzerWithCorpus(
    coverageMap: Buffer,
    config?: Partial<FuzzerConfig>,
    watchdog?: Watchdog | null,
    shmemHandle?: ShmemHandle | null,
  ): Fuzzer {
    const fullConfig: FuzzerConfig = {
      seed: 42,
      grimoire: false,
      unicode: false,
      redqueen: false,
      ...config,
    };
    const fuzzer = new Fuzzer(
      coverageMap,
      fullConfig,
      watchdog ?? null,
      shmemHandle ?? null,
    );
    fuzzer.addSeed(Buffer.from("test"));

    // Evaluate seed to establish corpus with coverage at index 0.
    fuzzer.getNextInput();
    coverageMap[0] = 1;
    fuzzer.reportResult(ExitKind.Ok, 50_000);

    return fuzzer;
  }

  // ── 5.1: runBatch basic tests ───────────────────────────────────────

  describe("runBatch", () => {
    it("batch completes fully when no iterations produce novel coverage", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          cov[0] = 1; // Same coverage as seed, not novel
          return 0;
        },
        32,
        0,
      );

      expect(result.exitReason).toBe("completed");
      expect(result.executionsCompleted).toBe(32);
      expect(result.triggeringInput).toBeUndefined();
      expect(result.solutionExitKind).toBeUndefined();
    });

    it("exits early on interesting input (new coverage)", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      let callCount = 0;
      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          callCount++;
          cov[0] = 1;
          if (callCount === 3) {
            cov[1] = 1; // New edge - triggers interesting
          }
          return 0;
        },
        64,
        0,
      );

      expect(result.exitReason).toBe("interesting");
      expect(result.executionsCompleted).toBe(3);
      expect(result.triggeringInput).toBeDefined();
      expect(result.triggeringInput).toBeInstanceOf(Buffer);
      expect(result.solutionExitKind).toBeUndefined();
    });

    it("exits early on solution (crash)", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      let callCount = 0;
      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          callCount++;
          cov[0] = 1;
          if (callCount === 2) {
            return 1; // ExitKind.Crash
          }
          return 0;
        },
        64,
        0,
      );

      expect(result.exitReason).toBe("solution");
      expect(result.executionsCompleted).toBe(2);
      expect(result.triggeringInput).toBeDefined();
      expect(result.solutionExitKind).toBe(1); // Crash
    });

    it("exits early on callback error (thrown exception)", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      let callCount = 0;
      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          callCount++;
          cov[0] = 1;
          if (callCount === 2) {
            throw new Error("infrastructure error!");
          }
          return 0;
        },
        64,
        0,
      );

      expect(result.exitReason).toBe("error");
      expect(result.executionsCompleted).toBe(2);
      expect(result.triggeringInput).toBeDefined();
    });

    it("returns immediately for empty batch size", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      const result = fuzzer.runBatch(
        () => {
          throw new Error("should not be called");
        },
        0,
        0,
      );

      expect(result.exitReason).toBe("completed");
      expect(result.executionsCompleted).toBe(0);
      expect(result.triggeringInput).toBeUndefined();
    });

    it("treats invalid callback return value as Ok", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          cov[0] = 1;
          return 5; // Invalid ExitKind, treated as Ok
        },
        16,
        0,
      );

      expect(result.exitReason).toBe("completed");
      expect(result.executionsCompleted).toBe(16);
    });
  });

  // ── 5.2: runBatch with watchdog ─────────────────────────────────────

  describe("runBatch with watchdog", () => {
    it("timeout during callback triggers early exit with solution exitKind=2", () => {
      const cov = Buffer.alloc(1024);
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const fuzzer = createFuzzerWithCorpus(cov, {}, watchdog);

      try {
        // Busy loop is the canonical test pattern for V8's TerminateExecution.
        // The loop is pure JS with no I/O or microtask yields, so V8's interrupt
        // mechanism fires deterministically. The timeout is generous (500ms) to
        // avoid CI flakiness while still testing the watchdog path.
        const result = fuzzer.runBatch(
          (_buf: Buffer, _len: number) => {
            cov[0] = 1;
            for (;;) {
              /* intentionally empty */
            }
          },
          32,
          500, // 500ms timeout - generous for CI headroom
        );

        expect(result.exitReason).toBe("solution");
        expect(result.solutionExitKind).toBe(2); // Timeout
        expect(result.triggeringInput).toBeDefined();
        expect(result.executionsCompleted).toBe(1);
      } finally {
        fuzzer.shutdown();
      }
    });

    it("runs normally without watchdog (no-op)", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          cov[0] = 1;
          return 0;
        },
        16,
        0,
      );

      expect(result.exitReason).toBe("completed");
      expect(result.executionsCompleted).toBe(16);
    });
  });

  // ── 5.3: runBatch with shmem ────────────────────────────────────────

  describe("runBatch with shmem", () => {
    const originalShmemEnv = process.env["VITIATE_SHMEM"];

    afterEach(() => {
      if (originalShmemEnv === undefined) {
        delete process.env["VITIATE_SHMEM"];
      } else {
        process.env["VITIATE_SHMEM"] = originalShmemEnv;
      }
    });

    it("input stashed before each callback", () => {
      const shmemHandle = ShmemHandle.allocate(4096);
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov, {}, null, shmemHandle);

      let stashedContent: Buffer | null = null;
      let callbackContent: Buffer | null = null;
      fuzzer.runBatch(
        (buf: Buffer, len: number) => {
          cov[0] = 1;
          // Capture callback input and stashed input for comparison
          callbackContent = Buffer.from(buf.subarray(0, len));
          stashedContent = shmemHandle.readStashedInput();
          return 0;
        },
        1,
        0,
      );

      // Verify that stashed bytes match the callback input
      expect(stashedContent).not.toBeNull();
      expect(callbackContent).not.toBeNull();
      expect(stashedContent!.length).toBeGreaterThan(0);
      expect(Buffer.compare(stashedContent!, callbackContent!)).toBe(0);
    });

    it("runs normally without shmem handle (no-op)", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          cov[0] = 1;
          return 0;
        },
        16,
        0,
      );

      expect(result.exitReason).toBe("completed");
      expect(result.executionsCompleted).toBe(16);
    });
  });

  // ── 5.4: Pre-allocated buffer ───────────────────────────────────────

  describe("pre-allocated buffer", () => {
    it("same Buffer object passed to every callback invocation", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const bufferRefs: Buffer[] = [];
      fuzzer.runBatch(
        (buf: Buffer, _len: number) => {
          cov[0] = 1;
          bufferRefs.push(buf);
          return 0;
        },
        5,
        0,
      );

      expect(bufferRefs.length).toBe(5);
      // All callbacks receive the same Buffer object (zero per-iteration allocation)
      for (let i = 1; i < bufferRefs.length; i++) {
        expect(bufferRefs[i]).toBe(bufferRefs[0]);
      }
    });

    it("triggeringInput is an independent copy, not the pre-allocated buffer", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      let callbackBuffer: Buffer | null = null;
      let callCount = 0;
      const result = fuzzer.runBatch(
        (buf: Buffer, _len: number) => {
          callCount++;
          cov[0] = 1;
          if (callCount === 2) {
            callbackBuffer = buf;
            cov[1] = 1; // Trigger interesting
          }
          return 0;
        },
        64,
        0,
      );

      expect(result.exitReason).toBe("interesting");
      expect(result.triggeringInput).toBeDefined();
      // triggeringInput must be a different Buffer object than the pre-allocated one
      expect(result.triggeringInput).not.toBe(callbackBuffer);
      // Verify the copy has content
      expect(result.triggeringInput!.length).toBeGreaterThan(0);
    });
  });

  // ── 5.5: stashInput pass-through ────────────────────────────────────

  describe("stashInput pass-through", () => {
    const originalShmemEnv = process.env["VITIATE_SHMEM"];

    afterEach(() => {
      if (originalShmemEnv === undefined) {
        delete process.env["VITIATE_SHMEM"];
      } else {
        process.env["VITIATE_SHMEM"] = originalShmemEnv;
      }
    });

    it("delegates to owned shmem handle", () => {
      const shmemHandle = ShmemHandle.allocate(4096);
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, shmemHandle);

      const testInput = Buffer.from("hello world");
      fuzzer.stashInput(testInput);

      const stashed = shmemHandle.readStashedInput();
      expect(stashed.toString()).toBe("hello world");
    });

    it("is a no-op without shmem handle", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      // Should not throw
      fuzzer.stashInput(Buffer.from("hello"));
    });
  });

  // ── 5.6: runTarget pass-through ─────────────────────────────────────

  describe("runTarget pass-through", () => {
    it("delegates to owned watchdog and returns Ok for normal execution", () => {
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, watchdog, null);

      try {
        let called = false;
        const result = fuzzer.runTarget(
          (_data: Buffer) => {
            called = true;
          },
          Buffer.from("test"),
          1000,
        );

        expect(called).toBe(true);
        expect(result.exitKind).toBe(ExitKind.Ok);
      } finally {
        fuzzer.shutdown();
      }
    });

    it("calls target directly without watchdog", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      let called = false;
      const result = fuzzer.runTarget(
        (_data: Buffer) => {
          called = true;
        },
        Buffer.from("test"),
        0,
      );

      expect(called).toBe(true);
      expect(result.exitKind).toBe(ExitKind.Ok);
    });

    it("handles watchdog timeout", () => {
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, watchdog, null);

      try {
        const result = fuzzer.runTarget(
          (_data: Buffer) => {
            for (;;) {
              /* intentionally empty */
            }
          },
          Buffer.from("test"),
          100, // 100ms timeout
        );

        expect(result.exitKind).toBe(ExitKind.Timeout);
      } finally {
        fuzzer.shutdown();
      }
    });

    it("handles target exception", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      const result = fuzzer.runTarget(
        (_data: Buffer) => {
          throw new Error("target crashed!");
        },
        Buffer.from("test"),
        0,
      );

      expect(result.exitKind).toBe(ExitKind.Crash);
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("target crashed!");
    });
  });

  // ── 5.7: armWatchdog/disarmWatchdog ─────────────────────────────────

  describe("armWatchdog/disarmWatchdog", () => {
    it("delegates to owned watchdog without error", () => {
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, watchdog, null);

      try {
        // Should not throw
        fuzzer.armWatchdog(1000);
        fuzzer.disarmWatchdog();
      } finally {
        fuzzer.shutdown();
      }
    });

    it("is a no-op without watchdog", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      // Should not throw
      fuzzer.armWatchdog(1000);
      fuzzer.disarmWatchdog();
    });
  });

  // ── 5.8: shutdown ───────────────────────────────────────────────────

  describe("shutdown", () => {
    it("shuts down owned watchdog thread", () => {
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, watchdog, null);

      // Should not throw
      fuzzer.shutdown();
      // Calling shutdown again should be a no-op
      fuzzer.shutdown();
    });

    it("is a no-op without watchdog", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = new Fuzzer(cov, { seed: 42 }, null, null);

      // Should not throw
      fuzzer.shutdown();
    });
  });

  // ── 5.9: constructor ────────────────────────────────────────────────

  describe("constructor", () => {
    const originalShmemEnv = process.env["VITIATE_SHMEM"];

    afterEach(() => {
      if (originalShmemEnv === undefined) {
        delete process.env["VITIATE_SHMEM"];
      } else {
        process.env["VITIATE_SHMEM"] = originalShmemEnv;
      }
    });

    it("accepts Watchdog and ShmemHandle", () => {
      const shmemHandle = ShmemHandle.allocate(4096);
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);

      const fuzzer = new Fuzzer(cov, { seed: 42 }, watchdog, shmemHandle);

      // Verify both features work
      fuzzer.stashInput(Buffer.from("test"));
      const stashed = shmemHandle.readStashedInput();
      expect(stashed.toString()).toBe("test");

      fuzzer.shutdown();
    });

    it("pre-allocates buffer of maxInputLen bytes", () => {
      const cov = Buffer.alloc(1024);
      const maxInputLen = 8192;
      const fuzzer = createFuzzerWithCorpus(cov, { maxInputLen });

      let bufferSize = 0;
      fuzzer.runBatch(
        (buf: Buffer, _len: number) => {
          cov[0] = 1;
          bufferSize = buf.length;
          return 0;
        },
        1,
        0,
      );

      expect(bufferSize).toBe(maxInputLen);
    });

    it("defaults pre-allocated buffer to 4096 bytes", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      let bufferSize = 0;
      fuzzer.runBatch(
        (buf: Buffer, _len: number) => {
          cov[0] = 1;
          bufferSize = buf.length;
          return 0;
        },
        1,
        0,
      );

      expect(bufferSize).toBe(4096);
    });
  });

  // ── 5.13: solutionExitKind ──────────────────────────────────────────

  describe("solutionExitKind", () => {
    it("crash solution has exitKind=1", () => {
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov);

      const result = fuzzer.runBatch(
        (_buf: Buffer, _len: number) => {
          cov[0] = 1;
          return 1; // ExitKind.Crash
        },
        1,
        0,
      );

      expect(result.exitReason).toBe("solution");
      expect(result.solutionExitKind).toBe(1);
    });

    it("timeout solution has exitKind=2", () => {
      const watchdog = new Watchdog(path.join(tmpDir, "timeout-"), null);
      const cov = Buffer.alloc(1024);
      const fuzzer = createFuzzerWithCorpus(cov, {}, watchdog);

      try {
        const result = fuzzer.runBatch(
          (_buf: Buffer, _len: number) => {
            cov[0] = 1;
            for (;;) {
              /* intentionally empty */
            }
          },
          1,
          100, // 100ms timeout
        );

        expect(result.exitReason).toBe("solution");
        expect(result.solutionExitKind).toBe(2);
      } finally {
        fuzzer.shutdown();
      }
    });
  });
});
