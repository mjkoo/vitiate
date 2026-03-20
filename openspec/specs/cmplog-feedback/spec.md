## Requirements

### Requirement: CmpLogOperator enum

The system SHALL define a `CmpLogOperator` enum with the following variants:
- `Equal` - derived from `"==="` and `"=="`
- `NotEqual` - derived from `"!=="` and `"!="`
- `Less` - derived from `"<"` and `"<="`
- `Greater` - derived from `">"` and `">="`

#### Scenario: trace_cmp stores site ID and operator

- **WHEN** `trace_cmp(left, right, 42, "===")` is called
- **THEN** the accumulator entry SHALL contain the `CmpValues` for the operands, site ID `42`, and `CmpLogOperator::Equal`

#### Scenario: Less-than operator mapped

- **WHEN** `trace_cmp(left, right, 7, "<")` is called
- **THEN** the accumulator entry SHALL contain site ID `7` and `CmpLogOperator::Less`

#### Scenario: Less-than-or-equal mapped to Less

- **WHEN** `trace_cmp(left, right, 7, "<=")` is called
- **THEN** the accumulator entry SHALL contain `CmpLogOperator::Less`

#### Scenario: Not-equal operator mapped

- **WHEN** `trace_cmp(left, right, 3, "!==")` is called
- **THEN** the accumulator entry SHALL contain `CmpLogOperator::NotEqual`

### Requirement: Thread-local comparison log accumulator

The system SHALL provide a thread-local accumulator in the `cmplog` module that comparison tracing calls can append to during a fuzz iteration. The accumulator SHALL store enriched entries of type `(CmpValues, u32, CmpLogOperator)` - comparison operand data, site ID, and operator type.

The accumulator SHALL be disabled by default (no entries recorded) and enabled only when a `Fuzzer` instance is active. The maximum capacity SHALL remain 4096 entries per iteration. When the accumulator is full, new entries SHALL be silently dropped. Additionally, each comparison site SHALL be limited to `MAX_ENTRIES_PER_SITE` entries per iteration via the per-site entry cap.

The accumulator state SHALL include a fixed-size `[u8; SITE_COUNT_SLOTS]` count array for per-site tracking.

#### Scenario: Accumulator is disabled by default

- **WHEN** no `Fuzzer` instance has been created
- **AND** comparison values are pushed to the accumulator
- **THEN** the accumulator remains empty (entries are silently dropped)

#### Scenario: Accumulator is enabled when Fuzzer is active

- **WHEN** a `Fuzzer` instance is created
- **THEN** the CmpLog accumulator is enabled
- **AND** subsequent comparison value pushes are recorded with site ID and operator
- **AND** per-site counts are tracked

#### Scenario: Accumulator is disabled when Fuzzer is dropped

- **WHEN** a `Fuzzer` instance is dropped
- **THEN** the CmpLog accumulator is disabled
- **AND** subsequent comparison value pushes are silently dropped

#### Scenario: Entries within capacity are recorded

- **WHEN** fewer than 4096 enriched entries are pushed in a single iteration
- **AND** no individual site exceeds `MAX_ENTRIES_PER_SITE`
- **THEN** all entries are present in the accumulator

#### Scenario: Entries beyond capacity are dropped

- **WHEN** 4096 enriched entries have already been pushed in a single iteration
- **AND** another value is pushed
- **THEN** the new entry is silently dropped and the accumulator size remains 4096

### Requirement: Per-site entry cap

The CmpLog accumulator SHALL enforce a per-site entry cap in addition to the global 4096-entry cap. Each comparison site (identified by `cmp_id`) SHALL be limited to `MAX_ENTRIES_PER_SITE` (default: 8) entries per iteration. When a site has reached its cap, subsequent entries for that site SHALL be silently dropped.

The per-site cap SHALL be tracked using a fixed-size count array of `SITE_COUNT_SLOTS` (default: 512) `u8` slots. The slot for a given `cmp_id` SHALL be determined by `cmp_id & (SITE_COUNT_SLOTS - 1)`. Counts SHALL saturate at `MAX_ENTRIES_PER_SITE` (never overflow).

Hash collisions (two distinct `cmp_id` values mapping to the same slot) cause the colliding sites to share a budget. This is acceptable because the cap is a performance heuristic, not a correctness invariant. Under-recording is always safe.

`MAX_ENTRIES_PER_SITE` MUST NOT exceed 255, since per-site counts are stored as `u8`.

#### Scenario: Entries within per-site cap are recorded

- **WHEN** a comparison site with `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries in the current iteration
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded in the accumulator

#### Scenario: Entries beyond per-site cap are dropped

- **WHEN** a comparison site with `cmp_id = 42` has already recorded `MAX_ENTRIES_PER_SITE` entries in the current iteration
- **AND** another entry is pushed for site 42
- **THEN** the new entry SHALL be silently dropped
- **AND** the global entry count SHALL NOT increase

#### Scenario: Different sites have independent budgets

- **WHEN** site `cmp_id = 1` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** site `cmp_id = 2` has recorded 0 entries
- **AND** sites 1 and 2 do not collide in the count array
- **AND** a new entry is pushed for site 2
- **THEN** the entry for site 2 SHALL be recorded

#### Scenario: Global cap still applies

- **WHEN** 4096 total entries have been recorded across all sites
- **AND** a site that has not reached its per-site cap pushes a new entry
- **THEN** the entry SHALL be silently dropped (global cap takes precedence)

#### Scenario: Colliding sites share a budget

- **WHEN** `cmp_id_a & (SITE_COUNT_SLOTS - 1) == cmp_id_b & (SITE_COUNT_SLOTS - 1)`
- **AND** `MAX_ENTRIES_PER_SITE` entries have been recorded across sites A and B combined
- **AND** another entry is pushed for either site
- **THEN** the entry SHALL be silently dropped

#### Scenario: Multi-entry serialization counts against per-site cap

- **WHEN** a numeric comparison produces 2 `CmpValues` entries (one integer variant and one `Bytes` variant)
- **THEN** both entries SHALL count toward the per-site cap for that `cmp_id`
- **AND** the 5th numeric comparison at the same site (attempting entries 9 and 10) SHALL have its entries dropped

#### Scenario: Partial multi-entry drop at cap boundary

- **WHEN** a comparison site has recorded 7 entries (one slot remaining under `MAX_ENTRIES_PER_SITE`)
- **AND** a numeric comparison produces 2 `CmpValues` entries for that site
- **THEN** the first entry SHALL be recorded (count becomes 8)
- **AND** the second entry SHALL be silently dropped (count is at cap)

### Requirement: Early-exit check before serialization

The CmpLog module SHALL provide a public `is_site_at_cap(cmp_id: u32) -> bool` function that returns `true` when the per-site count for the given `cmp_id` has reached `MAX_ENTRIES_PER_SITE`, or when the accumulator is disabled, or when the global cap has been reached.

`trace_cmp_record` SHALL call `is_site_at_cap` before `serialize_to_cmp_values`. When `is_site_at_cap` returns `true`, serialization (NAPI type extraction, value extraction, ryu_js formatting, allocation) SHALL be skipped entirely.

#### Scenario: Serialization skipped for capped site

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `trace_cmp_record` is called with `cmp_id = 42`
- **THEN** `is_site_at_cap(42)` SHALL return `true`
- **AND** `serialize_to_cmp_values` SHALL NOT be called

#### Scenario: Serialization proceeds for uncapped site

- **WHEN** site `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries
- **AND** the accumulator is enabled and below the global cap
- **THEN** `is_site_at_cap(42)` SHALL return `false`
- **AND** serialization SHALL proceed normally

#### Scenario: Early exit when disabled

- **WHEN** the accumulator is disabled (no active Fuzzer)
- **THEN** `is_site_at_cap` SHALL return `true` for any `cmp_id`

#### Scenario: Early exit at global cap

- **WHEN** 4096 entries have been recorded across all sites
- **AND** site `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries
- **THEN** `is_site_at_cap(42)` SHALL return `true`

### Requirement: Per-site counts reset on drain, enable, and disable

The per-site count array SHALL be zeroed when the accumulator is drained (via `drain()`), when CmpLog recording is enabled (via `enable()`), and when CmpLog recording is disabled (via `disable()`). This ensures each fuzz iteration and each fuzzing session starts with a fresh per-site budget, and that stale counts do not persist across enable/disable cycles.

#### Scenario: Counts reset on drain

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `drain()` is called
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded (the per-site count was reset)

#### Scenario: Counts reset on enable

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `enable()` is called
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded (the per-site count was reset)

#### Scenario: Counts reset on disable

- **WHEN** `disable()` is called
- **THEN** the per-site count array SHALL be zeroed

### Requirement: JS value serialization to CmpValues

The system SHALL serialize JavaScript comparison operands to LibAFL `CmpValues` variants
according to the following rules:

- **String operands:** Both operands are converted to UTF-8 bytes and stored as
  `CmpValues::Bytes(CmplogBytes, CmplogBytes)`. Strings longer than 32 bytes are truncated
  to 32 bytes.
- **Integer number operands (both sides are safe integers):** Stored as the smallest fitting
  `CmpValues` integer variant (`U8`, `U16`, or `U32`) based on the maximum absolute value
  of either operand. Additionally, a `CmpValues::Bytes` entry is emitted with each operand's
  decimal string representation as UTF-8 bytes.
- **Non-integer number operands:** Both operands are converted to their decimal string
  representation and stored as `CmpValues::Bytes`.
- **All other types (boolean, null, undefined, object, symbol, BigInt):** The comparison
  is skipped -- no entry is recorded.

The `v1_is_const` field SHALL be set to `false` for all integer `CmpValues` entries, since
the system cannot statically determine which operand originates from the input.

#### Scenario: String comparison serialization

- **WHEN** `traceCmp` is called with `left = "hello"` and `right = "world"`
- **THEN** a `CmpValues::Bytes` entry is recorded with left bytes `[104, 101, 108, 108, 111]`
  and right bytes `[119, 111, 114, 108, 100]`

#### Scenario: Long string truncation

- **WHEN** `traceCmp` is called with a 50-byte string operand
- **THEN** the `CmplogBytes` entry contains only the first 32 bytes

#### Scenario: Integer comparison serialization

- **WHEN** `traceCmp` is called with `left = 42` and `right = 100`
- **THEN** a `CmpValues::U8((42, 100, false))` entry is recorded
- **AND** a `CmpValues::Bytes` entry is recorded with left bytes `"42"` and right bytes `"100"`

#### Scenario: Integer fitting to U16

- **WHEN** `traceCmp` is called with `left = 1000` and `right = 2000`
- **THEN** a `CmpValues::U16((1000, 2000, false))` entry is recorded
- **AND** a `CmpValues::Bytes` entry is recorded with string representations

#### Scenario: Non-integer number serialization

- **WHEN** `traceCmp` is called with `left = 3.14` and `right = 2.71`
- **THEN** a `CmpValues::Bytes` entry is recorded with the decimal string representations
- **AND** no integer `CmpValues` variant is recorded

#### Scenario: Non-serializable types are skipped

- **WHEN** `traceCmp` is called with `left = null` and `right = undefined`
- **THEN** no entry is recorded in the accumulator

#### Scenario: Mixed types with one string

- **WHEN** `traceCmp` is called with `left = "42"` and `right = 42`
- **THEN** a `CmpValues::Bytes` entry is recorded with both operands converted to their
  string representation as UTF-8 bytes

### Requirement: Drain accumulator into AflppCmpValuesMetadata

The system SHALL provide a function to drain the thread-local accumulator and return the collected enriched entries as a `Vec<(CmpValues, u32, CmpLogOperator)>`. After draining, the accumulator SHALL be empty for the next iteration.

During `reportResult()`, the drained entries SHALL be processed into `AflppCmpValuesMetadata`:
1. Group entries by site ID (`u32`) into `orig_cmpvals: HashMap<usize, Vec<CmpValues>>`.
2. Derive `AflppCmpLogHeader` for each site from the `CmpLogOperator` and operand sizes, storing in `headers: Vec<(usize, AflppCmpLogHeader)>`.
3. Initialize `new_cmpvals` as an empty `HashMap` (populated later by colorization dual trace).

#### Scenario: Drain returns all accumulated enriched entries

- **WHEN** 10 comparison values have been recorded during an iteration
- **AND** the accumulator is drained
- **THEN** a Vec of 10 `(CmpValues, u32, CmpLogOperator)` entries is returned
- **AND** the accumulator is empty

#### Scenario: Drain on empty accumulator

- **WHEN** no comparison values were recorded during an iteration
- **AND** the accumulator is drained
- **THEN** an empty Vec is returned

#### Scenario: Entries grouped by site ID in metadata

- **WHEN** the accumulator contains entries with site IDs [1, 2, 1, 3, 2]
- **AND** `reportResult()` processes them
- **THEN** `orig_cmpvals[1]` SHALL contain 2 entries
- **AND** `orig_cmpvals[2]` SHALL contain 2 entries
- **AND** `orig_cmpvals[3]` SHALL contain 1 entry

### Requirement: Site-keyed CmpLog metadata

The system SHALL store CmpLog metadata in `AflppCmpValuesMetadata` format, which keys comparison values by site ID. The metadata SHALL contain:

- `orig_cmpvals: HashMap<usize, Vec<CmpValues>>` - comparison values from the main loop execution, keyed by comparison site ID.
- `new_cmpvals: HashMap<usize, Vec<CmpValues>>` - comparison values from the dual trace execution (colorized input), keyed by comparison site ID.
- `headers: Vec<(usize, AflppCmpLogHeader)>` - comparison attributes (operator type, operand size) per site ID, stored as a list of (site ID, header) tuples.

The `orig_cmpvals` and `headers` SHALL be populated during `reportResult()` by draining the enriched CmpLog accumulator, grouping entries by site ID, and deriving header attributes from the `CmpLogOperator`.

The `new_cmpvals` SHALL be populated during the dual trace step of the colorization stage.

#### Scenario: CmpLog entries grouped by site ID

- **WHEN** a fuzz iteration produces comparisons at sites 1, 2, and 1 (site 1 hit twice)
- **AND** `reportResult()` is called
- **THEN** `orig_cmpvals[1]` SHALL contain 2 entries
- **AND** `orig_cmpvals[2]` SHALL contain 1 entry

#### Scenario: Headers record operator attributes

- **WHEN** site ID 5 has `CmpLogOperator::Less` and operands are `U32` values
- **THEN** `headers` SHALL contain a `(5, header)` tuple where `header` indicates `CMP_ATTRIBUTE_IS_LESSER` and the appropriate operand size

#### Scenario: new_cmpvals initially empty

- **WHEN** `reportResult()` populates `AflppCmpValuesMetadata`
- **THEN** `new_cmpvals` SHALL be an empty HashMap
- **AND** it SHALL be populated later by the colorization dual trace step

### Requirement: Dual metadata storage for I2S compatibility

During `reportResult()`, the system SHALL store **both** metadata types on the fuzzer state:

- `AflppCmpValuesMetadata` - site-keyed, used by REDQUEEN.
- `CmpValuesMetadata` - flat list, synthesized by flattening `orig_cmpvals` values into a `Vec<CmpValues>` at drain time. Used by I2S mutators with zero code changes.

Both metadata types are populated once during `reportResult()`. No runtime adapter is needed - I2S mutators read `CmpValuesMetadata` as before.

#### Scenario: I2S reads from flat metadata

- **WHEN** `reportResult()` processes enriched CmpLog entries with sites 1 and 2
- **THEN** `CmpValuesMetadata.list` SHALL contain all entries from both sites (flattened)
- **AND** `I2SRandReplace` SHALL operate identically to before

#### Scenario: I2S works when orig_cmpvals is empty

- **WHEN** `reportResult()` processes an empty CmpLog drain
- **THEN** `CmpValuesMetadata` SHALL have an empty list
- **AND** `I2SRandReplace` SHALL return `MutationResult::Skipped`

### Requirement: I2SRandReplace mutator integration

The `Fuzzer` SHALL include LibAFL's `I2SRandReplace` mutator in its mutation pipeline. After the standard havoc mutation, `I2SRandReplace` SHALL be applied to the mutated input. `I2SRandReplace` reads `CmpValuesMetadata` from the fuzzer state.

Since `reportResult()` stores both `AflppCmpValuesMetadata` and `CmpValuesMetadata` (flattened from `orig_cmpvals`) on the state, the I2S mutator reads `CmpValuesMetadata` directly with zero code changes.

#### Scenario: I2S mutation applied after havoc

- **WHEN** `getNextInput()` is called on a Fuzzer with `CmpValuesMetadata` in its state
- **THEN** the input is first mutated by havoc mutations and then by `I2SRandReplace`
- **AND** `I2SRandReplace` reads `CmpValuesMetadata` directly (populated by `reportResult()`)

#### Scenario: I2S skips when no comparison metadata exists

- **WHEN** `getNextInput()` is called and the state has no `CmpValuesMetadata`
- **THEN** `I2SRandReplace` returns `MutationResult::Skipped` and the input is unaffected by I2S

#### Scenario: I2S replaces matching bytes

- **WHEN** the input contains the bytes `"test"` and `CmpValuesMetadata.list` contains `CmpValues::Bytes("test", "pass")`
- **THEN** `I2SRandReplace` may replace `"test"` with `"pass"` in the input

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

- **WHEN** a fuzz iteration executes `__vitiate_trace_cmp("http", "javascript", ...)`
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
