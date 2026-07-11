# CLI Subcommands

## Purpose

Defines the subcommand-based CLI dispatch for vitiate, providing `init`, `fuzz`, `regression`, `reproduce`, `optimize`, and `libfuzzer` subcommands as the primary user interface.
## Requirements
### Requirement: Subcommand dispatch

The CLI entry point (`npx vitiate`) SHALL use `@optique`'s `command()` primitive and `or()` combinator to dispatch subcommands. Known subcommands: `init`, `fuzz`, `regression`, `reproduce`, `optimize`, `libfuzzer`, `paths`. Each subcommand SHALL be registered with a brief description for help text generation.

If no subcommand is provided, the CLI SHALL print an auto-generated usage summary listing all available subcommands with their descriptions and exit with code 0.

If an unknown subcommand is provided, the CLI SHALL print an error message. If the unknown subcommand is similar to a known subcommand, a "Did you mean...?" suggestion SHALL be included. The CLI SHALL exit with code 1.

#### Scenario: Known subcommand dispatched

- **WHEN** `npx vitiate fuzz --fuzz-time 60` is executed
- **THEN** the `fuzz` subcommand handler SHALL be invoked with the remaining arguments

#### Scenario: paths subcommand dispatched

- **WHEN** `npx vitiate paths` is executed
- **THEN** the `paths` subcommand handler SHALL be invoked

#### Scenario: No subcommand shows help

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** an auto-generated usage summary SHALL be printed listing all subcommands with brief descriptions
- **AND** the process SHALL exit with code 0

#### Scenario: Unknown subcommand shows error with suggestion

- **WHEN** `npx vitiate fuz` is executed
- **THEN** an error message SHALL be printed indicating `fuz` is not a valid subcommand
- **AND** a "Did you mean...?" suggestion SHALL include `fuzz`
- **AND** the process SHALL exit with code 1

#### Scenario: Unknown subcommand with no close match

- **WHEN** `npx vitiate unknown-command` is executed
- **THEN** an error message SHALL be printed indicating `unknown-command` is not a valid subcommand
- **AND** the process SHALL exit with code 1

#### Scenario: Top-level help flag

- **WHEN** `npx vitiate --help` is executed
- **THEN** the auto-generated usage summary SHALL be printed listing all subcommands
- **AND** the process SHALL exit with code 0

### Requirement: fuzz subcommand

The `vitiate fuzz` subcommand SHALL parse vitiate-specific flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`, `--detectors`) via an `@optique` parser. Parsed flags SHALL be converted to environment variables on the spawned vitest process (see `subcommand-flags` capability). Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`. Both positional arguments (e.g. test file paths) and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim, even if they shadow vitiate flags.

The subcommand SHALL set `VITIATE_FUZZ=1` in the environment, then spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments.

The subcommand SHALL spawn vitest with inherited stdio and forward the exit code.

#### Scenario: Basic fuzz invocation

- **WHEN** `npx vitiate fuzz` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_FUZZ=1`
- **AND** the exit code from vitest SHALL be forwarded

#### Scenario: Fuzz with vitiate flags and vitest arguments

- **WHEN** `npx vitiate fuzz --fuzz-time 60 --reporter verbose --bail 1` is executed
- **THEN** `--fuzz-time 60` SHALL be parsed by vitiate and set as `VITIATE_FUZZ_TIME=60`
- **AND** `vitest run .fuzz.ts --reporter verbose --bail 1` SHALL be spawned

#### Scenario: Fuzz with positional test file

- **WHEN** `npx vitiate fuzz test/specific.fuzz.ts` is executed
- **THEN** `vitest run .fuzz.ts test/specific.fuzz.ts` SHALL be spawned with `VITIATE_FUZZ=1`

#### Scenario: Fuzz with mixed positional and option args

- **WHEN** `npx vitiate fuzz --fuzz-time 60 test/foo.fuzz.ts --reporter verbose` is executed
- **THEN** `VITIATE_FUZZ_TIME=60` SHALL be set in the environment
- **AND** `test/foo.fuzz.ts`, `--reporter`, and `verbose` SHALL be forwarded to vitest
- **AND** `--fuzz-time` SHALL NOT appear in the forwarded arguments

#### Scenario: Fuzz with test name filter

- **WHEN** `npx vitiate fuzz --test-name-pattern 'parses URLs'` is executed
- **THEN** the vitest `--test-name-pattern` flag SHALL be forwarded, filtering within `*.fuzz.ts` files

#### Scenario: Fuzz with -- separator shadowing vitiate flags

- **WHEN** `npx vitiate fuzz --fuzz-time 60 -- --fuzz-time 999 --reporter verbose` is executed
- **THEN** `VITIATE_FUZZ_TIME=60` SHALL be set from the pre-separator flag
- **AND** `--fuzz-time`, `999`, `--reporter`, and `verbose` SHALL all be forwarded verbatim to vitest

### Requirement: regression subcommand

The `vitiate regression` subcommand SHALL parse vitiate-specific flags (`--detectors`) via an `@optique` parser. Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`.

The subcommand SHALL spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments. No special environment variables SHALL be set beyond those derived from parsed flags (regression is vitest's default mode for fuzz tests).

Both positional arguments and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim.

#### Scenario: Basic regression invocation

- **WHEN** `npx vitiate regression` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned
- **AND** no `VITIATE_FUZZ` or `VITIATE_OPTIMIZE` environment variable SHALL be set

#### Scenario: Regression with vitest arguments

- **WHEN** `npx vitiate regression --reporter dot` is executed
- **THEN** `vitest run .fuzz.ts --reporter dot` SHALL be spawned

#### Scenario: Regression with positional test file

- **WHEN** `npx vitiate regression test/specific.fuzz.ts` is executed
- **THEN** `vitest run .fuzz.ts test/specific.fuzz.ts` SHALL be spawned

### Requirement: reproduce subcommand

The `vitiate reproduce <file>` subcommand SHALL replay a single input file **once** through a fuzz target, matching libFuzzer's single-input reproduce contract. It SHALL accept a required positional input-file argument and the single-hyphen `-test <name>` and `-timeout <seconds>` flags.

The subcommand SHALL:

1. Resolve the input file to an absolute path; if it does not exist, print an error to stderr and exit with code 1 without running any test.
2. Discover the project's fuzz tests (globbing `*.fuzz.*` and collecting fully-qualified names). When `-test` is provided, filter to the exactly-matching name. If no test matches, print an error and exit 1; if more than one matches, list the candidate `file :: name` pairs and exit 1.
3. Spawn `vitest run <testFile> --test-name-pattern ^<name>$` **once** (single process, no supervisor/shmem), passing the absolute input path to the worker via the `reproduceInputFile` field of the `VITIATE_CLI_IPC` JSON blob and the `-timeout` value (converted to ms) via `VITIATE_OPTIONS`. It SHALL NOT set `VITIATE_FUZZ`, `VITIATE_OPTIMIZE`, or `VITIATE_SUPERVISOR`, so the worker takes the regression replay path.
4. Map the spawned vitest status to the final exit code: `0` when vitest succeeds, otherwise the crash exit code (`77`).

When `reproduceInputFile` is present, the worker's regression path SHALL replay exactly that input once via `replayCorpusEntry` (skipping corpus loading), so a crash, detector finding, or timeout throws with the failure's stack trace.

#### Scenario: Reproduce a crashing input

- **WHEN** `npx vitiate reproduce ./crash.bin -test parse-url` is executed AND the input reproduces a crash
- **THEN** the failure's stack trace SHALL be printed AND the process SHALL exit with code 77

#### Scenario: Reproduce a benign input

- **WHEN** `npx vitiate reproduce ./ok.bin -test parse-url` is executed AND the input replays cleanly
- **THEN** the process SHALL exit with code 0

#### Scenario: Missing input file

- **WHEN** `npx vitiate reproduce ./missing.bin` is executed AND the file does not exist
- **THEN** an error SHALL be printed to stderr AND the process SHALL exit with code 1

#### Scenario: Ambiguous target without -test

- **WHEN** `npx vitiate reproduce ./input.bin` is executed AND the project defines more than one fuzz test
- **THEN** the candidate `file :: name` pairs SHALL be listed AND the process SHALL exit with code 1

### Requirement: optimize subcommand

The `vitiate optimize` subcommand SHALL parse vitiate-specific flags (`--detectors`, `--timeout`) via an `@optique` parser. Unrecognized arguments SHALL be forwarded to vitest via `passThrough()`. The `--timeout <N>` flag SHALL set the per-entry replay timeout in seconds (converted to `timeoutMs`; see `subcommand-flags` capability).

The subcommand SHALL set `VITIATE_OPTIMIZE=1` in the environment, then spawn `vitest run` with `.fuzz.ts` prepended to the forwarded arguments.

Both positional arguments and unrecognized option-like arguments SHALL be forwarded to vitest. The `--` separator SHALL force all subsequent tokens to be forwarded verbatim.

#### Scenario: Basic optimize invocation

- **WHEN** `npx vitiate optimize` is executed
- **THEN** `vitest run .fuzz.ts` SHALL be spawned with `VITIATE_OPTIMIZE=1`

#### Scenario: Optimize with per-entry timeout

- **WHEN** `npx vitiate optimize --timeout 5` is executed
- **THEN** vitest SHALL be spawned with `VITIATE_OPTIMIZE=1` and a `VITIATE_OPTIONS` JSON containing `timeoutMs: 5000`

### Requirement: libfuzzer subcommand

The `vitiate libfuzzer` subcommand SHALL provide all current standalone CLI functionality. The argument parsing, parent/child supervisor model, shmem management, libFuzzer-compatible flags, merge mode, and all other existing CLI behavior SHALL be preserved unchanged under this subcommand.

Arguments after `libfuzzer` SHALL be parsed using the existing `@optique`-based parser with all current flags (`-max_len`, `-timeout`, `-runs`, `-seed`, `-max_total_time`, `-test`, `-artifact_prefix`, `-dict`, `-detectors`, `-fork`, `-jobs`, `-merge`, `-minimize_budget`, `-minimize_time_limit`), plus the exit-code flags `-error_exitcode`/`-timeout_exitcode` and the parsed-but-ignored compatibility flags `-rss_limit_mb`, `-print_final_stats`, `-close_fd_mask`, `-reload` (see `standalone-cli` capability). An explicit `-runs=0` SHALL replay the loaded corpus once and exit (rather than fuzzing unbounded). The final process exit code SHALL follow libFuzzer's conventions (see `parent-supervisor` capability): crash → `-error_exitcode` (default 77), timeout → `-timeout_exitcode` (default 70).

#### Scenario: libfuzzer mode invocation

- **WHEN** `npx vitiate libfuzzer ./test.fuzz.ts -max_total_time=60` is executed
- **THEN** the existing CLI behavior SHALL execute (parent spawns child, supervisor loop, shmem)
- **AND** all libFuzzer-compatible flags SHALL be parsed and applied

#### Scenario: libfuzzer merge mode

- **WHEN** `npx vitiate libfuzzer ./test.fuzz.ts -merge=1 ./corpus/` is executed
- **THEN** corpus merge mode SHALL execute using the existing merge implementation

#### Scenario: Fuzzing platform compatibility

- **WHEN** a fuzzing platform build script invokes `npx vitiate libfuzzer ./target.fuzz.ts ./corpus/ -max_total_time=600`
- **THEN** the fuzzer SHALL behave identically to the current `npx vitiate` invocation

### Requirement: Vitest wrapper execution

The `fuzz`, `regression`, and `optimize` subcommands SHALL resolve the `vitest` CLI entry point and spawn it as a child process. The resolution SHALL use the same mechanism as the current codebase (`resolveVitestCli()` or equivalent).

The spawn SHALL:

1. Use `process.execPath` (the current Node.js binary) as the executable.
2. Pass the resolved vitest CLI path as the first argument, followed by `run`, then `.fuzz.ts` as a positional file pattern, then any forwarded arguments from the `passThrough()` parser.
3. Set environment variables derived from parsed vitiate flags (e.g., `VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`, `VITIATE_OPTIONS`).
4. Inherit stdio (`stdio: 'inherit'`).
5. Forward the child's exit code as the process exit code.

#### Scenario: Vitest resolution

- **WHEN** any vitest wrapper subcommand is executed
- **THEN** the vitest CLI entry point SHALL be resolved from the project's dependencies
- **AND** the resolved path SHALL be used to spawn vitest

#### Scenario: Exit code forwarding

- **WHEN** vitest exits with code 1 (test failure)
- **THEN** the vitiate process SHALL also exit with code 1

#### Scenario: Stdio inheritance

- **WHEN** a vitest wrapper subcommand runs
- **THEN** vitest's stdout, stderr, and stdin SHALL be inherited from the parent process

### Requirement: paths subcommand

The `vitiate paths [pattern]` subcommand SHALL be a read-only inspector that maps each discovered fuzz test to its testdata and corpus hash directory. It SHALL create no directories and mutate no files, except on the explicit `--prune` deletion path.

The subcommand SHALL discover the project's fuzz tests via the same discovery used by `init` (globbing `*.fuzz.*` and collecting fully-qualified names). If discovery cannot determine the test set (for example, Vitest is not installed), the subcommand SHALL exit with code 1 without scanning or deleting anything. If discovery succeeds but finds no fuzz tests at all, the subcommand SHALL still render an empty table or JSON, but SHALL refuse `--orphans` and `--prune` (printing an error and exiting with code 1), because with no known tests every on-disk directory would appear orphaned.

For each discovered test the subcommand SHALL compute its hash directory, testdata directory, corpus directory, and per-bucket entry counts (`seeds`, `crashes`, `timeouts`, `ooms`, and cached `corpus`).

The subcommand SHALL accept an optional positional `pattern` argument that filters the listed tests by case-insensitive substring match against the test's file path, test name, or hash directory.

The subcommand SHALL accept the following flags:

- `--dir`: print only the matched test's testdata directory. It SHALL require the filter to match exactly one test; if zero or more than one test matches, an error SHALL be printed to stderr and the process SHALL exit with code 1.
- `--json`: emit machine-readable JSON (a `tests` array with per-test directories and counts, and an `orphans` array) instead of the human table.
- `--absolute`: print absolute directory paths instead of project-root-relative paths.
- `--orphans`: additionally list on-disk `testdata/` and `corpus/` hash directories that match no discovered test.
- `--prune`: delete orphaned `corpus/` directories. It SHALL prompt for confirmation before deleting.
- `--all`: with `--prune`, additionally delete orphaned `testdata/` directories. Using `--all` without `--prune` SHALL be a usage error (exit code 1).
- `--force` / `-f`: with `--prune`, skip the confirmation prompt. Using `--force` without `--prune` SHALL be a usage error (exit code 1).

`--dir`, `--json`, and `--prune` are mutually-exclusive output/action modes; specifying more than one SHALL be a usage error (exit code 1). `--absolute` affects only the human table and the `--orphans` list; `--json` and `--dir` always emit absolute paths.

For `--prune`, if `--force` is not given and stdin is not a TTY, the subcommand SHALL print the orphan list and abort with code 1 rather than hanging or deleting. If the user declines the confirmation prompt, nothing SHALL be deleted.

Absent `--dir`, `--json`, and `--prune`, the subcommand SHALL print a human-readable table with columns for the test file, test name, seed/crash/timeout counts, and directory, followed (when `--orphans` is set) by a list of orphaned directories.

#### Scenario: Default mapping table

- **WHEN** `npx vitiate paths` is executed in a project with fuzz tests
- **THEN** a table SHALL be printed mapping each test to its directory with seed/crash/timeout counts
- **AND** no directories SHALL be created

#### Scenario: Pattern filter

- **WHEN** `npx vitiate paths url` is executed
- **THEN** only tests whose file path, test name, or hash directory contains `url` SHALL be listed

#### Scenario: Pattern matches no test

- **WHEN** `npx vitiate paths zzz` is executed in a project that has fuzz tests but none match `zzz`
- **THEN** a message SHALL indicate that no fuzz tests match the pattern (distinct from the "no fuzz tests found" message used when the project has none)

#### Scenario: Unique directory for scripting

- **WHEN** `npx vitiate paths normalize --dir` is executed AND exactly one test matches `normalize`
- **THEN** only that test's testdata directory path SHALL be printed

#### Scenario: Ambiguous --dir match

- **WHEN** `npx vitiate paths url --dir` is executed AND more than one test matches
- **THEN** an error SHALL be printed to stderr AND the process SHALL exit with code 1

#### Scenario: Orphan listing

- **WHEN** `npx vitiate paths --orphans` is executed AND a hash directory exists on disk with no matching test
- **THEN** that directory SHALL be listed as orphaned with its entry count

#### Scenario: Prune corpus orphans with confirmation

- **WHEN** `npx vitiate paths --prune` is executed on a TTY AND the user confirms
- **THEN** orphaned `corpus/` directories SHALL be deleted
- **AND** orphaned `testdata/` directories SHALL be left intact

#### Scenario: Prune all with --all

- **WHEN** `npx vitiate paths --prune --all --force` is executed
- **THEN** orphaned `corpus/` and `testdata/` directories SHALL both be deleted

#### Scenario: Non-TTY prune without --force aborts

- **WHEN** `npx vitiate paths --prune` is executed AND stdin is not a TTY AND `--force` is not given
- **THEN** the orphan list SHALL be printed AND nothing SHALL be deleted AND the process SHALL exit with code 1

#### Scenario: Prune refused on unknown test set

- **WHEN** `npx vitiate paths --prune` is executed AND the fuzz-test set cannot be discovered (Vitest missing)
- **THEN** nothing SHALL be deleted AND the process SHALL exit with code 1

#### Scenario: Prune refused when no fuzz tests are discovered

- **WHEN** `npx vitiate paths --prune --all --force` is executed AND discovery succeeds but finds zero fuzz tests
- **THEN** an error SHALL be printed AND nothing SHALL be deleted AND the process SHALL exit with code 1

#### Scenario: Usage error for --all without --prune

- **WHEN** `npx vitiate paths --all` is executed without `--prune`
- **THEN** an error SHALL be printed AND the process SHALL exit with code 1

#### Scenario: Mode flags are mutually exclusive

- **WHEN** `npx vitiate paths --dir --json` (or any two of `--dir`/`--json`/`--prune`) is executed
- **THEN** an error SHALL be printed AND the process SHALL exit with code 1

