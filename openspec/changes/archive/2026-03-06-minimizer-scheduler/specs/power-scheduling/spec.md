## MODIFIED Requirements

### Requirement: Power-aware corpus scoring

The scheduler SHALL weight corpus entry selection using `CorpusPowerTestcaseScore` (from LibAFL) instead of uniform weighting. The scoring algorithm SHALL consider the following factors for each corpus entry:

- **Execution speed**: Entries faster than the global average SHALL receive higher scores (up to 3x boost). Entries slower than average SHALL be penalized (down to 0.1x).
- **Coverage size**: Entries with larger bitmap sizes relative to the global average SHALL receive higher scores (up to 3x boost).
- **Mutation depth**: Deeper entries (more parent-child hops from the original seed) SHALL receive higher scores, up to 5x at depth 25+.
- **Handicap**: Entries added when `queue_cycles` is high (i.e., added recently relative to the campaign's progress) SHALL receive a boost.
- **Fuzz count**: Entries that have been selected many times SHALL be deprioritized using the FAST schedule (logarithmic decay based on path frequency).
- **Favored status**: Entries marked with `IsFavoredMetadata` by the corpus minimizer SHALL receive a 1.15x boost. (This boost is pre-existing behavior in `CorpusPowerTestcaseScore` — it was always in the LibAFL implementation but previously inert because `IsFavoredMetadata` was never populated. The minimizer now activates it.)

The scheduler SHALL use `PowerSchedule::fast()` exclusively. There SHALL be no user-configurable schedule strategy.

The `ProbabilitySamplingScheduler` SHALL remain the base scheduler implementation, wrapped by the `MinimizerScheduler`. The `MinimizerScheduler` delegates to `ProbabilitySamplingScheduler` for weighted selection, then applies probabilistic skipping of non-favored entries (see corpus-minimizer spec).

#### Scenario: Fast entry selected more frequently

- **WHEN** the corpus contains entry A (calibrated avg exec time 100us) and entry B (calibrated avg exec time 1ms), both with equal coverage and depth
- **THEN** over many selections, entry A SHALL be selected significantly more often than entry B

#### Scenario: High-coverage entry selected more frequently

- **WHEN** the corpus contains entry A (bitmap size 500) and entry B (bitmap size 50), both with equal exec time and depth
- **THEN** over many selections, entry A SHALL be selected significantly more often than entry B

#### Scenario: Deep entry boosted

- **WHEN** the corpus contains entry A (depth 0) and entry B (depth 20), both with equal exec time and coverage
- **THEN** over many selections, entry B SHALL be selected more often than entry A

#### Scenario: Frequently-fuzzed entry deprioritized

- **WHEN** entry A has been selected 1000 times and entry B has been selected 10 times, both otherwise equal
- **THEN** entry B SHALL be selected more often than entry A in subsequent iterations

#### Scenario: Favored entry boosted over non-favored

- **WHEN** the corpus contains entry A (favored) and entry B (non-favored), both otherwise equal in power score factors
- **THEN** entry A SHALL have a 1.15x higher power score than entry B
- **AND** entry A SHALL be far more likely to be selected due to the minimizer's 95% skip of non-favored entries
