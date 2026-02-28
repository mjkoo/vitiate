## 1. Workspace Cleanup

- [x] 1.1 Delete `vitiate-engine/` crate directory
- [x] 1.2 Remove `vitiate-engine` from workspace `Cargo.toml` members and `[workspace.dependencies]`
- [x] 1.3 Remove `vitiate-engine` dependency from `vitiate-napi/Cargo.toml`
- [x] 1.4 Remove `vitiate-engine` reference from `vitiate/package.json` if present
- [x] 1.5 Verify workspace builds cleanly (`cargo check`, `pnpm build`)

## 2. Add LibAFL Dependencies

- [x] 2.1 Add `libafl` and `libafl_bolts` to `[workspace.dependencies]` in root `Cargo.toml` with `default-features = false` and required features (`std`, `derive`, `serdeany_autoreg`)
- [x] 2.2 Add `libafl` and `libafl_bolts` as workspace deps in `vitiate-napi/Cargo.toml`
- [x] 2.3 Update `deny.toml` with any new license exceptions required by LibAFL transitive deps
- [x] 2.4 Verify `cargo check -p vitiate_napi` compiles and `cargo deny check` passes

## 3. Implement types.rs

- [x] 3.1 Create `vitiate-napi/src/types.rs` with `FuzzerConfig` struct (`#[napi(object)]`) - fields: `max_input_len`, `seed`
- [x] 3.2 Add `ExitKind` enum (Ok=0, Crash=1, Timeout=2) with `#[napi]`
- [x] 3.3 Add `IterationResult` struct (`#[napi(object)]`) - fields: `interesting`, `solution`
- [x] 3.4 Add `FuzzerStats` struct (`#[napi(object)]`) - fields: `total_execs`, `corpus_size`, `solution_count`, `coverage_edges`, `execs_per_sec`

## 4. Implement coverage.rs

- [x] 4.1 Create `vitiate-napi/src/coverage.rs` with `create_coverage_map(size: u32) -> Buffer` function - allocates a zeroed `Vec<u8>`, returns as napi `Buffer`, validates size > 0

## 5. Implement engine.rs

- [x] 5.1 Create `vitiate-napi/src/engine.rs` with `Fuzzer` struct containing concrete LibAFL types: `StdState`, `ProbabilitySamplingScheduler`, `MaxMapFeedback`, `CrashFeedback`, `StdScheduledMutator` with `havoc_mutations`, `InMemoryCorpus`, stats counters, `Instant` for timing, and a raw pointer + `napi::Ref<Buffer>` for zero-copy coverage map access
- [x] 5.2 Implement `Fuzzer::new(coverage_map, config)` - stash raw pointer and `napi::Ref<Buffer>` from coverage map, initialize all LibAFL components with concrete type parameters, set up feedback and objective, create empty state
- [x] 5.3 Implement `Fuzzer::add_seed(input)` - create `BytesInput`, wrap in `Testcase`, add to corpus, notify scheduler
- [x] 5.4 Implement `Fuzzer::get_next_input()` - if corpus empty, auto-seed with diverse default set (empty, `"\n"`, `"0"`, `"\x00\x00\x00\x00"`, `"{}"`, `"test"`), call `scheduler.next()`, load testcase, clone and mutate input, enforce `max_input_len`, return bytes
- [x] 5.5 Implement `Fuzzer::report_result(exit_kind)` - construct a `MapObserver` view over the stashed coverage map pointer (unsafe), evaluate `MaxMapFeedback::is_interesting()`, evaluate `CrashFeedback` for crash/timeout, add to corpus or solutions as appropriate, increment stats, zero the coverage map in place, return `IterationResult`
- [x] 5.6 Implement `Fuzzer::stats()` getter - compute `execs_per_sec` from elapsed time, read corpus/solution counts, read coverage edge count from feedback metadata

## 6. Wire Up NAPI Exports

- [x] 6.1 Update `vitiate-napi/src/lib.rs` - declare modules (`types`, `coverage`, `engine`), export `create_coverage_map` function and `Fuzzer` class with `#[napi]` annotations, export `ExitKind` enum
- [x] 6.2 Build native addon: `napi build --platform` to produce `.node` binary
- [x] 6.3 Verify auto-generated `index.d.ts` contains all expected type exports: `createCoverageMap`, `Fuzzer`, `FuzzerConfig`, `ExitKind`, `IterationResult`, `FuzzerStats`

## 7. Tests

- [x] 7.1 Add Rust unit tests in `engine.rs` - test `new()`, `add_seed()`, `get_next_input()` returns bytes, `report_result()` with novel coverage returns interesting=true, report with duplicate coverage returns interesting=false, crash detection
- [x] 7.2 Add Rust unit test for coverage map size validation (zero size rejected)
- [x] 7.3 Add Rust unit test for coverage map pointer stash - verify observer reads from stashed pointer correctly
- [x] 7.4 Add Rust unit test for `max_input_len` enforcement
- [x] 7.5 Create TypeScript integration test (`vitiate-napi/test/smoke.mjs`) - create coverage map, create fuzzer with coverage map, add seed, run 1000 iterations with a target that sets coverage map bytes based on input content, assert corpus grew, assert coverage edges > 0, assert stats are correct
