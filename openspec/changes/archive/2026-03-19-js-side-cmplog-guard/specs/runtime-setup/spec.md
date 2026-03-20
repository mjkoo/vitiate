## MODIFIED Requirements

### Requirement: Trace function initialization

The runtime setup module SHALL initialize `globalThis.__vitiate_cmplog_write` before any test code executes. The function reference SHALL remain stable for the entire process lifetime - instrumented modules cache a module-level reference and the identity MUST NOT change.

In regression mode (default): `__vitiate_cmplog_write` SHALL be a no-op function `(_l, _r, _c, _o) => {}` with no side effects and no dependency on the napi addon. It does NOT evaluate comparisons - comparisons are performed inline in the instrumented JavaScript code.

In fuzzing mode: `__vitiate_cmplog_write` SHALL be a pure JS function that writes comparison operands (type tag + raw bytes) into a Rust-owned shared-memory slot buffer. It does NOT evaluate comparisons. It does NOT cross the NAPI boundary on the hot path. The slot buffer and write pointer are obtained via one-time NAPI calls to `cmplogGetSlotBuffer()` and `cmplogGetWritePointer()` during initialization.

The initialization SHALL also allocate JS-local state for the write function: a `Uint8Array(512)` for per-site counts, a `DataView` over the slot buffer, and a `TextEncoder` instance. A companion `globalThis.__vitiate_cmplog_reset_counts` function SHALL be set, closing over the same per-site counts array, for the fuzz loop to call at iteration boundaries. In regression mode, this SHALL be a no-op `() => {}`.

#### Scenario: Regression mode trace function

- **WHEN** Vitest starts without `VITIATE_FUZZ` set
- **THEN** `globalThis.__vitiate_cmplog_write` is a callable function
- **AND** calling it has no side effects and no return value
- **AND** no napi addon is loaded

#### Scenario: Fuzzing mode trace function

- **WHEN** Vitest starts with `VITIATE_FUZZ=1`
- **THEN** `globalThis.__vitiate_cmplog_write` is a pure JS function that writes to the shared-memory slot buffer
- **AND** comparison operands are serialized (type tag + raw bytes) and written to the slot buffer when the write pointer indicates enabled state
- **AND** no NAPI boundary crossing occurs per comparison

#### Scenario: Old global names cause clear error

- **WHEN** code compiled with an old SWC plugin references `globalThis.__vitiate_trace_cmp` or `globalThis.__vitiate_trace_cmp_record`
- **THEN** the reference is `undefined`
- **AND** attempting to call it throws a `TypeError` (not a silent incorrect result)
