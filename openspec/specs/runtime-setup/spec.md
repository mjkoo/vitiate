## ADDED Requirements

### Requirement: Coverage map initialization

The runtime setup module SHALL initialize `globalThis.__vitiate_cov` before any test code executes. The buffer identity SHALL remain stable for the entire process lifetime - instrumented modules cache a module-level reference and the identity MUST NOT change.

In regression mode (default): `__vitiate_cov` SHALL be a plain `Uint8Array` of the configured coverage map size (default 65536, configurable via `coverageMapSize` plugin option) that absorbs counter writes without any consumer reading the data.

In fuzzing mode (`VITIATE_FUZZ` env var is set): `__vitiate_cov` SHALL be the `Buffer` returned from `createCoverageMap(getCoverageMapSize())` backed by Rust memory for zero-copy feedback to the fuzzing engine.

#### Scenario: Regression mode initialization

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_cov` is a `Uint8Array` of the configured coverage map size
- **AND** instrumented code can write to it without errors

#### Scenario: Fuzzing mode initialization

- **WHEN** Vitest starts with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_cov` is the `Buffer` from `createCoverageMap(getCoverageMapSize())`
- **AND** the buffer is backed by Rust memory for zero-copy engine access

#### Scenario: Buffer identity is stable

- **WHEN** `globalThis.__vitiate_cov` is initialized
- **THEN** the same object reference persists for the entire process lifetime
- **AND** any module-level `let __vitiate_cov = globalThis.__vitiate_cov` cache remains valid

### Requirement: Trace function initialization

The runtime setup module SHALL initialize `globalThis.__vitiate_trace_cmp` before any test code executes.

In regression mode: `__vitiate_trace_cmp` SHALL be a pure JavaScript function that evaluates comparisons using the specified operator (`===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`) and returns the boolean result. It SHALL have no side effects and no dependency on the napi addon.

In fuzzing mode: `__vitiate_trace_cmp` SHALL delegate to the napi `traceCmp` function, which evaluates the comparison and records operands in the CmpLog accumulator for the I2S mutation engine.

#### Scenario: Regression mode trace function

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_trace_cmp("hello", "world", 0, "===")` returns `false`
- **AND** no napi addon is loaded

#### Scenario: Fuzzing mode trace function

- **WHEN** Vitest starts with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_trace_cmp` delegates to the napi `traceCmp` function
- **AND** comparison operands are recorded for CmpLog when a Fuzzer is active

### Requirement: Mode detection

The runtime setup SHALL detect fuzzing mode by checking for the `VITIATE_FUZZ` environment variable. Any truthy value (non-empty string) activates fuzzing mode.

#### Scenario: VITIATE_FUZZ not set

- **WHEN** the `VITIATE_FUZZ` environment variable is not set or is empty
- **THEN** regression mode is activated

#### Scenario: VITIATE_FUZZ set to 1

- **WHEN** `VITIATE_FUZZ=1` is set
- **THEN** fuzzing mode is activated

#### Scenario: VITIATE_FUZZ set to a non-boolean truthy value

- **WHEN** `VITIATE_FUZZ=parser` is set
- **THEN** fuzzing mode is activated (any truthy value activates fuzzing mode; the value itself is not used as a filter)
