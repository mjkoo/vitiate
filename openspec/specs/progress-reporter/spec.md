# Progress Reporter

## Purpose

Defines the fuzzer's human- and machine-facing progress output: periodic status lines, crash
and final-summary reporting, the file-based results channel, and startup diagnostics such as
the coverage-map load warning.
## Requirements
### Requirement: Periodic fuzzing status output

The reporter SHALL report progress periodically to stderr (not Vitest normal output). The status line includes:
- Elapsed time (seconds)
- Total executions
- Executions per second (covers all target executions, including calibration)
- Calibration executions
- Corpus size (total and new interesting since last report)
- Coverage edge count
- Coverage feature count (hit-count-bucket pairs)

Format: `fuzz: elapsed: {N}s, execs: {N} ({N}/sec), cal: {N}, corpus: {N} ({N} new), edges: {N}, ft: {N}`

The reporter polls `fuzzer.stats` on a timer. In the batched execution path, timer callbacks fire between batches when the event loop yields. The adaptive batch size (see fuzz-loop spec) ensures yields occur approximately every 3 seconds, maintaining the existing reporting cadence. The `fuzzer.stats` getter reads Rust-internal counters that are updated per-iteration within `runBatch`, so stats are current when polled.

#### Scenario: Status output during batched fuzzing
- **WHEN** the fuzz loop runs with batched execution and the reporter timer fires between batches
- **THEN** a status line is printed to stderr with current stats reflecting all iterations completed within previous batches

#### Scenario: Status updates periodically
- **WHEN** fuzzing runs for more than the reporting interval
- **THEN** multiple status lines are printed approximately every 3 seconds, regardless of whether execution is batched or per-iteration

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

### Requirement: Coverage-map load warning

The system SHALL, at the start of a fuzzing campaign (after the target's instrumented modules
have loaded), estimate coverage-map load as the total number of instrumented coverage counters
divided by the coverage-map size, and SHALL emit a one-time warning to stderr when that
fraction is at or above a threshold (2%). The warning signals that hash collisions may
silently merge edges and coarsen coverage feedback, and SHALL recommend raising
`coverageMapSize`.

The instrumented-counter total SHALL be read from the `__vitiate_edge_count` global, which the
instrumentation preamble accumulates per loaded module. When no instrumented modules have
loaded (the global is unset), the system SHALL NOT emit the warning. The warning SHALL be
emitted independent of quiet mode, since it is a one-shot correctness diagnostic rather than
periodic status.

#### Scenario: Warns at high coverage-map load

- **WHEN** roughly 4000 instrumented edges have loaded into a coverage map of 65536 slots
  (about 6.1% load)
- **THEN** a single warning is written to stderr that names the instrumented-edge count and
  recommends raising `coverageMapSize`

#### Scenario: No warning below the threshold

- **WHEN** roughly 500 instrumented edges have loaded into a 65536-slot map (about 0.8% load)
- **THEN** no warning is emitted

#### Scenario: No warning when nothing is instrumented

- **WHEN** no instrumented modules have loaded (`__vitiate_edge_count` is unset)
- **THEN** no warning is emitted

