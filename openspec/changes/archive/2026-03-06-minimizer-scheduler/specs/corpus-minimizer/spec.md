## ADDED Requirements

### Requirement: MapIndexesMetadata collection

When `evaluate_coverage()` determines that an input is interesting and adds it to the corpus, the engine SHALL also store `MapIndexesMetadata` on the testcase. `MapIndexesMetadata` SHALL contain the indices of all nonzero entries in the coverage map at the time of evaluation — not just the novel indices.

The collection SHALL piggy-back on the existing coverage map iteration that computes `MapNoveltiesMetadata`. No additional coverage map pass SHALL be performed.

`MapIndexesMetadata` SHALL NOT be stored for non-interesting inputs (they are not added to the corpus).

#### Scenario: MapIndexesMetadata contains all covered edges not just novel

- **WHEN** an interesting input covers edges {10, 20, 30, 40, 50} and only {40, 50} are novel
- **THEN** `MapIndexesMetadata` SHALL contain all five indices {10, 20, 30, 40, 50}

#### Scenario: MapIndexesMetadata not stored for non-interesting inputs

- **WHEN** `evaluate_coverage()` processes an input that is not interesting
- **THEN** no `MapIndexesMetadata` SHALL be created or stored

### Requirement: TopRatedsMetadata state

The engine SHALL maintain a `TopRatedsMetadata` state (initialized during `Fuzzer` construction) that maps each observed coverage edge index to the corpus ID of the best testcase for that edge.

"Best" is defined by `LenTimeMulTestcasePenalty`: `penalty = exec_time_ms * input_length_bytes`. The testcase with the lowest penalty for a given edge is the best representative.

#### Scenario: TopRatedsMetadata initialized empty

- **WHEN** a Fuzzer is constructed
- **THEN** `TopRatedsMetadata` SHALL exist on the fuzzer state
- **AND** its edge-to-corpus-ID map SHALL be empty

#### Scenario: TopRatedsMetadata populated on first corpus entry

- **WHEN** the first interesting input is added to the corpus with `MapIndexesMetadata` containing edges {10, 20, 30}
- **THEN** `TopRatedsMetadata` SHALL map edges 10, 20, and 30 to that corpus entry's ID

### Requirement: update_score on corpus addition

When a new corpus entry is added and the scheduler's `on_add()` is invoked, the minimizer scheduler SHALL call `update_score` to update `TopRatedsMetadata`.

All corpus entries — including seeds — SHALL have `MapIndexesMetadata` when `on_add()` is invoked. Seeds SHALL be given empty `MapIndexesMetadata` (containing no edge indices) in `addSeed()`, so that `update_score` succeeds without error. An empty `MapIndexesMetadata` means the entry covers no edges and cannot become favored.

For each edge index in the entry's `MapIndexesMetadata`:
- If no existing entry is tracked for that edge: the new entry becomes the best.
- If an existing entry is tracked: compare `LenTimeMulTestcasePenalty` scores. If the new entry has a lower penalty (smaller and/or faster), it replaces the existing entry as the best for that edge.

#### Scenario: New entry displaces slower entry for shared edge

- **WHEN** corpus entry A (exec_time=1ms, length=100 bytes) is the best for edge 42
- **AND** corpus entry B (exec_time=0.5ms, length=50 bytes) is added and also covers edge 42
- **THEN** entry B SHALL replace entry A as the best for edge 42 in `TopRatedsMetadata` (penalty 25 < 100)

#### Scenario: New entry does not displace faster entry

- **WHEN** corpus entry A (exec_time=0.1ms, length=10 bytes) is the best for edge 42
- **AND** corpus entry B (exec_time=1ms, length=1000 bytes) is added and also covers edge 42
- **THEN** entry A SHALL remain the best for edge 42 in `TopRatedsMetadata` (penalty 1 < 1000)

#### Scenario: New entry covers previously unseen edge

- **WHEN** corpus entry B is added with `MapIndexesMetadata` containing edge 99
- **AND** no existing entry in `TopRatedsMetadata` covers edge 99
- **THEN** entry B SHALL become the best for edge 99

#### Scenario: update_score for seeds with empty MapIndexesMetadata

- **WHEN** a seed is added via `addSeed()` with empty `MapIndexesMetadata` (no edge indices)
- **AND** the scheduler's `on_add()` invokes `update_score`
- **THEN** `update_score` SHALL succeed without error
- **AND** `TopRatedsMetadata` SHALL NOT be modified (no edges to register)
- **AND** the seed SHALL NOT be marked with `IsFavoredMetadata`

### Requirement: update_score behavior on on_replace (calibration)

When `calibrateFinish()` calls `scheduler.on_replace()`, the `MinimizerScheduler` SHALL call `update_score` for the entry. The `update_score` method has a self-comparison shortcut: when the entry being scored is already the best for an edge in `TopRatedsMetadata`, it is retained unconditionally without recomputing or comparing penalties.

This means:
- Edges the entry already owns are retained regardless of how calibration changed its penalty.
- The entry may **gain** new edges if its calibrated penalty is now lower than the current best for those edges.
- If calibration made the entry's penalty **worse**, it still retains its existing edges. Only a future `update_score` call from a **different** entry can displace it — and that comparison will use the calibrated (worse) penalty.

The net effect is that calibrated penalties are reflected in `TopRatedsMetadata` comparisons, but only when different entries compete for the same edge — not when an entry is re-evaluated against itself.

#### Scenario: Calibrated entry retains existing edges unconditionally

- **WHEN** corpus entry A is the best for edge 42 in `TopRatedsMetadata` (added with preliminary exec_time=500us)
- **AND** calibration completes with averaged exec_time=2ms (penalty worsened)
- **AND** `calibrateFinish()` calls `scheduler.on_replace()`
- **THEN** entry A SHALL remain the best for edge 42 (self-comparison shortcut, no penalty recomputation)

#### Scenario: Calibrated entry gains new edges with improved penalty

- **WHEN** corpus entry A covers edges {10, 20, 30} but only owns edges {20, 30} in `TopRatedsMetadata` (edge 10 owned by entry B with lower penalty)
- **AND** calibration of A completes with averaged exec_time lower than the preliminary value
- **AND** A's calibrated penalty for edge 10 is now lower than B's penalty
- **AND** `calibrateFinish()` calls `scheduler.on_replace()`
- **THEN** entry A SHALL displace entry B for edge 10 and now own edges {10, 20, 30}

#### Scenario: Future entries compare using calibrated penalties

- **WHEN** corpus entry A owns edge 42 with a calibrated penalty of 60 (penalty worsened after calibration but retained via self-check)
- **AND** a new corpus entry C is added and also covers edge 42 with penalty 30
- **THEN** `update_score(C)` SHALL compare C's penalty (30) against A's calibrated penalty (60)
- **AND** entry C SHALL displace entry A for edge 42

### Requirement: IsFavoredMetadata marking

The minimizer scheduler SHALL maintain `IsFavoredMetadata` markers on corpus entries. A corpus entry SHALL have `IsFavoredMetadata` if and only if it appears as the best representative for at least one edge in `TopRatedsMetadata`.

The `cull` operation SHALL refresh these markers: iterate `TopRatedsMetadata` and mark each referenced corpus entry with `IsFavoredMetadata`. Entries no longer referenced SHALL have `IsFavoredMetadata` removed.

`cull` SHALL be called before each `next()` selection to ensure favored marks are up-to-date.

#### Scenario: Entry marked favored when it is best for at least one edge

- **WHEN** corpus entry A is the best representative for edges {10, 20} in `TopRatedsMetadata`
- **AND** `cull` is called
- **THEN** entry A SHALL have `IsFavoredMetadata`

#### Scenario: Entry loses favored status when displaced

- **WHEN** corpus entry A was the best for edge 10 (its only edge in `TopRatedsMetadata`)
- **AND** corpus entry B displaces A for edge 10
- **AND** `cull` is called
- **THEN** entry A SHALL NOT have `IsFavoredMetadata`
- **AND** entry B SHALL have `IsFavoredMetadata`

### Requirement: Probabilistic skip of non-favored entries

During `next()`, after the base scheduler (power-weighted `ProbabilitySamplingScheduler`) selects a candidate entry, the minimizer SHALL check whether the candidate has `IsFavoredMetadata`.

- If favored: return the candidate immediately.
- If non-favored: with 95% probability, reject the candidate and re-select from the base scheduler. With 5% probability, return the candidate anyway.

The re-selection loop SHALL evaluate: if the candidate lacks `IsFavoredMetadata` AND a random coinflip returns true with 95% probability, reject and re-select. Otherwise, return the candidate. Specifically, the loop condition is `!is_favored && coinflip(0.95)` — both conditions must hold to skip.

This means:
- Favored entries are always returned immediately (the `!is_favored` condition is false).
- Non-favored entries are returned with 5% probability per attempt (the coinflip returns false).
- There is no maximum retry count. Termination is probabilistic: each iteration has an independent 5% chance of accepting a non-favored entry, so the expected number of iterations before acceptance is 20.

#### Scenario: Favored entry selected without skipping

- **WHEN** the base scheduler selects a favored corpus entry
- **THEN** the minimizer SHALL return that entry immediately without any coinflip check

#### Scenario: Non-favored entry skipped with high probability

- **WHEN** the base scheduler selects a non-favored corpus entry
- **THEN** with 95% probability, the minimizer SHALL reject it and re-select
- **AND** with 5% probability, the minimizer SHALL return it

#### Scenario: All entries non-favored (e.g., only seeds)

- **WHEN** no corpus entries have `IsFavoredMetadata` (e.g., only seeds with empty `MapIndexesMetadata`)
- **THEN** the minimizer SHALL still terminate — each re-selection attempt has a 5% chance of returning the non-favored candidate
- **AND** the expected number of base scheduler calls before returning is 20
