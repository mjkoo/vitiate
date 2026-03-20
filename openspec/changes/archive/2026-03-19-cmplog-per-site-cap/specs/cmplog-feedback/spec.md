## ADDED Requirements

### Requirement: Per-site entry cap

The CmpLog accumulator SHALL enforce a per-site entry cap in addition to the global 4096-entry cap. Each comparison site (identified by `cmp_id`) SHALL be limited to `MAX_ENTRIES_PER_SITE` (default: 8) entries per iteration. When a site has reached its cap, subsequent entries for that site SHALL be silently dropped.

The per-site cap SHALL be tracked using a fixed-size count array of `SITE_COUNT_SLOTS` (default: 512) `u8` slots. The slot for a given `cmp_id` SHALL be determined by `cmp_id & (SITE_COUNT_SLOTS - 1)`. Counts SHALL saturate at `MAX_ENTRIES_PER_SITE` (never overflow).

Hash collisions (two distinct `cmp_id` values mapping to the same slot) cause the colliding sites to share a budget. This is acceptable because the cap is a performance heuristic, not a correctness invariant. Under-recording is always safe.

`MAX_ENTRIES_PER_SITE` MUST NOT exceed 255, since per-site counts are stored as `u8`.

#### Scenario: Entries within per-site cap are recorded

- **WHEN** a comparison site with `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries in the current iteration
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded in the accumulator

#### Scenario: Entries beyond per-site cap are dropped

- **WHEN** a comparison site with `cmp_id = 42` has already recorded `MAX_ENTRIES_PER_SITE` entries in the current iteration
- **AND** another entry is pushed for site 42
- **THEN** the new entry SHALL be silently dropped
- **AND** the global entry count SHALL NOT increase

#### Scenario: Different sites have independent budgets

- **WHEN** site `cmp_id = 1` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** site `cmp_id = 2` has recorded 0 entries
- **AND** sites 1 and 2 do not collide in the count array
- **AND** a new entry is pushed for site 2
- **THEN** the entry for site 2 SHALL be recorded

#### Scenario: Global cap still applies

- **WHEN** 4096 total entries have been recorded across all sites
- **AND** a site that has not reached its per-site cap pushes a new entry
- **THEN** the entry SHALL be silently dropped (global cap takes precedence)

#### Scenario: Colliding sites share a budget

- **WHEN** `cmp_id_a & (SITE_COUNT_SLOTS - 1) == cmp_id_b & (SITE_COUNT_SLOTS - 1)`
- **AND** `MAX_ENTRIES_PER_SITE` entries have been recorded across sites A and B combined
- **AND** another entry is pushed for either site
- **THEN** the entry SHALL be silently dropped

#### Scenario: Multi-entry serialization counts against per-site cap

- **WHEN** a numeric comparison produces 2 `CmpValues` entries (one integer variant and one `Bytes` variant)
- **THEN** both entries SHALL count toward the per-site cap for that `cmp_id`
- **AND** the 5th numeric comparison at the same site (attempting entries 9 and 10) SHALL have its entries dropped

#### Scenario: Partial multi-entry drop at cap boundary

- **WHEN** a comparison site has recorded 7 entries (one slot remaining under `MAX_ENTRIES_PER_SITE`)
- **AND** a numeric comparison produces 2 `CmpValues` entries for that site
- **THEN** the first entry SHALL be recorded (count becomes 8)
- **AND** the second entry SHALL be silently dropped (count is at cap)

### Requirement: Early-exit check before serialization

The CmpLog module SHALL provide a public `is_site_at_cap(cmp_id: u32) -> bool` function that returns `true` when the per-site count for the given `cmp_id` has reached `MAX_ENTRIES_PER_SITE`, or when the accumulator is disabled, or when the global cap has been reached.

`trace_cmp_record` SHALL call `is_site_at_cap` before `serialize_to_cmp_values`. When `is_site_at_cap` returns `true`, serialization (NAPI type extraction, value extraction, ryu_js formatting, allocation) SHALL be skipped entirely.

#### Scenario: Serialization skipped for capped site

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `trace_cmp_record` is called with `cmp_id = 42`
- **THEN** `is_site_at_cap(42)` SHALL return `true`
- **AND** `serialize_to_cmp_values` SHALL NOT be called

#### Scenario: Serialization proceeds for uncapped site

- **WHEN** site `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries
- **AND** the accumulator is enabled and below the global cap
- **THEN** `is_site_at_cap(42)` SHALL return `false`
- **AND** serialization SHALL proceed normally

#### Scenario: Early exit when disabled

- **WHEN** the accumulator is disabled (no active Fuzzer)
- **THEN** `is_site_at_cap` SHALL return `true` for any `cmp_id`

#### Scenario: Early exit at global cap

- **WHEN** 4096 entries have been recorded across all sites
- **AND** site `cmp_id = 42` has recorded fewer than `MAX_ENTRIES_PER_SITE` entries
- **THEN** `is_site_at_cap(42)` SHALL return `true`

### Requirement: Per-site counts reset on drain, enable, and disable

The per-site count array SHALL be zeroed when the accumulator is drained (via `drain()`), when CmpLog recording is enabled (via `enable()`), and when CmpLog recording is disabled (via `disable()`). This ensures each fuzz iteration and each fuzzing session starts with a fresh per-site budget, and that stale counts do not persist across enable/disable cycles.

#### Scenario: Counts reset on drain

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `drain()` is called
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded (the per-site count was reset)

#### Scenario: Counts reset on enable

- **WHEN** site `cmp_id = 42` has recorded `MAX_ENTRIES_PER_SITE` entries
- **AND** `enable()` is called
- **AND** a new entry is pushed for site 42
- **THEN** the entry SHALL be recorded (the per-site count was reset)

#### Scenario: Counts reset on disable

- **WHEN** `disable()` is called
- **THEN** the per-site count array SHALL be zeroed

## MODIFIED Requirements

### Requirement: Thread-local comparison log accumulator

The system SHALL provide a thread-local accumulator in the `cmplog` module that comparison tracing calls can append to during a fuzz iteration. The accumulator SHALL store enriched entries of type `(CmpValues, u32, CmpLogOperator)` - comparison operand data, site ID, and operator type.

The accumulator SHALL be disabled by default (no entries recorded) and enabled only when a `Fuzzer` instance is active. The maximum capacity SHALL remain 4096 entries per iteration. When the accumulator is full, new entries SHALL be silently dropped. Additionally, each comparison site SHALL be limited to `MAX_ENTRIES_PER_SITE` entries per iteration via the per-site entry cap.

The accumulator state SHALL include a fixed-size `[u8; SITE_COUNT_SLOTS]` count array for per-site tracking.

#### Scenario: Accumulator is disabled by default

- **WHEN** no `Fuzzer` instance has been created
- **AND** comparison values are pushed to the accumulator
- **THEN** the accumulator remains empty (entries are silently dropped)

#### Scenario: Accumulator is enabled when Fuzzer is active

- **WHEN** a `Fuzzer` instance is created
- **THEN** the CmpLog accumulator is enabled
- **AND** subsequent comparison value pushes are recorded with site ID and operator
- **AND** per-site counts are tracked

#### Scenario: Accumulator is disabled when Fuzzer is dropped

- **WHEN** a `Fuzzer` instance is dropped
- **THEN** the CmpLog accumulator is disabled
- **AND** subsequent comparison value pushes are silently dropped

#### Scenario: Entries within capacity are recorded

- **WHEN** fewer than 4096 enriched entries are pushed in a single iteration
- **AND** no individual site exceeds `MAX_ENTRIES_PER_SITE`
- **THEN** all entries are present in the accumulator

#### Scenario: Entries beyond capacity are dropped

- **WHEN** 4096 enriched entries have already been pushed in a single iteration
- **AND** another value is pushed
- **THEN** the new entry is silently dropped and the accumulator size remains 4096
