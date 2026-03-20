## MODIFIED Requirements

### Requirement: Unicode auto-detection shares Grimoire UTF-8 scanning

Unicode auto-detection SHALL use the same `scan_corpus_utf8()` function as Grimoire auto-detection. The detection result (UTF-8 majority in corpus) SHALL be shared: both Grimoire and unicode read the same signal.

The auto-detection follows the same three-channel logic as Grimoire:

1. **Explicit override**: If `unicode: true` or `unicode: false` is provided, use that.
2. **Immediate detection**: If the corpus is non-empty at initialization, scan all entries. Enable if `utf8_count > non_utf8_count`.
3. **Deferred detection**: If the corpus is empty at initialization, defer detection until 10 interesting inputs have been found via the main loop. Then scan the corpus and enable if UTF-8 majority.

The deferred detection threshold logic SHALL be shared with Grimoire - a single scan resolves both Grimoire and unicode enable states. Auto-seeds (detector seeds and default seeds) are excluded from the scan to avoid biasing detection; only user seeds and fuzzer-discovered inputs inform the vote.

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
- **AND** auto-seeds SHALL be excluded from the scan (only user seeds and fuzzer-discovered inputs inform detection)
