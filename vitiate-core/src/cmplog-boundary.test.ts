/**
 * Cross-language CmpLog boundary test.
 *
 * Drives the real JS slot writer (`createCmplogWriteFunctions` from
 * globals.ts) over the real Rust-owned shared buffers from the napi addon,
 * then asserts what Rust actually decoded via `cmplogDrainTestEntries()`.
 * This is the single place where both sides of the 80-byte slot-layout and
 * op-ID contract meet: a drift in offsets, endianness, type tags, or the
 * op-ID table on either side fails here even though each side's own unit
 * tests (cmplog-write.test.ts, cmplog.rs tests) would still pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Fuzzer,
  createCoverageMap,
  cmplogGetSlotBuffer,
  cmplogGetWritePointer,
  cmplogDrainTestEntries,
  cmplogSlotSize,
  cmplogWritePtrDisabled,
} from "@vitiate/engine";
import {
  createCmplogWriteFunctions,
  SLOT_SIZE,
  SLOT_BUFFER_SIZE,
  MAX_SLOTS,
  WRITE_PTR_DISABLED,
  type CmplogWriteFunctions,
} from "./globals.js";

describe("cmplog cross-language boundary", () => {
  describe("constants", () => {
    it("globals.ts constants equal the engine's", () => {
      expect(SLOT_SIZE).toBe(cmplogSlotSize());
      expect(SLOT_BUFFER_SIZE).toBe(cmplogGetSlotBuffer().length);
      expect(MAX_SLOTS).toBe((SLOT_BUFFER_SIZE / SLOT_SIZE) | 0);
      expect(WRITE_PTR_DISABLED).toBe(cmplogWritePtrDisabled());
      expect(cmplogGetWritePointer().length).toBe(4);
    });
  });

  describe("slot round-trip through the real buffers", () => {
    let fuzzer: Fuzzer;
    let fns: CmplogWriteFunctions;
    let wptr: Uint32Array;

    beforeEach(() => {
      // Constructing a Fuzzer enables CmpLog (write pointer 0). No seeds and
      // no iterations: getNextInput/reportResult would drain the slot buffer
      // internally before the test could observe it.
      fuzzer = new Fuzzer(
        createCoverageMap(65536),
        { seed: 42, grimoire: false, unicode: false, redqueen: false },
        null,
        null,
      );
      const slotBuffer = cmplogGetSlotBuffer();
      const writePointerBuffer = cmplogGetWritePointer();
      fns = createCmplogWriteFunctions(slotBuffer, writePointerBuffer);
      wptr = new Uint32Array(
        writePointerBuffer.buffer,
        writePointerBuffer.byteOffset,
        1,
      );
      fns.resetCounts();
    });

    afterEach(() => {
      fuzzer.shutdown();
    });

    it("maps every op ID to the operator Rust decodes", () => {
      // Op-ID table from vitiate-swc-plugin comparison_op_id():
      // === 0, !== 1, == 2, != 3, < 4, > 5, <= 6, >= 7
      // CmpLogOperator::from_id: 0|2 equal, 1|3 not_equal, 4|6 less, 5|7 greater
      const expected = [
        "equal",
        "not_equal",
        "equal",
        "not_equal",
        "less",
        "greater",
        "less",
        "greater",
      ];
      for (let opId = 0; opId < 8; opId++) {
        fns.write(opId, 100 + opId, opId + 1, opId);
      }
      const entries = cmplogDrainTestEntries();
      expect(entries).toHaveLength(8);
      for (let opId = 0; opId < 8; opId++) {
        const entry = entries[opId]!;
        expect(entry.cmpId).toBe(opId + 1);
        expect(entry.operator).toBe(expected[opId]);
        expect(entry.leftKind).toBe("num");
        expect(entry.left).toBe(String(opId));
        expect(entry.rightKind).toBe("num");
        expect(entry.right).toBe(String(100 + opId));
      }
      // drain resets the write pointer for the next iteration
      expect(wptr[0]).toBe(0);
    });

    it("round-trips numeric operands exactly", () => {
      fns.write(3.5, -1, 10, 0);
      fns.write(9007199254740991, 0.1, 11, 4);
      const entries = cmplogDrainTestEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        cmpId: 10,
        leftKind: "num",
        left: "3.5",
        rightKind: "num",
        right: "-1",
      });
      expect(entries[1]).toMatchObject({
        cmpId: 11,
        leftKind: "num",
        left: "9007199254740991",
        rightKind: "num",
        right: "0.1",
      });
    });

    it("round-trips string and mixed operands, truncating strings to 32 bytes", () => {
      const long = "0123456789012345678901234567890123456789"; // 40 ASCII chars
      fns.write("hello", "world", 20, 2);
      fns.write(long, "x", 21, 0);
      fns.write("magic", 7, 22, 0);
      const entries = cmplogDrainTestEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        cmpId: 20,
        leftKind: "str",
        left: "hello",
        rightKind: "str",
        right: "world",
      });
      expect(entries[1]).toMatchObject({
        cmpId: 21,
        leftKind: "str",
        left: long.slice(0, 32),
        rightKind: "str",
        right: "x",
      });
      expect(entries[2]).toMatchObject({
        cmpId: 22,
        leftKind: "str",
        left: "magic",
        rightKind: "num",
        right: "7",
      });
    });

    it("shutdown sets the disabled sentinel and writes become no-ops", () => {
      fuzzer.shutdown();
      expect(wptr[0]).toBe(WRITE_PTR_DISABLED);
      fns.write(1, 2, 30, 0);
      expect(wptr[0]).toBe(WRITE_PTR_DISABLED);
      // drain_test_entries leaves the disabled sentinel untouched
      expect(cmplogDrainTestEntries()).toHaveLength(0);
      expect(wptr[0]).toBe(WRITE_PTR_DISABLED);
    });
  });
});
