## ADDED Requirements

### Requirement: REDQUEEN configuration option

The system SHALL accept a `redqueen` configuration option in `FuzzerConfig` of type `Option<bool>`:

- `Some(true)`: REDQUEEN is explicitly enabled regardless of corpus content.
- `Some(false)`: REDQUEEN is explicitly disabled regardless of corpus content.
- `None`: REDQUEEN enablement is auto-detected based on corpus content.

The TypeScript `FuzzOptions` SHALL expose a corresponding `redqueen?: boolean` field that maps to this configuration.

#### Scenario: Explicit enable

- **WHEN** `FuzzerConfig` has `redqueen: Some(true)`
- **THEN** `redqueen_enabled` SHALL be `true` from initialization
- **AND** auto-detection SHALL NOT override this setting

#### Scenario: Explicit disable

- **WHEN** `FuzzerConfig` has `redqueen: Some(false)`
- **THEN** `redqueen_enabled` SHALL be `false` from initialization
- **AND** auto-detection SHALL NOT override this setting

#### Scenario: Default is auto-detect

- **WHEN** `FuzzerConfig` has `redqueen: None` (or the field is omitted)
- **THEN** REDQUEEN enablement SHALL be determined by auto-detection

### Requirement: Inverted-polarity auto-detection

When REDQUEEN is set to auto-detect (`redqueen: None`), the system SHALL enable REDQUEEN when the corpus is predominantly non-UTF-8 (binary). This uses the same `scan_corpus_utf8()` function and `DEFERRED_DETECTION_THRESHOLD` (10 interesting inputs) as Grimoire and Unicode auto-detection, but with inverted polarity. Auto-seeded corpus entries SHALL be excluded from the scan, consistent with Grimoire and Unicode auto-detection.

Specifically:
- When `scan_corpus_utf8()` returns `true` (corpus is mostly UTF-8): `redqueen_enabled = false`.
- When `scan_corpus_utf8()` returns `false` (corpus is mostly non-UTF-8): `redqueen_enabled = true`.

The deferred detection trigger SHALL include REDQUEEN alongside Grimoire and Unicode. A single corpus scan resolves all three features simultaneously.

#### Scenario: Binary corpus enables REDQUEEN

- **WHEN** REDQUEEN auto-detection is active
- **AND** `DEFERRED_DETECTION_THRESHOLD` interesting inputs have been found
- **AND** the corpus is predominantly non-UTF-8
- **THEN** `redqueen_enabled` SHALL be set to `true`

#### Scenario: UTF-8 corpus disables REDQUEEN

- **WHEN** REDQUEEN auto-detection is active
- **AND** `DEFERRED_DETECTION_THRESHOLD` interesting inputs have been found
- **AND** the corpus is predominantly UTF-8
- **THEN** `redqueen_enabled` SHALL remain `false`

#### Scenario: Complementary specialization

- **WHEN** all three features (Grimoire, Unicode, REDQUEEN) are in auto-detect mode
- **AND** the corpus is predominantly UTF-8
- **THEN** Grimoire and Unicode SHALL be enabled, REDQUEEN SHALL be disabled

- **WHEN** all three features are in auto-detect mode
- **AND** the corpus is predominantly non-UTF-8
- **THEN** REDQUEEN SHALL be enabled, Grimoire and Unicode SHALL be disabled

### Requirement: Deferred detection integration

REDQUEEN auto-detection SHALL participate in the existing deferred detection mechanism:

- If `redqueen` is `None`, the `deferred_detection_count` system SHALL include REDQUEEN in the set of features needing detection.
- When the threshold is reached, the single `scan_corpus_utf8()` call SHALL resolve REDQUEEN alongside Grimoire and Unicode.
- Auto-seeded corpus entries SHALL be excluded from the corpus scan.
- Only main-loop interesting inputs (not stage-found entries) SHALL count toward the threshold.

#### Scenario: Deferred detection resolves REDQUEEN

- **WHEN** the corpus is initially empty
- **AND** REDQUEEN, Grimoire, and Unicode are all in auto-detect mode
- **AND** 10 interesting inputs are found via the main loop
- **THEN** a single corpus scan SHALL resolve all three features
- **AND** `deferred_detection_count` SHALL be set to `None` (resolved)

### Requirement: Immediate detection for non-empty corpus

When REDQUEEN is set to auto-detect (`redqueen: None`) and the corpus is non-empty at initialization, the system SHALL immediately scan the corpus (excluding auto-seeds) using `scan_corpus_utf8()` and set `redqueen_enabled = !is_utf8`. No deferred detection is needed.

#### Scenario: Non-empty binary corpus enables REDQUEEN immediately

- **WHEN** the fuzzer starts with a non-empty corpus
- **AND** REDQUEEN is in auto-detect mode
- **AND** the corpus is predominantly non-UTF-8
- **THEN** `redqueen_enabled` SHALL be `true` from initialization
- **AND** colorization and REDQUEEN stages SHALL run for the first interesting input

#### Scenario: Non-empty UTF-8 corpus disables REDQUEEN immediately

- **WHEN** the fuzzer starts with a non-empty corpus
- **AND** REDQUEEN is in auto-detect mode
- **AND** the corpus is predominantly UTF-8
- **THEN** `redqueen_enabled` SHALL be `false` from initialization

### Requirement: Initial state before detection

When REDQUEEN is in auto-detect mode and the corpus is empty (detection deferred), `redqueen_enabled` SHALL default to `false`. REDQUEEN stages SHALL not run until auto-detection resolves.

#### Scenario: REDQUEEN disabled before detection

- **WHEN** the fuzzer starts with an empty corpus
- **AND** REDQUEEN is in auto-detect mode
- **AND** fewer than 10 interesting inputs have been found
- **THEN** `redqueen_enabled` SHALL be `false`
- **AND** colorization and REDQUEEN stages SHALL not run

### Requirement: Mixed explicit and auto-detect configuration

The system SHALL support any combination of explicit and auto-detect settings across Grimoire, Unicode, and REDQUEEN. An explicit setting for one feature SHALL NOT affect auto-detection of the others.

#### Scenario: REDQUEEN explicit with Grimoire auto

- **WHEN** `redqueen: Some(true)` and `grimoire: None`
- **AND** the corpus is predominantly UTF-8
- **THEN** REDQUEEN SHALL be enabled (explicit override)
- **AND** Grimoire SHALL be enabled (auto-detected from UTF-8 corpus)
- **AND** both REDQUEEN and Grimoire stages SHALL run for interesting inputs

#### Scenario: Both REDQUEEN and Grimoire explicitly enabled

- **WHEN** `redqueen: Some(true)` and `grimoire: Some(true)`
- **THEN** REDQUEEN SHALL be enabled
- **AND** Grimoire SHALL be enabled
- **AND** the full pipeline SHALL run: Colorization → Redqueen → (skip I2S) → Generalization → Grimoire → Unicode → None
