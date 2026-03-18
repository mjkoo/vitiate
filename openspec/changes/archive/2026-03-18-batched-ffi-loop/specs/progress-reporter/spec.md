## MODIFIED Requirements

### Requirement: Periodic fuzzing status output

Report progress periodically to stderr (not Vitest normal output). Status line includes:
- Elapsed time (seconds)
- Total executions
- Executions per second
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
