## ADDED Requirements

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
