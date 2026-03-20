## Purpose

Detector auto-seeding provides seed inputs from bug detectors to the fuzzing engine. Detectors that target specific input patterns (e.g., prototype pollution via JSON payloads) contribute general-purpose seeds that exercise their bug class, improving the fuzzer's ability to find vulnerabilities without requiring user-provided seeds.

## Requirements

### Requirement: Detector getSeeds interface method

The `Detector` interface SHALL include a `getSeeds()` method that returns an array of `Uint8Array` seed inputs. Each seed is a complete input that exercises the detector's target bug class.

Seeds SHALL be:
- General-purpose for the bug class (not specific to any particular target library).
- Valid inputs that a typical target would accept (e.g., valid JSON for JSON-consuming targets).
- Small (under 256 bytes each) to keep corpus overhead low.

Detectors that have no meaningful seeds to contribute SHALL return an empty array.

#### Scenario: Detector provides seeds

- **WHEN** a detector implements `getSeeds()`
- **AND** the detector has meaningful seeds for its bug class
- **THEN** `getSeeds()` SHALL return a non-empty array of `Uint8Array` inputs

#### Scenario: Detector with no seeds returns empty array

- **WHEN** a detector has no meaningful seeds to contribute
- **THEN** `getSeeds()` SHALL return an empty array `[]`

#### Scenario: Detector implements all lifecycle hooks (updated)

- **WHEN** a detector is registered with the `DetectorManager`
- **THEN** the detector SHALL implement all interface members (`name`, `tier`, `getTokens`, `getSeeds`, `setup`, `beforeIteration`, `afterIteration`, `resetIteration`, `teardown`)
- **AND** the `name` SHALL be a non-empty kebab-case string
- **AND** the `tier` SHALL be either `1` or `2`

### Requirement: DetectorManager collects seeds from active detectors

The `DetectorManager` SHALL provide a `getSeeds()` method that collects seeds from all active detectors by calling each detector's `getSeeds()` method. The collected seeds SHALL be concatenated into a single array.

#### Scenario: Seeds collected from multiple detectors

- **WHEN** two detectors are active and each provides 3 seeds
- **THEN** `DetectorManager.getSeeds()` SHALL return an array of 6 seeds

#### Scenario: No active detectors with seeds

- **WHEN** all active detectors return empty arrays from `getSeeds()`
- **THEN** `DetectorManager.getSeeds()` SHALL return an empty array

### Requirement: Detector seeds passed via FuzzerConfig

Detector seeds SHALL be passed to the engine via the `detectorSeeds` field on `FuzzerConfig`, following the same pattern as `detectorTokens`. The TypeScript fuzz loop SHALL collect detector seeds via `DetectorManager.getSeeds()` and include them in `FuzzerConfig` when constructing the `Fuzzer`, unless `autoSeed` is `false`.

The engine SHALL queue detector seeds internally during the seed composition phase of the first `getNextInput()` call, after user seeds (from `addSeed()`) and before default auto-seeds. Detector seeds do NOT set the `has_user_seeds` flag.

#### Scenario: Detector seeds passed via config

- **WHEN** the prototype pollution detector is active and provides 4 seeds
- **AND** `autoSeed` is not `false`
- **THEN** `FuzzerConfig.detectorSeeds` SHALL contain the 4 seed buffers
- **AND** the engine SHALL queue them during seed composition

#### Scenario: Detector seeds omitted when autoSeed is false

- **WHEN** `autoSeed` is `false`
- **THEN** the TypeScript fuzz loop SHALL pass an empty `detectorSeeds` array
- **AND** no detector seeds SHALL be queued by the engine

#### Scenario: Detector seeds coexist with user seeds

- **WHEN** the user provides 2 seeds via `addSeed()` and the config contains 4 detector seeds
- **THEN** the seed queue SHALL contain user seeds first, then detector seeds
- **AND** `has_user_seeds` SHALL be `true` (set by the `addSeed()` calls)
- **AND** default auto-seeds SHALL NOT be loaded (because `has_user_seeds` is `true`)

#### Scenario: Detector seeds coexist with default auto-seeds

- **WHEN** no user seeds are provided
- **AND** the config contains 4 detector seeds
- **AND** `autoSeed` is not `false`
- **THEN** the seed queue SHALL contain detector seeds followed by default auto-seeds
- **AND** `has_user_seeds` SHALL remain `false`

#### Scenario: Detector seeds do not set has_user_seeds

- **WHEN** no user seeds are provided
- **AND** detector seeds are present in config
- **THEN** the `has_user_seeds` flag SHALL remain `false`
- **AND** if all seeds fail to produce coverage, the "no seeds produced coverage" error SHALL NOT fire (because `has_user_seeds` is `false`)

### Requirement: Auto-seeds excluded from feature detection scan

Auto-seeds (detector seeds and default seeds) SHALL be excluded from the deferred feature detection scan. The scan uses `auto_seed_count` to skip the first N corpus entries (all auto-seeds are queued before any fuzzer-discovered inputs). Only user-provided seeds and fuzzer-discovered inputs inform the detection vote.

Auto-seeds are guesses about what the target might consume - they should not influence the detection algorithms that infer which mutators are appropriate. User seeds ARE included because they represent deliberate signal from the user about the target's input format.

Auto-seeds remain full corpus members for all other purposes: coverage tracking, scheduling, execution metrics, and mutation.

#### Scenario: Auto-seeds excluded from detection scan

- **WHEN** 4 detector seeds and 10 default auto-seeds are queued
- **AND** some produce coverage and are added to the corpus
- **AND** 10 interesting inputs are found during fuzzing
- **THEN** the deferred detection scan SHALL skip the auto-seed entries
- **AND** only user seeds and fuzzer-discovered inputs SHALL inform the classification

### Requirement: Prototype pollution detector seeds

The prototype pollution detector SHALL implement `getSeeds()` returning general-purpose JSON inputs that exercise prototype-sensitive code paths. The seeds SHALL include:

1. `{"__proto__":1}` - direct `__proto__` key access
2. `[{"__proto__":1}]` - `__proto__` key in array-wrapped object (exercises array-of-objects parser paths)
3. `{"constructor":{"prototype":{}}}` - constructor.prototype chain
4. `["__proto__"]` - array containing `__proto__` string

These seeds are general-purpose: they test prototype pollution patterns that apply across many JSON-consuming libraries, not just a specific target.

#### Scenario: Prototype pollution detector provides JSON seeds

- **WHEN** the prototype pollution detector is active
- **THEN** `getSeeds()` SHALL return at least 4 seed inputs
- **AND** each seed SHALL be valid JSON
- **AND** the seeds SHALL contain the tokens `__proto__` and `constructor`

### Requirement: Other detectors provide empty seeds

Detectors for bug classes where meaningful seed inputs are not generalizable (command injection, path traversal, unsafe eval, SSRF, ReDoS) SHALL return empty arrays from `getSeeds()`. Their bug classes are detected via module hooking or runtime checks, not via specific input patterns.

#### Scenario: Command injection detector has no seeds

- **WHEN** the command injection detector is active
- **THEN** `getSeeds()` SHALL return an empty array

#### Scenario: Path traversal detector has no seeds

- **WHEN** the path traversal detector is active
- **THEN** `getSeeds()` SHALL return an empty array
