import { describe, expect, it } from "vitest";
import {
  toNixBase32,
  fromNixBase32,
  compressHash,
  hashTestPath,
} from "./nix-base32.js";

describe("toNixBase32", () => {
  it("encodes SHA-256 hash matching Nix test vector", () => {
    const hex =
      "ab335240fd942ab8191c5e628cd4ff3903c577bda961fb75df08e0303a00527b";
    const bytes = Buffer.from(hex, "hex");
    expect(toNixBase32(bytes)).toBe(
      "0ysj00x31q08vxsznqd9pmvwa0rrzza8qqjy3hcvhallzm054cxb",
    );
  });

  it("encodes 16-byte hash matching Nix test vector", () => {
    const hex = "47b2d8f260c2d48116044bc43fe3de0f";
    const bytes = Buffer.from(hex, "hex");
    expect(toNixBase32(bytes)).toBe("0gvvikzi2b0hb83m62c3rdicj7");
  });

  it("encodes 20-byte hash matching Nix test vector", () => {
    const hex = "1f74d74729abdc08f4f84e8f7f8c808c8ed92ee5";
    const bytes = Buffer.from(hex, "hex");
    expect(toNixBase32(bytes)).toBe("wlpdk3lch267z3sfz3s0ip5b553xfx0z");
  });

  it("returns empty string for empty input", () => {
    expect(toNixBase32(new Uint8Array(0))).toBe("");
  });

  it("uses only characters from the Nix alphabet", () => {
    const alphabet = "0123456789abcdfghijklmnpqrsvwxyz";
    const bytes = Buffer.from("deadbeef01234567", "hex");
    const encoded = toNixBase32(bytes);
    for (const char of encoded) {
      expect(alphabet).toContain(char);
    }
  });
});

describe("fromNixBase32", () => {
  it("decodes valid Nix base32 string", () => {
    const hex =
      "ab335240fd942ab8191c5e628cd4ff3903c577bda961fb75df08e0303a00527b";
    const result = fromNixBase32(
      "0ysj00x31q08vxsznqd9pmvwa0rrzza8qqjy3hcvhallzm054cxb",
    );
    expect(result).not.toBeNull();
    expect(Buffer.from(result!).toString("hex")).toBe(hex);
  });

  it("returns null for invalid character", () => {
    expect(fromNixBase32("hello!")).toBeNull();
  });

  it("returns null for omitted alphabet characters (e, o, u, t)", () => {
    expect(fromNixBase32("test")).toBeNull();
  });

  it("returns empty Uint8Array for empty string", () => {
    const result = fromNixBase32("");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it("round-trips arbitrary byte arrays", () => {
    const testCases = [
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array([1, 2, 3, 4, 5]),
      Buffer.from(
        "ab335240fd942ab8191c5e628cd4ff3903c577bda961fb75df08e0303a00527b",
        "hex",
      ),
      Buffer.from("1f74d74729abdc08f4f84e8f7f8c808c8ed92ee5", "hex"),
      Buffer.from("47b2d8f260c2d48116044bc43fe3de0f", "hex"),
    ];

    for (const original of testCases) {
      const encoded = toNixBase32(original);
      const decoded = fromNixBase32(encoded);
      expect(decoded).not.toBeNull();
      expect(Buffer.from(decoded!).toString("hex")).toBe(
        Buffer.from(original).toString("hex"),
      );
    }
  });
});

describe("compressHash", () => {
  it("produces 20-byte output from 32-byte input", () => {
    const hash = Buffer.alloc(32, 0);
    const result = compressHash(hash);
    expect(result.length).toBe(20);
  });

  it("XOR-folds bytes 20-31 into bytes 0-11", () => {
    const hash = new Uint8Array(32);
    // Set specific values to verify XOR-fold
    for (let i = 0; i < 32; i++) {
      hash[i] = i;
    }
    const result = compressHash(hash);

    // result[i] = hash[i] ^ hash[20 + i] for i in 0..11
    for (let i = 0; i < 12; i++) {
      expect(result[i]).toBe(hash[i]! ^ hash[20 + i]!);
    }
    // result[i] = hash[i] for i in 12..19
    for (let i = 12; i < 20; i++) {
      expect(result[i]).toBe(hash[i]);
    }
  });

  it("throws for non-32-byte input", () => {
    expect(() => compressHash(new Uint8Array(16))).toThrow(
      "compressHash requires exactly 32 bytes",
    );
    expect(() => compressHash(new Uint8Array(0))).toThrow();
    expect(() => compressHash(new Uint8Array(64))).toThrow();
  });
});

describe("hashTestPath", () => {
  it("produces deterministic output", () => {
    const result1 = hashTestPath("src/parser.fuzz.ts", "parses URLs");
    const result2 = hashTestPath("src/parser.fuzz.ts", "parses URLs");
    expect(result1).toBe(result2);
  });

  it("produces 32-char hash prefix with slug suffix", () => {
    const result = hashTestPath("src/parser.fuzz.ts", "parses URLs");
    expect(result).toMatch(/^[0-9a-df-np-sv-z]{32}-parses_URLs$/);
  });

  it("produces different hashes for same test name in different files", () => {
    const result1 = hashTestPath("src/a.fuzz.ts", "parse");
    const result2 = hashTestPath("src/b.fuzz.ts", "parse");
    expect(result1).not.toBe(result2);
    // Both should have the same slug
    expect(result1.endsWith("-parse")).toBe(true);
    expect(result2.endsWith("-parse")).toBe(true);
    // Hash prefixes should differ
    expect(result1.slice(0, 32)).not.toBe(result2.slice(0, 32));
  });

  it("produces different hashes for different test names in same file", () => {
    const result1 = hashTestPath("src/a.fuzz.ts", "foo");
    const result2 = hashTestPath("src/a.fuzz.ts", "bar");
    expect(result1).not.toBe(result2);
  });

  it("handles test name with only non-alphanumeric characters (no slug)", () => {
    // Characters like @#$ are replaced with _, then collapsed and stripped
    const result = hashTestPath("test.fuzz.ts", "@#$");
    expect(result).toMatch(/^[0-9a-df-np-sv-z]{32}$/);
  });

  it("keeps dots in slug since they are allowed characters", () => {
    const result = hashTestPath("test.fuzz.ts", "...");
    expect(result).toMatch(/^[0-9a-df-np-sv-z]{32}-\.\.\.$/);
  });

  it("handles empty test name", () => {
    const result = hashTestPath("test.fuzz.ts", "");
    expect(result).toMatch(/^[0-9a-df-np-sv-z]{32}$/);
  });

  it("sanitizes special characters in slug", () => {
    const result = hashTestPath("src/parser.fuzz.ts", "parse url");
    expect(result).toMatch(/^[0-9a-df-np-sv-z]{32}-parse_url$/);
  });

  it("collapses consecutive underscores in slug", () => {
    const result = hashTestPath("test.fuzz.ts", "a   b");
    expect(result).toMatch(/-a_b$/);
  });

  it("strips leading and trailing underscores from slug", () => {
    const result = hashTestPath("test.fuzz.ts", " hello ");
    expect(result).toMatch(/-hello$/);
  });

  it("preserves hyphens, dots, and underscores in slug", () => {
    const result = hashTestPath("test.fuzz.ts", "my-test_v2.0");
    expect(result).toMatch(/-my-test_v2\.0$/);
  });
});
