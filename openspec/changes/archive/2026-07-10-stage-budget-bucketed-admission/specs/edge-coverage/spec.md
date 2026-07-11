## MODIFIED Requirements

### Requirement: Track novel coverage indices for interesting inputs

When `evaluate_coverage()` determines an input is interesting (triggers new coverage), the system SHALL identify and store the specific coverage map indices that are newly maximized. These "novel indices" SHALL be stored as `MapNoveltiesMetadata` on the testcase.

The novelty computation SHALL:

1. Before calling `MaxMapFeedback::is_interesting()`, compare the current coverage map against the feedback's internal history to identify indices where `map[i] > history[i]`. Because the coverage map has been classified into AFL-style hit-count buckets and the history stores classified values, this comparison identifies indices where the current execution reached a strictly higher hit-count *bucket* than any previous execution at that index (not merely a higher raw count within the same bucket).
2. Record these indices as a `Vec<usize>`.
3. After `is_interesting()` confirms the input is interesting, store the recorded indices as `MapNoveltiesMetadata` on the testcase.

`MapNoveltiesMetadata` SHALL be LibAFL's `MapNoveltiesMetadata` type (from `libafl::feedbacks::map`), containing a `list: Vec<usize>` of novel coverage map indices.

Novelty tracking applies to all paths through `evaluate_coverage()` - both the main fuzz loop (`reportResult`) and stage executions (`advanceStage`). Any input added to the corpus SHALL have `MapNoveltiesMetadata` stored on its testcase.

Novelty tracking SHALL NOT occur during calibration. Calibration calls `MaxMapFeedback::is_interesting()` multiple times for the same input to detect unstable edges; computing novelties during these re-runs would produce incorrect results (the history changes between runs). The `MapNoveltiesMetadata` stored on a testcase reflects the novelties from the initial `evaluate_coverage()` call that added the input to the corpus, not any subsequent calibration runs.

#### Scenario: Novel indices recorded for interesting input

- **WHEN** a fuzz input triggers coverage at map indices `[42, 107, 255]`
- **AND** indices 42 and 255 were previously zero in the feedback history (newly discovered)
- **AND** index 107 had a previous classified value of 1 but the current execution reaches bucket `[8,15]` (classified value 8, a higher bucket)
- **THEN** `MapNoveltiesMetadata` on the testcase SHALL contain `[42, 107, 255]`

#### Scenario: Same-bucket increase is not novel

- **WHEN** index 107 had a previous classified value of 4 (bucket `[4,7]`)
- **AND** the current execution has a raw count of 6 at index 107 (still bucket `[4,7]`)
- **THEN** index 107 SHALL NOT appear in `MapNoveltiesMetadata`

#### Scenario: No novelty metadata for non-interesting inputs

- **WHEN** a fuzz input does NOT trigger new coverage (not interesting)
- **THEN** no `MapNoveltiesMetadata` SHALL be stored (input is not added to corpus)

#### Scenario: Novelty tracking during stage executions

- **WHEN** a stage execution (I2S, generalization, or Grimoire) triggers new coverage
- **AND** the input is added to the corpus
- **THEN** `MapNoveltiesMetadata` SHALL be stored on the new testcase
- **AND** the new entry can be generalized in a future stage pipeline
