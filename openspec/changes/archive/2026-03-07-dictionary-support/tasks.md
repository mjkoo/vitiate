## 1. Rust Engine — Dictionary Loading

- [x] 1.1 Add `dictionary_path: Option<String>` field to `FuzzerConfig` in `vitiate-napi/src/types.rs`
- [x] 1.2 In `Fuzzer::new()` (`vitiate-napi/src/engine/mod.rs`), if `dictionary_path` is set, call `Tokens::from_file(path)` and add the result as `Tokens` state metadata before constructing the mutator. Map parse errors to `napi::Error` with a clear message including the file path.
- [x] 1.3 Write unit tests for `Fuzzer::new()` with dictionary: valid file loads tokens into state, nonexistent file returns error, malformed file returns error

## 2. Rust Engine — TokenTracker Cap Fix

- [x] 2.1 Change the `MAX_DICTIONARY_SIZE` check in `TokenTracker::process()` from `state.metadata::<Tokens>().tokens().len() >= MAX_DICTIONARY_SIZE` to `self.promoted.len() >= MAX_DICTIONARY_SIZE`
- [x] 2.2 Write unit tests: user-provided tokens present in state, CmpLog promotion still works up to cap; user-provided tokens don't count toward cap; cap is enforced on CmpLog-promoted count only

## 3. TypeScript — Dictionary Path Resolution

- [x] 3.1 Add `getDictionaryPath(testDir: string, testName: string): string | undefined` to `vitiate/src/corpus.ts` that returns `testdata/fuzz/<sanitizedTestName>.dict` if the file exists, `undefined` otherwise
- [x] 3.2 Add `getDictionaryPathEnv(): string | undefined` helper to `vitiate/src/config.ts` that reads `VITIATE_DICTIONARY_PATH` env var
- [x] 3.3 Write unit tests for `getDictionaryPath`: returns path when `.dict` file exists, returns `undefined` when absent

## 4. TypeScript — Fuzz Loop Integration

- [x] 4.1 In `runFuzzLoop()` (`vitiate/src/loop.ts`), resolve dictionary path: use `getDictionaryPathEnv()` if set (CLI mode), otherwise `getDictionaryPath()` (Vitest mode). Pass as `dictionaryPath` in the `FuzzerConfig` object to `new Fuzzer()`.
- [x] 4.2 Ensure dictionary path is not resolved or passed in regression mode

## 5. TypeScript — CLI `-dict` Flag

- [x] 5.1 Add `-dict` option to the CLI parser in `vitiate/src/cli.ts` (`optional(option("-dict", string()))`)
- [x] 5.2 Validate the `-dict` path exists at startup; exit with error if not found
- [x] 5.3 Resolve `-dict` to absolute path and set `VITIATE_DICTIONARY_PATH` env var for the child process
- [x] 5.4 Write integration test: CLI with `-dict` flag passes path to child via env var

## 6. Regenerate Type Definitions

- [x] 6.1 Run `turbo build` to regenerate `vitiate-napi/index.d.ts` with the new `dictionaryPath` field on `FuzzerConfig`

## 7. End-to-End Validation

- [x] 7.1 Create a test dictionary file and fuzz test that exercises dictionary-based mutations (e.g., a target that checks for a magic string only present in the dictionary)
- [x] 7.2 Run full test suite (`pnpm test`) and verify all existing tests pass
- [x] 7.3 Run lints and checks: eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv
