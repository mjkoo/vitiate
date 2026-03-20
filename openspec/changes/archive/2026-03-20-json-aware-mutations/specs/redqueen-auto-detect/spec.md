## MODIFIED Requirements

### Requirement: Inverted-polarity auto-detection

When REDQUEEN is set to auto-detect (`redqueen: None`), the system SHALL enable REDQUEEN when the corpus is predominantly non-UTF-8 (binary). This uses the same `scan_corpus_utf8()` function and `DEFERRED_DETECTION_THRESHOLD` (10 interesting inputs) as Grimoire and Unicode auto-detection, but with inverted polarity. Auto-seeds (detector seeds and default seeds) are excluded from the scan to avoid biasing detection; only user seeds and fuzzer-discovered inputs inform the vote.

Specifically:
- When `scan_corpus_utf8()` returns `true` (corpus is mostly UTF-8): `redqueen_enabled = false`.
- When `scan_corpus_utf8()` returns `false` (corpus is mostly non-UTF-8): `redqueen_enabled = true`.

The deferred detection trigger SHALL include REDQUEEN alongside Grimoire, Unicode, and JSON. A single corpus scan resolves all four features simultaneously.

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
- Auto-seeds SHALL be excluded from the scan; only user seeds and fuzzer-discovered inputs inform detection.
- Only main-loop interesting inputs (not stage-found entries) SHALL count toward the threshold.

#### Scenario: Deferred detection resolves REDQUEEN

- **WHEN** the corpus is initially empty
- **AND** REDQUEEN, Grimoire, and Unicode are all in auto-detect mode
- **AND** 10 interesting inputs are found via the main loop
- **THEN** a single corpus scan SHALL resolve all four features (Grimoire, Unicode, REDQUEEN, JSON)
- **AND** `deferred_detection_count` SHALL be set to `None` (resolved)

### Requirement: Immediate detection for non-empty corpus

When REDQUEEN is set to auto-detect (`redqueen: None`) and the corpus is non-empty at initialization, the system SHALL immediately scan the corpus using `scan_corpus_utf8()` and set `redqueen_enabled = !is_utf8`. Auto-seeds are excluded from the scan; only user seeds and fuzzer-discovered inputs inform detection. No deferred detection is needed.

#### Scenario: Non-empty binary corpus enables REDQUEEN immediately

- **WHEN** the fuzzer starts with a non-empty corpus
- **AND** `redqueen` is absent (auto-detect)
- **AND** the corpus is majority non-UTF-8
- **THEN** `redqueen_enabled` SHALL be `true`
- **AND** auto-seeds SHALL be excluded from the scan (only user seeds and fuzzer-discovered inputs inform detection)
