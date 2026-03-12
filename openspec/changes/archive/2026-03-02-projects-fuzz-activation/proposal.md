## Why

The `--fuzz` CLI flag is fundamentally broken: Vitest's `cac` parser rejects unknown flags before the plugin's `config()` hook ever runs, making `parseFuzzFlag()` dead code. The Vitest maintainers have explicitly declined to support plugin-extensible CLI flags and recommend environment variables as the workaround. `VITIATE_FUZZ=1` is already the primary activation mechanism and works well in practice (npm scripts always use sh, so cross-platform is a non-issue for the primary usage path).

Meanwhile, four ergonomic limitations in multi-test handling create friction as projects grow beyond a single fuzz test: corpus directory collisions between same-named tests in different files, the standalone CLI's filename-based artifact naming conflicting with `fuzz()` test names, non-targeted tests running in regression mode instead of skipping during fuzz sessions, and no way to target specific tests in CLI mode.

## What Changes

- **Codify `VITIATE_FUZZ=1` as the sole activation mechanism**: Remove the dead `parseFuzzFlag` code and `--fuzz` / `--fuzz=<pattern>` from the vitest-plugin spec. `VITIATE_FUZZ=1` is already the working mechanism; this change removes the broken alternative and updates specs to match reality.
- **Remove `VITIATE_FUZZ_PATTERN` in favor of Vitest's `-t` and a new CLI flag**: In vitest mode, Vitest's built-in `--test-name-pattern` / `-t` provides proper test filtering (non-matching tests are skipped by the runner, not regression-replayed). For the standalone CLI, add a `-test=<name>` flag that selects exactly one fuzz test by name (escaped and anchored as `^{escaped}$` before passing to `startVitest`'s `testNamePattern` option). Remove `VITIATE_FUZZ_PATTERN` env var, `getFuzzPattern()`, and `shouldEnterFuzzLoop()` pattern logic.
- **Adopt Vitest projects for file selection**: Configure fuzz tests in a separate Vitest project (`--project fuzz`) to cleanly separate fuzz files from unit tests. This is orthogonal to fuzz activation - `vitest run` runs everything in regression mode, `VITIATE_FUZZ=1 vitest run --project fuzz` fuzzes only fuzz files. Projects are the Vitest-endorsed mechanism for test profiles.
- **Fix corpus directory naming**: Qualify cached corpus paths with the relative test file path to prevent collisions between tests with the same `fuzz()` name in different files, or tests whose names differ only in non-alphanumeric characters.
- **Fix standalone CLI parent artifact naming**: Store the active `fuzz()` test name in the shmem region so the parent supervisor can use the correct name for crash artifacts after native crashes, instead of deriving it from the filename.
- **Expand the url-parser example**: Add multi-test-per-file and multi-file scenarios with a projects-based `vitest.config.ts`, exercising all three workflows (regression, fuzz via env var + project, CLI).

## Capabilities

### New Capabilities

_(none -- all changes modify existing capabilities)_

### Modified Capabilities

- `vitest-plugin`: Remove `parseFuzzFlag` / `--fuzz` / `VITIATE_FUZZ_PATTERN`; codify `VITIATE_FUZZ=1` env var as sole activation mechanism
- `test-fuzz-api`: Remove `VITIATE_FUZZ_PATTERN` / `shouldEnterFuzzLoop` pattern logic and `getFuzzPattern()`; all fuzz tests enter the fuzz loop when `VITIATE_FUZZ=1` is set (use Vitest's `-t` for filtering)
- `corpus-management`: Qualify cached corpus directory names with relative file path to prevent cross-file collisions
- `standalone-cli`: Add `-test=<name>` flag with exact-match semantics; fix parent mode artifact naming via shmem test name stashing
- `parent-supervisor`: Read test name from shmem for artifact paths instead of accepting a caller-provided `testName`

## Impact

- **Breaking**: `--fuzz` and `--fuzz=<pattern>` syntax removed (was already non-functional). `VITIATE_FUZZ_PATTERN` env var removed. Users relying on `VITIATE_FUZZ_PATTERN` must switch to Vitest's `-t` flag or the new CLI `-test` flag.
- **Code**: `plugin.ts` (remove parseFuzzFlag), `fuzz.ts` (remove pattern logic), `corpus.ts` (path qualification), `cli.ts` (add -test, artifact naming), `supervisor.ts` (shmem test name), `config.ts` (remove pattern helpers)
- **Examples**: `examples/url-parser/` expanded with projects config and additional fuzz tests
- **Specs**: Five specs updated (vitest-plugin, test-fuzz-api, corpus-management, standalone-cli, parent-supervisor)
