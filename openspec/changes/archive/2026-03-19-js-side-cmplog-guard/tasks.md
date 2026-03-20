## 1. Rust: Slot buffer allocation and state

- [x] 1.1 Add slot buffer (`Box<[u8; SLOT_BUFFER_SIZE]>`) and write pointer (`Box<[u8; 4]>`) fields to `CmpLogState`, initialized with write pointer set to `0xFFFFFFFF` (disabled)
- [x] 1.2 Add NAPI exports `cmplogGetSlotBuffer() -> Buffer` (256KB) and `cmplogGetWritePointer() -> Buffer` (4 bytes) that return `Buffer` views over the Rust-owned memory
- [x] 1.3 Update `enable()` to set `writePtr = 0` and `disable()` to set `writePtr = 0xFFFFFFFF` (replacing the boolean `enabled` field)
- [x] 1.4 Remove `is_site_at_cap()` (per-site checks moved to JS) and the `enabled` boolean field from `CmpLogState`. Update `push()` to only enforce the global 4,096-entry cap (remove the `enabled` and per-site count checks). Note: safe to remove because `drain()` guards `N > MAX_SLOTS` (covering disabled state), and per-site checks move to JS in task 3. The old `traceCmpRecord` path may be inconsistent until task 5.2 removes it.

## 2. Rust: Slot buffer bulk processing

- [x] 2.1 Implement slot deserialization: read cmpId, operatorId, type tags, f64/string data from 80-byte slots into `ExtractedValue` variants
- [x] 2.2 Update `drain()` to guard against `writePtr[0] > MAX_SLOTS` (return empty Vec without modifying write pointer), then read slot buffer entries `0..writePtr[0]`, call `serialize_pair()` + `push()` for each, reset write pointer to 0, and return accumulated entries
- [x] 2.3 Write unit tests for slot buffer deserialization: numeric slots, string slots, mixed-type slots, invalid operator IDs, boundary cases (empty buffer, full buffer), and drain-when-disabled (writePtr = 0xFFFFFFFF returns empty without modifying pointer)
- [x] 2.4 Write unit tests for drain bulk processing: verify produced `CmpValues` match expected output for numeric, string, and mixed-type comparisons

## 3. TypeScript: JS write function and initialization

- [x] 3.1 Update `globals.ts` type declarations: replace `__vitiate_trace_cmp_record` with `__vitiate_cmplog_write` on globalThis
- [x] 3.2 Update `initGlobals()` fuzzing mode: call `cmplogGetSlotBuffer()` and `cmplogGetWritePointer()`, create `DataView`/`Uint8Array` views, allocate `Uint8Array(512)` per-site counts, `TextEncoder`, define `__vitiate_cmplog_write` write function, and set `__vitiate_cmplog_reset_counts` (closing over the counts array)
- [x] 3.3 Update `initGlobals()` regression mode: set `__vitiate_cmplog_write` to no-op `(_l, _r, _c, _o) => {}`
- [x] 3.4 Update the fuzz loop to call `globalThis.__vitiate_cmplog_reset_counts()` at the top of each iteration before running the target

## 3b. TypeScript: JS write function unit tests

- [x] 3.5 Write unit tests for `__vitiate_cmplog_write`: numeric operand serialization to slot buffer, string operand serialization, unsupported type early returns (null, undefined, boolean, Symbol, BigInt), buffer-full silent drop, disabled sentinel silent drop, per-site cap enforcement (9th entry at same site dropped), and count reset via `__vitiate_cmplog_reset_counts`

## 4. SWC plugin: Update instrumentation

- [x] 4.1 Change the default `trace_cmp_global_name` from `__vitiate_trace_cmp_record` to `__vitiate_cmplog_write` in the plugin config
- [x] 4.2 Update SWC plugin snapshot tests and assertions for the new default global name

## 5. Cleanup and integration testing

- [x] 5.1 Update `loop.test.ts` test helpers to call `__vitiate_cmplog_write` instead of `__vitiate_trace_cmp_record`
- [x] 5.2 Remove (or `#[cfg(test)]`-gate) the `traceCmpRecord` NAPI function in `trace.rs` and remove the `serialize_to_cmp_values` NAPI extraction path
- [x] 5.3 Remove the `site_counts` field from `CmpLogState` (per-site counting is now JS-local)
- [x] 5.4 Run full test suite (`pnpm test`) and e2e tests (`pnpm test:e2e`) to verify semantic equivalence
- [x] 5.5 Run all lefthook checks: eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv, tsc
