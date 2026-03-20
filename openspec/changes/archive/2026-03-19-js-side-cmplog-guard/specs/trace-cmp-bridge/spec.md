## REMOVED Requirements

### Requirement: Export traceCmp napi function

**Reason**: The `traceCmpRecord` NAPI function is replaced by the shared-memory slot buffer. JS writes comparison operands directly to the slot buffer without crossing the NAPI boundary. The NAPI function is removed (or gated to `#[cfg(test)]`).
**Migration**: JS code that called `traceCmpRecord` directly (e.g., test helpers) SHALL call `globalThis.__vitiate_cmplog_write(left, right, cmpId, operatorId)` instead.

### Requirement: Record function must not throw

**Reason**: With no NAPI record function, this requirement moves to the `cmplog-slot-buffer` capability's "Write function must not throw" requirement, which preserves the same safety guarantee for the JS write function.
**Migration**: No migration needed. The non-throwing guarantee is now specified in `cmplog-slot-buffer`.

## MODIFIED Requirements

### Requirement: Correct comparison evaluation for all operators

The comparison tracing system SHALL NOT evaluate comparisons. It SHALL only record operands and operator metadata. The comparison is performed in JavaScript by the instrumented code.

The JS write function writes the numeric `operatorId` to the buffer slot. Rust maps it to `CmpLogOperator` during bulk processing in `drain()`:

| ID | Operator | CmpLogOperator |
|---|---|---|
| 0 | `===` | Equal |
| 1 | `!==` | NotEqual |
| 2 | `==` | Equal |
| 3 | `!=` | NotEqual |
| 4 | `<` | Less |
| 5 | `>` | Greater |
| 6 | `<=` | Less |
| 7 | `>=` | Greater |

#### Scenario: Operands recorded with correct operator

- **WHEN** a Fuzzer is active
- **AND** `__vitiate_cmplog_write("hello", "world", 42, 0)` is called (operator ID 0 = `===`)
- **THEN** the buffer slot contains cmpId=42, operatorId=0, and the UTF-8 representations of "hello" and "world"
- **AND** during `drain()`, Rust maps operatorId 0 to `CmpLogOperator::Equal`

#### Scenario: Numeric operands recorded

- **WHEN** a Fuzzer is active
- **AND** `__vitiate_cmplog_write(3, 5, 10, 4)` is called (operator ID 4 = `<`)
- **THEN** the buffer slot contains cmpId=10, operatorId=4, and float64 representations of 3 and 5
- **AND** during `drain()`, Rust maps operatorId 4 to `CmpLogOperator::Less`

#### Scenario: Invalid operator ID

- **WHEN** `__vitiate_cmplog_write(1, 2, 0, 99)` is called
- **THEN** the entry is written to the slot buffer (JS does not validate operator IDs)
- **AND** during `drain()`, Rust SHALL skip the entry (invalid operator ID is silently ignored)
- **AND** the system SHALL NOT panic or throw

### Requirement: Passthrough behavior (no LibAFL feedback)

The comparison tracing system SHALL record comparison operands only when a Fuzzer instance is active (CmpLog recording is enabled via the write pointer). When no Fuzzer is active, the write pointer SHALL be `0xFFFFFFFF`, causing the JS write function to return immediately without writing to the slot buffer.

In regression mode, `globalThis.__vitiate_cmplog_write` is a no-op function that never writes to any buffer, because no slot buffer is allocated.

#### Scenario: No side effects without active Fuzzer

- **WHEN** `__vitiate_cmplog_write` is called without an active Fuzzer
- **THEN** the fuzzer's corpus, coverage map, and statistics are unaffected
- **AND** no comparison operands are written to the slot buffer

#### Scenario: Comparison operands recorded during fuzzing

- **WHEN** a Fuzzer instance is active (write pointer set to a valid slot index)
- **AND** `__vitiate_cmplog_write("hello", "world", 42, 0)` is called
- **THEN** the comparison operands are written to the slot buffer

## ADDED Requirements

### Requirement: Export slot buffer allocation functions

The `@vitiate/engine` package SHALL export two functions for slot buffer allocation, called once during `initGlobals()`:

- `cmplogGetSlotBuffer() -> Buffer` - returns a 256KB `Buffer` backed by Rust-owned memory (`Box<[u8; N]>` for stable heap address). The `Buffer` provides a zero-copy view into the slot buffer.
- `cmplogGetWritePointer() -> Buffer` - returns a 4-byte `Buffer` backed by Rust-owned memory, used as `Uint32Array(1)` by JS.

Both buffers SHALL have stable addresses for the entire process lifetime. The NAPI `Buffer` objects are created with no-op release callbacks (Rust owns the memory via thread-local `CmpLogState`).

#### Scenario: Slot buffer allocation

- **WHEN** `cmplogGetSlotBuffer()` is called
- **THEN** a 256KB `Buffer` is returned
- **AND** the buffer is backed by Rust-owned heap memory
- **AND** JS can create `Uint8Array` and `DataView` views over it

#### Scenario: Write pointer allocation

- **WHEN** `cmplogGetWritePointer()` is called
- **THEN** a 4-byte `Buffer` is returned
- **AND** JS can create a `Uint32Array(1)` view over it
- **AND** the initial value is `0xFFFFFFFF` (disabled)

#### Scenario: Buffer lifetime

- **WHEN** `cmplogGetSlotBuffer()` and `cmplogGetWritePointer()` return buffers
- **THEN** the backing memory SHALL remain valid for the entire process lifetime
- **AND** the addresses SHALL NOT change (no reallocation)
