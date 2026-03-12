## ADDED Requirements

### Requirement: Nix base32 alphabet

The system SHALL define the Nix base32 alphabet as the 32-character string `0123456789abcdfghijklmnpqrsvwxyz`. This alphabet omits the letters `e`, `o`, `u`, and `t` to avoid offensive substrings in encoded output.

#### Scenario: Alphabet composition

- **WHEN** the Nix base32 alphabet is examined
- **THEN** it SHALL contain exactly 32 characters
- **AND** it SHALL contain digits `0-9` and lowercase letters `a-z` minus `e`, `o`, `u`, `t`
- **AND** character at index 0 SHALL be `'0'` and character at index 31 SHALL be `'z'`

### Requirement: Nix base32 encoding

The system SHALL provide a `toNixBase32(bytes: Uint8Array): string` function that encodes a byte array into a Nix base32 string.

The encoding algorithm SHALL:

1. Compute the output length as `Math.ceil(bytes.length * 8 / 5)`.
2. Iterate character positions from `length - 1` down to `0`.
3. For each position `n`, extract a 5-bit value spanning byte boundaries:
   - Compute bit offset `b = n * 5`, byte index `i = Math.floor(b / 8)`, bit shift `j = b % 8`.
   - Extract bits from `bytes[i]` shifted right by `j`.
   - If `i < bytes.length - 1`, OR in bits from `bytes[i + 1]` shifted left by `(8 - j)`.
   - Mask to 5 bits (`& 0x1f`) and index into the alphabet.
4. Collect characters in iteration order (reversed positions produce the final string directly).

The encoding SHALL NOT use padding characters.

#### Scenario: Encode SHA-256 hash

- **WHEN** `toNixBase32` is called with the bytes of hex `ab335240fd942ab8191c5e628cd4ff3903c577bda961fb75df08e0303a00527b`
- **THEN** the result SHALL be `"0ysj00x31q08vxsznqd9pmvwa0rrzza8qqjy3hcvhallzm054cxb"`

#### Scenario: Encode 16-byte hash

- **WHEN** `toNixBase32` is called with the bytes of hex `47b2d8f260c2d48116044bc43fe3de0f`
- **THEN** the result SHALL be `"0gvvikzi2b0hb83m62c3rdicj7"`

#### Scenario: Encode 20-byte hash

- **WHEN** `toNixBase32` is called with the bytes of hex `1f74d74729abdc08f4f84e8f7f8c808c8ed92ee5`
- **THEN** the result SHALL be `"wlpdk3lch267z3sfz3s0ip5b553xfx0z"`

#### Scenario: Empty input

- **WHEN** `toNixBase32` is called with an empty byte array
- **THEN** the result SHALL be an empty string

### Requirement: Nix base32 decoding

The system SHALL provide a `fromNixBase32(encoded: string): Uint8Array | null` function that decodes a Nix base32 string back to bytes.

The decoding algorithm SHALL:

1. Compute output byte length as `Math.floor(encoded.length * 5 / 8)`.
2. Allocate a zero-filled byte array of the computed length.
3. Iterate character positions from `0` to `encoded.length - 1`, reading characters from the END of the string (position `encoded.length - n - 1`).
4. For each character, find its index in the alphabet. Return `null` if the character is not in the alphabet.
5. Distribute the 5-bit value across byte boundaries:
   - Compute bit offset `b = n * 5`, byte index `i = Math.floor(b / 8)`, bit shift `j = b % 8`.
   - OR the value shifted left by `j` into `bytes[i]`.
   - If `i < byteLength - 1`, OR the overflow bits (`value >> (8 - j)`) into `bytes[i + 1]`.
   - If `i >= byteLength - 1` and there are non-zero overflow bits, return `null` (invalid padding).

#### Scenario: Round-trip encoding

- **WHEN** arbitrary bytes are encoded with `toNixBase32` and then decoded with `fromNixBase32`
- **THEN** the decoded bytes SHALL be identical to the original input

#### Scenario: Decode valid Nix base32 string

- **WHEN** `fromNixBase32("0ysj00x31q08vxsznqd9pmvwa0rrzza8qqjy3hcvhallzm054cxb")` is called
- **THEN** the result SHALL be the bytes of hex `ab335240fd942ab8191c5e628cd4ff3903c577bda961fb75df08e0303a00527b`

#### Scenario: Invalid character

- **WHEN** `fromNixBase32("hello!")` is called (contains `!` which is not in the alphabet)
- **THEN** the result SHALL be `null`

#### Scenario: Invalid character from omitted set

- **WHEN** `fromNixBase32("test")` is called (contains `e` and `t` which are omitted from the alphabet)
- **THEN** the result SHALL be `null`

### Requirement: SHA-256 XOR-fold compression to 160 bits

The system SHALL provide a `compressHash(hash: Uint8Array): Uint8Array` function that compresses a 32-byte (256-bit) SHA-256 digest to 20 bytes (160 bits) using XOR-folding.

The algorithm SHALL:

1. Accept exactly 32 bytes of input. Throw an error if the input length is not 32.
2. Copy the first 20 bytes to a new output array.
3. For each index `i` from `0` to `11` (inclusive), XOR `output[i]` with `hash[20 + i]`.
4. Return the 20-byte result.

This is the same compression algorithm used by Nix to reduce SHA-256 hashes to 160 bits for store paths.

#### Scenario: Compress 32-byte SHA-256

- **WHEN** `compressHash` is called with a 32-byte SHA-256 digest
- **THEN** the result SHALL be exactly 20 bytes
- **AND** `result[i] === hash[i] ^ hash[20 + i]` for `i` in `0..11`
- **AND** `result[i] === hash[i]` for `i` in `12..19`

#### Scenario: Invalid input length

- **WHEN** `compressHash` is called with a byte array that is not exactly 32 bytes
- **THEN** an error SHALL be thrown

### Requirement: Test name to directory name hashing

The system SHALL provide a `hashTestPath(relativeTestFilePath: string, testName: string): string` function that produces a Nix-style directory name for a fuzz test.

The algorithm SHALL:

1. Construct the hash input as `<relativeTestFilePath>::<testName>` using `::` as the delimiter.
2. Compute the SHA-256 digest of the UTF-8 encoded input string.
3. XOR-fold compress the 32-byte digest to 20 bytes using `compressHash`.
4. Encode the 20 bytes in Nix base32 using `toNixBase32`, producing a 32-character string.
5. Compute a sanitized slug from `testName`: replace non-`[a-zA-Z0-9\-_.]` characters with `_`, collapse consecutive underscores, strip leading/trailing underscores.
6. If the slug is non-empty and not `.` or `..`, return `<nix32hash>-<slug>`. Otherwise return `<nix32hash>` (hash only, no trailing dash).

The `::` delimiter SHALL be used because file paths do not contain `::`, making the concatenation unambiguous and preventing distinct `(filePath, testName)` pairs from producing the same hash input.

#### Scenario: Standard test name

- **WHEN** `hashTestPath("src/parser.fuzz.ts", "parses URLs")` is called
- **THEN** the result SHALL be a string matching the pattern `^[0-9a-df-np-sv-z]{32}-parses_URLs$`
- **AND** the hash portion SHALL be the Nix base32 encoding of the XOR-folded SHA-256 of `"src/parser.fuzz.ts::parses URLs"`

#### Scenario: Same test name in different files

- **WHEN** `hashTestPath("src/a.fuzz.ts", "parse")` and `hashTestPath("src/b.fuzz.ts", "parse")` are called
- **THEN** the two results SHALL have different hash prefixes
- **AND** both SHALL have the slug `parse`

#### Scenario: Same file with different test names

- **WHEN** `hashTestPath("src/a.fuzz.ts", "foo")` and `hashTestPath("src/a.fuzz.ts", "bar")` are called
- **THEN** the two results SHALL have different hash prefixes

#### Scenario: Test name with only special characters

- **WHEN** `hashTestPath("test.fuzz.ts", "...")` is called
- **THEN** the result SHALL be a 32-character Nix base32 hash with no slug suffix (no trailing dash)

#### Scenario: Deterministic output

- **WHEN** `hashTestPath` is called twice with the same arguments
- **THEN** both calls SHALL return identical strings
