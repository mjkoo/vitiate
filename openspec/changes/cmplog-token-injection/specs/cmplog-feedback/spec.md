## MODIFIED Requirements

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
