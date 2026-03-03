## ADDED Requirements

### Requirement: Fuzz mode activation via --fuzz CLI flag

The plugin's `config()` hook SHALL scan `process.argv` for a `--fuzz` argument and set `process.env.VITIATE_FUZZ` accordingly if the environment variable is not already set. This provides a CLI convenience so users can write `vitest --fuzz` instead of `VITIATE_FUZZ=1 vitest`.

The scan SHALL recognize two forms:

- `--fuzz` (bare flag): sets `VITIATE_FUZZ` to `"1"` (all fuzz tests run).
- `--fuzz=<pattern>` (with value): sets `VITIATE_FUZZ` to `<pattern>` (only fuzz tests matching the pattern run).

The form `--fuzz <pattern>` (space-separated) SHALL NOT be supported because it is ambiguous with Vitest's positional file arguments.

If `VITIATE_FUZZ` is already set in the environment, the `--fuzz` flag SHALL be ignored (explicit env vars take precedence).

#### Scenario: Bare --fuzz flag activates fuzzing

- **WHEN** `vitest --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"1"`
- **AND** all fuzz tests run in fuzzing mode

#### Scenario: --fuzz with pattern filters fuzz tests

- **WHEN** `vitest --fuzz=mypattern` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** the plugin's `config()` hook sets `VITIATE_FUZZ` to `"mypattern"`
- **AND** only fuzz tests whose name matches `mypattern` run in fuzzing mode

#### Scenario: Explicit VITIATE_FUZZ env var takes precedence over --fuzz

- **WHEN** `VITIATE_FUZZ=otherpattern vitest --fuzz=mypattern` is executed
- **THEN** `VITIATE_FUZZ` retains the value `"otherpattern"`
- **AND** the `--fuzz` flag is ignored

#### Scenario: No --fuzz flag and no env var

- **WHEN** `vitest` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **AND** `--fuzz` is not present in `process.argv`
- **THEN** `VITIATE_FUZZ` is not set
- **AND** fuzz tests run in regression mode (replaying corpus only)

#### Scenario: --fuzz after -- sentinel is ignored

- **WHEN** `vitest -- --fuzz` is executed with the vitiate plugin loaded
- **AND** `VITIATE_FUZZ` is not set in the environment
- **THEN** `VITIATE_FUZZ` is not set
- **AND** fuzz tests run in regression mode

## RENAMED Requirements

### Requirement: configureVitest lifecycle hook
FROM: configureVitest lifecycle hook
TO: Setup file registration

## MODIFIED Requirements

### Requirement: Setup file registration

The plugin SHALL register the runtime setup file via the `config()` hook by returning `{ test: { setupFiles: [setupPath] } }`. Vite deep-merges `config()` return values into the resolved config before Vitest processes them, ensuring the setup file is registered before any test code executes.

The `configureVitest` hook SHALL NOT be used for setup file registration because it fires after Vitest's project config is resolved and frozen — `setupFiles` cannot be modified at that point.

#### Scenario: Setup file is registered via config hook

- **WHEN** the vitiate plugin is loaded by Vitest
- **THEN** the plugin's `config()` hook returns a config object containing the vitiate runtime setup module in `test.setupFiles`
- **AND** the setup file is present in the resolved Vitest config before any tests execute
