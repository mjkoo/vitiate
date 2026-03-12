## 1. Nix Base32 Encoding

- [x] 1.1 Implement `toNixBase32(bytes: Uint8Array): string` in a new `vitiate-core/src/nix-base32.ts` module with the Nix alphabet and reverse-iteration encoding algorithm
- [x] 1.2 Implement `fromNixBase32(encoded: string): Uint8Array | null` decoding function in the same module
- [x] 1.3 Implement `compressHash(hash: Uint8Array): Uint8Array` XOR-fold compression (32 bytes to 20 bytes)
- [x] 1.4 Write unit tests for `toNixBase32`/`fromNixBase32` using the Nix crate's test vectors (hex/base32 pairs from `nix-base32` Rust crate), round-trip property, invalid input handling
- [x] 1.5 Write unit tests for `compressHash` including the XOR-fold correctness property and invalid-length rejection

## 2. Test Name Hashing

- [x] 2.1 Implement `hashTestPath(relativeTestFilePath: string, testName: string): string` in `vitiate-core/src/nix-base32.ts` or `corpus.ts` - SHA-256 of `filePath::testName`, compress, encode, append slug
- [x] 2.2 Write unit tests for `hashTestPath`: determinism, different-file-same-name produces different hashes, slug sanitization, empty/degenerate names
- [x] 2.3 Remove `sanitizeTestName()` from `corpus.ts` and update all call sites to use `hashTestPath`

## 3. Global Test Data Root

- [x] 3.1 Add `dataDir` option to `VitiatePluginOptions` in `config.ts`, replacing `cacheDir` (remove `setCacheDir`/`resetCacheDir`/`getResolvedCacheDir`)
- [x] 3.2 Implement `getDataDir(): string` resolver in `config.ts` (plugin option or default `.vitiate/` relative to project root)
- [x] 3.3 Implement `getTestDataDir(relativeTestFilePath: string, testName: string): string` returning `<dataDir>/testdata/<hashdir>`
- [x] 3.4 Implement `getCorpusDir(relativeTestFilePath: string, testName: string): string` returning `<dataDir>/corpus/<hashdir>`

## 4. Corpus and Artifact Path Updates

- [x] 4.1 Update `loadSeedCorpus` to read from `<dataDir>/testdata/<hashdir>/seeds/` instead of `<testDir>/testdata/fuzz/<sanitized>/`
- [x] 4.2 Add loading of crash and timeout artifacts from `crashes/` and `timeouts/` subdirectories for regression mode (seeds, crashes, and timeouts are all loaded as regression corpus)
- [x] 4.3 Update `loadCachedCorpus` and `loadCachedCorpusWithPaths` to read from `<dataDir>/corpus/<hashdir>/` without `testFilePath` directory nesting; update function signatures to drop `cacheDir` parameter
- [x] 4.4 Update `writeCorpusEntry` to write to `<dataDir>/corpus/<hashdir>/<contenthash>`; update signature to drop `cacheDir` parameter
- [x] 4.5 Update `writeArtifact` to write crashes to `<dataDir>/testdata/<hashdir>/crashes/crash-<contenthash>` and timeouts to `timeouts/timeout-<contenthash>`
- [x] 4.6 Update `getFuzzTestDataDir` to return the new global testdata path
- [x] 4.7 Rewrite dictionary discovery: scan `<dataDir>/testdata/<hashdir>/` top-level for `*.dict` files and `dictionary` file, concatenate if multiple found; remove old `getDictionaryPath`
- [x] 4.8 Update `replaceArtifact` to work with the new path structure (crashes/ subdirectory)
- [x] 4.9 Update callers in `fuzz.ts`: regression mode to load from seeds/ + crashes/ + timeouts/ + corpus; fuzzing parent mode to pass `relativeTestFilePath` instead of `testDir`; optimize mode to load from new paths
- [x] 4.10 Update callers in `loop.ts`: seed loading, interesting input persistence, artifact prefix resolution to use global paths and `hashTestPath`
- [x] 4.11 Update `supervisor.ts` callers: Vitest-mode crash artifact paths to use `<dataDir>/testdata/<hashdir>/crashes/`
- [x] 4.12 Update watchdog artifact prefix in Vitest mode to use `<dataDir>/testdata/<hashdir>/timeouts/` for timeouts and `crashes/` for SEH crashes
- [x] 4.13 Write integration tests verifying seeds, crashes, timeouts, corpus, and dictionaries use the correct global paths

## 5. CLI Subcommand Restructuring

- [x] 5.1 Add subcommand dispatch to `main()` in `cli.ts`: check `process.argv[2]` against known subcommands, print help with subcommand descriptions if no match or unknown subcommand
- [x] 5.2 Implement `fuzz` subcommand: set `VITIATE_FUZZ=1`, resolve vitest CLI, spawn `vitest run --include '*.fuzz.ts'` with forwarded args
- [x] 5.3 Implement `regression` subcommand: spawn `vitest run --include '*.fuzz.ts'` with forwarded args (no special env vars)
- [x] 5.4 Implement `optimize` subcommand: set `VITIATE_OPTIMIZE=1`, spawn `vitest run --include '*.fuzz.ts'` with forwarded args
- [x] 5.5 Move all existing CLI logic (parser, parent/child modes, merge) into a `libfuzzer` subcommand handler
- [x] 5.6 Write tests for subcommand dispatch: known subcommand routing, unknown subcommand help, no-argument help

## 6. Init Subcommand

- [x] 6.1 Implement `init` subcommand: use `createVitest` from `vitest/node` to discover `*.fuzz.ts` test files
- [x] 6.2 Walk the Vitest test module tree to extract `fuzz()` test names from each discovered file
- [x] 6.3 Compute `hashTestPath` for each discovered test and create `<dataDir>/testdata/<hashdir>/seeds/` directories
- [x] 6.4 Implement gitignore management: add `.vitiate/corpus/` to `.gitignore` if not present, create `.gitignore` if needed
- [x] 6.5 Print manifest table to stdout: relative file path, test name, hash directory, seed path
- [x] 6.6 Write tests for `init`: test discovery, directory creation idempotency, gitignore management

## 7. Update Existing Tests

- [x] 7.1 Update `corpus.test.ts`: replace all `sanitizeTestName` usage with `hashTestPath`, update path expectations from `testdata/fuzz/<sanitized>/` to `testdata/<hashdir>/seeds/` and `crashes/`, update `getCacheDir` tests for `getDataDir` and `.vitiate/` default, remove `setCacheDir`/`resetCacheDir` usage, update dictionary path tests for new convention-based discovery
- [x] 7.2 Update `loop.test.ts`: replace `sanitizeTestName` imports and path construction for `testdata/fuzz/` with new global paths, update dictionary path tests from `testdata/fuzz/{name}.dict` to convention-based discovery
- [x] 7.3 Update `fuzz-api.test.ts`: replace `sanitizeTestName` imports, update `setCacheDir`/`cacheDirPath` usage to `setDataDir`/`dataDirPath`, update directory structure expectations
- [x] 7.4 Update `supervisor.test.ts`: replace `sanitizeTestName` imports, update `testdata/fuzz/` path expectations to `testdata/<hashdir>/crashes/`
- [x] 7.5 Update `e2e-fuzz.test.ts`: update hardcoded `.vitiate-corpus` to `.vitiate/corpus/`, update `testdata/fuzz/` paths to `.vitiate/testdata/<hashdir>/`
- [x] 7.6 Update `e2e-detectors.test.ts`: update hardcoded `.vitiate-corpus` to `.vitiate/corpus/`, update `testdata/fuzz/` paths to `.vitiate/testdata/<hashdir>/`
- [x] 7.7 Check `integration.test.ts` and `e2e-instrumented.test.ts` for any path references that need updating
- [x] 7.8 Run full test suite and fix any remaining path references or import breakages

## 8. Documentation Updates

- [x] 8.1 Update `README.md`: change `npx vitiate test/parser.fuzz.ts` to `npx vitiate fuzz` (prefer vitest interface with `VITIATE_FUZZ=1 npx vitest run` as primary); update crash artifact path from `testdata/fuzz/<name>/crash-<sha256>` to `.vitiate/testdata/<hashdir>/crashes/crash-<sha256>`
- [x] 8.2 Update `docs/getting-started/quickstart.md`: update run command examples (prefer vitest interface, mention `npx vitiate fuzz` as equivalent); update crash artifact output path; change `.vitiate-corpus/` gitignore to `.vitiate/corpus/`
- [x] 8.3 Update `docs/getting-started/tutorial.md`: update all `test/testdata/fuzz/*parseUrl*/` paths to `.vitiate/testdata/<hashdir>/` layout; update seed directory discovery instructions to mention `vitiate init`; update dictionary placement instructions for new convention; update the step-by-step walkthrough commands
- [x] 8.4 Update `docs/concepts/corpus.md`: rewrite corpus locations section for global `.vitiate/` root with `testdata/` and `corpus/` subtrees; update sanitized test name description to Nix base32; update crash artifact paths; update checkpointing commands (copy from `.vitiate/corpus/` to `.vitiate/testdata/`); update optimize mode description; update all path examples
- [x] 8.5 Update `docs/guides/dictionaries-and-seeds.md`: rewrite seed directory layout to show `seeds/`, `crashes/`, `timeouts/` subdirectories under `.vitiate/testdata/<hashdir>/`; mention `vitiate init` for creating seed directories; update dictionary placement from `testdata/fuzz/<name>.dict` to convention-based discovery within per-test directory; update example commands
- [x] 8.6 Update `docs/guides/cli.md`: restructure to document subcommand interface (`vitiate init`, `vitiate fuzz`, `vitiate regression`, `vitiate optimize`, `vitiate libfuzzer`); move current content under the `libfuzzer` subcommand section; document `vitiate init` as the way to discover test data paths; update corpus merge example from `npx vitiate` to `npx vitiate libfuzzer`; update `.vitiate-corpus` references
- [x] 8.7 Update `docs/reference/cli-flags.md`: update usage line from `npx vitiate <test-file>` to `npx vitiate libfuzzer <test-file>`; add a note that these flags apply to the `libfuzzer` subcommand only; document `fuzz`/`regression`/`optimize` subcommands as vitest wrappers
- [x] 8.8 Update `docs/reference/plugin-options.md`: replace `cacheDir` option documentation with `dataDir`; update example config; update default value from `.vitiate-corpus` to `.vitiate/`
- [x] 8.9 Update `docs/guides/ci-fuzzing.md`: update GitHub Actions cache path from `.vitiate-corpus` to `.vitiate/corpus/`; update crash artifact upload path from `testdata/fuzz/**/crash-*` to `.vitiate/testdata/**/crashes/crash-*`; optionally show `npx vitiate fuzz` alongside `VITIATE_FUZZ=1 npx vitest run` but keep vitest interface as primary
- [x] 8.10 Update `docs/guides/troubleshooting.md`: update `testdata/fuzz/<test-name>/` seed path references to `.vitiate/testdata/<hashdir>/seeds/`; update `testdata/fuzz/<test-name>.dict` dictionary path to convention-based discovery in `.vitiate/testdata/<hashdir>/`; update `.vitiate-corpus/` reference to `.vitiate/corpus/`

## 9. Lints and Final Checks

- [x] 9.1 Run eslint, prettier, tsc, clippy, cargo fmt, cargo deny, cargo autoinherit, cargo msrv and fix any issues
- [x] 9.2 Verify all documentation examples are internally consistent (paths match, commands match)
