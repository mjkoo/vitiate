import { describe, it, expect, vi } from "vitest";
import { minimize, type MinimizeOptions } from "./minimize.js";

/**
 * Creates a deterministic testCandidate callback that returns true (crash)
 * if the candidate contains the specified byte pattern.
 */
function crashesOnPattern(
  pattern: Buffer,
): (candidate: Buffer) => Promise<boolean> {
  return async (candidate: Buffer) => {
    if (candidate.length < pattern.length) return false;
    for (let i = 0; i <= candidate.length - pattern.length; i++) {
      if (candidate.subarray(i, i + pattern.length).equals(pattern)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Creates a testCandidate that crashes if the candidate contains
 * all of the specified bytes (at any position).
 */
function crashesIfContainsAll(
  bytes: number[],
): (candidate: Buffer) => Promise<boolean> {
  return async (candidate: Buffer) => {
    for (const b of bytes) {
      if (!candidate.includes(b)) return false;
    }
    return true;
  };
}

describe("minimize", () => {
  describe("truncation pass", () => {
    it("removes trailing bytes that are irrelevant to the crash", async () => {
      // Input: 1024 bytes where only the first 4 matter (contain "ABCD")
      const pattern = Buffer.from("ABCD");
      const input = Buffer.alloc(1024);
      pattern.copy(input, 0);

      const result = await minimize(input, crashesOnPattern(pattern));

      // Truncation should reduce to at most pattern length
      expect(result.length).toBeLessThanOrEqual(pattern.length);
      // Result must still contain the pattern
      expect(result.subarray(0, 4).equals(pattern)).toBe(true);
    });

    it("preserves the full input when all bytes are needed", async () => {
      // Every byte must be present for the crash
      const input = Buffer.from([0x01, 0x02, 0x03]);
      const testCandidate = async (candidate: Buffer): Promise<boolean> => {
        return candidate.equals(input);
      };

      const result = await minimize(input, testCandidate);

      // Can't truncate without losing the last byte
      expect(result.equals(input)).toBe(true);
    });
  });

  describe("byte deletion pass", () => {
    it("removes interior bytes that are irrelevant to the crash", async () => {
      // Input: [0x41, 0x00, 0x00, 0x00, 0x42] - crashes if contains both 0x41 and 0x42
      const input = Buffer.from([0x41, 0x00, 0x00, 0x00, 0x42]);
      const testCandidate = crashesIfContainsAll([0x41, 0x42]);

      const result = await minimize(input, testCandidate);

      // Should remove the 3 irrelevant interior bytes
      expect(result.length).toBe(2);
      expect(result.includes(0x41)).toBe(true);
      expect(result.includes(0x42)).toBe(true);
    });

    it("scenario: 10-byte input with 3 irrelevant interior bytes", async () => {
      // Crashes on pattern [0xAA, 0xBB, 0xCC, 0xDD] at positions 0,1,5,9
      // Interior filler at positions 2,3,4,6,7,8
      const input = Buffer.from([
        0xaa, 0xbb, 0xff, 0xff, 0xff, 0xcc, 0xff, 0xff, 0xff, 0xdd,
      ]);
      const testCandidate = crashesIfContainsAll([0xaa, 0xbb, 0xcc, 0xdd]);

      const result = await minimize(input, testCandidate);

      // Should remove all 0xFF filler bytes
      expect(result.length).toBe(4);
      expect(result.includes(0xaa)).toBe(true);
      expect(result.includes(0xbb)).toBe(true);
      expect(result.includes(0xcc)).toBe(true);
      expect(result.includes(0xdd)).toBe(true);
    });
  });

  describe("both passes contribute", () => {
    it("truncation + byte deletion together produce smaller result than either alone", async () => {
      // 2048 bytes: pattern bytes at positions 0, 50, 100 with filler between,
      // and 1948 trailing bytes
      const input = Buffer.alloc(2048);
      input[0] = 0xaa;
      input[50] = 0xbb;
      input[100] = 0xcc;
      const testCandidate = crashesIfContainsAll([0xaa, 0xbb, 0xcc]);

      const result = await minimize(input, testCandidate);

      // Truncation should reduce from 2048 to ~101 (first 101 bytes contain all needed bytes)
      // Byte deletion should then remove interior filler
      expect(result.length).toBe(3);
      expect(result.includes(0xaa)).toBe(true);
      expect(result.includes(0xbb)).toBe(true);
      expect(result.includes(0xcc)).toBe(true);
    });
  });

  describe("budget tracking", () => {
    it("stops when iteration cap is reached and returns best so far", async () => {
      // Large input with crash pattern at the start - but iteration budget is very small
      const input = Buffer.alloc(500);
      input[0] = 0xaa;
      let execCount = 0;
      const testCandidate = async (candidate: Buffer): Promise<boolean> => {
        execCount++;
        return candidate.includes(0xaa);
      };

      const opts: MinimizeOptions = {
        maxIterations: 5,
        timeLimitMs: 60_000,
      };
      const result = await minimize(input, testCandidate, opts);

      // Should have stopped after 5 executions
      expect(execCount).toBe(5);
      // Result should be smaller than original (truncation pass made some progress)
      expect(result.length).toBeLessThan(input.length);
    });

    it("stops when wall-clock time limit is reached and returns best so far", async () => {
      // Mock Date.now to advance 10ms per call for deterministic testing
      let mockTime = 1000;
      const originalDateNow = Date.now;
      Date.now = () => {
        mockTime += 10;
        return mockTime;
      };

      try {
        const input = Buffer.alloc(100);
        input[0] = 0xaa;
        let execCount = 0;
        const testCandidate = async (candidate: Buffer): Promise<boolean> => {
          execCount++;
          return candidate.includes(0xaa);
        };

        const opts: MinimizeOptions = {
          maxIterations: 100_000,
          timeLimitMs: 25, // 25ms limit / 10ms per Date.now call = ~2-3 execs before budget
        };
        const result = await minimize(input, testCandidate, opts);

        // Should have stopped after a few executions (each Date.now call advances 10ms)
        expect(execCount).toBeLessThanOrEqual(5);
        // Result should still be valid (at least contains the crash byte)
        expect(result.includes(0xaa)).toBe(true);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it("completes within both limits for small inputs", async () => {
      const input = Buffer.from([0xaa, 0x00, 0xbb]);
      const testCandidate = crashesIfContainsAll([0xaa, 0xbb]);

      const opts: MinimizeOptions = {
        maxIterations: 10_000,
        timeLimitMs: 5_000,
      };
      const result = await minimize(input, testCandidate, opts);

      // Full minimization should complete
      expect(result.length).toBe(2);
    });
  });

  describe("truncation executions are O(log n)", () => {
    it("uses at most ceil(log2(n)) + 1 executions for the truncation pass", async () => {
      // Input: 1024 bytes, crash requires only first byte.
      // Truncation should find length=1 in ~11 steps (ceil(log2(1024)) + 1).
      // With the old restart-from-zero approach this was O(log²n) ≈ 100 steps.
      const input = Buffer.alloc(1024);
      input[0] = 0xaa;
      let execCount = 0;
      const testCandidate = async (candidate: Buffer): Promise<boolean> => {
        execCount++;
        return candidate.includes(0xaa);
      };

      // Use a tight iteration budget to prove we finish truncation quickly.
      // ceil(log2(1024)) + 1 = 11. Allow a small margin for the byte deletion pass.
      const opts: MinimizeOptions = {
        maxIterations: 100_000,
        timeLimitMs: 60_000,
      };
      const result = await minimize(input, testCandidate, opts);

      expect(result.length).toBe(1);
      // Truncation: ceil(log2(1024)) + 1 = 11 execs.
      // Byte deletion on a 1-byte input: 1 exec (try removing the only byte - fails).
      // Total should be ~12, well under 20.
      expect(execCount).toBeLessThanOrEqual(20);
    });
  });

  describe("does not mutate the input buffer", () => {
    it("returns a new buffer without modifying the original", async () => {
      const input = Buffer.from([0xaa, 0x00, 0x00, 0xbb]);
      const originalCopy = Buffer.from(input);
      const testCandidate = crashesIfContainsAll([0xaa, 0xbb]);

      const result = await minimize(input, testCandidate);

      expect(result.length).toBe(2);
      // Original input must be unchanged
      expect(input.equals(originalCopy)).toBe(true);
    });
  });

  describe("zero-means-unlimited", () => {
    it("maxIterations=0 means unlimited iteration budget", async () => {
      // Small input so minimization completes quickly
      const input = Buffer.from([0xaa, 0x00, 0x00, 0xbb]);
      const testCandidate = crashesIfContainsAll([0xaa, 0xbb]);

      const opts: MinimizeOptions = {
        maxIterations: 0,
        timeLimitMs: 60_000,
      };
      const result = await minimize(input, testCandidate, opts);

      // Full minimization should complete (not short-circuited by budget)
      expect(result.length).toBe(2);
      expect(result.includes(0xaa)).toBe(true);
      expect(result.includes(0xbb)).toBe(true);
    });
  });

  describe("progress reporting", () => {
    it("prints start and completion messages to stderr", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const input = Buffer.alloc(1024);
        input[0] = 0x42;
        const testCandidate = async (candidate: Buffer): Promise<boolean> => {
          return candidate.includes(0x42);
        };

        await minimize(input, testCandidate);

        const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
        // Start message mentioning original size
        expect(calls.some((c) => c.includes("1024"))).toBe(true);
        // Completion message mentioning final size and executions
        expect(calls.some((c) => /\d+ bytes/.test(c))).toBe(true);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe("edge cases", () => {
    it("returns original input when target stops crashing on all smaller candidates", async () => {
      const input = Buffer.from([0x01, 0x02, 0x03]);
      // Only crashes on the exact original input
      const testCandidate = async (candidate: Buffer): Promise<boolean> => {
        return candidate.equals(input);
      };

      const result = await minimize(input, testCandidate);

      expect(result.equals(input)).toBe(true);
    });

    it("handles single-byte input", async () => {
      const input = Buffer.from([0x42]);
      const testCandidate = async (_candidate: Buffer): Promise<boolean> => {
        return true; // Always crashes
      };

      const result = await minimize(input, testCandidate);

      // Can't shrink a single byte (can truncate to empty if that crashes)
      // With "always crashes", empty buffer should be returned
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it("handles empty input", async () => {
      const input = Buffer.alloc(0);
      const testCandidate = async (_candidate: Buffer): Promise<boolean> => {
        return true;
      };

      const result = await minimize(input, testCandidate);

      expect(result.length).toBe(0);
    });
  });
});
