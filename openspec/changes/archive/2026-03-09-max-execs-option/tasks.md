## 1. Config Schema and Helpers

- [x] 1.1 Rename `runs` to `fuzzExecs` in `FuzzOptionsSchema` in `vitiate/src/config.ts`
- [x] 1.2 Add `getFuzzExecs()` helper mirroring `getFuzzTime()` - reads `VITIATE_FUZZ_EXECS` env var, validates as non-negative integer, returns `number | undefined`
- [x] 1.3 Add `VITIATE_FUZZ_EXECS` to `KNOWN_VITIATE_ENV_VARS` set
- [x] 1.4 Apply `getFuzzExecs()` override in `getCliOptions()` (same pattern as `getFuzzTime()` override for `fuzzTimeMs`)

## 2. Fuzz Loop

- [x] 2.1 Update `vitiate/src/loop.ts` to read `options.fuzzExecs` instead of `options.runs`

## 3. CLI Flag Mapping

- [x] 3.1 Update CLI flag parser in `vitiate/src/cli.ts` to map `-runs=N` to `fuzzExecs` instead of `runs` in the fuzz options object

## 4. Tests

- [x] 4.1 Update all `runs:` references in `vitiate/src/loop.test.ts` to `fuzzExecs:` (~40 occurrences)
- [x] 4.2 Update any config tests that reference `runs` to use `fuzzExecs`
- [x] 4.3 Add unit test for `getFuzzExecs()` - valid integer, zero, negative, non-integer, empty string
- [x] 4.4 Add unit test for `getCliOptions()` verifying `VITIATE_FUZZ_EXECS` overrides `fuzzExecs`

## 5. Specs

- [x] 5.1 Sync delta specs to main specs (`fuzz-loop`, `standalone-cli`, `test-fuzz-api`) after implementation is verified
