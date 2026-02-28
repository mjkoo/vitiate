## Why

The Rust infrastructure is complete — `vitiate-instrument` inserts coverage counters and comparison tracing, `vitiate-napi` exposes LibAFL's mutation engine, coverage feedback, and CmpLog. But the `vitiate` TypeScript package is a one-line scaffold. There is no way for a developer to actually fuzz anything. This change builds the end-to-end integration layer: a Vitest plugin that instruments code through the Vite transform pipeline, a `test.fuzz()` API that drives the fuzzing loop, corpus management, progress reporting, and a standalone CLI for OSS-Fuzz.

## What Changes

- New Vitest plugin (`vitiatePlugin()`) that hooks into Vite's `transform` to run `@swc/core.transform()` with the `vitiate-instrument` WASM plugin. Configurable include/exclude patterns control which files are instrumented — `node_modules` excluded by default but overridable.
- New runtime setup that initializes `globalThis.__vitiate_cov` and `globalThis.__vitiate_trace_cmp` before test code runs. Regression mode uses a dummy `Uint8Array` sink; fuzzing mode uses the zero-copy `Buffer` from `createCoverageMap()`.
- New `fuzz()` test registrar function (following Vitest's `bench()` pattern). In regression mode, replays corpus entries as sub-tests. In fuzzing mode, enters the LibAFL-driven mutation loop.
- New fuzz loop runner: get input → zero coverage map → call target → report result → repeat. Activated by `--fuzz` flag or `VITIATE_FUZZ=1`.
- New corpus management following Go conventions: seed corpus in `testdata/fuzz/{TestName}/`, generated corpus in `.vitiate-corpus/`, crash artifacts written back to `testdata/`.
- New progress reporter showing execs/sec, corpus size, coverage edges.
- New standalone CLI (`npx vitiate`) wrapping `startVitest()` with libFuzzer-compatible flags.

## Capabilities

### New Capabilities

- `vitest-plugin`: Vite plugin providing `transform` hook for SWC instrumentation with configurable include/exclude patterns, plus `configureVitest` lifecycle hook
- `runtime-setup`: Global coverage map and trace function initialization for both regression and fuzzing modes
- `test-fuzz-api`: `fuzz()` test registrar function (like Vitest's `bench()`) that runs corpus entries as regression tests or drives the fuzzing loop
- `fuzz-loop`: Core fuzzing iteration cycle — input generation, target execution, coverage feedback, crash detection
- `corpus-management`: Seed corpus loading, generated corpus persistence, crash artifact writing following Go conventions
- `progress-reporter`: Custom Vitest reporter for fuzzing status output
- `standalone-cli`: `npx vitiate` CLI with libFuzzer-compatible flags wrapping `startVitest()`

### Modified Capabilities

None — all existing specs (`coverage-map`, `fuzzing-engine`, `edge-coverage`, `trace-cmp-bridge`, `comparison-tracing`, `cmplog-feedback`) are consumed as-is.

## Impact

- **`vitiate` package**: Complete rewrite from scaffold to full implementation. New source files for plugin, runtime, test API, fuzz loop, corpus, reporter, and CLI.
- **`vitiate/package.json`**: Add `vitest` as peer dependency, add `bin` entry for CLI, add build/test scripts, add `tsconfig.json`.
- **Dependencies**: Requires `vitest >=3.1` (for `configureVitest` hook), `@swc/core` (already present), `vitiate-napi` and `vitiate-instrument` (already present).
- **User-facing API**: New public exports (`vitiatePlugin`, `test.fuzz`). New CLI binary.
- **File system**: Fuzzing creates `testdata/fuzz/` and `.vitiate-corpus/` directories.
