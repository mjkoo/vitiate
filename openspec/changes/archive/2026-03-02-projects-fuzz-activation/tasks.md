## 1. Remove dead fuzz flag code and VITIATE_FUZZ_PATTERN

- [x] 1.1 Remove `parseFuzzFlag()` function from `plugin.ts` and its call in the `config()` hook
- [x] 1.2 Remove `VITIATE_FUZZ_PATTERN` handling from the `config()` hook in `plugin.ts`
- [x] 1.3 Remove `getFuzzPattern()` and `shouldEnterFuzzLoop()` pattern logic from `config.ts`
- [x] 1.4 Update `fuzz.ts` parent mode to remove pattern-based filtering — all fuzz tests enter the fuzz loop when `VITIATE_FUZZ=1`
- [x] 1.5 Remove tests for `parseFuzzFlag`, `getFuzzPattern`, `shouldEnterFuzzLoop` pattern matching, and `VITIATE_FUZZ_PATTERN` scenarios
- [x] 1.6 Write tests verifying: all fuzz tests enter fuzz loop when `VITIATE_FUZZ=1` (no pattern filtering)

## 2. Hash-prefixed test name directories and file-qualified cached corpus

- [x] 2.1 Rewrite `sanitizeTestName()` in `corpus.ts` to produce `{hash}-{slug}` format (8 hex chars of SHA-256 of original name, dash, lossy slug)
- [x] 2.2 Update `loadCachedCorpus()` and `writeCorpusEntry()` in `corpus.ts` to accept a `testFilePath` parameter and include the relative file path in the cache directory structure
- [x] 2.3 Update all callers of corpus functions (`fuzz.ts`, `loop.ts`, `supervisor.ts`, `cli.ts`) to pass the test file path where needed
- [x] 2.4 Update existing corpus tests for the new `{hash}-{slug}` directory format
- [x] 2.5 Write tests verifying: distinct names that previously collided (e.g., `"parse url"` vs `"parse:url"`) now produce different directories; same test name in different files produces distinct cache paths; empty/degenerate names produce valid hash-only directories

## 3. Add `-test` flag to standalone CLI

- [x] 3.1 Add `-test` option to the `cliParser` definition in `cli.ts`
- [x] 3.2 Update `runParentMode()` to use `-test` value as `testName` for `runSupervisor()` when provided, falling back to filename-derived name
- [x] 3.3 Update `runChildMode()` to pass `-test` value as escaped+anchored `testNamePattern` to `startVitest()` when provided
- [x] 3.4 Update `parseArgs` / `toCliArgs` to include the test name in `CliArgs`
- [x] 3.5 Write tests for `-test` flag parsing (present, absent, combined with other flags)

## 4. Expand url-parser example

- [x] 4.1 Add a second fuzz test to `test/url-parser.fuzz.ts` (e.g., `fuzz("normalize-url", ...)` targeting URL normalization/canonicalization)
- [x] 4.2 Create `test/url-scheme.fuzz.ts` with a fuzz test (e.g., `fuzz("validate-scheme", ...)` targeting scheme validation)
- [x] 4.3 Add seed corpus entries for the new tests using hash-prefixed directory names (`testdata/fuzz/{hash}-normalize-url/`, `testdata/fuzz/{hash}-validate-scheme/`)
- [x] 4.4 Rename existing seed corpus directory from `testdata/fuzz/parse-url/` to `testdata/fuzz/{hash}-parse-url/`
- [x] 4.5 Update `vitest.config.ts` to use projects: a `unit` project for `*.test.ts` and a `fuzz` project for `*.fuzz.ts`
- [x] 4.6 Update `package.json` scripts: `test` runs all (regression), `fuzz` runs `VITIATE_FUZZ=1 vitest run --project fuzz`, `fuzz:cli` uses `vitiate` CLI
- [x] 4.7 Add any supporting source code needed for the new fuzz targets (extend `url-parser.ts` or add new modules)

## 5. Verify and clean up

- [x] 5.1 Run full test suite (`pnpm run build && pnpm run test`) — all tests pass
- [x] 5.2 Run all lints (`pnpm run lint && pnpm exec tsc --noEmit && pnpm run format:check`) — clean
- [x] 5.3 Manually verify the three example workflows from `examples/url-parser/`: regression mode (`vitest run`), fuzz mode (`VITIATE_FUZZ=1 vitest run --project fuzz`), CLI mode (`vitiate test/url-parser.fuzz.ts -max_total_time=10`)
- [x] 5.4 Verify multi-test scenarios: `VITIATE_FUZZ=1 vitest run --project fuzz -t "normalize-url"` targets only that test; CLI `-test=parse-url` targets only that test
