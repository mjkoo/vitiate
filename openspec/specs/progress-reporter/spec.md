## ADDED Requirements

### Requirement: Periodic fuzzing status output

The system SHALL report fuzzing progress periodically during the fuzz loop. Status lines SHALL be written to stderr so they do not interfere with Vitest's normal test output.

The status line SHALL include:

- Elapsed time (in seconds)
- Total executions
- Executions per second
- Calibration executions
- Corpus size (total and new interesting since last report)
- Coverage edge count
- Coverage feature count (hit-count-bucket pairs)

Format: `fuzz: elapsed: {N}s, execs: {N} ({N}/sec), cal: {N}, corpus: {N} ({N} new), edges: {N}, ft: {N}`

#### Scenario: Status output during fuzzing

- **WHEN** the fuzz loop has been running for 3 seconds
- **THEN** at least one status line has been written to stderr
- **AND** the line contains elapsed time, execs, execs/sec, calibration execs, corpus size, edge count, and feature count

#### Scenario: Status updates periodically

- **WHEN** the fuzz loop runs for 10 seconds
- **THEN** multiple status lines are written at regular intervals (approximately every 3 seconds)

### Requirement: Crash finding output

When a crash is found, the system SHALL report the crash to stderr with the error message and the path to the saved crash artifact.

#### Scenario: Crash reported

- **WHEN** the fuzz target throws during fuzzing
- **THEN** a message is written to stderr containing the error message and the crash artifact file path

### Requirement: Final summary output

When the fuzz loop terminates (by time limit, iteration limit, or crash), the system SHALL print a final summary to stderr with total executions, calibration executions, corpus size, coverage edges, coverage features, and elapsed time.

Format: `fuzz: done - execs: {N}, cal: {N}, corpus: {N}, edges: {N}, ft: {N}, elapsed: {N}s`

#### Scenario: Summary after time limit

- **WHEN** the fuzz loop terminates due to time limit
- **THEN** a summary line is written to stderr with final statistics

### Requirement: File-based results output

When the `VITIATE_RESULTS_FILE` environment variable is set to a non-empty file path, the system SHALL write final fuzzing statistics as a JSON file to that path in the fuzz loop's `finally` block. This bypasses Vitest's output pipeline, which may lose data during fork pool shutdown.

The JSON file SHALL contain all fields from `FuzzerStats` plus:

- `crashed` (boolean): Whether any crash was found
- `crashCount` (number): Number of unique crashes found
- `crashArtifactPaths` (string[]): Paths to all written crash artifacts
- `duplicateCrashesSkipped` (number): Number of duplicate crashes suppressed
- `elapsedMs` (number): Wall-clock time elapsed since fuzz loop start
- `error` (string, optional): Error message of the first crash, omitted when no crash

The file SHALL be written with `writeFileSync` (synchronous I/O) to ensure it reaches disk even during process shutdown.

#### Scenario: Results file written when env var is set

- **WHEN** `VITIATE_RESULTS_FILE=/tmp/result.json` and the fuzz loop terminates
- **THEN** `/tmp/result.json` contains valid JSON with all required fields

#### Scenario: Results file not written when env var is unset

- **WHEN** `VITIATE_RESULTS_FILE` is not set or empty
- **THEN** no results file is written

#### Scenario: Results file contains crash info

- **WHEN** the fuzz target crashes and `VITIATE_RESULTS_FILE` is set
- **THEN** the JSON file includes `crashed: true`, the error message, and artifact paths
