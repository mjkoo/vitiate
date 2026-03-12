## Purpose

Unicode auto-detection determines whether to enable unicode mutations based on corpus content analysis. It supports explicit override via configuration, shares the UTF-8 scanning infrastructure with Grimoire auto-detection, and uses the same deferred detection mechanism for empty corpora.

## Requirements

### Requirement: Unicode configuration option

The system SHALL accept a `unicode` configuration option in `FuzzOptions` and `FuzzerConfig` with the following tri-state behavior:

- `true`: Force-enable unicode mutations regardless of corpus content.
- `false`: Force-disable unicode mutations regardless of corpus content.
- absent (undefined): Auto-detect based on corpus UTF-8 content.

This follows the same pattern as the existing `grimoire` configuration option.

#### Scenario: Unicode explicitly enabled

- **WHEN** `FuzzOptions.unicode` is set to `true`
- **THEN** the unicode stage SHALL be enabled regardless of corpus content

#### Scenario: Unicode explicitly disabled

- **WHEN** `FuzzOptions.unicode` is set to `false`
- **THEN** the unicode stage SHALL be disabled regardless of corpus content

#### Scenario: Unicode auto-detected from corpus

- **WHEN** `FuzzOptions.unicode` is absent (undefined)
- **THEN** the system SHALL auto-detect based on corpus UTF-8 content

#### Scenario: Invalid unicode option rejected

- **WHEN** `FuzzOptions.unicode` is set to a non-boolean value
- **THEN** the system SHALL reject the configuration with a validation error

### Requirement: Unicode auto-detection shares Grimoire UTF-8 scanning

Unicode auto-detection SHALL use the same `scan_corpus_utf8()` function as Grimoire auto-detection. The detection result (UTF-8 majority in corpus) SHALL be shared: both Grimoire and unicode read the same signal.

The auto-detection follows the same three-channel logic as Grimoire:

1. **Explicit override**: If `unicode: true` or `unicode: false` is provided, use that.
2. **Immediate detection**: If the corpus is non-empty at initialization, scan all entries (excluding auto-seeds). Enable if `utf8_count > non_utf8_count`.
3. **Deferred detection**: If the corpus is empty at initialization, defer detection until 10 interesting inputs have been found via the main loop. Then scan the corpus (excluding auto-seeds) and enable if UTF-8 majority.

The deferred detection threshold and auto-seed exclusion logic SHALL be shared with Grimoire - a single scan resolves both Grimoire and unicode enable states.

#### Scenario: Both Grimoire and unicode auto-enabled from UTF-8 corpus

- **WHEN** neither `grimoire` nor `unicode` is explicitly configured
- **AND** the corpus contains majority UTF-8 inputs
- **THEN** both Grimoire and unicode stages SHALL be enabled

#### Scenario: Unicode enabled but Grimoire disabled

- **WHEN** `grimoire: false` is explicitly set
- **AND** `unicode` is absent (auto-detect)
- **AND** the corpus contains majority UTF-8 inputs
- **THEN** Grimoire SHALL be disabled
- **AND** unicode SHALL be enabled (auto-detection is independent per feature)

#### Scenario: Deferred detection resolves both features

- **WHEN** the corpus is empty at initialization
- **AND** neither `grimoire` nor `unicode` is explicitly configured
- **AND** after 10 interesting main-loop inputs, the corpus is majority UTF-8
- **THEN** both Grimoire and unicode SHALL be enabled by the same deferred scan

#### Scenario: Deferred detection threshold shared

- **WHEN** the deferred detection threshold (10 interesting inputs) is reached
- **THEN** a single `scan_corpus_utf8()` call SHALL resolve both Grimoire and unicode enable states
- **AND** stage-found entries SHALL NOT count toward the threshold (same as Grimoire)
- **AND** auto-seeds SHALL be excluded from the scan (same as Grimoire)
