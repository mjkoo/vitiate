## 1. CmpLog Module Foundation

- [x] 1.1 Create `vitiate-napi/src/cmplog.rs` module with thread-local `Vec<CmpValues>` accumulator, `CMPLOG_ENABLED` flag, `enable()`/`disable()` functions, `push()` function that checks enabled + capacity, and `drain()` function that returns and clears entries
- [x] 1.2 Add `mod cmplog;` to `vitiate-napi/src/lib.rs`
- [x] 1.3 Write unit tests for accumulator: disabled-by-default, enable/disable lifecycle, push when enabled, push when disabled (dropped), capacity limit at 4096, drain returns entries and clears

## 2. JS Value Serialization

- [x] 2.1 Implement `serialize_to_cmp_values(env, left, right) -> Option<Vec<CmpValues>>` in `cmplog.rs` that converts JS values to CmpValues variants per the serialization rules (strings→Bytes, integers→U8/U16/U32 + Bytes, floats→Bytes, skip null/undefined/boolean/object)
- [x] 2.2 Write unit tests for serialization: string pair, long string truncation to 32 bytes, small integer pair (U8), medium integer pair (U16), large integer pair (U32), float pair (Bytes only), mixed string+number, null/undefined/boolean/object skipped

## 3. Wire traceCmp to CmpLog Accumulator

- [x] 3.1 Modify `trace_cmp` in `trace.rs` to call `cmplog::push(serialize_to_cmp_values(...))` after evaluating the comparison, only when cmplog is enabled
- [x] 3.2 Write integration test: create Fuzzer (enables cmplog), call traceCmp with string operands via NAPI, call reportResult, verify CmpValuesMetadata on state contains the recorded entries

## 4. Fuzzer Engine Integration

- [x] 4.1 Add `I2SRandReplace` to the Fuzzer's mutation pipeline in `engine.rs` - apply it as a secondary mutation step after havoc in `get_next_input()`
- [x] 4.2 Update `Fuzzer::new()` to call `cmplog::enable()` and initialize `CmpValuesMetadata` on the state
- [x] 4.3 Implement `Drop` for `Fuzzer` that calls `cmplog::disable()`
- [x] 4.4 Update `Fuzzer::report_result()` to drain the cmplog accumulator and insert/replace `CmpValuesMetadata` on the state, after coverage feedback evaluation and before returning
- [x] 4.5 Update type aliases in `engine.rs` if the mutator type changes

## 5. Testing

- [x] 5.1 Write Rust unit test: Fuzzer construction enables cmplog, drop disables it
- [x] 5.2 Write Rust unit test: simulated comparison entries are drained into CmpValuesMetadata during reportResult
- [x] 5.3 Write Rust unit test: I2SRandReplace fires when CmpValuesMetadata contains matching bytes - seed with "foo", add CmpValues::Bytes("foo","bar"), verify "bar" appears in output after multiple getNextInput calls
- [x] 5.4 Update `vitiate-napi/test/smoke.mjs` to test CmpLog end-to-end: create Fuzzer, run iterations where traceCmp is called with known operands, verify corpus grows and I2S mutations produce expected byte patterns
- [x] 5.5 Verify existing tests still pass (`cargo test --workspace` and `pnpm test`)

## 6. Cargo Configuration

- [x] 6.1 Check if LibAFL feature flags need updating in workspace `Cargo.toml` for CmpValues/I2SRandReplace imports (add features if needed)
