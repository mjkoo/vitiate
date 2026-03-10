import { describe, expect, it } from "vitest";
import { FuzzedDataProvider } from "./index.js";

// Helper to create a provider from byte values
function fdp(...bytes: number[]): FuzzedDataProvider {
  return new FuzzedDataProvider(new Uint8Array(bytes));
}

describe("FuzzedDataProvider", () => {
  // ==========================================
  // 2. Core Buffer Management
  // ==========================================
  describe("construction and buffer management", () => {
    it("constructs from Uint8Array", () => {
      const provider = new FuzzedDataProvider(new Uint8Array([1, 2, 3]));
      expect(provider.remainingBytes).toBe(3);
    });

    it("constructs from Node.js Buffer", () => {
      const provider = new FuzzedDataProvider(Buffer.from([1, 2, 3]));
      expect(provider.remainingBytes).toBe(3);
    });

    it("constructs from empty input", () => {
      const provider = new FuzzedDataProvider(new Uint8Array(0));
      expect(provider.remainingBytes).toBe(0);
    });

    it("tracks scalar and array consumption independently", () => {
      const provider = fdp(0, 1, 2, 3, 4, 5, 6, 7, 8, 9);
      expect(provider.remainingBytes).toBe(10);

      // Consume 1 byte from end (boolean)
      provider.consumeBoolean();
      expect(provider.remainingBytes).toBe(9);

      // Consume 2 bytes from front (bytes)
      provider.consumeBytes(2);
      expect(provider.remainingBytes).toBe(7);
    });

    it("consumption regions do not overlap", () => {
      const provider = fdp(0xaa, 0xbb, 0xcc, 0xdd);

      // Consume 2 from front
      const frontBytes = provider.consumeBytes(2);
      expect(frontBytes).toEqual(new Uint8Array([0xaa, 0xbb]));

      // Consume 2 from end via integral
      const endValue = provider.consumeIntegral(2);
      expect(provider.remainingBytes).toBe(0);
      // The end value should be from bytes [0xcc, 0xdd] in LE: 0xddcc
      expect(endValue).toBe(0xddcc);
    });
  });

  // ==========================================
  // 3. Boolean and Integer Consumption
  // ==========================================
  describe("consumeBoolean", () => {
    it("returns true when LSB is 1", () => {
      expect(fdp(0x03).consumeBoolean()).toBe(true);
    });

    it("returns false when LSB is 0", () => {
      expect(fdp(0x02).consumeBoolean()).toBe(false);
    });

    it("returns false on exhausted buffer", () => {
      expect(fdp().consumeBoolean()).toBe(false);
    });

    it("decreases remainingBytes by 1", () => {
      const provider = fdp(0xff);
      provider.consumeBoolean();
      expect(provider.remainingBytes).toBe(0);
    });
  });

  describe("consumeIntegral", () => {
    it("consumes unsigned 2-byte integer in LE", () => {
      // Bytes in buffer order: [0x01, 0x00]. LE read from end: 0x0001 = 1
      expect(fdp(0x01, 0x00).consumeIntegral(2)).toBe(1);
    });

    it("consumes signed 1-byte integer", () => {
      // 0xFF = 255, range [-128, 127] has size 256. -128 + (255 % 256) = 127
      expect(fdp(0xff).consumeIntegral(1, true)).toBe(127);
      // 0x80 = 128, -128 + (128 % 256) = 0
      expect(fdp(0x80).consumeIntegral(1, true)).toBe(0);
    });

    it("handles partial consumption when fewer bytes remain", () => {
      const provider = fdp(0x01, 0x02);
      const result = provider.consumeIntegral(4);
      // 2 bytes [0x01, 0x02] read LE from end: 0x0201 = 513
      expect(result).toBe(513);
      expect(provider.remainingBytes).toBe(0);
    });

    it("throws RangeError for maxNumBytes out of range", () => {
      expect(() => fdp(0xff).consumeIntegral(0)).toThrow(RangeError);
      expect(() => fdp(0xff).consumeIntegral(7)).toThrow(RangeError);
    });

    it("throws TypeError for non-integer maxNumBytes", () => {
      expect(() => fdp(0xff).consumeIntegral(1.5)).toThrow(TypeError);
    });

    it("returns 0 on exhausted buffer", () => {
      expect(fdp().consumeIntegral(4)).toBe(0);
    });
  });

  describe("consumeIntegralInRange", () => {
    it("consumes in single-byte range with exact value", () => {
      // 0x80 = 128, range [0, 255], 1 byte consumed, 128 % 256 = 128
      expect(fdp(0x80).consumeIntegralInRange(0, 255)).toBe(128);
    });

    it("consumes in multi-byte range with exact value", () => {
      // Bytes [0x01, 0x00], LE from end: 0x0001 = 1, range [0, 65535]
      expect(fdp(0x01, 0x00).consumeIntegralInRange(0, 65535)).toBe(1);
    });

    it("returns value when min equals max", () => {
      const provider = fdp(0xff);
      expect(provider.consumeIntegralInRange(42, 42)).toBe(42);
      // No bytes consumed
      expect(provider.remainingBytes).toBe(1);
    });

    it("handles negative range", () => {
      // 0x80 = 128, range [-100, 100] has size 201. -100 + (128 % 201) = 28
      const result = fdp(0x80).consumeIntegralInRange(-100, 100);
      expect(result).toBe(28);
    });

    it("throws RangeError when range exceeds 2^48", () => {
      expect(() =>
        fdp(0xff).consumeIntegralInRange(0, Number.MAX_SAFE_INTEGER),
      ).toThrow(RangeError);
    });

    it("throws RangeError when min > max", () => {
      expect(() => fdp(0xff).consumeIntegralInRange(10, 5)).toThrow(RangeError);
    });

    it("returns min on exhausted buffer", () => {
      expect(fdp().consumeIntegralInRange(5, 100)).toBe(5);
    });
  });

  describe("consumeBigIntegral", () => {
    it("consumes unsigned 8-byte bigint", () => {
      // Bytes [0,0,0,0,0,0,0,0xff]: LE read from end gives 0xff = 255n
      // Range [0, 2^64-1], result = 255n % 2^64 + 0 = 255n
      const provider = fdp(0, 0, 0, 0, 0, 0, 0, 0xff);
      const result = provider.consumeBigIntegral(8);
      expect(typeof result).toBe("bigint");
      expect(result).toBe(255n);
    });

    it("consumes signed 8-byte bigint", () => {
      // All 0xff: LE raw = 2^64-1, range [-2^63, 2^63-1], size 2^64
      // Result = (2^64-1) % 2^64 + (-2^63) = 2^63 - 1 = 9223372036854775807n
      const result = fdp(
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ).consumeBigIntegral(8, true);
      expect(result).toBe(9223372036854775807n);
    });

    it("handles partial consumption", () => {
      // Bytes [0x01, 0x02, 0x03]: LE from end: 0x03 | (0x02 << 8) | (0x01 << 16) = 66051n
      const provider = fdp(0x01, 0x02, 0x03);
      const result = provider.consumeBigIntegral(16);
      expect(provider.remainingBytes).toBe(0);
      expect(result).toBe(66051n);
    });

    it("throws TypeError for non-integer maxNumBytes", () => {
      expect(() => fdp(0xff).consumeBigIntegral(2.5)).toThrow(TypeError);
    });
  });

  describe("consumeBigIntegralInRange", () => {
    it("handles arbitrary bigint range", () => {
      // 20 bytes of 0xff: reads 16 bytes (128 bits needed for range 2^128-1)
      // LE raw = 2^128-1, result = (2^128-1) % 2^128 + 0 = 2^128-1
      const provider = fdp(...new Array<number>(20).fill(0xff));
      const result = provider.consumeBigIntegralInRange(0n, 2n ** 128n - 1n);
      expect(result).toBe(340282366920938463463374607431768211455n);
    });

    it("returns value when min equals max", () => {
      const provider = fdp(0xff);
      expect(provider.consumeBigIntegralInRange(42n, 42n)).toBe(42n);
      expect(provider.remainingBytes).toBe(1);
    });

    it("throws RangeError when min > max", () => {
      expect(() => fdp(0xff).consumeBigIntegralInRange(10n, 5n)).toThrow(
        RangeError,
      );
    });

    it("returns min on exhausted buffer", () => {
      expect(fdp().consumeBigIntegralInRange(5n, 100n)).toBe(5n);
    });
  });

  // ==========================================
  // 4. Floating Point Consumption
  // ==========================================
  describe("consumeProbabilityFloat", () => {
    it("returns 0.0 for all-zero bytes", () => {
      expect(fdp(0, 0, 0, 0).consumeProbabilityFloat()).toBe(0.0);
    });

    it("returns 1.0 for all-max bytes", () => {
      expect(fdp(0xff, 0xff, 0xff, 0xff).consumeProbabilityFloat()).toBe(1.0);
    });

    it("returns value in [0, 1]", () => {
      const result = fdp(0x80, 0, 0, 0).consumeProbabilityFloat();
      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });
  });

  describe("consumeProbabilityDouble", () => {
    it("returns 0.0 for all-zero bytes", () => {
      expect(fdp(0, 0, 0, 0, 0, 0, 0, 0).consumeProbabilityDouble()).toBe(0.0);
    });

    it("returns value <= 1.0 for all-max bytes", () => {
      expect(
        fdp(
          0xff,
          0xff,
          0xff,
          0xff,
          0xff,
          0xff,
          0xff,
          0xff,
        ).consumeProbabilityDouble(),
      ).toBeLessThanOrEqual(1.0);
    });

    it("returns value in [0, 1]", () => {
      const result = fdp(0x80, 0, 0, 0, 0, 0, 0, 0).consumeProbabilityDouble();
      expect(result).toBeGreaterThanOrEqual(0.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });
  });

  describe("consumeNumber", () => {
    it("reads 8 bytes as IEEE-754 LE double", () => {
      // IEEE-754 LE for 1.0: 0x3FF0000000000000
      const provider = fdp(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f);
      expect(provider.consumeNumber()).toBe(1.0);
    });

    it("places partial bytes in MSB positions of LE buffer", () => {
      // 1 byte 0xC0 → LE buffer [0,0,0,0,0,0,0,0xC0] → -2.0
      // Matches LLVM/jazzer.js placement at high (MSB) indices
      expect(fdp(0xc0).consumeNumber()).toBe(-2.0);
      // 2 bytes [0x37, 0x40] → LE buffer [0,0,0,0,0,0,0x37,0x40] → 23.0
      expect(fdp(0x37, 0x40).consumeNumber()).toBe(23.0);
    });

    it("returns 0 on exhausted buffer", () => {
      expect(fdp().consumeNumber()).toBe(0);
    });
  });

  describe("consumeFloat and consumeFloatInRange", () => {
    it("consumeFloat returns value in 32-bit range", () => {
      const provider = fdp(0x80, 0x80, 0x80, 0x80, 0x01);
      const result = provider.consumeFloat();
      expect(result).toBeGreaterThanOrEqual(-3.4028235e38);
      expect(result).toBeLessThanOrEqual(3.4028235e38);
    });

    it("consumeFloatInRange returns value in range", () => {
      const result = fdp(0x80, 0x80, 0x80, 0x80).consumeFloatInRange(
        10.0,
        20.0,
      );
      expect(result).toBeGreaterThanOrEqual(10.0);
      expect(result).toBeLessThanOrEqual(20.0);
    });

    it("returns min when min equals max", () => {
      const provider = fdp(0xff);
      expect(provider.consumeFloatInRange(5.0, 5.0)).toBe(5.0);
      // No bytes consumed
      expect(provider.remainingBytes).toBe(1);
    });

    it("throws RangeError when min > max", () => {
      expect(() => fdp(0xff).consumeFloatInRange(10.0, 5.0)).toThrow(
        RangeError,
      );
    });

    it("throws RangeError when min or max is not finite", () => {
      expect(() => fdp(0xff).consumeFloatInRange(-Infinity, Infinity)).toThrow(
        RangeError,
      );
      expect(() => fdp(0xff).consumeFloatInRange(0, Infinity)).toThrow(
        RangeError,
      );
      expect(() => fdp(0xff).consumeFloatInRange(-Infinity, 0)).toThrow(
        RangeError,
      );
    });

    it("uses range splitting for large spans", () => {
      const provider = fdp(
        0x80,
        0x80,
        0x80,
        0x80, // probability float bytes
        0x01, // boolean byte
      );
      const result = provider.consumeFloatInRange(-3.4028235e38, 3.4028235e38);
      expect(result).toBeGreaterThanOrEqual(-3.4028235e38);
      expect(result).toBeLessThanOrEqual(3.4028235e38);
    });
  });

  describe("consumeDouble and consumeDoubleInRange", () => {
    it("consumeDouble returns value in full double range", () => {
      const provider = fdp(0, 0, 0, 0, 0, 0, 0, 0, 0x01);
      const result = provider.consumeDouble();
      expect(result).toBeGreaterThanOrEqual(-Number.MAX_VALUE);
      expect(result).toBeLessThanOrEqual(Number.MAX_VALUE);
    });

    it("consumeDoubleInRange returns value in range", () => {
      const result = fdp(
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
        0x80,
      ).consumeDoubleInRange(-1.0, 1.0);
      expect(result).toBeGreaterThanOrEqual(-1.0);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it("returns min when min equals max", () => {
      const provider = fdp(0xff);
      expect(provider.consumeDoubleInRange(7.5, 7.5)).toBe(7.5);
      expect(provider.remainingBytes).toBe(1);
    });

    it("throws RangeError when min > max", () => {
      expect(() => fdp(0xff).consumeDoubleInRange(10.0, 5.0)).toThrow(
        RangeError,
      );
    });

    it("throws RangeError when min or max is not finite", () => {
      expect(() => fdp(0xff).consumeDoubleInRange(-Infinity, Infinity)).toThrow(
        RangeError,
      );
      expect(() => fdp(0xff).consumeDoubleInRange(0, Infinity)).toThrow(
        RangeError,
      );
      expect(() => fdp(0xff).consumeDoubleInRange(-Infinity, 0)).toThrow(
        RangeError,
      );
    });
  });

  describe("consumeNumberInRange", () => {
    it("delegates to consumeDoubleInRange", () => {
      // Same bytes should produce same result
      const bytes = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80];
      const a = fdp(...bytes).consumeNumberInRange(0, 100);
      const b = fdp(...bytes).consumeDoubleInRange(0, 100);
      expect(a).toBe(b);
    });
  });

  // ==========================================
  // 5. Array Consumption (Front/BE)
  // ==========================================
  describe("consumeBooleans", () => {
    it("consumes booleans from front with LSB check", () => {
      expect(fdp(0x01, 0x02, 0x03).consumeBooleans(3)).toEqual([
        true,
        false,
        true,
      ]);
    });

    it("returns shorter array when fewer bytes remain", () => {
      const result = fdp(0x01, 0x02, 0x03).consumeBooleans(10);
      expect(result).toHaveLength(3);
    });

    it("throws TypeError for non-integer maxLength", () => {
      expect(() => fdp(0xff).consumeBooleans(2.5)).toThrow(TypeError);
    });

    it("throws RangeError for negative maxLength", () => {
      expect(() => fdp(0xff).consumeBooleans(-1)).toThrow(RangeError);
    });
  });

  describe("consumeIntegrals", () => {
    it("consumes array of unsigned 2-byte integers in BE", () => {
      const result = fdp(0x00, 0x01, 0x00, 0x02, 0x00, 0x03).consumeIntegrals(
        3,
        2,
      );
      expect(result).toEqual([1, 2, 3]);
    });

    it("handles partial final element", () => {
      const provider = fdp(0, 0, 0, 0, 0, 0, 0, 0, 0x05);
      const result = provider.consumeIntegrals(10, 4);
      expect(result).toHaveLength(3);
      // Last element consumed only 1 byte
      expect(result[2]).toBe(0x05);
    });

    it("throws TypeError for non-integer parameters", () => {
      expect(() => fdp(0xff).consumeIntegrals(1.5, 2)).toThrow(TypeError);
      expect(() => fdp(0xff).consumeIntegrals(2, 1.5)).toThrow(TypeError);
    });

    it("throws RangeError for numBytesPerIntegral out of range", () => {
      expect(() => fdp(0xff).consumeIntegrals(10, 0)).toThrow(RangeError);
      expect(() => fdp(0xff).consumeIntegrals(10, 7)).toThrow(RangeError);
    });
  });

  describe("consumeBigIntegrals", () => {
    it("consumes array of 8-byte bigints with exact values", () => {
      const bytes = new Array<number>(16).fill(0);
      // First 8 bytes: [0,0,0,0,0,0,0,1] BE → 1n
      bytes[7] = 1;
      // Second 8 bytes: [0,0,0,0,0,0,0,2] BE → 2n
      bytes[15] = 2;
      const result = fdp(...bytes).consumeBigIntegrals(2, 8);
      expect(result).toEqual([1n, 2n]);
    });

    it("throws TypeError for non-integer parameters", () => {
      expect(() => fdp(0xff).consumeBigIntegrals(1.5, 8)).toThrow(TypeError);
    });

    it("throws RangeError for numBytesPerIntegral = 0", () => {
      expect(() => fdp(0xff).consumeBigIntegrals(10, 0)).toThrow(RangeError);
    });
  });

  describe("consumeNumbers", () => {
    it("consumes array of doubles with exact values", () => {
      // All zeros → IEEE-754 BE 0.0 for both elements
      const bytes = new Array<number>(16).fill(0);
      const result = fdp(...bytes).consumeNumbers(2);
      expect(result).toEqual([0.0, 0.0]);
    });

    it("handles partial final element", () => {
      const bytes = new Array<number>(11).fill(0);
      const result = fdp(...bytes).consumeNumbers(2);
      expect(result).toHaveLength(2);
    });

    it("throws TypeError for non-integer maxLength", () => {
      expect(() => fdp(0xff).consumeNumbers(1.5)).toThrow(TypeError);
    });

    it("throws RangeError for negative maxLength", () => {
      expect(() => fdp(0xff).consumeNumbers(-1)).toThrow(RangeError);
    });
  });

  describe("consumeBytes", () => {
    it("consumes bytes from front", () => {
      const provider = fdp(0xaa, 0xbb, 0xcc, 0xdd);
      const result = provider.consumeBytes(3);
      expect(result).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
      expect(provider.remainingBytes).toBe(1);
    });

    it("returns shorter array when fewer bytes remain", () => {
      const result = fdp(0x01, 0x02, 0x03, 0x04, 0x05).consumeBytes(100);
      expect(result).toHaveLength(5);
    });

    it("throws TypeError for non-integer maxLength", () => {
      expect(() => fdp(0xff).consumeBytes(2.5)).toThrow(TypeError);
    });

    it("throws RangeError for negative maxLength", () => {
      expect(() => fdp(0xff).consumeBytes(-1)).toThrow(RangeError);
    });
  });

  describe("consumeRemainingAsBytes", () => {
    it("consumes all remaining bytes", () => {
      const provider = fdp(
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
        0x09,
        0x0a,
      );
      const result = provider.consumeRemainingAsBytes();
      expect(result).toHaveLength(10);
      expect(provider.remainingBytes).toBe(0);
    });

    it("returns empty Uint8Array when no bytes remain", () => {
      const result = fdp().consumeRemainingAsBytes();
      expect(result).toHaveLength(0);
      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  // ==========================================
  // 6. String Consumption
  // ==========================================
  describe("consumeString", () => {
    it("consumes ASCII string", () => {
      const result = fdp(0x48, 0x65, 0x6c, 0x6c, 0x6f).consumeString(5);
      expect(result).toBe("Hello");
    });

    it("consumes printable string", () => {
      const result = fdp(0x00, 0x80, 0xff).consumeString(3, {
        printable: true,
      });
      for (const ch of result) {
        const code = ch.charCodeAt(0);
        expect(code).toBeGreaterThanOrEqual(32);
        expect(code).toBeLessThanOrEqual(126);
      }
    });

    it("consumes UTF-8 string", () => {
      const result = fdp(0x48, 0x69).consumeString(10, { encoding: "utf-8" });
      expect(result).toBe("Hi");
    });

    it("consumes UTF-16LE string", () => {
      // "Hi" in UTF-16LE: H=0x0048, i=0x0069
      const result = fdp(0x48, 0x00, 0x69, 0x00).consumeString(4, {
        encoding: "utf-16le",
      });
      expect(result).toBe("Hi");
    });

    it("throws RangeError for invalid encoding", () => {
      expect(() =>
        fdp(0xff).consumeString(10, { encoding: "not-a-real-encoding" }),
      ).toThrow(RangeError);
    });

    it("returns shorter string when fewer bytes remain", () => {
      const result = fdp(0x41, 0x42, 0x43, 0x44, 0x45).consumeString(100);
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it("throws RangeError for negative maxLength", () => {
      expect(() => fdp(0xff).consumeString(-1)).toThrow(RangeError);
    });

    it("throws TypeError for non-integer maxLength", () => {
      expect(() => fdp(0xff).consumeString(2.5)).toThrow(TypeError);
    });
  });

  describe("consumeRemainingAsString", () => {
    it("consumes all remaining as string", () => {
      const provider = fdp(
        0x41,
        0x42,
        0x43,
        0x44,
        0x45,
        0x46,
        0x47,
        0x48,
        0x49,
        0x4a,
      );
      const result = provider.consumeRemainingAsString();
      expect(provider.remainingBytes).toBe(0);
      expect(result).toBe("ABCDEFGHIJ");
    });
  });

  describe("consumeStringArray", () => {
    it("consumes array of strings", () => {
      const bytes = new Array<number>(20).fill(0x41); // 20 'A' bytes
      const provider = fdp(...bytes);
      const result = provider.consumeStringArray(3, 5);
      expect(result).toEqual(["AAAAA", "AAAAA", "AAAAA"]);
      expect(provider.remainingBytes).toBe(5);
    });

    it("stops when buffer exhausted", () => {
      const result = fdp(
        0x41,
        0x42,
        0x43,
        0x44,
        0x45,
        0x46,
        0x47,
        0x48,
      ).consumeStringArray(100, 5);
      expect(result.length).toBeLessThan(100);
    });

    it("terminates immediately with maxStringLength=0", () => {
      const provider = fdp(0x41, 0x42, 0x43, 0x44, 0x45);
      const result = provider.consumeStringArray(10, 0);
      expect(result).toEqual([]);
      expect(provider.remainingBytes).toBe(5);
    });

    it("throws TypeError for non-integer parameters", () => {
      expect(() => fdp(0xff).consumeStringArray(1.5, 5)).toThrow(TypeError);
      expect(() => fdp(0xff).consumeStringArray(3, 1.5)).toThrow(TypeError);
    });
  });

  // ==========================================
  // 7. Element Picking
  // ==========================================
  describe("pickValue", () => {
    it("picks from non-empty array", () => {
      const result = fdp(0x01).pickValue(["a", "b", "c"]);
      expect(["a", "b", "c"]).toContain(result);
    });

    it("throws RangeError for empty array", () => {
      expect(() => fdp(0xff).pickValue([])).toThrow(RangeError);
    });
  });

  describe("pickValues", () => {
    it("picks multiple unique values", () => {
      const result = fdp(0x00, 0x01, 0x02, 0x03).pickValues(
        ["a", "b", "c", "d"],
        2,
      );
      expect(result).toHaveLength(2);
      expect(new Set(result).size).toBe(2);
      for (const v of result) {
        expect(["a", "b", "c", "d"]).toContain(v);
      }
    });

    it("picks all elements when numValues equals array length", () => {
      const result = fdp(0x00, 0x01, 0x02).pickValues([1, 2, 3], 3);
      expect(result).toHaveLength(3);
      expect(new Set(result).size).toBe(3);
    });

    it("throws RangeError for empty array", () => {
      expect(() => fdp(0xff).pickValues([], 1)).toThrow(RangeError);
    });

    it("throws RangeError when numValues exceeds array length", () => {
      expect(() => fdp(0xff).pickValues([1, 2], 5)).toThrow(RangeError);
    });

    it("throws RangeError for negative numValues", () => {
      expect(() => fdp(0xff).pickValues([1, 2], -1)).toThrow(RangeError);
    });

    it("throws TypeError for non-integer numValues", () => {
      expect(() => fdp(0xff).pickValues([1, 2], 1.5)).toThrow(TypeError);
    });
  });

  // ==========================================
  // Exhausted buffer deterministic behavior
  // ==========================================
  describe("exhausted buffer behavior", () => {
    it("all methods safe on exhausted buffer", () => {
      const empty = fdp();
      expect(empty.consumeBoolean()).toBe(false);
      expect(empty.consumeIntegralInRange(5, 10)).toBe(5);
      expect(empty.consumeNumber()).toBe(0);
      expect(empty.consumeBytes(10)).toEqual(new Uint8Array(0));
      expect(empty.consumeString(10)).toBe("");
      expect(empty.consumeProbabilityFloat()).toBe(0.0);
      expect(empty.consumeProbabilityDouble()).toBe(0.0);
    });
  });
});
