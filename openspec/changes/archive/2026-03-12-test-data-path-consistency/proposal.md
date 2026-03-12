## Why

Test data paths are inconsistent across the two storage locations (seed/artifacts vs corpus cache), use truncated 32-bit hashes with non-zero collision probability, and cannot be discovered without running the fuzzer first. The standalone CLI also lacks the subcommand structure needed to support management commands like path discovery and test initialization.

## What Changes

- **Nix-style base32 hashing**: Replace the current `sanitizeTestName()` (8-char truncated SHA-256 hex) with Nix's proven scheme: SHA-256 of `<relativeTestFilePath>::<testName>`, truncated to 160 bits, encoded in Nix's custom base32 alphabet (`0123456789abcdfghijklmnpqrsvwxyz` - omits `e`, `o`, `u`, `t` to avoid offensive substrings). Result: 32-char hash + `-` + sanitized slug. The hash input includes the test file path so same-named tests in different files never collide without needing a directory hierarchy for namespacing.
- **Global test data root**: Consolidate all test data (seeds, crash/timeout artifacts, corpus cache) under a single configurable root (default `.vitiate/` at project root) instead of scattering seed/artifacts next to test files and corpus in a separate `.vitiate-corpus/` tree. Separate `testdata/` (committed) from `corpus/` (gitignored) subtrees. Within `testdata/`, separate seeds from crashes/timeouts into distinct subdirectories per test. Dictionary files discovered by convention: any `*.dict` file or a file named `dictionary` as a sibling of `seeds/` and `crashes/`.
- **CLI subcommand restructuring**: **BREAKING** - Restructure the CLI from a single-command libFuzzer-compatible tool into a subcommand-based CLI. Current functionality moves to `vitiate libfuzzer`. New subcommands: `vitiate init` (test discovery and directory creation), `vitiate fuzz` (wrapper for `VITIATE_FUZZ=1 vitest run`), `vitiate regression` (wrapper for `vitest run`), `vitiate optimize` (wrapper for `VITIATE_OPTIMIZE=1 vitest run`). The `fuzz`, `regression`, and `optimize` subcommands filter to `*.fuzz.ts` files and forward args to vitest.
- **`vitiate init` command**: Boots Vitest to discover `*.fuzz.ts` test files, computes Nix-hash paths for each test, creates seed directories, prints a test-name-to-path manifest, and ensures `.vitiate/corpus/` is in `.gitignore`. Idempotent.

## Capabilities

### New Capabilities

- `nix-base32`: Nix-style base32 encoding/decoding and the test-name-to-path hashing scheme (SHA-256, 160-bit truncation, Nix base32, slug construction)
- `global-test-data`: Global test data root directory layout, configuration, directory creation, dictionary discovery convention, and gitignore management
- `cli-subcommands`: Subcommand dispatch (`init`, `fuzz`, `regression`, `optimize`, `libfuzzer`), arg forwarding for vitest-wrapping subcommands, `*.fuzz.ts` file filtering
- `test-discovery`: `vitiate init` test discovery via Vitest Node API, directory scaffolding, and manifest output

### Modified Capabilities

- `corpus-management`: Hash scheme changes from 8-char hex to 32-char Nix base32; path layout changes from flat/hierarchical hybrid to uniform flat under global root; seed and crash directories separated; dictionary discovery changes from name-based to convention-based (any `*.dict` or `dictionary` file); regression mode loads from `seeds/` + `crashes/` + `timeouts/` subdirectories
- `standalone-cli`: Entry point becomes `vitiate libfuzzer` instead of bare `vitiate`; all existing flags and behavior preserved under the new subcommand
- `fuzz-loop`: Seed loading and interesting input persistence paths updated to use global test data root and `hashTestPath`
- `test-fuzz-api`: Regression mode corpus loading updated to read from three testdata subdirectories plus cached corpus under global root
- `user-dictionary`: Dictionary discovery changes from single `{sanitizedTestName}.dict` sibling file to convention-based scan (`*.dict` or `dictionary`) within per-test testdata directory
- `parent-supervisor`: Vitest-mode crash artifact paths updated to use global test data root with `crashes/` subdirectory
- `watchdog`: Vitest-mode timeout/crash artifact paths updated to use global test data root with typed subdirectories
- `vitest-plugin`: `cacheDir` plugin option replaced by `dataDir`
- `cli-artifact-prefix`: Vitest-mode artifact path resolution updated to use global test data root with typed subdirectories
- `set-cover-merge`: Optimize mode loads seeds, crashes, and timeouts from global testdata root; cached corpus from global corpus root

## Impact

- **`vitiate-core/src/corpus.ts`**: `sanitizeTestName()` replaced by `hashTestPath()`, all path construction functions updated, new directory layout logic, dictionary discovery rewritten
- **`vitiate-core/src/cli.ts`**: Major restructuring - subcommand dispatch added, current logic moves under `libfuzzer` subcommand, new `init`/`fuzz`/`regression`/`optimize` subcommands
- **`vitiate-core/src/fuzz.ts`**: Updated to use global test data root instead of test-dir-relative paths; regression mode loads from three subdirectories
- **`vitiate-core/src/config.ts`**: New `dataDir` plugin option replacing `cacheDir`; `setCacheDir`/`resetCacheDir`/`getResolvedCacheDir` replaced
- **`vitiate-core/src/loop.ts`**: Seed loading, corpus writing, and artifact prefix paths updated for new layout
- **`vitiate-core/src/supervisor.ts`**: Vitest-mode artifact paths updated
- **Unit tests**: `corpus.test.ts`, `loop.test.ts`, `fuzz-api.test.ts`, `supervisor.test.ts` all reference old paths and `sanitizeTestName`
- **E2E tests**: `e2e-fuzz.test.ts`, `e2e-detectors.test.ts` hardcode `.vitiate-corpus` and `testdata/fuzz/` paths
- **Documentation**: README, quickstart, tutorial, CLI guide, CLI flags reference, corpus guide, dictionaries-and-seeds guide, CI fuzzing guide, plugin options reference all reference old paths and CLI interface
- **OSS-Fuzz integration**: Build scripts must call `vitiate libfuzzer` instead of `vitiate`
