## 1. Tests for --fuzz argv detection

- [x] 1.1 Write tests for `parseFuzzFlag(argv)`: bare `--fuzz` returns `"1"`, `--fuzz=pattern` returns the pattern value, no flag returns `undefined`, flag after `--` is ignored
- [x] 1.2 Write tests for `config()` hook integration: `--fuzz` sets `VITIATE_FUZZ` when env var is unset, existing `VITIATE_FUZZ` env var is not overridden

## 2. Implement --fuzz argv detection

- [x] 2.1 Add `parseFuzzFlag(argv: string[]): string | undefined` helper in `plugin.ts` that scans argv for `--fuzz` or `--fuzz=<pattern>`, skipping args after `--`
- [x] 2.2 Call `parseFuzzFlag(process.argv)` in the `config()` hook and set `process.env.VITIATE_FUZZ` if the env var is not already set

## 3. Spec correction

- [x] 3.1 Verify existing `config()` setupFiles tests already cover the modified `configureVitest` requirement (the implementation is already correct; only the spec was wrong)

## 4. Lint and verify

- [x] 4.1 Run full test suite, eslint, prettier, and tsc to confirm no regressions
