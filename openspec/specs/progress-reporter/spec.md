## ADDED Requirements

### Requirement: Periodic fuzzing status output

The system SHALL report fuzzing progress periodically during the fuzz loop. Status lines SHALL be written to stderr so they do not interfere with Vitest's normal test output.

The status line SHALL include:

- Elapsed time (in seconds)
- Total executions
- Executions per second
- Corpus size (total and new interesting since last report)
- Coverage edge count

Format: `fuzz: elapsed: {N}s, execs: {N} ({N}/sec), corpus: {N} ({N} new), edges: {N}`

#### Scenario: Status output during fuzzing

- **WHEN** the fuzz loop has been running for 3 seconds
- **THEN** at least one status line has been written to stderr
- **AND** the line contains elapsed time, execs, execs/sec, corpus size, and edge count

#### Scenario: Status updates periodically

- **WHEN** the fuzz loop runs for 10 seconds
- **THEN** multiple status lines are written at regular intervals (approximately every 3 seconds)

### Requirement: Crash finding output

When a crash is found, the system SHALL report the crash to stderr with the error message and the path to the saved crash artifact.

#### Scenario: Crash reported

- **WHEN** the fuzz target throws during fuzzing
- **THEN** a message is written to stderr containing the error message and the crash artifact file path

### Requirement: Final summary output

When the fuzz loop terminates (by time limit, iteration limit, or crash), the system SHALL print a final summary to stderr with total executions, corpus size, coverage edges, and elapsed time.

#### Scenario: Summary after time limit

- **WHEN** the fuzz loop terminates due to time limit
- **THEN** a summary line is written to stderr with final statistics
