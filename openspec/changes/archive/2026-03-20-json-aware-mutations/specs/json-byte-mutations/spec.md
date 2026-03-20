## ADDED Requirements

### Requirement: JSON string slot identification

The system SHALL provide a function that scans a byte buffer and returns the byte ranges of all JSON string slots. A string slot is the content range `(start, end)` of a double-quoted string, excluding the quote characters themselves.

The scanner SHALL:

1. Walk the byte buffer tracking whether the current position is inside a quoted string.
2. Handle escape sequences: when `\` is encountered inside a string, unconditionally skip the next byte (advancing by 2). This correctly handles all JSON escapes (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) without needing to recognize each one individually. The critical cases are `\\` (so the byte after the escaped backslash is not treated as an escape prefix) and `\"` (so the escaped quote does not terminate the string).
3. Return an empty list if no valid string slots are found.
4. Operate in O(n) time with no heap allocation beyond the output list.

A string slot is valid if:
- It starts with `"` and ends with a matching unescaped `"`.
- The content between the quotes is zero or more bytes (empty strings are valid slots).

The scanner does NOT validate that the surrounding context is valid JSON. It identifies all double-quoted string regions in the byte buffer regardless of whether the overall input is well-formed JSON.

#### Scenario: Simple object with string values

- **WHEN** the input is `{"name":"alice","role":"admin"}`
- **THEN** the scanner SHALL return four string slots: `name`, `alice`, `role`, `admin`

#### Scenario: Escaped quotes within strings

- **WHEN** the input is `{"key":"value with \"quotes\""}`
- **THEN** the scanner SHALL return two string slots: `key` and `value with \"quotes\"`
- **AND** the escaped quotes SHALL NOT terminate the string early

#### Scenario: Escaped backslash before quote

- **WHEN** the input is `{"k":"v\\"}`
- **THEN** the scanner SHALL return two string slots: `k` and `v\\`
- **AND** the `\\` SHALL be recognized as an escaped backslash, so the following `"` terminates the string

#### Scenario: No strings in input

- **WHEN** the input is `[1, true, null]`
- **THEN** the scanner SHALL return an empty list

#### Scenario: Empty string value

- **WHEN** the input is `{"":""}`
- **THEN** the scanner SHALL return two string slots, both with empty content (zero-length ranges)

#### Scenario: Nested structures

- **WHEN** the input is `{"a":{"b":"c"}}`
- **THEN** the scanner SHALL return three string slots: `a`, `b`, `c`

### Requirement: JSON value range identification

The system SHALL provide a function that, given a byte buffer and a position within it, identifies the byte range of the JSON value at that position. A value range is `(start, end)` covering the entire value including any delimiters (quotes for strings, brackets for arrays/objects).

The function SHALL handle these value types:
- **Strings**: From opening `"` to closing unescaped `"` (inclusive).
- **Numbers**: Contiguous run of `0-9`, `-`, `+`, `.`, `e`, `E`.
- **Booleans**: `true` or `false` (4 or 5 bytes).
- **Null**: `null` (4 bytes).
- **Arrays**: From `[` to matching `]`, respecting nesting depth.
- **Objects**: From `{` to matching `}`, respecting nesting depth.

For arrays and objects, the function SHALL track nesting depth to find the matching closing bracket. Strings encountered during bracket matching SHALL be skipped (brackets inside strings do not count).

The function SHALL return `None` if the position does not point to the start of a recognizable JSON value, or if the value is malformed (unterminated string, unbalanced brackets).

#### Scenario: Identify string value range

- **WHEN** the input is `{"k":"hello"}` and position points to the `"` before `hello`
- **THEN** the function SHALL return the range covering `"hello"` (including quotes)

#### Scenario: Identify nested object range

- **WHEN** the input is `{"a":{"b":1}}` and position points to the `{` before `"b"`
- **THEN** the function SHALL return the range covering `{"b":1}`

#### Scenario: Identify number value range

- **WHEN** the input is `{"x":42.5}` and position points to `4`
- **THEN** the function SHALL return the range covering `42.5`

#### Scenario: Brackets inside strings ignored during matching

- **WHEN** the input is `{"a":"[{"}` and position points to the outer `{`
- **THEN** the function SHALL return the range covering the entire `{"a":"[{"}`
- **AND** the brackets inside the string `[{` SHALL NOT interfere with depth tracking

#### Scenario: Unterminated string returns None

- **WHEN** the input is `{"a":"unterminated` and position points to the `"` before `unterminated`
- **THEN** the function SHALL return `None`

#### Scenario: Unbalanced brackets returns None

- **WHEN** the input is `{"a":[1,2` and position points to `[`
- **THEN** the function SHALL return `None`

### Requirement: JSON object key identification

The system SHALL provide a function that identifies which string slots in a byte buffer are object keys (as opposed to string values). A string slot is an object key if:

1. The byte immediately following the closing `"` (after skipping whitespace) is `:`.

This heuristic does not require full JSON parsing. It distinguishes keys from values in well-formed JSON and is correct for the common case. False positives on malformed input are acceptable (the consequence is a `Skipped` mutation, not incorrect behavior).

#### Scenario: Distinguish keys from values

- **WHEN** the input is `{"name":"alice"}`
- **THEN** `name` SHALL be identified as an object key
- **AND** `alice` SHALL NOT be identified as an object key

#### Scenario: Whitespace between key and colon

- **WHEN** the input is `{ "name" : "alice" }`
- **THEN** `name` SHALL be identified as an object key (whitespace before `:` is tolerated)

### Requirement: JsonTokenReplaceString mutator

The system SHALL implement a `JsonTokenReplaceString` mutator that replaces a random string value's content with a dictionary token. The mutator SHALL implement LibAFL's `Mutator<BytesInput>` trait.

The mutation procedure SHALL:

1. Scan the input for string slots using the string slot identification function.
2. Filter out slots identified as object keys (only mutate values).
3. If no value string slots exist, return `MutationResult::Skipped`.
4. Select a random value string slot.
5. Select a random token from the `Tokens` state metadata. If no tokens exist, return `MutationResult::Skipped`.
6. Replace the string slot's content bytes with the selected token's bytes (the surrounding quotes are preserved).
7. Return `MutationResult::Mutated`.

The replacement is a byte-range splice: the old content is removed and the new content is inserted, so the input length may change. Token bytes are inserted as-is without JSON escaping - if a token contains characters like `"` or `\`, the resulting JSON may be malformed. This is acceptable: byte-level mutations already produce invalid JSON, and the cost of escaping outweighs the benefit for the common case (most dictionary tokens are simple identifiers like `__proto__`).

#### Scenario: Replace string value with dictionary token

- **WHEN** the input is `{"x":"1"}` and the dictionary contains token `__proto__`
- **AND** the mutator selects the string slot `1` and token `__proto__`
- **THEN** the output SHALL be `{"x":"__proto__"}`

#### Scenario: Skip when no string values exist

- **WHEN** the input is `{"x":42}`
- **THEN** the mutator SHALL return `MutationResult::Skipped`

#### Scenario: Skip when dictionary is empty

- **WHEN** the input is `{"x":"hello"}` and no tokens exist in state
- **THEN** the mutator SHALL return `MutationResult::Skipped`

#### Scenario: Keys are not mutated

- **WHEN** the input is `{"name":"alice"}` and the mutator runs multiple times
- **THEN** `name` SHALL never be replaced (only value slots are eligible)

### Requirement: JsonTokenReplaceKey mutator

The system SHALL implement a `JsonTokenReplaceKey` mutator that replaces a random object key's content with a dictionary token. The mutator SHALL implement LibAFL's `Mutator<BytesInput>` trait.

The mutation procedure SHALL:

1. Scan the input for string slots using the string slot identification function.
2. Filter to only slots identified as object keys.
3. If no key slots exist, return `MutationResult::Skipped`.
4. Select a random key slot.
5. Select a random token from `Tokens` state metadata. If no tokens exist, return `MutationResult::Skipped`.
6. Replace the key slot's content bytes with the token's bytes (surrounding quotes preserved).
7. Return `MutationResult::Mutated`.

#### Scenario: Replace object key with dictionary token

- **WHEN** the input is `{"x":"1"}` and the dictionary contains token `__proto__`
- **AND** the mutator selects the key slot `x` and token `__proto__`
- **THEN** the output SHALL be `{"__proto__":"1"}`

#### Scenario: Skip when no object keys exist

- **WHEN** the input is `["hello", "world"]`
- **THEN** the mutator SHALL return `MutationResult::Skipped`

### Requirement: JsonReplaceValue mutator

The system SHALL implement a `JsonReplaceValue` mutator that replaces a random JSON value with a type-changed alternative. The mutator SHALL implement LibAFL's `Mutator<BytesInput>` trait.

The mutation procedure SHALL:

1. Scan the input for string slots.
2. In a single pass, collect all value positions: string opening quotes and non-string value starts (`0-9`, `-`, `t`, `f`, `n`, `[`, `{`) that are outside string content. String interiors are skipped using the same escape-aware logic as `find_string_slots`.
3. If no values found, return `MutationResult::Skipped`.
4. Select a random value position. Determine its byte range using the value range identification function. If `find_value_range` returns `None` (malformed value at the identified position), return `MutationResult::Skipped`.
5. Select a replacement strategy (uniformly random):
   - **Token string**: Pick a random token from `Tokens` metadata, format as `"<token>"` (token bytes inserted without JSON escaping, same rationale as `JsonTokenReplaceString`). If `Tokens` metadata is empty, fall back to "type change".
   - **Type change**: Pick uniformly from `null`, `true`, `false`, `0`, `1`, `""`, `[]`, `{}`.
   - **Copy**: Pick another value from the same input and use its bytes as the replacement. If only one value exists in the input (no other value to copy), fall back to "type change" (which always succeeds since it picks from a fixed set).
6. Replace the value's byte range with the replacement bytes.
7. Return `MutationResult::Mutated`.

#### Scenario: Replace number with token string

- **WHEN** the input is `{"x":42}` and the dictionary contains token `__proto__`
- **AND** the mutator selects value `42` and strategy "token string"
- **THEN** the output SHALL be `{"x":"__proto__"}`

#### Scenario: Replace string with null

- **WHEN** the input is `{"x":"hello"}` and the mutator selects value `"hello"` and strategy "type change" with replacement `null`
- **THEN** the output SHALL be `{"x":null}`

#### Scenario: Replace value with copy from same input

- **WHEN** the input is `{"a":"one","b":"two"}` and the mutator selects value `"one"` and strategy "copy" with source `"two"`
- **THEN** the output SHALL be `{"a":"two","b":"two"}`

#### Scenario: Copy with single value falls back to type change

- **WHEN** the input is `42` and the mutator selects the sole value `42` and strategy "copy"
- **AND** no other value exists in the input to copy from
- **THEN** the mutator SHALL fall back to the "type change" strategy
- **AND** the mutator SHALL return `MutationResult::Mutated` (not `Skipped`)

#### Scenario: Skip when input has no values

- **WHEN** the input is empty or contains no recognizable JSON values
- **THEN** the mutator SHALL return `MutationResult::Skipped`

### Requirement: JSON mutation stage

The system SHALL implement a JSON mutation stage that runs as part of the per-corpus-entry stage pipeline, after the Unicode stage. The stage uses a dedicated `HavocScheduledMutator` wrapping the three JSON mutators (`JsonTokenReplaceString`, `JsonTokenReplaceKey`, `JsonReplaceValue`).

Stage parameters:
- `max_stack_pow = 3` (2..=8 stacked mutations per iteration). Stacking JSON mutations with each other is valuable - e.g., replacing both a key and a value in a single iteration.
- 1-128 iterations per corpus entry (selected uniformly at random, same as Grimoire and Unicode).
- Each iteration SHALL clone the original corpus entry and apply fresh mutations (mutations are NOT cumulative across iterations).

The stage entry pre-check uses `looks_like_json()` (the same heuristic used for auto-detection) to determine whether the corpus entry is worth mutating. This is broader than checking for string slots alone: it catches inputs like `[1,2,3]` that have no strings but are still valid JSON mutation targets for `JsonReplaceValue`. No string slots are cached on `StageState::Json` since mutations are non-cumulative (each iteration starts from a fresh clone).

The stage SHALL:
1. Only run when `json_mutations_enabled` is `true` on `FeatureDetection`.
2. Only run when the corpus entry passes `looks_like_json()` (quick pre-check to avoid 128 iterations of `Skipped`).
3. Drain and discard CmpLog entries after each iteration (no token promotion from stage runs).
4. Evaluate coverage after each iteration using the shared coverage evaluation helper.
5. Add new-coverage inputs to the corpus with `SchedulerTestcaseMetadata`.

#### Scenario: JSON stage runs after Unicode stage

- **WHEN** the Unicode stage completes (or is skipped)
- **AND** `json_mutations_enabled` is `true`
- **AND** the corpus entry passes `looks_like_json()`
- **THEN** `advanceStage()` SHALL transition from `Unicode` (or the preceding stage) to `StageState::Json`
- **AND** return a JSON-mutated variant of the corpus entry

#### Scenario: JSON stage skipped when disabled

- **WHEN** the Unicode stage completes
- **AND** `json_mutations_enabled` is `false`
- **THEN** `advanceStage()` SHALL transition to `StageState::None`
- **AND** the JSON stage SHALL be skipped entirely

#### Scenario: JSON stage skipped when corpus entry is not JSON-like

- **WHEN** the Unicode stage completes
- **AND** `json_mutations_enabled` is `true`
- **AND** the corpus entry does not pass `looks_like_json()`
- **THEN** the JSON stage SHALL be skipped
- **AND** `advanceStage()` SHALL transition to `StageState::None`

#### Scenario: JSON stage iterations are non-cumulative

- **WHEN** the JSON stage runs 50 iterations
- **THEN** each iteration SHALL start from the original corpus entry
- **AND** mutations from iteration N SHALL NOT carry over to iteration N+1

#### Scenario: JSON stage discovers new coverage

- **WHEN** a JSON mutation produces an input that discovers new edges
- **THEN** the input SHALL be added to the corpus with `SchedulerTestcaseMetadata`
- **AND** subsequent main-loop iterations may select this entry for further mutation

#### Scenario: JSON stage CmpLog handling

- **WHEN** the JSON stage runs an iteration
- **THEN** CmpLog entries SHALL be drained and discarded
- **AND** no token promotion SHALL occur from stage-generated CmpLog data

#### Scenario: JSON stage iteration where all mutations return Skipped

- **WHEN** the JSON stage runs an iteration
- **AND** all stacked `mutate()` calls return `MutationResult::Skipped` (e.g., mutators cannot find suitable slots in the cloned input)
- **THEN** the stage SHALL return the unmodified clone of the corpus entry as the candidate input
- **AND** the stage SHALL proceed normally with remaining iterations

### Requirement: JSON heuristic for auto-detection

The system SHALL provide a function that classifies a byte buffer as "JSON-like" or "not JSON-like" using a lightweight statistical heuristic. This function is used by `FeatureDetection` during corpus scanning.

The heuristic SHALL check:

1. **Starts like JSON**: The first non-whitespace byte (ASCII 0x20, 0x09, 0x0A, 0x0D) is one of: `{`, `[`, `"`, `0`-`9`, `-`, `t`, `f`, `n`.
2. **Has brackets**: The input contains at least one `{` or `[` character.
3. **Balanced brackets**: The count of opening brackets (`{` + `[`) equals the count of closing brackets (`}` + `]`). Brackets inside double-quoted strings (tracked via the same escape-aware logic as string slot scanning) SHALL NOT be counted.
4. **JSON control character density**: The ratio of JSON-structural bytes (`"`, `:`, `,`, `{`, `}`, `[`, `]`) to total input length exceeds 5%.

An input is "JSON-like" if ALL four checks pass. The function SHALL return a boolean.

#### Scenario: Valid JSON object classified as JSON-like

- **WHEN** the input is `{"name":"alice","age":30}`
- **THEN** the function SHALL return `true`

#### Scenario: Valid JSON array classified as JSON-like

- **WHEN** the input is `[1, "two", null, true]`
- **THEN** the function SHALL return `true`

#### Scenario: Plain text not classified as JSON-like

- **WHEN** the input is `Hello, this is a test string`
- **THEN** the function SHALL return `false` (fails starts-like-JSON and bracket checks)

#### Scenario: Unbalanced brackets not classified as JSON-like

- **WHEN** the input is `{"name":"alice"`
- **THEN** the function SHALL return `false` (brackets are unbalanced)

#### Scenario: Brackets inside strings not counted

- **WHEN** the input is `{"data":"[{invalid}"}`
- **THEN** brackets inside the string `[{invalid}` SHALL NOT be counted toward balance
- **AND** the outer `{`/`}` SHALL be balanced
- **AND** the function SHALL return `true`

#### Scenario: Bare number not classified as JSON-like

- **WHEN** the input is `42`
- **THEN** the function SHALL return `false` (no brackets)

#### Scenario: Bare string not classified as JSON-like

- **WHEN** the input is `"hello"`
- **THEN** the function SHALL return `false` (no brackets)

#### Scenario: Low control character density

- **WHEN** the input is `{"x":"` followed by 1000 bytes of `a` followed by `"}`
- **THEN** the function SHALL return `false` (control character density below 5%)

### Requirement: JSON auto-detection in FeatureDetection

The `FeatureDetection` system SHALL auto-detect JSON-like corpus content and enable JSON mutations, following the same tri-state pattern as Grimoire, Unicode, and REDQUEEN.

The `FuzzerConfig` SHALL accept a `jsonMutations` field of type `Option<bool>`:
- `Some(true)`: Force-enable JSON mutations.
- `Some(false)`: Force-disable JSON mutations.
- `None` (or absent): Auto-detect from corpus content.

When auto-detecting:
1. The corpus scan (triggered at `DEFERRED_DETECTION_THRESHOLD` interesting inputs) SHALL classify each corpus entry as JSON-like using the JSON heuristic function, in addition to the existing UTF-8 check.
2. Only entries that are valid UTF-8 are candidates for JSON classification.
3. Auto-seeds (detector seeds and default seeds) SHALL be excluded from the scan. Only user seeds and fuzzer-discovered inputs inform detection. Auto-seeds are guesses, not signal for inferring target characteristics.
4. `json_mutations_enabled` SHALL be set to `true` if `json_like_count > utf8_count / 2` (a majority of UTF-8 entries are JSON-like).
5. When explicitly configured, the scan result SHALL NOT override the explicit setting.

The detection result SHALL be stored as a field on `FeatureDetection` (`json_mutations_enabled`), consistent with `grimoire_enabled`, `unicode_enabled`, and `redqueen_enabled`. The stage pipeline checks this field in `begin_stage()` and stage transition logic, which have direct access to `self.features`.

#### Scenario: Auto-detect enables JSON mutations for JSON-heavy corpus

- **WHEN** `jsonMutations` is absent (auto-detect)
- **AND** after 10 interesting inputs, 8 are valid UTF-8 and 6 of those are JSON-like
- **THEN** `json_mutations_enabled` SHALL be `true`

#### Scenario: Auto-detect disables JSON mutations for text corpus

- **WHEN** `jsonMutations` is absent (auto-detect)
- **AND** after 10 interesting inputs, 8 are valid UTF-8 and 1 is JSON-like
- **THEN** `json_mutations_enabled` SHALL be `false`

#### Scenario: Explicit enable overrides non-JSON corpus

- **WHEN** `jsonMutations` is `true`
- **AND** the corpus contains no JSON-like inputs
- **THEN** `json_mutations_enabled` SHALL be `true`

#### Scenario: Explicit disable overrides JSON corpus

- **WHEN** `jsonMutations` is `false`
- **AND** every corpus entry is JSON-like
- **THEN** `json_mutations_enabled` SHALL be `false`

#### Scenario: Deferred detection resolves alongside other features

- **WHEN** the corpus is initially empty
- **AND** `jsonMutations`, `grimoire`, and `unicode` are all in auto-detect mode
- **THEN** a single corpus scan at the deferred threshold SHALL resolve all features simultaneously

#### Scenario: JSON mutations initially disabled before detection

- **WHEN** the corpus is empty and `jsonMutations` is in auto-detect mode
- **THEN** `json_mutations_enabled` SHALL be `false` until deferred detection resolves
