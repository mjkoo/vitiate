## MODIFIED Requirements

### Requirement: CLI entry point

The system SHALL provide a `bin` entry (`npx vitiate`) that accepts a fuzz test file path as the first positional argument and starts fuzzing targeting that file.

Usage: `npx vitiate <test-file> [corpus_dirs...] [flags]`

The CLI SHALL:

1. Parse the test file path from the first positional argument.
2. Check for the `VITIATE_SUPERVISOR` environment variable to determine mode:
   - **If absent (parent mode)**: Allocate shmem, spawn itself as a child process with `VITIATE_SUPERVISOR` set to the shmem identifier, and enter the supervisor wait loop.
   - **If present (child mode)**: Attach to the shmem region, set `VITIATE_FUZZ=1` in the process environment, and call `startVitest('test', [testFile], ...)` with the vitiate plugin loaded.
3. In parent mode, forward the exit code from the supervisor's exit code protocol (0, 1, or respawn on signal death).

#### Scenario: Basic invocation (parent mode)

- **WHEN** `npx vitiate ./tests/parser.fuzz.ts` is executed
- **THEN** the CLI allocates a shmem region
- **AND** spawns itself as a child with `VITIATE_SUPERVISOR` set
- **AND** enters the supervisor wait loop

#### Scenario: Child mode invocation

- **WHEN** `npx vitiate ./tests/parser.fuzz.ts` is executed with `VITIATE_SUPERVISOR` set
- **THEN** the CLI attaches to the shmem region
- **AND** Vitest starts in fuzzing mode with `./tests/parser.fuzz.ts` as the test file
- **AND** the vitiate plugin is loaded for instrumentation

#### Scenario: No test file provided

- **WHEN** `npx vitiate` is executed with no arguments
- **THEN** an error message is printed and the process exits with code 1

#### Scenario: Child inherits CLI flags

- **WHEN** `npx vitiate ./test.ts -timeout=10 -runs=100000 -seed=42` is executed
- **THEN** the child process receives the same arguments
- **AND** the child parses and applies the same flags as if invoked directly
