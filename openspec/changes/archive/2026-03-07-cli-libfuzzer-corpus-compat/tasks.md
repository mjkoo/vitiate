## 1. Corpus management additions

- [x] 1.1 Add `writeCorpusEntryToDir(dir, data)` to `corpus.ts` - flat layout (`{dir}/{fullSha256Hex}`), mkdir recursive, idempotent via `wx` flag. Add unit tests.
- [x] 1.2 Add `writeArtifactWithPrefix(prefix, data, kind)` to `corpus.ts` - writes `{prefix}{kind}-{fullSha256Hex}`, mkdir for parent directory if prefix includes a directory component, idempotent. Add unit tests.

## 2. CLI flag parsing

- [x] 2.1 Add `-artifact_prefix` to `cliParser` in `cli.ts` as `optional(option("-artifact_prefix", string()))`. Include in `CliArgs` and `toCliArgs`.
- [x] 2.2 Add CLI parsing tests for `-artifact_prefix`.

## 3. CLI parent mode plumbing

- [x] 3.1 In `runParentMode`, resolve artifact prefix (flag value or `./` default). Pass artifact prefix to `runSupervisor` via new `artifactPrefix` field on `SupervisorOptions`.
- [x] 3.2 In `runChildMode`, set env vars for the child: `VITIATE_LIBFUZZER_COMPAT=1` (always), `VITIATE_CORPUS_OUTPUT_DIR` (first corpus dir, if any), `VITIATE_ARTIFACT_PREFIX` (flag value, if provided - omit when not provided so child uses `./` default under compat mode).

## 4. Supervisor artifact prefix support

- [x] 4.1 Add `artifactPrefix?: string` to `SupervisorOptions` interface in `supervisor.ts`.
- [x] 4.2 Update `handleCrash` to use `writeArtifactWithPrefix` when `artifactPrefix` is set, falling back to `writeArtifact(testDir, testName, ...)` when unset.
- [x] 4.3 Add supervisor tests for artifact prefix behavior (with prefix, without prefix).

## 5. Rust interface: artifact prefix

- [x] 5.1 In `watchdog.rs`, rename `artifact_dir: PathBuf` to `artifact_prefix: String` on `WatchdogShared`. Update `Watchdog::new` NAPI constructor parameter from `artifact_dir: String` to `artifact_prefix: String`. Update `exit_with_input_capture` to construct the artifact path as `format!("{artifact_prefix}timeout-{hash}")` and use `Path::new(&path).parent()` for `create_dir_all`. Update doc comments.
- [x] 5.2 In `exception_handler.rs`, rename `artifact_dir: PathBuf` to `artifact_prefix: String` on `ExceptionContext`. Update `install_exception_handler` NAPI function parameter from `artifact_dir: String` to `artifact_prefix: String`. Update `handler_callback` to construct the artifact path as `format!("{artifact_prefix}crash-{hash}")` and use `Path::new(&path).parent()` for `create_dir_all`. Update doc comments.
- [x] 5.3 Update watchdog tests (`make_shared`, etc.) to use the new `artifact_prefix` field name.

## 6. Fuzz loop routing

- [x] 6.1 Add env var reading helpers to `config.ts`, following the established `isFuzzingMode()` / `isSupervisorChild()` / `envTruthy()` pattern: `isLibfuzzerCompat()` (reads `VITIATE_LIBFUZZER_COMPAT`), `getCorpusOutputDir()` (reads `VITIATE_CORPUS_OUTPUT_DIR`, returns `string | undefined`), `getArtifactPrefix()` (reads `VITIATE_ARTIFACT_PREFIX`, returns `string | undefined`). In `fuzz.ts`, call these helpers and resolve into explicit parameters for `runFuzzLoop`: `corpusOutputDir?: string`, `artifactPrefix?: string`, `libfuzzerCompat: boolean`.
- [x] 6.2 Update `runFuzzLoop` signature to accept `corpusOutputDir?: string`, `artifactPrefix?: string`, `libfuzzerCompat?: boolean`. Corpus write logic: if `corpusOutputDir` is set, use `writeCorpusEntryToDir`; else if `libfuzzerCompat`, skip writes; else use `writeCorpusEntry` (cache dir).
- [x] 6.3 Artifact write logic in `runFuzzLoop`: if `artifactPrefix` is set, use `writeArtifactWithPrefix`; else if `libfuzzerCompat`, use `writeArtifactWithPrefix` with `./` default; else use `writeArtifact` (testdata/fuzz/). Apply to both the main-loop crash path and the stage-crash path.
- [x] 6.4 Update `artifactDir` computation in `runFuzzLoop` (used for `Watchdog` constructor and `installExceptionHandler`). Replace with resolved `artifactPrefix` string: when in CLI mode, pass the prefix directly (e.g., `./`, `./out/`, `bug-`); when in Vitest mode, pass `testdata/fuzz/{sanitizedName}/` (trailing slash). Pass the prefix string to both `new Watchdog(artifactPrefix, shmemHandle)` and `installExceptionHandler(shmemHandle, artifactPrefix)`.
- [x] 6.5 Verify Vitest mode is unchanged - when no libfuzzer-compat env vars are set, existing behavior is preserved (cache dir for corpus, testdata/fuzz/ for artifacts).

## 7. Integration verification

- [x] 7.1 Manual smoke test: `npx vitiate <test> ./corpus/ -artifact_prefix=./` - verify corpus entries land in `./corpus/` and crash artifacts land in `./crash-<hash>`.
- [x] 7.2 Manual smoke test: `npx vitiate <test>` (no corpus dir, no prefix) - verify no corpus files written to disk, crash artifacts land in `./crash-<hash>`.
- [x] 7.3 Verify existing CLI tests and fuzz-pipeline tests still pass.
