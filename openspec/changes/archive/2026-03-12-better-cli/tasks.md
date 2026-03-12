## 1. Subcommand dispatch via optique

- [x] 1.1 Define optique parsers for each subcommand: `fuzzParser`, `regressionParser`, `optimizeParser`, and a trivial `initParser` (empty object, no flags). The existing `cliParser` becomes `libfuzzerParser`.
- [x] 1.2 Build top-level CLI parser using `or()` + `command()` for all five subcommands with brief descriptions
- [x] 1.3 Replace manual `switch`/`SUBCOMMANDS`/`printUsage()` dispatch with `runSync(cli, ...)` and result handling
- [x] 1.4 Update existing dispatch tests in `cli.test.ts` (replace manual switch tests with optique-based dispatch tests): no args shows help, unknown subcommand exits 1 with suggestion, `--help` shows subcommand listing

## 2. Fuzz subcommand flags

- [x] 2.1 Add `--fuzz-time`, `--fuzz-execs`, `--max-crashes` options to `fuzzParser` using optique `option()` with `integer({ min: 1 })`
- [x] 2.2 Add `--detectors` option to `fuzzParser` using optique `option()` with `string()`
- [x] 2.3 Add `passThrough({ format: "nextToken" })` as `vitestArgs` field to `fuzzParser`
- [x] 2.4 Refactor `spawnVitestWrapper()` to accept `(env: Record<string, string>, forwardedArgs: readonly string[])` instead of reading `process.argv.slice(3)`
- [x] 2.5 Wire fuzz subcommand handler: parse flags, build env vars (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`, `VITIATE_FUZZ_OPTIONS`), call `spawnVitestWrapper()` with parsed env and passthrough args
- [x] 2.6 Add tests for fuzz flag parsing: each flag sets correct env var, CLI flag overrides env var, multiple flags combined, invalid values rejected
- [x] 2.7 Add tests for fuzz detectors: `--detectors` value parsed via `parseDetectorsFlag()` and serialized to `VITIATE_FUZZ_OPTIONS`

## 3. Regression and optimize subcommand flags

- [x] 3.1 Add `--detectors` option and `passThrough()` to `regressionParser` and `optimizeParser`
- [x] 3.2 Wire regression handler: parse detectors, build `VITIATE_FUZZ_OPTIONS` env var if present, call `spawnVitestWrapper()` with passthrough args
- [x] 3.3 Wire optimize handler: same as regression but also sets `VITIATE_OPTIMIZE=1`
- [x] 3.4 Add tests for regression/optimize detectors and vitest forwarding

## 4. Vitest flag forwarding

- [x] 4.1 Add tests for passThrough forwarding: unknown flags forwarded, mixed vitiate/vitest flags work, `--` separator works, no vitiate flags forwards everything

## 5. Help text

- [x] 5.1 Add note to each subcommand's help description that unrecognized flags are forwarded to vitest

## 6. Documentation - CLI guide and reference

- [x] 6.1 Rewrite `docs/src/content/docs/guides/cli.md`: restructure with `vitiate fuzz` as primary, sections for each subcommand, libfuzzer compatibility section with motivation and full flag reference
- [x] 6.2 Rewrite `docs/src/content/docs/reference/cli-flags.md`: organize flags by subcommand, note vitest forwarding for wrapper subcommands
- [x] 6.3 Add environment variable reference section to CLI guide: document `VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`, `VITIATE_FUZZ`, `VITIATE_OPTIMIZE`, `VITIATE_DEBUG` with CLI flag equivalents noted

## 7. Documentation - other pages

- [x] 7.1 Update `docs/src/content/docs/reference/environment-variables.md`: flip precedence so CLI flags override env vars for fuzz/regression/optimize subcommands, note `--fuzz-time`/`--fuzz-execs`/`--max-crashes` as CLI equivalents
- [x] 7.2 Update `docs/src/content/docs/guides/ci-fuzzing.md`: show `--fuzz-time` as primary invocation pattern alongside env var examples
- [x] 7.3 Update `docs/src/content/docs/guides/detectors.md`: add `vitiate fuzz --detectors` examples alongside existing `vitiate libfuzzer -detectors` examples
- [x] 7.4 Update `docs/src/content/docs/getting-started/quickstart.md`: remove file path positional argument from `npx vitiate fuzz` examples (fuzz subcommand runs all `*.fuzz.ts` files, no positional file arg)
- [x] 7.5 Update `docs/src/content/docs/getting-started/tutorial.md`: remove file path positional argument from `npx vitiate fuzz` examples
- [x] 7.6 Update `docs/src/content/docs/guides/troubleshooting.md`: remove file path positional argument from `npx vitiate fuzz` examples
- [x] 7.7 Update `docs/src/content/docs/guides/dictionaries-and-seeds.md`: verify CLI examples are consistent with new subcommand conventions
- [x] 7.8 Update `README.md`: update CLI usage examples to use `npx vitiate fuzz` without file path positional argument
