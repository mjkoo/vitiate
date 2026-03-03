## Why

`VITIATE_FUZZ` serves dual duty as both a boolean activation flag and a pattern carrier, using `"1"` as a magic sentinel for "fuzz all tests". This forces `getFuzzPattern()` to special-case `"1"`, conflates two concerns in a single env var, and creates a latent collision risk if a test name happens to be `"1"`.

## What Changes

- Split `VITIATE_FUZZ` into two single-purpose env vars: `VITIATE_FUZZ` remains a pure boolean (`"1"` / unset), and a new `VITIATE_FUZZ_PATTERN` carries the optional filter string.
- `parseFuzzFlag()` returns a structured type instead of a sentinel string: `{ enabled: true }` or `{ enabled: true, pattern: string }`.
- `getFuzzPattern()` reads `VITIATE_FUZZ_PATTERN` directly instead of special-casing `"1"` in `VITIATE_FUZZ`.
- All writers (`plugin.ts` config hook, `cli.ts`, `fuzz.ts` supervisor spawn) set `VITIATE_FUZZ="1"` and optionally set `VITIATE_FUZZ_PATTERN` when a filter pattern is provided.
- `isFuzzingMode()` is unchanged (already a pure boolean check on `VITIATE_FUZZ`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `vitest-plugin`: `config()` hook writes `VITIATE_FUZZ_PATTERN` when `--fuzz=<pattern>` is used; `parseFuzzFlag` returns a structured type instead of a sentinel string.
- `test-fuzz-api`: `getFuzzPattern()` reads from `VITIATE_FUZZ_PATTERN` instead of special-casing `VITIATE_FUZZ`.

## Impact

- **`vitiate/src/config.ts`**: `getFuzzPattern()` reads `VITIATE_FUZZ_PATTERN`; sentinel special-casing removed.
- **`vitiate/src/plugin.ts`**: `parseFuzzFlag()` return type changes; `config()` hook sets `VITIATE_FUZZ_PATTERN` when pattern is present.
- **`vitiate/src/fuzz.ts`**: Supervisor spawn env unchanged (already sets `VITIATE_FUZZ="1"`, no pattern).
- **`vitiate/src/cli.ts`**: Unchanged (already sets `VITIATE_FUZZ="1"`, no pattern).
- **Tests**: `config.test.ts`, `plugin.test.ts`, `fuzz-api.test.ts` updated for new env var and return type.
