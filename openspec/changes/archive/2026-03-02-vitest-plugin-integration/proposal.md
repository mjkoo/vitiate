## Why

The vitest-plugin spec contains a requirement that cannot be implemented as written (`configureVitest` for setupFiles injection - this hook fires after config is frozen), and the PRD promises a `vitest --fuzz` flag that doesn't exist (fuzzing requires `VITIATE_FUZZ=1` env var). This change corrects the specs to match Vitest's actual plugin API and adds `--fuzz` flag detection as a UX improvement.

## What Changes

- **Add `--fuzz` flag detection**: The plugin's `config()` hook scans `process.argv` for `--fuzz` or `--fuzz=<pattern>` and sets `VITIATE_FUZZ` accordingly. Users can write `vitest --fuzz` instead of `VITIATE_FUZZ=1 vitest`. The env var remains the primary activation mechanism; `--fuzz` is syntactic sugar.
- **Correct `configureVitest` spec requirement**: The vitest-plugin spec requires `configureVitest(context)` to register setupFiles. This is impossible - `configureVitest` fires after Vitest's project config is resolved and frozen. The `config()` hook (which already implements setupFiles injection correctly) is the proper mechanism. The spec is updated to match the working implementation.
- **Dismiss reporter interleaving concern**: Fuzzing output goes to stderr, which is correct behavior: the fuzz loop runs in a Vitest worker process/thread, which cannot access the main-process `vitest` instance or its logger. Vitest does not produce output during test execution, so interleaving is not a practical concern.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `vitest-plugin`: Add `--fuzz` argv detection in `config()` hook. Replace the `configureVitest` setupFiles requirement with the correct `config()` mechanism that is already implemented.

## Impact

- **`vitiate/src/plugin.ts`**: Add `process.argv` parsing in `config()` for `--fuzz` flag.
- **`vitiate/src/plugin.test.ts`**: Add tests for `--fuzz` argv detection.
- **`openspec/specs/vitest-plugin/spec.md`**: Delta spec correcting `configureVitest` requirement and adding `--fuzz` requirement.
