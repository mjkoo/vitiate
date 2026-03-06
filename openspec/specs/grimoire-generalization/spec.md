## Purpose

The generalization stage identifies which bytes of a corpus entry are "structural" (affect coverage novelty) versus "gaps" (can be freely replaced). It produces `GeneralizedInputMetadata` used by the Grimoire mutational stage for structure-aware mutations.

## Requirements

### Requirement: Generalization stage analyzes corpus entries for structural gaps

The system SHALL implement a generalization stage that identifies which bytes of a corpus entry are "structural" (affect coverage novelty) vs "gaps" (can be freely replaced without losing the entry's novel coverage contribution). The stage SHALL:

1. Run after the I2S stage completes (or is skipped) for each interesting corpus entry, when Grimoire is enabled.
2. Operate on the corpus entry identified by the stage pipeline's `corpus_id`.
3. Produce `GeneralizedInputMetadata` — a sequence of `GeneralizedItem::Bytes(Vec<u8>)` and `GeneralizedItem::Gap` items — stored on the testcase.
4. Use the `beginStage`/`advanceStage`/`abortStage` protocol, with `StageState::Generalization` as the active state.

The generalization stage is interactive: each target execution informs the next decision. The JS fuzz loop drives execution identically to I2S — it receives a candidate input from Rust, executes the target, and calls `advanceStage()` to process the result.

#### Scenario: Generalization produces metadata for a text corpus entry

- **WHEN** an interesting corpus entry `b"fn foo() { return 42; }"` is generalized
- **AND** the target's coverage is stable
- **THEN** `GeneralizedInputMetadata` SHALL be stored on the testcase
- **AND** the metadata SHALL contain at least one `GeneralizedItem::Gap` (some bytes identified as non-structural)

#### Scenario: Generalization skipped when Grimoire disabled

- **WHEN** Grimoire is disabled (auto-detection or explicit override)
- **AND** the I2S stage completes
- **THEN** the generalization stage SHALL NOT run
- **AND** the stage pipeline SHALL complete (return `null` from `advanceStage`)

### Requirement: Generalization skipping conditions

The generalization stage SHALL be skipped (not entered) for a corpus entry when any of these conditions hold:

- Grimoire is disabled.
- The input exceeds 8192 bytes (`MAX_GENERALIZED_LEN`).
- The testcase has no `MapNoveltiesMetadata`, or its novelties list is empty (no novel coverage indices recorded).
- The testcase already has `GeneralizedInputMetadata` (already generalized).

When generalization is skipped and the testcase already has `GeneralizedInputMetadata`, the pipeline SHALL transition directly to the Grimoire mutational stage. When generalization is skipped and no `GeneralizedInputMetadata` exists, the pipeline SHALL complete.

#### Scenario: Input exceeding size limit skips generalization

- **WHEN** an interesting corpus entry is 10000 bytes long
- **AND** Grimoire is enabled
- **THEN** the generalization stage SHALL be skipped
- **AND** no `GeneralizedInputMetadata` SHALL be stored

#### Scenario: Already-generalized entry skips to Grimoire

- **WHEN** an interesting corpus entry already has `GeneralizedInputMetadata` from a prior generalization
- **THEN** the generalization stage SHALL be skipped
- **AND** the pipeline SHALL transition to the Grimoire mutational stage

#### Scenario: Entry without novelty metadata skips generalization

- **WHEN** an interesting corpus entry has no `MapNoveltiesMetadata`
- **THEN** the generalization stage SHALL be skipped

### Requirement: Verification phase confirms input stability

The first execution of the generalization stage SHALL be a verification step: execute the original corpus entry (unmodified) and check that all novel coverage indices from `MapNoveltiesMetadata` are nonzero in the coverage map.

If verification fails (any novel index has a zero value in the map after execution), the input is unstable and generalization SHALL be aborted — no `GeneralizedInputMetadata` is produced, and the stage pipeline transitions to completion (or Grimoire if metadata already exists from a prior run, which it won't for a fresh entry).

#### Scenario: Verification succeeds for stable input

- **WHEN** the original corpus entry is executed during the verification phase
- **AND** all indices in `MapNoveltiesMetadata` have nonzero values in the coverage map
- **THEN** verification passes
- **AND** the gap-finding phases SHALL begin

#### Scenario: Verification fails for unstable input

- **WHEN** the original corpus entry is executed during the verification phase
- **AND** at least one index in `MapNoveltiesMetadata` has a zero value in the coverage map
- **THEN** verification fails
- **AND** no `GeneralizedInputMetadata` SHALL be stored
- **AND** the generalization stage SHALL end (transition to next stage or completion)

### Requirement: Gap-finding via offset-based passes

After verification, the system SHALL run 5 offset-based gap-finding passes with offsets `[255, 127, 63, 31, 0]`. For each pass:

1. Iterate through the payload starting at position 0.
2. At each position `start`, compute `end = start + 1 + offset`. Clamp `end` to the payload length.
3. Construct a candidate `BytesInput` by concatenating all `Some(byte)` values from `payload[..start]` and `payload[end..]`. This omits the `[start, end)` range entirely, and also excludes all already-gapped (`None`) positions across the entire payload.
4. Return the candidate for execution via the stage protocol.
5. On the next `advanceStage()`: read the coverage map and check if all novel indices are nonzero. If yes, mark `payload[start..end]` as gaps (`None`). If no, leave them as structural.
6. Advance `start` to `end` and repeat.

After each pass completes, trim consecutive gaps in the payload (no two adjacent `None` entries).

#### Scenario: Offset pass identifies removable bytes

- **WHEN** an offset-255 pass removes bytes `[0, 256)` from a 512-byte input
- **AND** the ablated input still triggers all novel coverage indices
- **THEN** bytes `[0, 256)` SHALL be marked as gaps in the payload

#### Scenario: Offset pass preserves structural bytes

- **WHEN** an offset-255 pass removes bytes `[0, 256)` from the input
- **AND** the ablated input does NOT trigger all novel coverage indices
- **THEN** bytes `[0, 256)` SHALL remain as structural bytes in the payload

#### Scenario: Consecutive gaps trimmed after pass

- **WHEN** an offset pass marks positions 5, 6, 7 as gaps
- **AND** positions 5, 6, 7 are all adjacent
- **THEN** after trimming, a single `None` entry SHALL represent the contiguous gap region

### Requirement: Gap-finding via delimiter-based passes

After offset passes, the system SHALL run 7 delimiter-based gap-finding passes with delimiters `['.', ';', ',', '\n', '\r', '#', ' ']`. For each pass:

1. Iterate through the payload starting at position 0.
2. At each position `start`, scan forward to find the next occurrence of the delimiter character (gapped positions are iterated over but never match, since `None != Some(delimiter)`).
3. Set `end` to `delimiter_pos + 1` if the delimiter was found, or `payload.len()` if not found (i.e., remove everything from `start` to the end).
4. Construct a candidate by concatenating `Some(byte)` values from `payload[..start]` and `payload[end..]` (same as offset passes). Execute and verify novelties.
5. Mark bytes `[start, end)` as gaps or leave as structural based on the verification result.
6. Set `start = end` and repeat. (When `end == payload.len()`, the loop terminates naturally.)

After each pass completes, trim consecutive gaps.

#### Scenario: Delimiter pass splits on newlines

- **WHEN** a newline delimiter pass processes input `b"line1\nline2\nline3"`
- **AND** removing `b"line1\n"` (bytes up to and including first `\n`) preserves novelties
- **THEN** `b"line1\n"` bytes SHALL be marked as gaps

#### Scenario: Delimiter not found removes tail

- **WHEN** a semicolon delimiter pass processes input `b"no semicolons here"` starting at position 0
- **THEN** a candidate SHALL be generated removing the entire input (from `start` to `payload.len()`)
- **AND** the range SHALL be marked as gaps or left as structural based on the verification result
- **AND** the pass SHALL then complete (since `start == payload.len()`)

### Requirement: Gap-finding via bracket-based passes

After delimiter passes, the system SHALL run 6 bracket-based (closure) gap-finding passes with bracket pairs `['(' ')', '[' ']', '{' '}', '<' '>', '\'' '\'', '"' '"']`. For each pass, using two tracking variables — `index` (overall progress through the payload, used by the outer loop) and `start` (current opening bracket position):

1. Initialize `index = 0`.
2. **Find opening bracket:** Scan forward from `index`, incrementing `index` at each position, until `payload[index] == Some(opening_char)`. If `index >= payload.len()`, the pass is complete. Set `start = index`.
3. **Scan backward for closings:** Set `end = payload.len() - 1`, `endings = 0`. While `end > start`:
   a. If `payload[end] == Some(closing_char)`: increment `endings`, construct a candidate by concatenating `Some(byte)` values from `payload[..start]` and `payload[end..]` (same as offset passes). Execute, verify novelties. If novelties survived, mark `payload[start..end]` as gaps. Set `start = end` (reposition to the closing bracket).
   b. Decrement `end` and increment `index` on every iteration of this inner loop (regardless of whether a closing bracket was found).
4. If `endings == 0` (no closing bracket found for this opening), the entire bracket pass terminates.
5. Otherwise, repeat from step 2 with the current `index` value. Note: `index` has been advanced by the inner loop, so the outer loop progresses through the payload.

For same-character pairs (`''` and `""`), the opening bracket is the first occurrence scanning forward, and the closing bracket is found by scanning backward from the end of the payload. This means the outermost pair is tested first (e.g., for input `a'b'c'd`, the first `'` at position 1 is the opener and the last `'` at position 5 is the closer, testing removal of `b'c`).

After each pass completes, trim consecutive gaps.

#### Scenario: Bracket pass identifies JSON object content as gap

- **WHEN** a curly-brace pass processes input `b"{\"key\": \"value\"}"`
- **AND** removing the content between `{` and `}` preserves novelties
- **THEN** the content bytes SHALL be marked as gaps

#### Scenario: Quote pass handles string literals

- **WHEN** a double-quote pass processes input `b"hello \"world\" end"`
- **AND** removing the content between the quotes preserves novelties
- **THEN** the quoted content SHALL be marked as gaps

### Requirement: Generalization output format

After all gap-finding phases complete, the system SHALL convert the payload (`Vec<Option<u8>>`) to `GeneralizedInputMetadata` using the following rules:

1. Each contiguous run of `Some(byte)` values becomes a `GeneralizedItem::Bytes(Vec<u8>)`.
2. Each `None` value becomes a `GeneralizedItem::Gap`.
3. If the first element of the payload is not `None`, a leading `GeneralizedItem::Gap` SHALL be prepended.
4. If the last element of the payload is not `None`, a trailing `GeneralizedItem::Gap` SHALL be appended.

The resulting metadata SHALL always start and end with `GeneralizedItem::Gap`. There SHALL be no consecutive `GeneralizedItem::Gap` entries (guaranteed by trimming after each pass). There SHALL be no empty `GeneralizedItem::Bytes` entries.

#### Scenario: Simple generalization output

- **WHEN** the payload after gap-finding is `[None, Some(b'f'), Some(b'n'), None, Some(b'('), Some(b')'), None]`
- **THEN** the `GeneralizedInputMetadata` SHALL be `[Gap, Bytes(b"fn"), Gap, Bytes(b"()"), Gap]`

#### Scenario: Leading and trailing gaps always present

- **WHEN** the payload starts with `Some(b'a')` and ends with `Some(b'z')`
- **THEN** the metadata SHALL start with `Gap` and end with `Gap`
- **AND** the total items SHALL include the prepended and appended gaps

### Requirement: CmpLog and coverage handling during generalization

During generalization stage executions:

1. The CmpLog accumulator SHALL be drained and discarded after each execution (same as I2S stage behavior).
2. Token promotion SHALL NOT occur.
3. The coverage map SHALL be read for novelty verification, then zeroed.
4. Coverage evaluation for corpus addition SHALL NOT occur during the verification phase (the verification execution is only checking stability, not evaluating for new coverage).
5. **Vitiate-specific enhancement (not in LibAFL):** Coverage evaluation for corpus addition SHALL occur during gap-finding executions — an ablated input that triggers new coverage (beyond the original entry's novelties) SHALL be added to the corpus. LibAFL's generalization stage does not evaluate gap-finding candidates for corpus addition; Vitiate adds this to avoid wasting coverage discoveries made during the many generalization executions.

#### Scenario: Generalization execution discovers new coverage

- **WHEN** an ablated candidate during gap-finding triggers coverage at a new map index (not in the original entry's novelties)
- **THEN** the candidate SHALL be evaluated for corpus addition via the standard `evaluate_coverage` path
- **AND** if interesting, it SHALL be added to the corpus with `SchedulerTestcaseMetadata`
- **AND** the gap-finding decision SHALL still be based solely on whether the original novelty indices survived

#### Scenario: CmpLog discarded during generalization

- **WHEN** a generalization stage execution completes
- **THEN** the CmpLog accumulator SHALL be drained and discarded
- **AND** `CmpValuesMetadata` on the fuzzer state SHALL NOT be updated

### Requirement: Generalization execution counting

Each generalization stage execution (including the verification execution) SHALL increment `total_execs` and `state.executions`. The execution count for generalization depends on input structure and can range from 1 (verification fails immediately) to dozens (verification plus up to 18 gap-finding passes — 5 offset, 7 delimiter, 6 bracket — with multiple candidates each).

#### Scenario: Verification-only execution counted

- **WHEN** the verification phase executes the original input and fails
- **THEN** `total_execs` SHALL increment by 1
- **AND** no further generalization executions SHALL occur

#### Scenario: Full generalization execution count

- **WHEN** a generalization stage runs verification (1 execution) plus 25 gap-finding candidates
- **THEN** `total_execs` SHALL increment by 26
