## Requirements

### Requirement: Thread-local comparison log accumulator

The system SHALL provide a thread-local `Vec<CmpValues>` accumulator in the `cmplog` module that
comparison tracing calls can append to during a fuzz iteration. The accumulator SHALL be disabled
by default (no entries recorded) and enabled only when a `Fuzzer` instance is active.

#### Scenario: Accumulator is disabled by default

- **WHEN** no `Fuzzer` instance has been created
- **AND** comparison values are pushed to the accumulator
- **THEN** the accumulator remains empty (entries are silently dropped)

#### Scenario: Accumulator is enabled when Fuzzer is active

- **WHEN** a `Fuzzer` instance is created
- **THEN** the CmpLog accumulator is enabled
- **AND** subsequent comparison value pushes are recorded

#### Scenario: Accumulator is disabled when Fuzzer is dropped

- **WHEN** a `Fuzzer` instance is dropped
- **THEN** the CmpLog accumulator is disabled
- **AND** subsequent comparison value pushes are silently dropped

### Requirement: Accumulator capacity limit

The accumulator SHALL enforce a maximum capacity of 4096 entries per iteration. When the
accumulator is full, new entries SHALL be silently dropped.

#### Scenario: Entries within capacity are recorded

- **WHEN** fewer than 4096 comparison values are pushed in a single iteration
- **THEN** all entries are present in the accumulator

#### Scenario: Entries beyond capacity are dropped

- **WHEN** 4096 comparison values have already been pushed in a single iteration
- **AND** another value is pushed
- **THEN** the new entry is silently dropped and the accumulator size remains 4096

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

### Requirement: Drain accumulator into CmpValuesMetadata

The system SHALL provide a function to drain the thread-local accumulator and return the
collected entries as a `Vec<CmpValues>` suitable for insertion into `CmpValuesMetadata`
on the fuzzer state. After draining, the accumulator SHALL be empty for the next iteration.

#### Scenario: Drain returns all accumulated entries

- **WHEN** 10 comparison values have been recorded during an iteration
- **AND** the accumulator is drained
- **THEN** a Vec of 10 `CmpValues` entries is returned
- **AND** the accumulator is empty

#### Scenario: Drain on empty accumulator

- **WHEN** no comparison values were recorded during an iteration
- **AND** the accumulator is drained
- **THEN** an empty Vec is returned

### Requirement: I2SRandReplace mutator integration

The `Fuzzer` SHALL include LibAFL's `I2SRandReplace` mutator in its mutation pipeline.
After the standard havoc mutation, `I2SRandReplace` SHALL be applied to the mutated input.
`I2SRandReplace` reads `CmpValuesMetadata` from the fuzzer state and replaces byte patterns
matching one comparison operand with the other.

#### Scenario: I2S mutation applied after havoc

- **WHEN** `getNextInput()` is called on a Fuzzer with `CmpValuesMetadata` in its state
- **THEN** the input is first mutated by havoc mutations and then by `I2SRandReplace`

#### Scenario: I2S skips when no comparison metadata exists

- **WHEN** `getNextInput()` is called and the state has no `CmpValuesMetadata`
  (e.g., first iteration before any `reportResult`)
- **THEN** `I2SRandReplace` returns `MutationResult::Skipped` and the input is
  unaffected by I2S (only havoc mutations apply)

#### Scenario: I2S replaces matching bytes

- **WHEN** the input contains the bytes `"test"` and `CmpValuesMetadata` contains
  `CmpValues::Bytes("test", "pass")`
- **THEN** `I2SRandReplace` may replace `"test"` with `"pass"` in the input

### Requirement: CmpValuesMetadata populated each iteration

During `reportResult()`, the `Fuzzer` SHALL drain the thread-local CmpLog accumulator
and set the resulting entries as `CmpValuesMetadata` on the fuzzer state. This metadata
is then available to `I2SRandReplace` during the next `getNextInput()` call.

Additionally, the `Fuzzer` SHALL extract `CmpValues::Bytes` operands from the drained entries and merge them into `Tokens` metadata on the fuzzer state. This enables `TokenInsert` and `TokenReplace` mutations to use comparison operands as dictionary entries, allowing length-changing mutations that `I2SRandReplace` cannot perform.

#### Scenario: Metadata updated after each iteration

- **WHEN** a fuzz iteration executes code containing comparisons
- **AND** `reportResult()` is called
- **THEN** the fuzzer state's `CmpValuesMetadata` contains the comparison entries
  from that iteration

#### Scenario: Metadata cleared between iterations

- **WHEN** a fuzz iteration executes code with 5 comparisons
- **AND** `reportResult()` is called
- **AND** the next iteration executes code with 3 comparisons
- **AND** `reportResult()` is called again
- **THEN** the fuzzer state's `CmpValuesMetadata` contains exactly 3 entries
  (not 8)

#### Scenario: Tokens extracted from Bytes entries on reportResult

- **WHEN** a fuzz iteration executes `__vitiate_trace_cmp("http", "javascript", ...)`
- **AND** `reportResult()` is called
- **THEN** the fuzzer state's `Tokens` metadata SHALL contain `"http"` and `"javascript"`
- **AND** the fuzzer state's `CmpValuesMetadata` SHALL contain the `CmpValues::Bytes` entry

#### Scenario: Tokens persist across CmpValuesMetadata replacements

- **WHEN** iteration 1 records `CmpValues::Bytes("http", "javascript")`
- **AND** `reportResult()` is called (tokens extracted, CmpValuesMetadata set)
- **AND** iteration 2 records `CmpValues::Bytes("ftp", "ssh")`
- **AND** `reportResult()` is called (CmpValuesMetadata replaced with iteration 2 entries)
- **THEN** the `Tokens` metadata SHALL contain all four tokens: `"http"`, `"javascript"`, `"ftp"`, `"ssh"`
- **AND** the `CmpValuesMetadata` SHALL contain only the iteration 2 entries
