## MODIFIED Requirements

### Requirement: Unstable edge detection

During calibration, each rerun's coverage map SHALL be classified into AFL-style hit-count buckets and compared against the first calibration run's classified baseline. Comparing classified values means within-bucket count jitter (for example a loop running 5 vs 6 times, both in bucket `[4,7]`) is NOT treated as instability - only a change of hit-count bucket counts as a disagreement.

For each corpus entry, the engine SHALL accumulate a per-edge count of reruns whose classified value differed from the baseline. Observing any disagreement SHALL extend the calibration run budget to `CAL_STAGE_MAX` (8) so that enough samples are gathered to judge each edge by majority.

At `calibrateFinish()`, an edge SHALL be considered flaky *for this entry* only if it disagreed with the baseline in a strict majority of the baseline comparisons (`disagreements * 2 > comparisons`, where `comparisons` is the number of reruns compared against the baseline). A one-off blip in a single rerun SHALL NOT flag the edge for the entry.

The engine SHALL maintain a per-edge count of how many distinct corpus entries have found each edge flaky. An edge SHALL be added to the fuzzer's globally-masked unstable entries set only when this count reaches `UNSTABLE_ENTRY_THRESHOLD` (2) - i.e. only after multiple distinct entries independently corroborate the edge as flaky. A single entry's calibration noise SHALL NOT mask an edge. Once added, an edge SHALL remain in the masked set for the lifetime of the fuzzer.

#### Scenario: Stable edges not flagged

- **WHEN** all calibration runs produce identical (classified) coverage maps
- **THEN** no edge SHALL be recorded as flaky
- **AND** `calibrateRun()` SHALL NOT extend the run count beyond 4

#### Scenario: Within-bucket jitter is not instability

- **WHEN** an edge's raw count varies across reruns but stays within a single hit-count bucket (e.g. 4, 5, 6, 7)
- **THEN** no disagreement SHALL be recorded for that edge
- **AND** the edge SHALL NOT be flagged flaky for the entry

#### Scenario: Single-entry flaky edge is tracked but not masked

- **WHEN** exactly one entry's calibration finds edge 20 flaky (a majority of its reruns disagree)
- **THEN** edge 20's cross-entry flaky count SHALL be 1
- **AND** edge 20 SHALL NOT be in the fuzzer's masked unstable entries set

#### Scenario: Edge masked after corroboration across entries

- **WHEN** a second distinct entry's calibration also finds edge 20 flaky
- **THEN** edge 20's cross-entry flaky count SHALL reach `UNSTABLE_ENTRY_THRESHOLD` (2)
- **AND** edge 20 SHALL be added to the fuzzer's masked unstable entries set

#### Scenario: Masked edges are never removed

- **WHEN** an edge index has been added to the masked unstable entries set
- **THEN** it SHALL remain there for the lifetime of the fuzzer
- **AND** there SHALL be no mechanism to remove entries from the masked set
