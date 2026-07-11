## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: paths subcommand

The `vitiate paths [pattern]` subcommand SHALL be a read-only inspector that maps each discovered fuzz test to its testdata and corpus hash directory. It SHALL create no directories and mutate no files, except on the explicit `--prune` deletion path.

The subcommand SHALL discover the project's fuzz tests via the same discovery used by `init` (globbing `*.fuzz.*` and collecting fully-qualified names). If discovery cannot determine the test set (for example, Vitest is not installed), the subcommand SHALL exit with code 1 without scanning or deleting anything.

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

For `--prune`, if `--force` is not given and stdin is not a TTY, the subcommand SHALL print the orphan list and abort with code 1 rather than hanging or deleting. If the user declines the confirmation prompt, nothing SHALL be deleted.

Absent `--dir`, `--json`, and `--prune`, the subcommand SHALL print a human-readable table with columns for the test file, test name, seed/crash/timeout counts, and directory, followed (when `--orphans` is set) by a list of orphaned directories.

#### Scenario: Default mapping table

- **WHEN** `npx vitiate paths` is executed in a project with fuzz tests
- **THEN** a table SHALL be printed mapping each test to its directory with seed/crash/timeout counts
- **AND** no directories SHALL be created

#### Scenario: Pattern filter

- **WHEN** `npx vitiate paths url` is executed
- **THEN** only tests whose file path, test name, or hash directory contains `url` SHALL be listed

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

- **WHEN** `npx vitiate paths --prune` is executed AND the fuzz-test set cannot be discovered
- **THEN** nothing SHALL be deleted AND the process SHALL exit with code 1

#### Scenario: Usage error for --all without --prune

- **WHEN** `npx vitiate paths --all` is executed without `--prune`
- **THEN** an error SHALL be printed AND the process SHALL exit with code 1
