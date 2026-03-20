## MODIFIED Requirements

### Requirement: Create fuzzer instance

Provide `Fuzzer` class constructable via `new Fuzzer(coverageMap, config?, watchdog?, shmemHandle?)`.

Required: coverage map `Buffer`.

Optional:
- `FuzzerConfig` object (all fields optional with defaults as specified below)
- `Watchdog` instance - the Fuzzer takes ownership; used for arming/disarming during `runBatch` iterations
- `ShmemHandle` instance - the Fuzzer takes ownership; used for stashing inputs during `runBatch` iterations and exposed via `stashInput()` pass-through

Config fields (all optional with defaults):
- `maxInputLen` (number, default 4096)
- `seed` (number, optional, negative reinterpreted as unsigned 64-bit)
- `dictionaryPath` (string, optional, absolute path to AFL/libfuzzer-format dictionary)
- `detectorTokens` (array of `Buffer`, optional, pre-seeded from bug detectors)
- `detectorSeeds` (array of `Buffer`, optional, detector-contributed seed inputs queued during seed composition)
- `grimoire` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `unicode` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `redqueen` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `jsonMutations` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `autoSeed` (boolean, optional, default true: controls automatic seeding - both detector seeds and default auto-seeds)

On construction:
- Enable CmpLog accumulator for `traceCmp` calls
- Initialize `CmpValuesMetadata` on fuzzer state
- Include `I2SSpliceReplace` (wrapping `I2SRandReplace`) in mutation pipeline
- Initialize `SchedulerMetadata` with `PowerSchedule::fast()` using `CorpusPowerTestcaseScore`
- Initialize havoc mutator with `havoc_mutations()` merged with `tokens_mutations()`
- Initialize JSON mutation stage mutator: `HavocScheduledMutator` wrapping `JsonTokenReplaceString`, `JsonTokenReplaceKey`, `JsonReplaceValue` with `max_stack_pow = 3`
- Initialize `TopRatedsMetadata` on fuzzer state
- Initialize: `stage_state` to `StageState::None`, `last_interesting_corpus_id` to `None`, `last_stage_input` to `None`
- Allocate pre-allocated input buffer of `maxInputLen` bytes for `runBatch` use
- Store owned `Watchdog` reference (if provided)
- Store owned `ShmemHandle` reference (if provided)
- Pass `jsonMutations` override to `FeatureDetection::new()` alongside existing feature overrides
- Store `auto_seed_enabled` flag from `autoSeed` config (default `true`)
- Store `detector_seeds` from config for deferred queuing during seed composition

#### Scenario: Create with defaults
- **WHEN** `new Fuzzer(coverageMap)` is called with only a coverage map
- **THEN** fuzzer is created with default config, no watchdog, no shmem handle, and a pre-allocated input buffer of 4096 bytes
- **AND** `json_mutations_enabled` SHALL be `false` (auto-detect pending)

#### Scenario: Create with custom config
- **WHEN** `new Fuzzer(coverageMap, { maxInputLen: 8192, seed: 42 })` is called
- **THEN** fuzzer uses specified maxInputLen and seed, pre-allocated buffer is 8192 bytes

#### Scenario: Create with dictionary path
- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/path/to/dict" })` is called with a valid dictionary file
- **THEN** dictionary tokens are loaded and added to the `Tokens` metadata

#### Scenario: Create with nonexistent dictionary path
- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/nonexistent" })` is called
- **THEN** constructor throws an error

#### Scenario: Create with malformed dictionary
- **WHEN** a dictionary file contains unparseable entries
- **THEN** constructor throws an error

#### Scenario: Reproducible with same seed
- **WHEN** two fuzzers are created with identical seeds and identical initial conditions
- **THEN** `getNextInput()` produces the same sequence of mutations

#### Scenario: Create with defaults includes stage state
- **WHEN** `new Fuzzer(coverageMap)` is called
- **THEN** `stage_state` is `StageState::None`, `last_interesting_corpus_id` is `None`, `last_stage_input` is `None`

#### Scenario: Create with detector tokens
- **WHEN** `new Fuzzer(coverageMap, { detectorTokens: [buf1, buf2] })` is called
- **THEN** tokens are added to `Tokens` metadata as pre-promoted entries

#### Scenario: Detector tokens coexist with user dictionary
- **WHEN** both `dictionaryPath` and `detectorTokens` are provided
- **THEN** both sets of tokens are present in `Tokens` metadata

#### Scenario: Detector tokens exempt from CmpLog cap
- **WHEN** detector tokens are provided
- **THEN** they do not count against CmpLog token promotion threshold

#### Scenario: CmpLog does not re-promote detector tokens
- **WHEN** a CmpLog entry matches an already-promoted detector token
- **THEN** the token is not re-added to `Tokens` metadata

#### Scenario: Create with watchdog
- **WHEN** `new Fuzzer(coverageMap, config, watchdog)` is called with a Watchdog instance
- **THEN** the Fuzzer takes ownership and uses it for arming/disarming during `runBatch`

#### Scenario: Create with jsonMutations explicit enable
- **WHEN** `new Fuzzer(coverageMap, { jsonMutations: true })` is called
- **THEN** `json_mutations_enabled` on `FeatureDetection` SHALL be `true`
- **AND** auto-detection SHALL NOT override this setting

#### Scenario: Create with jsonMutations explicit disable
- **WHEN** `new Fuzzer(coverageMap, { jsonMutations: false })` is called
- **THEN** `json_mutations_enabled` on `FeatureDetection` SHALL be `false`
- **AND** auto-detection SHALL NOT override this setting

### Requirement: Seed composition on first getNextInput (replaces: Auto-seed on empty corpus)

When `getNextInput()` is first called, the system SHALL compose the seed queue from multiple sources in a single initialization step. The composition order SHALL be:

1. **User seeds** (already queued via prior `addSeed()` calls).
2. **Detector seeds** (from `FuzzerConfig.detectorSeeds`, if `auto_seed_enabled` is `true`). Queued after user seeds.
3. **Default auto-seeds** (if `has_user_seeds` is `false` AND `auto_seed_enabled` is `true`). The default set is: `""`, `"\n"`, `"0"`, `"\x00\x00\x00\x00"`, `"{}"`, `"test"`, `"[]"`, `"null"`, `"[{}]"`, `"{\"a\":\"b\"}"`.
4. **Empty fallback** (if the seed queue is still empty after steps 1-3). A single empty buffer `b""` is added as the minimum viable seed. LibAFL requires at least one corpus entry to function.

The check for default auto-seeds is based on `has_user_seeds`, not corpus emptiness. Detector seeds in the queue do not suppress default auto-seeds.

Each seed is returned verbatim (no mutation) and only added to the corpus if it produces new coverage via `reportResult()`.

#### Scenario: No explicit seeds, auto-seed enabled

- **WHEN** `getNextInput()` is called without any prior `addSeed()` calls
- **AND** `auto_seed_enabled` is `true`
- **AND** `detectorSeeds` in config is empty
- **THEN** the call succeeds and returns a Buffer
- **AND** the default auto-seeds SHALL be queued (`""`, `"\n"`, `"0"`, `"\x00\x00\x00\x00"`, `"{}"`, `"test"`, `"[]"`, `"null"`, `"[{}]"`, `"{\"a\":\"b\"}"`)

#### Scenario: Detector seeds composed with default auto-seeds

- **WHEN** no user seeds have been added via `addSeed()`
- **AND** `detectorSeeds` in config contains 4 seeds
- **AND** `auto_seed_enabled` is `true`
- **THEN** the seed queue SHALL contain: 4 detector seeds, then default auto-seeds
- **AND** `has_user_seeds` SHALL remain `false`

#### Scenario: User seeds suppress default auto-seeds

- **WHEN** user seeds have been added via `addSeed()`
- **AND** `detectorSeeds` in config contains 4 seeds
- **THEN** the seed queue SHALL contain: user seeds, then 4 detector seeds
- **AND** default auto-seeds SHALL NOT be loaded (because `has_user_seeds` is `true`)

#### Scenario: Default seeds include JSON shapes

- **WHEN** default auto-seeds are loaded
- **THEN** the seed set SHALL include `[]`, `null`, `[{}]`, and `{"a":"b"}` in addition to the existing seeds

#### Scenario: Auto-seed disabled, no user seeds

- **WHEN** `auto_seed_enabled` is `false`
- **AND** no user seeds have been added
- **AND** `getNextInput()` is called
- **THEN** detector seeds SHALL NOT be queued (TypeScript passes empty `detectorSeeds` when `autoSeed` is `false`)
- **AND** default auto-seeds SHALL NOT be loaded
- **AND** a single empty buffer `b""` SHALL be added as the minimum viable seed
- **AND** the call SHALL succeed and return a Buffer

#### Scenario: Auto-seed disabled, user seeds present

- **WHEN** `auto_seed_enabled` is `false`
- **AND** user seeds have been added via `addSeed()`
- **THEN** no default auto-seeds SHALL be loaded
- **AND** no detector seeds SHALL be present (TypeScript passes empty `detectorSeeds` when `autoSeed` is `false`)
- **AND** the seed queue SHALL contain only user-provided seeds

### Requirement: StageState enum on Fuzzer

The `StageState` enum SHALL include a `Json` variant for the JSON mutation stage. The variant SHALL track:
- `corpus_id`: The corpus entry being mutated.
- `iteration`: Current iteration index (starts at 0).
- `max_iterations`: Total iterations for this stage entry (1-128).

No string slots are cached on the variant since mutations are non-cumulative (each iteration starts from a fresh clone). The stage entry pre-check uses `looks_like_json()` instead.

The pipeline ordering SHALL be: Colorization → REDQUEEN → I2S → Generalization → Grimoire → Unicode → Json → None.

#### Scenario: StageState includes Json variant

- **WHEN** the JSON stage is active
- **THEN** `stage_state` SHALL be `StageState::Json { corpus_id, iteration, max_iterations }`
- **AND** `iteration` SHALL start at 0 and increment each iteration
- **AND** `max_iterations` SHALL be between 1 and 128 inclusive

#### Scenario: Full pipeline traversal

- **WHEN** all features are enabled (REDQUEEN, Grimoire, Unicode, JSON mutations)
- **THEN** `StageState` transitions `None` → `Colorization` → ... → `Redqueen` → ... → `Generalization` → ... → `Grimoire` → ... → `Unicode` → ... → `Json` → ... → `None`

## ADDED Requirements
