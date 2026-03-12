/**
 * Nix-style base32 encoding/decoding and test-name-to-path hashing.
 *
 * Uses the Nix alphabet (omits e, o, u, t to avoid offensive substrings)
 * and the same XOR-fold compression used by Nix store paths.
 */
import { createHash } from "node:crypto";

const NIX_BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

/** Reverse lookup table: character -> index in NIX_BASE32_ALPHABET. */
const NIX_BASE32_DECODE_TABLE: Map<string, number> = new Map(
  [...NIX_BASE32_ALPHABET].map((c, i) => [c, i]),
);

/**
 * Encode a byte array into a Nix base32 string.
 *
 * The encoding iterates character positions from length-1 down to 0,
 * extracts 5-bit values spanning byte boundaries, and indexes into the
 * Nix alphabet. No padding characters are used.
 */
export function toNixBase32(bytes: Uint8Array): string {
  const length = Math.ceil((bytes.length * 8) / 5);
  const chars: string[] = new Array<string>(length);

  for (let n = length - 1; n >= 0; n--) {
    const b = n * 5;
    const i = Math.floor(b / 8);
    const j = b % 8;

    let value = (bytes[i]! >> j) & 0x1f;
    if (j > 3 && i + 1 < bytes.length) {
      value |= (bytes[i + 1]! << (8 - j)) & 0x1f;
    }

    chars[length - 1 - n] = NIX_BASE32_ALPHABET[value]!;
  }

  return chars.join("");
}

/**
 * Decode a Nix base32 string back to bytes.
 *
 * Returns null if the string contains invalid characters or has
 * non-zero overflow bits (invalid padding).
 */
export function fromNixBase32(encoded: string): Uint8Array | null {
  if (encoded.length === 0) {
    return new Uint8Array(0);
  }

  const byteLength = Math.floor((encoded.length * 5) / 8);
  const bytes = new Uint8Array(byteLength);

  for (let n = 0; n < encoded.length; n++) {
    const char = encoded[encoded.length - n - 1]!;
    const value = NIX_BASE32_DECODE_TABLE.get(char);
    if (value === undefined) {
      return null;
    }

    const b = n * 5;
    const i = Math.floor(b / 8);
    const j = b % 8;

    bytes[i] = (bytes[i]! | (value << j)) & 0xff;

    if (j > 3) {
      if (i + 1 < byteLength) {
        bytes[i + 1] = (bytes[i + 1]! | (value >> (8 - j))) & 0xff;
      } else {
        // Check for non-zero overflow bits (invalid padding)
        if (value >> (8 - j) !== 0) {
          return null;
        }
      }
    }
  }

  return bytes;
}

/**
 * XOR-fold a 32-byte SHA-256 digest to 20 bytes (160 bits).
 *
 * This is the same compression algorithm used by Nix to reduce SHA-256
 * hashes to 160 bits for store paths. The first 20 bytes are kept, and
 * bytes 20-31 are XOR'd into bytes 0-11.
 *
 * @throws Error if input is not exactly 32 bytes
 */
export function compressHash(hash: Uint8Array): Uint8Array {
  if (hash.length !== 32) {
    throw new Error(
      `compressHash requires exactly 32 bytes, got ${hash.length}`,
    );
  }

  const output = new Uint8Array(20);
  output.set(hash.subarray(0, 20));

  for (let i = 0; i < 12; i++) {
    output[i] = output[i]! ^ hash[20 + i]!;
  }

  return output;
}

/**
 * Produce a Nix-style directory name for a fuzz test.
 *
 * Algorithm:
 * 1. SHA-256 of `<relativeTestFilePath>::<testName>`
 * 2. XOR-fold to 160 bits (20 bytes)
 * 3. Encode in Nix base32 (32 characters)
 * 4. Append `-<slug>` where slug is the sanitized test name
 *
 * The `::` delimiter is unambiguous since file paths do not contain `::`.
 */
export function hashTestPath(
  relativeTestFilePath: string,
  testName: string,
): string {
  const input = `${relativeTestFilePath}::${testName}`;
  const sha256 = createHash("sha256").update(input).digest();
  const compressed = compressHash(sha256);
  const hash = toNixBase32(compressed);

  const slug = testName
    .replace(/[^a-zA-Z0-9\-_.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (!slug || slug === "." || slug === "..") {
    return hash;
  }

  return `${hash}-${slug}`;
}
