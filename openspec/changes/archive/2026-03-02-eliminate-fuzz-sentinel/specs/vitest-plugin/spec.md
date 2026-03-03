## MODIFIED Requirements

### Requirement: Fuzz mode activation via --fuzz CLI flag

The plugin's `config()` hook SHALL scan `process.argv` for a `--fuzz` argument and activate fuzzing mode if the `VITIATE_FUZZ` environment variable is not already set. This provides a CLI convenience so users can write `vitest --fuzz` instead of `VITIATE_FUZZ=1 vitest`.

The scan SHALL recognize two forms:

- `--fuzz` (bare flag): sets `VITIATE_FUZZ` to `"1"` (all fuzz tests run).
- `--fuzz=<pattern>` (with value): sets `VITIATE_FUZZ` to `"1"` and sets `VITIATE_FUZZ_PATTERN` to `<pattern>` (only fuzz tests matching the pattern run).

The form `--fuzz <pattern>` (space-separated) SHALL NOT be supported because it is ambiguous with Vitest's positional file arguments.

If `VITIATE_FUZZ` is already set in the environment, the `--fuzz` flag SHALL be ignored (explicit env vars take precedence). If `VITIATE_FUZZ_PATTERN` is already set in the environment, the pattern from `--fuzz=<pattern>` SHALL be ignored.

The `parseFuzzFlag(argv)` helper SHALL return a structured value: `{ pattern?: string }` when a `--fuzz` flag is found, or `undefined` when no flag is present. The optional `pattern` field SHALL be present only when `--fuzz=<pattern>` is used with a non-empty value.

#### Scenario: Bare --fuzz flag activates fuzzing

- **WHEN** `vitest --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"1"`
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** all fuzz tests run in fuzzing mode

#### Scenario: --fuzz with pattern sets both env vars

- **WHEN** `vitest --fuzz=mypattern` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **AND** `VITIATE_FUZZ_PATTERN` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"1"`
- **AND** the plugin's `config()` hook sets `VITIATE_FUZZ_PATTERN` to `"mypattern"`
- **AND** only fuzz tests whose name matches `mypattern` run in fuzzing mode

#### Scenario: Explicit VITIATE_FUZZ env var takes precedence over --fuzz

- **WHEN** `VITIATE_FUZZ=1 vitest --fuzz=mypattern` is executed
- **THEN** `VITIATE_FUZZ` retains the value `"1"`
- **AND** the `--fuzz` flag is ignored for the activation env var

#### Scenario: Explicit VITIATE_FUZZ_PATTERN env var takes precedence

- **WHEN** `VITIATE_FUZZ_PATTERN=existing vitest --fuzz=override` is executed
- **THEN** `VITIATE_FUZZ_PATTERN` retains the value `"existing"`

#### Scenario: No --fuzz flag and no env var

- **WHEN** `vitest` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **AND** `--fuzz` is not present in `process.argv`
- **THEN** `VITIATE_FUZZ` is not set
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** fuzz tests run in regression mode (replaying corpus only)

#### Scenario: --fuzz after -- sentinel is ignored

- **WHEN** `vitest -- --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** `VITIATE_FUZZ` is not set
- **AND** `VITIATE_FUZZ_PATTERN` is not set
- **AND** fuzz tests run in regression mode
