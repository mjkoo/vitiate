## 1. Package scaffolding and build setup

- [x] 1.1 Update `vitiate/package.json`: add `vitest` as peerDependency (>=3.1), add `bin` entry for CLI, add `tsconfig.json`, configure `tsup` or `tsc` build
- [x] 1.2 Create source file structure: `src/plugin.ts`, `src/setup.ts`, `src/fuzz.ts`, `src/loop.ts`, `src/corpus.ts`, `src/reporter.ts`, `src/cli.ts`, `src/config.ts`
- [x] 1.3 Update `src/index.ts` to export public API: `vitiatePlugin`, `fuzz`

## 2. Runtime setup

- [x] 2.1 Implement `src/config.ts`: mode detection from `VITIATE_FUZZ` env var, `FuzzOptions` type, config resolution helpers
- [x] 2.2 Implement `src/setup.ts`: Vitest setup file that initializes `globalThis.__vitiate_cov` and `globalThis.__vitiate_trace_cmp` based on mode (regression: dummy Uint8Array + JS comparator; fuzzing: createCoverageMap + napi traceCmp)
- [x] 2.3 Test: verify regression mode globals are plain JS (no napi dependency loaded)
- [x] 2.4 Test: verify fuzzing mode globals use napi-backed buffer and traceCmp

## 3. Vitest plugin

- [x] 3.1 Implement `src/plugin.ts`: `vitiatePlugin(options?)` returning a Vite plugin with `name`, `enforce: 'post'`, `transform` hook, and `configureVitest` hook
- [x] 3.2 Implement transform hook: resolve `vitiate-instrument` WASM path, call `@swc/core.transform()` with the WASM plugin, apply include/exclude filter via Vite's `createFilter`
- [x] 3.3 Implement `configureVitest` hook: add `src/setup.ts` to Vitest's `setupFiles`
- [x] 3.4 Test: verify a simple JS file is instrumented (output contains `__vitiate_cov[` and `__vitiate_trace_cmp(`)
- [x] 3.5 Test: verify `node_modules` files are skipped by default
- [x] 3.6 Test: verify `node_modules` files are instrumented when `exclude: []`

## 4. Corpus management

- [x] 4.1 Implement `src/corpus.ts`: `loadSeedCorpus(testDir, testName)` reads files from `testdata/fuzz/{testName}/`
- [x] 4.2 Implement `loadCachedCorpus(cacheDir, testName)` reads from cache directory with `VITIATE_CACHE_DIR` env var support
- [x] 4.3 Implement `writeCorpusEntry(cacheDir, testName, data)` writes interesting inputs with SHA-256 hash filename
- [x] 4.4 Implement `writeCrashArtifact(testDir, testName, data)` writes crash files with `crash-{hash}` naming
- [x] 4.5 Test: round-trip write and load for corpus entries and crash artifacts
- [x] 4.6 Test: duplicate writes are idempotent (no overwrite)
- [x] 4.7 Test: missing directories are created on demand

## 5. Fuzz loop

- [x] 5.1 Implement `src/loop.ts`: `runFuzzLoop(target, options, callbacks)` - core iteration cycle with Fuzzer creation, seed loading, mutation loop, termination conditions
- [x] 5.2 Implement crash detection: catch target exceptions, report as ExitKind.Crash, capture error and input
- [x] 5.3 Implement async target support: await target if it returns a Promise
- [x] 5.4 Implement periodic event loop yield via setImmediate every N iterations
- [x] 5.5 Implement termination conditions: fuzzTime, runs limit, SIGINT handler
- [x] 5.6 Implement interesting input persistence: write to cached corpus on IterationResult.Interesting
- [x] 5.7 Test: fuzz loop runs against a trivial target and terminates after runs limit
- [x] 5.8 Test: fuzz loop detects a crash in a target with a known bug and writes crash artifact

## 6. Test API (`fuzz()` function)

- [x] 6.1 Implement `src/fuzz.ts`: `fuzz(name, target, options?)` function that registers a Vitest test
- [x] 6.2 Implement regression mode: load corpus, run target with each entry, fail on throw, smoke-test with empty buffer if no corpus
- [x] 6.3 Implement fuzzing mode: detect mode, apply filter pattern, enter fuzz loop
- [x] 6.4 Implement `fuzz.skip`, `fuzz.only`, `fuzz.todo` modifiers delegating to `test.skip`, `test.only`, `test.todo`
- [x] 6.5 Test: regression mode replays corpus entries as separate assertions
- [x] 6.6 Test: regression mode with no corpus runs smoke test
- [x] 6.7 Test: fuzz.skip, fuzz.only, fuzz.todo behave like test equivalents

## 7. Progress reporter

- [x] 7.1 Implement `src/reporter.ts`: periodic status line to stderr with elapsed, execs, execs/sec, corpus size, edges
- [x] 7.2 Implement crash finding output with error message and artifact path
- [x] 7.3 Implement final summary on loop termination
- [x] 7.4 Test: reporter outputs status lines at expected intervals

## 8. Standalone CLI

- [x] 8.1 Implement `src/cli.ts`: parse libFuzzer-style arguments (positional test file, corpus dirs, -max_len, -timeout, -runs, -seed, -fuzztime)
- [x] 8.2 Implement flag translation: convert libFuzzer flags to vitiate FuzzOptions
- [x] 8.3 Implement startVitest wrapper: call `startVitest('test', [testFile], ...)` with vitiate plugin and fuzzing mode
- [x] 8.4 Handle unsupported flags (-fork, -jobs, -merge) with warnings
- [x] 8.5 Test: CLI parses flags correctly and rejects missing test file argument

## 9. End-to-end integration test

- [x] 9.1 Create an example fuzz test (`examples/` or `vitiate/test/`) that fuzzes a simple parser with a planted bug
- [x] 9.2 Test: regression mode with seeded corpus runs and passes
- [x] 9.3 Test: fuzzing mode discovers the planted bug and writes a crash artifact
- [x] 9.4 Test: the crash artifact replays as a failing regression test
