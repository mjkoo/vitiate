## MODIFIED Requirements

### Requirement: Trace function initialization

The runtime setup module SHALL initialize `globalThis.__vitiate_trace_cmp_record` before any test code executes.

In regression mode: `__vitiate_trace_cmp_record` SHALL be a no-op function `() => {}` with no side effects and no dependency on the napi addon. It does NOT evaluate comparisons - comparisons are performed inline in the instrumented JavaScript code.

In fuzzing mode: `__vitiate_trace_cmp_record` SHALL delegate to the napi `traceCmpRecord` function, which records comparison operands in the CmpLog accumulator for the I2S mutation engine. It does NOT evaluate comparisons.

#### Scenario: Regression mode trace function

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_trace_cmp_record` is a callable function
- **AND** calling it has no side effects and no return value
- **AND** no napi addon is loaded

#### Scenario: Fuzzing mode trace function

- **WHEN** Vitest starts with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_trace_cmp_record` delegates to the napi `traceCmpRecord` function
- **AND** comparison operands are recorded for CmpLog when a Fuzzer is active

#### Scenario: Old global name causes clear error

- **WHEN** code compiled with the old SWC plugin references `globalThis.__vitiate_trace_cmp`
- **THEN** the reference is `undefined`
- **AND** attempting to call it throws a `TypeError` (not a silent incorrect result)
