## REMOVED Requirements

### Requirement: Early-exit check before serialization

**Reason**: The `is_site_at_cap` Rust function is no longer needed. Per-site cap enforcement has moved to the JS write function, which checks per-site counts before writing to the slot buffer. The NAPI `trace_cmp_record` function that called `is_site_at_cap` is removed.
**Migration**: No migration needed. The JS write function's per-site check replaces the Rust early-exit check. The Rust global cap (4,096 entries) is still enforced during bulk processing in `push()`.

### Requirement: Per-site counts reset on drain, enable, and disable

**Reason**: Per-site counts have moved from Rust to JS-local state. The reset lifecycle is now managed by the JS fuzz loop (reset at iteration start), not by Rust's `enable()`/`disable()`/`drain()`. The new behavior is specified in the `cmplog-slot-buffer` capability's "JS-local per-site counts" requirement.
**Migration**: No migration needed. The JS fuzz loop resets `counts.fill(0)` at the top of each iteration.

## MODIFIED Requirements

### Requirement: Thread-local comparison log accumulator

The system SHALL provide a thread-local `CmpLogState` in the `cmplog` module for comparison tracing during fuzz iterations. The state SHALL include:

- A heap-allocated slot buffer (`Box<[u8; SLOT_BUFFER_SIZE]>`) exposed to JS as a `Buffer` for zero-copy comparison data transfer.
- A heap-allocated write pointer (`Box<[u8; 4]>`) exposed to JS as a `Buffer` (used as `Uint32Array(1)` by JS).
- An entries vector `Vec<CmpLogEntry>` populated during `drain()` by deserializing slot buffer contents.

The write pointer SHALL double as the enabled/disabled flag:
- Enabled: `writePtr = 0` (JS starts writing from slot 0).
- Disabled: `writePtr = 0xFFFFFFFF` (JS write function's overflow check catches this).

The accumulator SHALL be disabled by default (write pointer set to `0xFFFFFFFF`). The maximum capacity SHALL remain 4096 `CmpValues` entries per iteration, enforced by Rust during bulk processing in `push()`.

#### Scenario: Accumulator is disabled by default

- **WHEN** no `Fuzzer` instance has been created
- **THEN** the write pointer SHALL be `0xFFFFFFFF`
- **AND** the JS write function SHALL return immediately for all comparisons

#### Scenario: Accumulator is enabled when Fuzzer is active

- **WHEN** a `Fuzzer` instance is created
- **THEN** `enable()` SHALL set the write pointer to 0
- **AND** the JS write function SHALL begin writing comparison data to the slot buffer

#### Scenario: Accumulator is disabled when Fuzzer is dropped

- **WHEN** a `Fuzzer` instance is dropped
- **THEN** `disable()` SHALL set the write pointer to `0xFFFFFFFF`
- **AND** the JS write function SHALL return immediately for subsequent comparisons

#### Scenario: Entries within capacity are recorded

- **WHEN** fewer than 4096 `CmpValues` entries are produced by bulk processing in a single iteration
- **THEN** all entries are present in the accumulator after `drain()`

#### Scenario: Entries beyond capacity are dropped

- **WHEN** 4096 `CmpValues` entries have been produced during bulk processing
- **AND** another buffer slot is processed
- **THEN** the resulting `CmpValues` entries are silently dropped and the accumulator size remains 4096

### Requirement: Per-site entry cap

The comparison tracing system SHALL enforce a per-site entry cap to limit hot comparison sites. Each comparison site (identified by `cmp_id`) SHALL be limited to `MAX_ENTRIES_PER_SITE` (default: 8) slot buffer entries per iteration. When a site has reached its cap, subsequent entries for that site SHALL be silently dropped by the JS write function before reaching the slot buffer.

The per-site cap SHALL be tracked using a JS-local `Uint8Array(512)`. The slot for a given `cmp_id` SHALL be determined by `cmp_id & (SITE_COUNT_SLOTS - 1)` where `SITE_COUNT_SLOTS = 512`. The count SHALL be incremented after each successful slot buffer write (one increment per comparison, regardless of how many `CmpValues` entries Rust produces from that slot during bulk processing).

Hash collisions (two distinct `cmp_id` values mapping to the same slot) cause the colliding sites to share a budget. This is acceptable because the cap is a performance heuristic, not a correctness invariant. Under-recording is always safe.

`MAX_ENTRIES_PER_SITE` MUST NOT exceed 255, since per-site counts are stored as `u8` slots in a `Uint8Array`.

The global 4,096-entry cap on `CmpValues` is enforced separately by Rust during bulk processing in `push()`.

The JS-side implementation details of this cap (array type, reset lifecycle, reset function access) are specified in the `cmplog-slot-buffer` capability's "JS-local per-site counts" requirement.

#### Scenario: Entries within per-site cap are recorded

- **WHEN** a comparison site with `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` slot buffer entries in the current iteration
- **AND** a new comparison is traced for site 42
- **THEN** the entry SHALL be written to the slot buffer

#### Scenario: Entries beyond per-site cap are dropped

- **WHEN** a comparison site with `cmp_id = 42` has already recorded `MAX_ENTRIES_PER_SITE` slot buffer entries in the current iteration
- **AND** another comparison is traced for site 42
- **THEN** the JS write function SHALL return without writing to the slot buffer

#### Scenario: Different sites have independent budgets

- **WHEN** site `cmp_id = 1` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** site `cmp_id = 2` has recorded 0 entries
- **AND** sites 1 and 2 do not collide in the count array
- **AND** a new comparison is traced for site 2
- **THEN** the entry for site 2 SHALL be written to the slot buffer

#### Scenario: Global cap still applies

- **WHEN** 4096 total `CmpValues` entries have been produced by Rust during bulk processing
- **AND** additional buffer slots remain to be processed
- **THEN** the resulting `CmpValues` entries SHALL be silently dropped by `push()`

#### Scenario: Colliding sites share a budget

- **WHEN** `cmp_id_a & (SITE_COUNT_SLOTS - 1) == cmp_id_b & (SITE_COUNT_SLOTS - 1)`
- **AND** `MAX_ENTRIES_PER_SITE` slot buffer entries have been written across sites A and B combined
- **AND** another comparison is traced for either site
- **THEN** the JS write function SHALL return without writing to the slot buffer

#### Scenario: Per-site count granularity is one comparison

- **WHEN** a numeric comparison produces 2 `CmpValues` entries during Rust bulk processing (one integer variant and one `Bytes` variant)
- **THEN** the per-site count SHALL have been incremented by 1 (at JS write time), not 2
- **AND** 8 numeric comparisons at the same site SHALL be allowed (producing up to 16 `CmpValues`)

### Requirement: JS value serialization to CmpValues

The system SHALL serialize JavaScript comparison operands to LibAFL `CmpValues` variants in a two-phase process:

**Phase 1 (JS - slot buffer write):** The JS write function serializes each operand based on `typeof`:
- `'number'`: type tag 1, raw float64 LE bytes
- `'string'`: type tag 2, UTF-8 bytes via `TextEncoder.encodeInto` (max 32 bytes, will not split multi-byte characters), byte length recorded
- All other types (`boolean`, `null`, `undefined`, `object`, `symbol`, `bigint`): early return, no entry recorded

**Phase 2 (Rust - bulk processing in drain):** Rust reads the type tags and raw bytes from each buffer slot, reconstructs `ExtractedValue` variants (`Num(f64)`, `Str(Vec<u8>)`), and calls existing `serialize_pair()` to produce `CmpValues`:
- **String + String:** `CmpValues::Bytes(CmplogBytes, CmplogBytes)` with both truncated to 32 bytes.
- **Integer + Integer (both non-negative safe integers):** smallest fitting `CmpValues` integer variant (`U8`, `U16`, `U32`, or `U64`) plus a `CmpValues::Bytes` entry with decimal string representations.
- **Non-integer numbers:** `CmpValues::Bytes` with decimal string representations via `ryu_js` formatting.
- **String + Number or Number + String:** `CmpValues::Bytes` with both converted to string representation.

The `v1_is_const` field SHALL be set to `false` for all integer `CmpValues` entries.

For strings with multi-byte UTF-8 characters near the 32-byte boundary, `TextEncoder.encodeInto` may produce 1-3 fewer bytes than the previous Rust-side byte-level truncation. This is an accepted minor deviation from exact byte-level equivalence with the old path.

#### Scenario: String comparison serialization

- **WHEN** `__vitiate_cmplog_write("hello", "world", 42, 0)` is called and `drain()` processes the entry
- **THEN** a `CmpValues::Bytes` entry is produced with left bytes `[104, 101, 108, 108, 111]` and right bytes `[119, 111, 114, 108, 100]`

#### Scenario: Long string truncation

- **WHEN** a 50-byte UTF-8 string operand is traced
- **THEN** the buffer slot contains at most 32 bytes of the string
- **AND** the `CmplogBytes` entry produced by Rust contains those bytes

#### Scenario: Integer comparison serialization

- **WHEN** `__vitiate_cmplog_write(42, 100, 10, 0)` is called and `drain()` processes the entry
- **THEN** a `CmpValues::U8((42, 100, false))` entry is produced
- **AND** a `CmpValues::Bytes` entry is produced with left bytes `"42"` and right bytes `"100"`

#### Scenario: Large integer serialization (U64)

- **WHEN** `__vitiate_cmplog_write(5000000000, 6000000000, 10, 0)` is called and `drain()` processes the entry
- **THEN** a `CmpValues::U64((5000000000, 6000000000, false))` entry is produced
- **AND** a `CmpValues::Bytes` entry is produced with left bytes `"5000000000"` and right bytes `"6000000000"`

#### Scenario: Non-integer number serialization

- **WHEN** `__vitiate_cmplog_write(3.14, 2.71, 10, 0)` is called and `drain()` processes the entry
- **THEN** a `CmpValues::Bytes` entry is produced with the decimal string representations
- **AND** no integer `CmpValues` variant is produced

#### Scenario: Non-serializable types are skipped

- **WHEN** `__vitiate_cmplog_write(null, undefined, 10, 0)` is called
- **THEN** no entry is written to the slot buffer (JS early return on unsupported left type)

#### Scenario: Mixed types with one string

- **WHEN** `__vitiate_cmplog_write("42", 42, 10, 0)` is called and `drain()` processes the entry
- **THEN** a `CmpValues::Bytes` entry is produced with both operands converted to their string representation as UTF-8 bytes

### Requirement: Drain accumulator into AflppCmpValuesMetadata

The system SHALL provide a function to drain the slot buffer into the thread-local accumulator and return the collected enriched entries as a `Vec<(CmpValues, u32, CmpLogOperator)>`. The drain process SHALL:

1. Read the write pointer to get entry count N. If N > MAX_SLOTS, return an empty Vec without modifying the write pointer. This guards against the disabled sentinel (`0xFFFFFFFF`) and any corruption, ensuring `drain()` is safe to call regardless of CmpLog state.
2. For entries 0..N:
   - Read `cmpId` and `operatorId` from the slot.
   - Map `operatorId` to `CmpLogOperator` (skip slots with invalid operator IDs).
   - Read `leftType`/`rightType` and deserialize to `ExtractedValue`:
     - Type 1 (f64): read 8 bytes as `f64` LE -> `ExtractedValue::Num`
     - Type 2 (string): read `len` bytes as UTF-8 -> `ExtractedValue::Str`
     - Type 0 or other: `ExtractedValue::Skip`
   - Call existing `serialize_pair(&left, &right)` to get `Vec<CmpValues>`.
   - Push each `CmpValues` via existing `push(entry, cmpId, operator)` (which enforces the global 4,096-entry cap).
3. Reset the write pointer to 0.
4. Return the accumulated entries and clear the entries vector.

After draining, the accumulator SHALL be empty for the next iteration.

During `reportResult()`, the drained entries SHALL be processed into `AflppCmpValuesMetadata`:
1. Group entries by site ID (`u32`) into `orig_cmpvals: HashMap<usize, Vec<CmpValues>>`.
2. Derive `AflppCmpLogHeader` for each site from the `CmpLogOperator` and operand sizes, storing in `headers: Vec<(usize, AflppCmpLogHeader)>`.
3. Initialize `new_cmpvals` as an empty `HashMap` (populated later by colorization dual trace).

#### Scenario: Drain returns all accumulated enriched entries

- **WHEN** 10 comparison entries have been written to the slot buffer during an iteration
- **AND** the accumulator is drained
- **THEN** a Vec of enriched `(CmpValues, u32, CmpLogOperator)` entries is returned (count may exceed 10 if numeric comparisons produce 2 CmpValues each)
- **AND** the write pointer is reset to 0
- **AND** the accumulator is empty

#### Scenario: Drain on empty slot buffer

- **WHEN** no comparison entries were written to the slot buffer during an iteration (`writePtr[0] == 0`)
- **AND** the accumulator is drained
- **THEN** an empty Vec is returned

#### Scenario: Drain when disabled

- **WHEN** CmpLog is disabled (`writePtr[0] == 0xFFFFFFFF`)
- **AND** `drain()` is called
- **THEN** an empty Vec SHALL be returned
- **AND** the write pointer SHALL NOT be modified (it remains `0xFFFFFFFF`)
- **AND** no slot buffer data SHALL be read

#### Scenario: Entries grouped by site ID in metadata

- **WHEN** the slot buffer contains entries with site IDs [1, 2, 1, 3, 2]
- **AND** `reportResult()` processes them
- **THEN** `orig_cmpvals[1]` SHALL contain entries from site 1
- **AND** `orig_cmpvals[2]` SHALL contain entries from site 2
- **AND** `orig_cmpvals[3]` SHALL contain entries from site 3

#### Scenario: Colorization dual trace uses slot buffer

- **WHEN** the colorization stage runs a dual trace with a colorized input
- **THEN** the target's instrumented comparisons write to the slot buffer via `__vitiate_cmplog_write`
- **AND** `drain()` processes the slot buffer entries into `new_cmpvals`
- **AND** no special code path is needed for colorization

### Requirement: AflppCmpValuesMetadata populated each iteration

During `reportResult()`, the `Fuzzer` SHALL drain the thread-local CmpLog accumulator and set the resulting entries as both `AflppCmpValuesMetadata` (site-keyed, for REDQUEEN) and `CmpValuesMetadata` (flat list, flattened from `orig_cmpvals`, for I2S) on the fuzzer state. `CmpValuesMetadata` is available to `I2SRandReplace` during the next `getNextInput()` call. `AflppCmpValuesMetadata` is available to the REDQUEEN mutation stage.

Additionally, the `Fuzzer` SHALL extract `CmpValues::Bytes` operands from the drained entries and merge them into `Tokens` metadata on the fuzzer state. Token extraction operates on the `CmpValues` component of the enriched tuples, using the same logic as before.

#### Scenario: Metadata updated after each iteration

- **WHEN** a fuzz iteration executes code containing comparisons
- **AND** `reportResult()` is called
- **THEN** the fuzzer state's `AflppCmpValuesMetadata` SHALL contain the comparison entries from that iteration, grouped by site ID

#### Scenario: Metadata cleared between iterations

- **WHEN** a fuzz iteration executes code with 5 comparisons
- **AND** `reportResult()` is called
- **AND** the next iteration executes code with 3 comparisons
- **AND** `reportResult()` is called again
- **THEN** the fuzzer state's `AflppCmpValuesMetadata.orig_cmpvals` SHALL contain exactly 3 entries total (not 8)

#### Scenario: Tokens extracted from enriched entries on reportResult

- **WHEN** a fuzz iteration executes `__vitiate_cmplog_write("http", "javascript", 42, 0)`
- **AND** `reportResult()` is called
- **THEN** the fuzzer state's `Tokens` metadata SHALL contain `"http"` and `"javascript"`
- **AND** the fuzzer state's `AflppCmpValuesMetadata` SHALL contain the corresponding entries

#### Scenario: Tokens persist across metadata replacements

- **WHEN** iteration 1 records `CmpValues::Bytes("http", "javascript")`
- **AND** `reportResult()` is called
- **AND** iteration 2 records `CmpValues::Bytes("ftp", "ssh")`
- **AND** `reportResult()` is called
- **THEN** the `Tokens` metadata SHALL contain all four tokens
- **AND** the `AflppCmpValuesMetadata` SHALL contain only the iteration 2 entries
