## Purpose

Shared-memory slot buffer protocol between JS and Rust for zero-NAPI comparison tracing. Covers buffer layout, JS write protocol, Rust bulk processing, and overflow handling.

## Requirements

### Requirement: Slot buffer layout

The system SHALL provide a fixed-slot slot buffer for zero-NAPI comparison tracing between JS and Rust. The slot buffer SHALL be a contiguous byte array allocated by Rust and exposed to JS as a `Buffer`. Each slot SHALL be a fixed 80 bytes with the following layout:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | cmpId (u32 LE) |
| 4 | 1 | operatorId (u8) |
| 5 | 1 | leftType (0=skip, 1=f64, 2=string) |
| 6 | 1 | rightType (0=skip, 1=f64, 2=string) |
| 7 | 1 | leftLen (string byte count, max 32; unused for f64) |
| 8 | 8 | leftF64 (when leftType=1, LE) |
| 8 | 32 | leftStr (when leftType=2, UTF-8) |
| 40 | 1 | rightLen (string byte count, max 32; unused for f64) |
| 41 | 8 | rightF64 (when rightType=1, LE) |
| 41 | 32 | rightStr (when rightType=2, UTF-8) |

The buffer SHALL hold `BUFFER_SIZE / SLOT_SIZE` entries. At 80 bytes per slot, a 256KB buffer holds 3,276 slots.

The slot buffer SHALL NOT be zeroed between iterations; only the write pointer is reset. Stale data from previous iterations may exist in slots beyond the current write pointer. This is safe because Rust processes only slots `0..writePtr[0]` (all freshly written), and uses the type tag to decide which fields to read within a slot. Partial writes from early returns (unsupported operand types) are safe because the write pointer is only incremented after both operands are successfully written.

#### Scenario: Slot layout is fixed 80 bytes

- **WHEN** a comparison entry is written to slot N
- **THEN** the entry occupies bytes `N * 80` through `N * 80 + 79`
- **AND** the cmpId is at offset 0 as a u32 little-endian

#### Scenario: Number operand in slot

- **WHEN** a numeric comparison `42 === 100` is traced
- **THEN** leftType (offset 5) SHALL be 1 (f64)
- **AND** leftF64 (offset 8) SHALL contain 42.0 as a float64 LE
- **AND** rightType (offset 6) SHALL be 1 (f64)
- **AND** rightF64 (offset 41) SHALL contain 100.0 as a float64 LE

#### Scenario: String operand in slot

- **WHEN** a string comparison `"hello" === "world"` is traced
- **THEN** leftType (offset 5) SHALL be 2 (string)
- **AND** leftLen (offset 7) SHALL be 5
- **AND** leftStr (offsets 8-12) SHALL contain the UTF-8 bytes of "hello"
- **AND** rightType (offset 6) SHALL be 2 (string)
- **AND** rightLen (offset 40) SHALL be 5
- **AND** rightStr (offsets 41-45) SHALL contain the UTF-8 bytes of "world"

#### Scenario: String truncation at character boundary

- **WHEN** a string operand longer than 32 UTF-8 bytes is traced
- **THEN** `TextEncoder.encodeInto` SHALL write up to 32 bytes without splitting multi-byte UTF-8 characters
- **AND** leftLen/rightLen SHALL reflect the actual number of bytes written (may be less than 32 for strings with multi-byte characters near the boundary)

#### Scenario: Stale data beyond write pointer is not read

- **WHEN** iteration 1 writes 100 entries and iteration 2 writes 50 entries
- **THEN** Rust SHALL process only slots 0-49 in iteration 2
- **AND** stale data in slots 50-99 SHALL NOT be read

#### Scenario: Partial write does not corrupt state

- **WHEN** the left operand is a number (written to slot) and the right operand is a boolean (unsupported)
- **THEN** the write function returns without incrementing `writePtr[0]`
- **AND** the next valid write overwrites the partially-written slot

### Requirement: Write pointer protocol

The system SHALL provide a shared write pointer as a 4-byte Rust-owned buffer exposed to JS as a `Uint32Array(1)`. The write pointer SHALL serve dual purposes: tracking the next write slot AND signaling enabled/disabled state.

- **Enabled:** Rust sets `writePtr[0] = 0`. JS writes entries starting from slot 0 and increments the write pointer after each complete entry.
- **Disabled:** Rust sets `writePtr[0] = 0xFFFFFFFF`. The JS write function's overflow check (`slot >= MAX_SLOTS`) catches this sentinel, since `0xFFFFFFFF >= MAX_SLOTS` is always true.
- **Drain:** Rust reads entries `0..writePtr[0]`, then resets `writePtr[0] = 0`.

No separate enabled/disabled flag, function reference swap, or JS signaling is needed.

#### Scenario: Write pointer starts at 0 when enabled

- **WHEN** a Fuzzer enables CmpLog
- **THEN** `writePtr[0]` SHALL be set to 0
- **AND** JS writes to slot 0 first

#### Scenario: Write pointer increments per entry

- **WHEN** the JS write function successfully writes an entry to slot N
- **THEN** `writePtr[0]` SHALL be set to N + 1

#### Scenario: Disabled sentinel prevents writes

- **WHEN** CmpLog is disabled
- **THEN** `writePtr[0]` SHALL be `0xFFFFFFFF`
- **AND** the JS write function's `slot >= MAX_SLOTS` check SHALL evaluate to true
- **AND** no entry SHALL be written

#### Scenario: Drain reads up to write pointer

- **WHEN** `drain()` is called and `writePtr[0]` is N
- **THEN** Rust SHALL process slots 0 through N-1
- **AND** `writePtr[0]` SHALL be reset to 0

### Requirement: JS write function

The system SHALL provide a `globalThis.__vitiate_cmplog_write` function defined once during `initGlobals()` in fuzzing mode. The function SHALL be pure JS with no NAPI crossings on the hot path.

The function signature SHALL be `(left: unknown, right: unknown, cmpId: number, opId: number) => void`.

The function SHALL:
1. Read `writePtr[0]`; return immediately if `slot >= MAX_SLOTS` (covers both buffer-full and disabled).
2. Check per-site count; return immediately if `counts[cmpId & 511] >= MAX_ENTRIES_PER_SITE`.
3. Write cmpId (u32 LE) and operatorId (u8) to the slot.
4. Serialize the left operand based on `typeof`: `'number'` writes type tag 1 and a float64 LE; `'string'` writes type tag 2, encodes UTF-8 via `TextEncoder.encodeInto` (max 32 bytes), and records the byte length. Any other type causes an early return without incrementing the write pointer.
5. Serialize the right operand identically. Any unsupported type causes an early return without incrementing the write pointer.
6. Increment `writePtr[0]` and `counts[cmpId & 511]` only after both operands are successfully written.

In regression mode, `__vitiate_cmplog_write` SHALL be a no-op `(_l, _r, _c, _o) => {}`.

The function is set once and never swapped at runtime. Modules cache the reference in their preamble at load time.

#### Scenario: Numeric comparison written to slot buffer

- **WHEN** `__vitiate_cmplog_write(42, 100, 5, 0)` is called with buffer space available
- **THEN** the slot contains cmpId=5, operatorId=0, leftType=1, leftF64=42.0, rightType=1, rightF64=100.0
- **AND** `writePtr[0]` is incremented by 1

#### Scenario: String comparison written to slot buffer

- **WHEN** `__vitiate_cmplog_write("hello", "world", 10, 0)` is called
- **THEN** the slot contains cmpId=10, leftType=2, leftStr="hello" (UTF-8), rightType=2, rightStr="world" (UTF-8)
- **AND** `writePtr[0]` is incremented by 1

#### Scenario: Unsupported left operand causes early return

- **WHEN** `__vitiate_cmplog_write(null, "world", 10, 0)` is called
- **THEN** `writePtr[0]` SHALL NOT be incremented
- **AND** no per-site count SHALL be incremented

#### Scenario: Unsupported right operand causes early return

- **WHEN** `__vitiate_cmplog_write(42, undefined, 10, 0)` is called
- **THEN** `writePtr[0]` SHALL NOT be incremented
- **AND** no per-site count SHALL be incremented

#### Scenario: Buffer full causes silent drop

- **WHEN** `writePtr[0] >= MAX_SLOTS`
- **AND** `__vitiate_cmplog_write(42, 100, 5, 0)` is called
- **THEN** the function SHALL return immediately with no side effects

#### Scenario: Disabled state causes silent drop

- **WHEN** `writePtr[0]` is `0xFFFFFFFF` (disabled)
- **AND** `__vitiate_cmplog_write(42, 100, 5, 0)` is called
- **THEN** the function SHALL return immediately with no side effects

#### Scenario: Regression mode no-op

- **WHEN** the system is in regression mode (no `VITIATE_FUZZ`)
- **THEN** `globalThis.__vitiate_cmplog_write` SHALL be a no-op function
- **AND** calling it SHALL have no side effects

#### Scenario: Write function reference is stable

- **WHEN** `__vitiate_cmplog_write` is set during `initGlobals()`
- **THEN** the same function reference SHALL persist for the entire process lifetime
- **AND** module-level `var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write` caches remain valid

### Requirement: Write function must not throw

The `__vitiate_cmplog_write` function SHALL NOT throw exceptions. Unsupported operand types SHALL cause an early return, not an exception. This is required because the write call precedes the comparison in the IIFE body - if the write call throws, the comparison never executes, which would change program control flow and violate the `comparison-tracing` capability's "Comparison tracing preserves semantics" requirement.

The function uses only primitive operations (`typeof` checks, `DataView` writes, `Uint8Array` indexing, `TextEncoder.encodeInto`) that cannot throw under normal operation. The shared `Buffer` backing store is Rust-owned and never detached.

#### Scenario: Unsupported types do not throw

- **WHEN** `__vitiate_cmplog_write(undefined, null, 0, 0)` is called
- **THEN** the function returns without throwing
- **AND** no slot buffer entry is recorded (operands cannot be serialized)

#### Scenario: Mixed unsupported types do not throw

- **WHEN** `__vitiate_cmplog_write(42, Symbol(), 0, 0)` is called
- **THEN** the function returns without throwing
- **AND** no slot buffer entry is recorded (right operand type unsupported)

#### Scenario: BigInt operands do not throw

- **WHEN** `__vitiate_cmplog_write(1n, 2n, 0, 0)` is called
- **THEN** the function returns without throwing
- **AND** no slot buffer entry is recorded (`typeof 1n === 'bigint'` is not a supported type)

### Requirement: JS-local per-site counts

The system SHALL maintain a `Uint8Array(512)` in JS for per-site entry tracking. The JS write function SHALL check `counts[cmpId & 511] >= MAX_ENTRIES_PER_SITE` (default: 8) before writing to the slot buffer. The count SHALL be incremented after a successful write.

Per-site counts track slot buffer entries (one per comparison), not `CmpValues` entries. A numeric comparison that produces two `CmpValues` during Rust bulk processing counts as one against the per-site budget. This differs from the previous Rust-side enforcement where each `CmpValues` entry counted separately, effectively doubling the per-site budget for numeric comparisons.

Per-site counts SHALL be reset at the top of each fuzz iteration, before running the target, by calling `globalThis.__vitiate_cmplog_reset_counts()`. This function SHALL be set by `initGlobals()` alongside the write function, closing over the same `counts` array and calling `counts.fill(0)`. In regression mode, it SHALL be a no-op `() => {}`.

This ensures clean counts even after abnormal shutdown of a previous session, because `Uint8Array` is zero-initialized on allocation (first session) and the fuzz loop always resets before use (subsequent sessions).

Rust does not read or write the per-site counts. Per-site cap enforcement is entirely JS-side. Rust's global 4,096-entry cap is enforced separately during bulk processing in `push()`.

#### Scenario: Per-site cap enforced in JS

- **WHEN** 8 entries have been written for `cmpId & 511 == 42`
- **AND** another comparison with `cmpId & 511 == 42` is traced
- **THEN** the JS write function SHALL return without writing to the slot buffer

#### Scenario: Different sites have independent counts

- **WHEN** 8 entries have been written for site slot 42
- **AND** a comparison with site slot 43 is traced
- **THEN** the entry SHALL be written to the slot buffer

#### Scenario: Counts reset at iteration start

- **WHEN** a fuzz iteration begins
- **THEN** `globalThis.__vitiate_cmplog_reset_counts()` SHALL be called before any target code executes
- **AND** all sites start with a fresh budget

#### Scenario: Counts survive abnormal shutdown cleanup

- **WHEN** a previous fuzzing session ended abnormally (exception before drain)
- **AND** a new fuzzing session starts
- **THEN** per-site counts SHALL be reset at the start of the first iteration
- **AND** no sites are incorrectly pre-capped

#### Scenario: Numeric comparison counts as one entry

- **WHEN** a numeric comparison `42 === 100` is traced
- **THEN** the per-site count for that cmpId slot SHALL increase by 1
- **AND** the 8th numeric comparison at the same site SHALL be allowed (count becomes 8)
- **AND** the 9th numeric comparison at the same site SHALL be dropped (count is at cap)
