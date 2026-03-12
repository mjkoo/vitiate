## Why

The recent subcommand work (`init`, `fuzz`, `regression`, `optimize`, `libfuzzer`) established the CLI structure, but the non-libfuzzer subcommands are thin wrappers that forward everything to vitest with no flag parsing. Key fuzzing parameters (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`) are only settable via environment variables, which is unintuitive for CLI users. The docs are still libfuzzer-centric, leaving users unclear on the canonical way to run vitiate.

## What Changes

- **Structured flag parsing for all subcommands**: Use `@optique` to define parsers for `fuzz`, `regression`, and `optimize` subcommands. Currently only `libfuzzer` uses optique; the others do raw `process.argv` slicing.
- **Promote env-var config to CLI flags**: `--fuzz-time`, `--fuzz-execs`, and `--max-crashes` become first-class flags on the `fuzz` subcommand, matching the `VITIATE_FUZZ_TIME`/`VITIATE_FUZZ_EXECS`/`VITIATE_MAX_CRASHES` env var naming convention. Environment variables remain supported as fallback (CLI flag takes precedence).
- **Vitest flag forwarding**: After parsing known vitiate flags, remaining arguments are forwarded to vitest. This replaces the current "forward everything" approach while preserving the ability to pass `--reporter`, `--bail`, `--test-name-pattern`, etc.
- **Documentation rewrite**: Restructure the CLI guide and reference to present `vitiate fuzz`/`vitiate regression`/`vitiate optimize` as the primary interface. The `libfuzzer` subcommand gets its own section covering its motivation (OSS-Fuzz/platform compatibility) and compatible flags, rather than being the default presentation.
- **Single canonical invocation**: For all non-libfuzzer use cases, `vitiate <subcommand>` is the documented way to run the tool. Running vitest directly with env vars is mentioned as an advanced/escape-hatch option, not the recommended path.

## Capabilities

### New Capabilities

- `subcommand-flags`: Optique-based flag parsing for `fuzz`, `regression`, and `optimize` subcommands. Covers defining known flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes` on fuzz; `--detectors` on all three), parsing them, setting the corresponding env vars for the vitest child, and forwarding unknown flags to vitest.
- `cli-docs`: Documentation structure for the CLI guide and reference pages. Covers the page organization, canonical invocation patterns, and how the libfuzzer subcommand is presented in context with the other subcommands.

### Modified Capabilities

- `cli-subcommands`: Subcommand dispatch moves from manual `switch`/`process.argv[2]` to optique's `command()` + `or()` combinators. The `fuzz`, `regression`, and `optimize` subcommands change from forwarding all arguments verbatim to vitest, to parsing known vitiate flags first and forwarding the remainder.
- `standalone-cli`: Update all scenarios from `npx vitiate ./test.ts` to `npx vitiate libfuzzer ./test.ts`. Update CLI entry point requirement to reference optique dispatch instead of `process.argv[2]`.
- `user-dictionary`: Update CLI dictionary flag scenarios to use `npx vitiate libfuzzer` invocation.
- `cli-artifact-prefix`: Update artifact prefix scenarios to use `npx vitiate libfuzzer` invocation.
- `set-cover-merge`: Update CLI merge mode scenarios to use `npx vitiate libfuzzer` invocation.

## Impact

- **`vitiate-core/src/cli.ts`**: Main implementation site. `spawnVitestWrapper()` gets replaced or refactored to accept parsed flags. New optique parser definitions for each subcommand.
- **`vitiate-core/src/cli.test.ts`**: New tests for flag parsing on fuzz/regression/optimize subcommands, vitest forwarding behavior.
- **`vitiate-core/src/config.ts`**: `getFuzzTime()`, `getFuzzExecs()`, `getMaxCrashes()` continue to read env vars but CLI flags set them before spawning vitest.
- **`docs/src/content/docs/guides/cli.md`**: Rewrite to lead with `vitiate fuzz`/`vitiate regression` as primary interface.
- **`docs/src/content/docs/reference/cli-flags.md`**: Reorganize to cover all subcommand flags, not just libfuzzer flags.
- **No breaking changes**: Existing env var config continues to work. The `libfuzzer` subcommand is unchanged.
