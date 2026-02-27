## MODIFIED Requirements

### Requirement: Passthrough behavior (no LibAFL feedback)

The `traceCmp` function SHALL evaluate the comparison and return the correct boolean result.
When a `Fuzzer` instance is active (CmpLog recording is enabled), the function SHALL
additionally record the comparison operands in the thread-local CmpLog accumulator before
returning the result. When no `Fuzzer` is active, the function SHALL behave as a pure
passthrough with no side effects beyond the comparison evaluation.

#### Scenario: No side effects in regression mode

- **WHEN** `traceCmp` is called during regression mode (no active Fuzzer)
- **THEN** the fuzzer's corpus, coverage map, and statistics are unaffected by the call
- **AND** no comparison operands are recorded anywhere

#### Scenario: Comparison operands recorded during fuzzing

- **WHEN** a `Fuzzer` instance is active
- **AND** `traceCmp("hello", "world", 42, "===")` is called
- **THEN** the function returns `false` (correct comparison result)
- **AND** the comparison operands are recorded in the CmpLog accumulator as
  `CmpValues::Bytes` with the UTF-8 representations of `"hello"` and `"world"`

#### Scenario: Return value unaffected by recording

- **WHEN** a `Fuzzer` instance is active
- **AND** `traceCmp(1, 1, 0, "===")` is called
- **THEN** the function returns `true`
- **AND** the comparison operands are recorded
- **AND** the return value is identical to what it would be without CmpLog recording
