/**
 * Unit tests for the __vitiate_cmplog_write function.
 *
 * Uses the real `createCmplogWriteFunctions` factory from globals.ts with
 * plain ArrayBuffer-backed memory, so no NAPI addon is required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createCmplogWriteFunctions,
  SLOT_SIZE,
  SLOT_BUFFER_SIZE,
  MAX_SLOTS,
  MAX_ENTRIES_PER_SITE,
  SITE_COUNT_SLOTS,
  type CmplogWriteFunctions,
} from "./globals.js";

/** Disabled sentinel (matches Rust WRITE_PTR_DISABLED). */
const WRITE_PTR_DISABLED = 0xffffffff;

interface TestContext {
  slotBuffer: Uint8Array;
  view: DataView;
  wptr: Uint32Array;
  fns: CmplogWriteFunctions;
}

function createTestContext(): TestContext {
  const slotArrayBuffer = new ArrayBuffer(SLOT_BUFFER_SIZE);
  const writePointerArrayBuffer = new ArrayBuffer(4);

  const slotBuffer = new Uint8Array(slotArrayBuffer);
  const writePointerBuffer = new Uint8Array(writePointerArrayBuffer);

  // Start enabled (write pointer = 0)
  new Uint32Array(writePointerArrayBuffer)[0] = 0;

  const fns = createCmplogWriteFunctions(slotBuffer, writePointerBuffer);

  const view = new DataView(slotArrayBuffer);
  const wptr = new Uint32Array(writePointerArrayBuffer);

  return { slotBuffer, view, wptr, fns };
}

describe("__vitiate_cmplog_write", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe("numeric operands", () => {
    it("serializes integer comparison to slot buffer", () => {
      ctx.fns.write(42, 100, 5, 0);

      expect(ctx.wptr[0]).toBe(1);
      // cmpId at offset 0
      expect(ctx.view.getUint32(0, true)).toBe(5);
      // operatorId at offset 4
      expect(ctx.slotBuffer[4]).toBe(0);
      // leftType = 1 (f64)
      expect(ctx.slotBuffer[5]).toBe(1);
      // rightType = 1 (f64)
      expect(ctx.slotBuffer[6]).toBe(1);
      // leftF64 at offset 8
      expect(ctx.view.getFloat64(8, true)).toBe(42);
      // rightF64 at offset 41
      expect(ctx.view.getFloat64(41, true)).toBe(100);
    });

    it("serializes float comparison", () => {
      ctx.fns.write(3.14, 2.71, 10, 4);

      expect(ctx.wptr[0]).toBe(1);
      expect(ctx.view.getFloat64(8, true)).toBeCloseTo(3.14);
      expect(ctx.view.getFloat64(41, true)).toBeCloseTo(2.71);
    });
  });

  describe("string operands", () => {
    it("serializes string comparison to slot buffer", () => {
      ctx.fns.write("hello", "world", 10, 0);

      expect(ctx.wptr[0]).toBe(1);
      expect(ctx.view.getUint32(0, true)).toBe(10);
      expect(ctx.slotBuffer[5]).toBe(2); // leftType = string
      expect(ctx.slotBuffer[6]).toBe(2); // rightType = string
      expect(ctx.slotBuffer[7]).toBe(5); // leftLen = 5
      expect(ctx.slotBuffer[40]).toBe(5); // rightLen = 5
      // Check UTF-8 bytes
      expect(Buffer.from(ctx.slotBuffer.slice(8, 13)).toString()).toBe("hello");
      expect(Buffer.from(ctx.slotBuffer.slice(41, 46)).toString()).toBe(
        "world",
      );
    });

    it("truncates strings longer than 32 bytes", () => {
      const long = "a".repeat(50);
      ctx.fns.write(long, "b", 0, 0);

      expect(ctx.wptr[0]).toBe(1);
      // leftLen should be 32 (truncated)
      expect(ctx.slotBuffer[7]).toBe(32);
      // rightLen should be 1
      expect(ctx.slotBuffer[40]).toBe(1);
    });

    it("handles multi-byte UTF-8 without splitting characters", () => {
      // Each emoji is 4 bytes. 8 emojis = 32 bytes exactly.
      // 9 emojis = 36 bytes, should truncate to 32 (8 complete emojis).
      const nineEmojis = "\u{1F600}".repeat(9);
      ctx.fns.write(nineEmojis, "x", 0, 0);

      expect(ctx.wptr[0]).toBe(1);
      // TextEncoder.encodeInto won't split a multi-byte char, so len <= 32
      expect(ctx.slotBuffer[7]).toBeLessThanOrEqual(32);
      // Should be exactly 32 (8 complete 4-byte emojis)
      expect(ctx.slotBuffer[7]).toBe(32);
    });
  });

  describe("unsupported types", () => {
    it("returns early for null left operand", () => {
      ctx.fns.write(null, "world", 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for undefined left operand", () => {
      ctx.fns.write(undefined, 42, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for boolean left operand", () => {
      ctx.fns.write(true, 42, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for Symbol left operand", () => {
      ctx.fns.write(Symbol(), 42, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for BigInt left operand", () => {
      ctx.fns.write(1n, 2n, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for null right operand", () => {
      ctx.fns.write(42, null, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for undefined right operand", () => {
      ctx.fns.write(42, undefined, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for boolean right operand", () => {
      ctx.fns.write(42, false, 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("returns early for Symbol right operand", () => {
      ctx.fns.write(42, Symbol(), 10, 0);
      expect(ctx.wptr[0]).toBe(0);
    });

    it("does not increment per-site count on unsupported type", () => {
      ctx.fns.write(null, "world", 10, 0);
      // Site should still have full budget
      for (let i = 0; i < MAX_ENTRIES_PER_SITE; i++) {
        ctx.fns.write(i, i + 1, 10, 0);
      }
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE);
    });
  });

  describe("buffer-full behavior", () => {
    it("silently drops when buffer is full", () => {
      ctx.wptr[0] = MAX_SLOTS;
      ctx.fns.write(42, 100, 5, 0);
      expect(ctx.wptr[0]).toBe(MAX_SLOTS);
    });
  });

  describe("disabled sentinel", () => {
    it("silently drops when disabled", () => {
      ctx.wptr[0] = WRITE_PTR_DISABLED;
      ctx.fns.write(42, 100, 5, 0);
      expect(ctx.wptr[0]).toBe(WRITE_PTR_DISABLED);
    });
  });

  describe("per-site cap", () => {
    it("allows up to MAX_ENTRIES_PER_SITE entries per site", () => {
      for (let i = 0; i < MAX_ENTRIES_PER_SITE; i++) {
        ctx.fns.write(i, i + 1, 42, 0);
      }
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE);
    });

    it("drops the 9th entry at the same site", () => {
      for (let i = 0; i < MAX_ENTRIES_PER_SITE; i++) {
        ctx.fns.write(i, i + 1, 42, 0);
      }
      // 9th entry should be dropped
      ctx.fns.write(99, 100, 42, 0);
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE);
    });

    it("different sites have independent budgets", () => {
      // Fill site 42 to cap
      for (let i = 0; i < MAX_ENTRIES_PER_SITE; i++) {
        ctx.fns.write(i, i + 1, 42, 0);
      }
      // Site 43 should still accept entries
      ctx.fns.write(1, 2, 43, 0);
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE + 1);
    });

    it("colliding sites share a budget", () => {
      // Sites 1 and 513 collide: 1 & 511 == 513 & 511 == 1
      for (let i = 0; i < 5; i++) {
        ctx.fns.write(i, i + 1, 1, 0);
      }
      for (let i = 0; i < 3; i++) {
        ctx.fns.write(i, i + 1, 513, 0);
      }
      // Total = 8 = cap, next should be dropped
      ctx.fns.write(99, 100, 1, 0);
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE);
    });
  });

  describe("count reset", () => {
    it("resets all per-site counts", () => {
      for (let i = 0; i < MAX_ENTRIES_PER_SITE; i++) {
        ctx.fns.write(i, i + 1, 42, 0);
      }
      // Site 42 is capped
      ctx.fns.write(99, 100, 42, 0);
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE);

      ctx.fns.resetCounts();
      // After reset, site 42 should accept entries again
      ctx.fns.write(1, 2, 42, 0);
      expect(ctx.wptr[0]).toBe(MAX_ENTRIES_PER_SITE + 1);
    });
  });

  describe("constants", () => {
    it("SLOT_SIZE is 80", () => {
      expect(SLOT_SIZE).toBe(80);
    });

    it("MAX_SLOTS matches buffer size / slot size", () => {
      expect(MAX_SLOTS).toBe(Math.floor(SLOT_BUFFER_SIZE / SLOT_SIZE));
    });

    it("SITE_COUNT_SLOTS is a power of two", () => {
      expect(SITE_COUNT_SLOTS & (SITE_COUNT_SLOTS - 1)).toBe(0);
    });
  });
});
