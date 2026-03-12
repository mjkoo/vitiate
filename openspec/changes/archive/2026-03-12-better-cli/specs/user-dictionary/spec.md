## MODIFIED Requirements

### Requirement: Dictionary flag in CLI mode

In CLI mode, the system SHALL accept a `-dict=<path>` flag specifying the path to a dictionary file. The path SHALL be resolved relative to the current working directory, matching libfuzzer behavior.

The resolved absolute path SHALL be passed to the child process via the `dictionaryPath` field in the `VITIATE_CLI_IPC` JSON blob.

If `-dict` is provided and the file does not exist, the system SHALL exit with an error before starting the fuzzer.

If `-dict` is not provided in CLI mode, the system SHALL NOT attempt convention-based dictionary discovery (the Vitest convention does not apply in CLI mode).

#### Scenario: Dictionary loaded via CLI flag

- **WHEN** `npx vitiate libfuzzer ./test.ts -dict=./my.dict` is executed
- **AND** `./my.dict` exists and contains valid entries
- **THEN** the tokens from the file SHALL be loaded into `Tokens` metadata before the fuzz loop starts

#### Scenario: CLI dictionary file not found

- **WHEN** `npx vitiate libfuzzer ./test.ts -dict=./missing.dict` is executed
- **AND** `./missing.dict` does not exist
- **THEN** the system SHALL print an error message and exit with a non-zero exit code
- **AND** the fuzzer SHALL NOT start

#### Scenario: No dictionary flag in CLI mode

- **WHEN** `npx vitiate libfuzzer ./test.ts` is executed without `-dict`
- **THEN** no dictionary file SHALL be loaded
- **AND** the system SHALL NOT search for a `.dict` file by convention
