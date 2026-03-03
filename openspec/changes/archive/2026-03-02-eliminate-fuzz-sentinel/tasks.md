## 1. Update `parseFuzzFlag` return type and implementation

- [x] 1.1 Change `parseFuzzFlag` return type from `string | undefined` to `{ pattern?: string } | undefined` and update implementation: bare `--fuzz` returns `{}`, `--fuzz=<pattern>` returns `{ pattern }`, no flag returns `undefined`
- [x] 1.2 Update `parseFuzzFlag` tests: adjust all existing assertions to use the structured return type, add test for `--fuzz=` (empty value) returning `{}` (no pattern)

## 2. Update `config()` hook to set `VITIATE_FUZZ_PATTERN`

- [x] 2.1 Update the `config()` hook in `plugin.ts`: always set `VITIATE_FUZZ="1"` when flag is detected, and set `VITIATE_FUZZ_PATTERN` from the structured result's `pattern` field if present (respecting existing env var precedence)
- [x] 2.2 Add `VITIATE_FUZZ_PATTERN` to the `envKeys` cleanup arrays in both `plugin.test.ts` describe blocks ("config hook env vars" and "config hook --fuzz flag integration")
- [x] 2.3 Update config hook integration tests: `--fuzz=mypattern` sets both `VITIATE_FUZZ="1"` and `VITIATE_FUZZ_PATTERN="mypattern"`, bare `--fuzz` sets `VITIATE_FUZZ="1"` without setting `VITIATE_FUZZ_PATTERN`, add test for explicit `VITIATE_FUZZ_PATTERN` env var precedence

## 3. Update `getFuzzPattern` to read `VITIATE_FUZZ_PATTERN`

- [x] 3.1 Rewrite `getFuzzPattern()` in `config.ts` to read `VITIATE_FUZZ_PATTERN` and return it if non-empty, or `null` otherwise (remove all `"1"` special-casing)
- [x] 3.2 Update `getFuzzPattern` tests in `config.test.ts`: replace `VITIATE_FUZZ`-based pattern tests with `VITIATE_FUZZ_PATTERN`-based equivalents, ensure `VITIATE_FUZZ_PATTERN` cleanup in afterEach

## 4. Update consumers that read `VITIATE_FUZZ` for pattern value

- [x] 4.1 Update `fuzz-api.test.ts` pattern filter tests to set `VITIATE_FUZZ_PATTERN` instead of `VITIATE_FUZZ="parser"`, add `VITIATE_FUZZ_PATTERN` to env cleanup

## 5. Verify

- [x] 5.1 Run full test suite, eslint, prettier, and tsc to confirm no regressions
