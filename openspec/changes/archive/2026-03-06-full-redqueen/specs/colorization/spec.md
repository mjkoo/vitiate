## ADDED Requirements

### Requirement: Colorization stage identifies free byte ranges

The system SHALL implement a colorization stage that identifies input byte ranges which do not affect the coverage pattern ("free bytes"). The colorization stage SHALL run as an interactive stage within the stage pipeline, using the same `beginStage()` / `advanceStage()` protocol as the generalization stage.

The colorization stage SHALL only run when REDQUEEN is enabled and the input length is at most `MAX_COLORIZATION_LEN` (4096 bytes). Inputs exceeding this threshold SHALL skip colorization entirely.

#### Scenario: Colorization runs for small input with REDQUEEN enabled

- **WHEN** `beginStage()` is called for an interesting corpus entry
- **AND** REDQUEEN is enabled
- **AND** the corpus entry is at most 4096 bytes
- **THEN** the colorization stage SHALL begin
- **AND** the first candidate SHALL be the original corpus entry (for baseline coverage hash computation)

#### Scenario: Colorization skipped for oversized input

- **WHEN** `beginStage()` is called for an interesting corpus entry
- **AND** REDQUEEN is enabled
- **AND** the corpus entry exceeds 4096 bytes
- **THEN** colorization SHALL be skipped
- **AND** the pipeline SHALL fall through to I2S (since REDQUEEN did not run)

#### Scenario: Colorization skipped when REDQUEEN disabled

- **WHEN** `beginStage()` is called for an interesting corpus entry
- **AND** REDQUEEN is disabled
- **THEN** colorization SHALL be skipped

### Requirement: Colorization binary search algorithm

The colorization stage SHALL use a binary search algorithm to identify free byte ranges:

1. `begin_colorization()` returns the original input for execution (to establish the baseline coverage pattern). It also applies `type_replace()` to produce a changed copy of the input and initializes the full range `[0, len)` as a single pending range.
2. The first `advance_colorization()` call computes the coverage hash from the coverage map left by the baseline execution as the `original_hash`. It then zeros the coverage map, copies the changed bytes for the first pending range into the candidate, and yields it for execution. Note: the baseline execution's coverage is only hashed (not evaluated via `evaluate_coverage()`), matching the generalization Verify phase pattern.
3. Each subsequent `advance_colorization()` call processes one step of the binary search:
   a. Compute the coverage hash of the last execution and compare it to `original_hash`.
   b. If the hash matches the baseline: the range is free — record it as a taint range.
   c. If the hash differs: revert the bytes, split the range in half, and push both halves as new pending ranges. Ranges of length 1 that differ are discarded (the byte is not free).
   d. Zero the coverage map.
   e. Pop the next pending range (largest first), copy the corresponding bytes from the changed input into the candidate, and yield it for execution.
4. When all pending ranges are processed or `max_executions` (2 * input_len) is reached: merge adjacent taint ranges. The `max_executions` cap applies only to the binary search phase; the dual trace always runs regardless. `TaintMetadata` is NOT stored at this point — it is deferred until the dual trace completes successfully (see the Dual CmpLog trace requirement).

#### Scenario: Entire input is free

- **WHEN** the corpus entry's coverage pattern is unchanged regardless of byte values
- **THEN** colorization SHALL produce a single taint range covering `[0, len)`
- **AND** the total execution count SHALL be approximately 3 (baseline + one full-range test + dual trace)

#### Scenario: No bytes are free

- **WHEN** every byte in the input affects the coverage pattern
- **THEN** colorization SHALL produce an empty taint range list
- **AND** the total execution count SHALL be approximately `2 * input_len`

#### Scenario: Partial free ranges

- **WHEN** bytes in range `[10, 20)` do not affect coverage but all other bytes do
- **THEN** colorization SHALL produce a taint range including `[10, 20)`
- **AND** no taint range SHALL include bytes outside `[10, 20)` that affect coverage

#### Scenario: Max executions reached

- **WHEN** the colorization stage reaches `2 * input_len` executions
- **AND** pending ranges remain
- **THEN** the stage SHALL stop processing pending ranges
- **AND** SHALL store a `TaintMetadata` from the taint ranges identified so far

#### Scenario: Adjacent taint ranges are merged

- **WHEN** the binary search identifies free ranges `[5, 10)` and `[10, 15)`
- **THEN** the stored `TaintMetadata` SHALL contain the merged range `[5, 15)`

#### Scenario: Coverage map zeroed between colorization iterations

- **WHEN** a colorization iteration computes the coverage hash
- **THEN** the coverage map SHALL be zeroed before the next colorization candidate is executed

### Requirement: Type-preserving byte replacement

The system SHALL provide a `type_replace()` function that produces a copy of the input with every byte replaced by a value guaranteed to differ from the original, while preserving character class where applicable. The function SHALL follow LibAFL's `type_replace` algorithm (`colorization.rs`):

- `0x00` → `0x01` (deterministic).
- `0x01` → `0x00` (deterministic). `0xFF` → `0x00` (deterministic).
- `'0'` ↔ `'1'` swap deterministically. Digits `'2'`–`'9'` are replaced with a random digit from `'3'`–`'9'` (excluding the original).
- Hex letters (`'A'`–`'F'`, `'a'`–`'f'`) are replaced with a random hex letter of the same case (excluding the original).
- Non-hex uppercase letters (`'G'`–`'Z'`) are replaced with a random uppercase letter from the full `'A'`–`'Z'` range (excluding the original).
- Non-hex lowercase letters (`'g'`–`'z'`) are replaced with a random lowercase letter from the full `'a'`–`'z'` range (excluding the original).
- Whitespace pairs swap deterministically: tab (`0x09`) ↔ space (`0x20`), CR (`0x0D`) ↔ LF (`0x0A`).
- `'+'` ↔ `'/'` swap deterministically.
- Low bytes (`< 0x20`, excluding the special cases above) are replaced via `XOR 0x1F`.
- All other bytes (printable punctuation, high bytes, etc.) are replaced via `XOR 0x7F`.

The key invariant is: **every byte SHALL be replaced with a value that differs from the original**. The replacement SHALL be deterministic for a given random seed (using the fuzzer's RNG) for the non-deterministic cases (digit/letter randomization).

#### Scenario: Digit replaced with digit

- **WHEN** `type_replace()` processes a byte with value `0x35` (ASCII '5')
- **THEN** the replacement byte SHALL be an ASCII digit
- **AND** the replacement SHALL differ from the original

#### Scenario: Lowercase letter replaced with lowercase letter

- **WHEN** `type_replace()` processes a byte with value `0x61` (ASCII 'a')
- **THEN** the replacement byte SHALL be a lowercase hex letter (`'a'`–`'f'`, excluding `'a'`)

#### Scenario: Null byte replaced deterministically

- **WHEN** `type_replace()` processes a byte with value `0x00`
- **THEN** the replacement byte SHALL be `0x01`

#### Scenario: Non-class byte replaced via XOR

- **WHEN** `type_replace()` processes a byte with value `0x80`
- **THEN** the replacement byte SHALL be `0x80 XOR 0x7F` = `0xFF`
- **AND** the replacement SHALL differ from the original

### Requirement: Coverage hash for pattern comparison

The system SHALL provide a `coverage_hash()` function that computes a fast u64 hash of the coverage pattern (the set of nonzero coverage map indices). The hash SHALL:

- Consider only whether each coverage map entry is nonzero, not the actual hit count.
- Use a fast hash function suitable for per-execution use (not a cryptographic hash).
- Produce identical hashes for coverage maps that have the same set of nonzero indices, regardless of hit count values.

#### Scenario: Same coverage pattern produces same hash

- **WHEN** two executions produce coverage maps where the same indices are nonzero
- **AND** the actual hit counts differ
- **THEN** `coverage_hash()` SHALL return the same u64 value for both maps

#### Scenario: Different coverage patterns produce different hashes

- **WHEN** two executions produce coverage maps where different indices are nonzero
- **THEN** `coverage_hash()` SHALL return different u64 values (with overwhelming probability)

### Requirement: TaintMetadata storage

After the dual trace completes successfully, the system SHALL store a `TaintMetadata` instance on the **fuzzer state** (via `state.metadata_map_mut()`) containing:

- `ranges: Vec<Range<usize>>` — the merged free byte ranges identified by the binary search.
- `input_vec: Vec<u8>` — the colorized input (all taint ranges filled with type-replaced bytes).

This metadata SHALL be readable by the REDQUEEN mutation stage (which reads both `TaintMetadata` and `AflppCmpValuesMetadata` from `state.metadata_map()`).

If the colorization stage is aborted (crash/timeout), no `TaintMetadata` SHALL be stored.

#### Scenario: TaintMetadata stored after successful colorization

- **WHEN** colorization completes normally
- **THEN** `TaintMetadata` SHALL be stored on the fuzzer state
- **AND** it SHALL contain the merged free byte ranges
- **AND** it SHALL contain the colorized input vector (all taint ranges filled with type-replaced bytes)

#### Scenario: No TaintMetadata on abort

- **WHEN** colorization is aborted via `abortStage()`
- **THEN** no `TaintMetadata` SHALL be stored on the fuzzer state

### Requirement: Dual CmpLog trace as colorization terminal step

After the binary search phase of colorization completes, the system SHALL execute one additional "dual trace" execution: the fully-colorized input (all taint ranges filled with type-replaced bytes) SHALL be executed with CmpLog capture enabled.

During this execution, the CmpLog accumulator SHALL be drained and retained (not discarded). The drained enriched entries SHALL be grouped by site ID (using the same grouping logic as `orig_cmpvals` in `reportResult()`) to produce the `new_cmpvals` map for `AflppCmpValuesMetadata`. This is the only stage execution that captures CmpLog data.

After the dual trace completes successfully, the system SHALL store `TaintMetadata` on the fuzzer state (containing the merged free byte ranges and the colorized input vector). This deferred storage ensures that if the dual trace is aborted (crash/timeout), no `TaintMetadata` is stored.

The dual trace execution SHALL be distinguished from normal colorization iterations by an `awaiting_dual_trace` flag on the Colorization stage state.

#### Scenario: Dual trace captures CmpLog data

- **WHEN** colorization binary search completes
- **AND** the colorized input is executed as the dual trace
- **THEN** the CmpLog accumulator SHALL be drained
- **AND** the drained entries SHALL be stored as `new_cmpvals` in `AflppCmpValuesMetadata` (keyed by comparison site ID)
- **AND** the entries SHALL NOT be discarded

#### Scenario: Dual trace uses fully colorized input

- **WHEN** the dual trace execution begins
- **THEN** the candidate input SHALL have all identified taint ranges filled with type-replaced bytes
- **AND** all non-taint bytes SHALL remain as the original input
- **AND** this colorized input is the same as what is stored in `TaintMetadata.input_vec`

#### Scenario: Colorization with no free ranges still runs dual trace

- **WHEN** colorization identifies no free byte ranges (empty taint)
- **THEN** the dual trace SHALL still execute (using the original input unchanged)
- **AND** `new_cmpvals` SHALL still be populated
