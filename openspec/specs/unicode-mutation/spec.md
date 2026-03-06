## Purpose

Unicode mutation provides character-aware mutators that operate on UTF-8 regions within fuzzer inputs. These mutators understand Unicode general categories and subcategories, enabling mutations that preserve structural properties like character class (letters stay letters, digits stay digits) while exploring the input space. The unicode stage uses a weighted pool of four mutator types with havoc-style stacking.

## Requirements

### Requirement: Unicode category random replacement mutator

The system SHALL provide a unicode category random replacement mutator that:

1. Selects a random byte position in the input.
2. Finds the UTF-8 string region containing that position using `UnicodeIdentificationMetadata`.
3. Picks a random character from the selected region.
4. Identifies the Unicode general category of that character (e.g., Letter, Number, Punctuation).
5. Expands the selection to the contiguous range of characters sharing the same category.
6. Replaces the range with up to 16 randomly-generated characters from the same category.
7. Recomputes `UnicodeIdentificationMetadata` for the mutated input.

The mutator SHALL return `Skipped` if the input is empty, if no valid UTF-8 region contains the selected position, or if the result would exceed `maxInputLen`.

#### Scenario: Letter replaced with letter

- **WHEN** the input is `"hello123"` and the mutator selects a position within `"hello"`
- **THEN** the contiguous letter range `"hello"` SHALL be identified
- **AND** it SHALL be replaced with up to 16 randomly-generated Unicode letter characters
- **AND** the replacement characters SHALL all belong to the Unicode Letter category

#### Scenario: Digit replaced with digit

- **WHEN** the input is `"hello123"` and the mutator selects a position within `"123"`
- **THEN** the contiguous number range `"123"` SHALL be identified
- **AND** it SHALL be replaced with up to 16 randomly-generated Unicode Number characters

#### Scenario: No valid UTF-8 region at selected position

- **WHEN** the randomly-selected byte position falls outside any UTF-8 region
- **THEN** the mutator SHALL return `Skipped`

#### Scenario: Result exceeds max input length

- **WHEN** the replacement would cause the input to exceed `maxInputLen`
- **THEN** the mutator SHALL return `Skipped`

### Requirement: Unicode subcategory random replacement mutator

The system SHALL provide a unicode subcategory random replacement mutator that operates identically to the category mutator except:

1. It identifies the Unicode **subcategory** of the selected character (e.g., Uppercase_Letter, Decimal_Number, Open_Punctuation).
2. It expands to the contiguous range of characters sharing the same subcategory.
3. It generates replacement characters from the same subcategory.

Subcategory mutations are finer-grained than category mutations — they preserve properties like case (uppercase→uppercase) and number type (decimal→decimal).

#### Scenario: Uppercase replaced with uppercase

- **WHEN** the input is `"HelloWorld"` and the mutator selects a position within `"H"`
- **THEN** the replacement character SHALL belong to the Uppercase_Letter subcategory

#### Scenario: Subcategory contiguous range

- **WHEN** the input is `"ABC123def"` and the mutator selects position within `"ABC"`
- **THEN** only the `"ABC"` range (Uppercase_Letter) SHALL be selected for replacement
- **AND** `"def"` (Lowercase_Letter — different subcategory) SHALL NOT be included

### Requirement: Unicode category token replacement mutator

The system SHALL provide a unicode category token replacement mutator that:

1. Selects a random byte position and finds the containing UTF-8 region.
2. Picks a random character and identifies its Unicode general category.
3. Expands to the contiguous range of characters sharing the same category.
4. Selects a random token from the `Tokens` metadata (dictionary).
5. Replaces the category-contiguous range with the selected token.
6. Recomputes `UnicodeIdentificationMetadata` for the mutated input.

The mutator SHALL return `Skipped` if the input is empty, no valid UTF-8 region is found, no tokens are available in the dictionary, or the result would exceed `maxInputLen`.

#### Scenario: Letter range replaced with dictionary token

- **WHEN** the input is `"hello world"` and the mutator selects the `"hello"` range
- **AND** the dictionary contains the token `"password"`
- **THEN** the `"hello"` range MAY be replaced with `"password"`

#### Scenario: No tokens available

- **WHEN** the `Tokens` metadata is empty (no dictionary entries)
- **THEN** the mutator SHALL return `Skipped`

### Requirement: Unicode subcategory token replacement mutator

The system SHALL provide a unicode subcategory token replacement mutator that operates identically to the category token replacement mutator except it uses subcategory-level contiguous ranges (finer-grained selection of the replacement region).

#### Scenario: Subcategory-level token replacement

- **WHEN** the input is `"ABCdef"` and the mutator selects position within `"ABC"` (Uppercase_Letter subcategory)
- **AND** the dictionary contains a token
- **THEN** only the `"ABC"` range SHALL be replaced with the token
- **AND** `"def"` (Lowercase_Letter) SHALL NOT be affected

### Requirement: Mutator weighting favors subcategory mutations

The unicode mutation stage SHALL weight subcategory mutators at approximately 4x the weight of category mutators. Specifically, the mutator pool SHALL contain:

- 1x `UnicodeCategoryRandMutator`
- 4x `UnicodeSubcategoryRandMutator`
- 1x `UnicodeCategoryTokenReplaceMutator`
- 4x `UnicodeSubcategoryTokenReplaceMutator`

Each iteration SHALL randomly select from this weighted pool.

#### Scenario: Subcategory mutations selected more frequently

- **WHEN** the unicode stage runs 100 iterations
- **THEN** approximately 80% of mutations SHALL use subcategory-level mutators
- **AND** approximately 20% SHALL use category-level mutators

### Requirement: Unicode mutation stacking depth

The unicode mutation stage SHALL use a `HavocScheduledMutator` with `max_stack_pow=7`, producing 2..=128 stacked mutations per `mutate()` call. Each stage iteration calls `mutate()` once, which internally applies 2 to 128 randomly-selected mutations from the weighted pool in sequence on the same input clone.

This stacking depth is appropriate for character-level mutations where each individual mutation is small (replacing a contiguous category range). It matches the default `HavocScheduledMutator` configuration and contrasts with Grimoire's `max_stack_pow=3` (2..=8 stacks) which uses fewer stacks because each Grimoire mutation makes larger structural changes.

#### Scenario: Stacking depth within bounds

- **WHEN** the unicode stage calls `mutate()` for a single iteration
- **THEN** the `HavocScheduledMutator` SHALL apply between 2 and 128 individual mutations from the weighted pool
- **AND** each individual mutation SHALL operate on the result of the previous mutation within the same `mutate()` call

#### Scenario: Stacking composes multiple mutator types

- **WHEN** a single `mutate()` call applies 5 stacked mutations
- **THEN** each of the 5 mutations SHALL be independently selected from the weighted pool
- **AND** a single `mutate()` call MAY include a mix of category-random, subcategory-random, category-token, and subcategory-token mutations

### Requirement: Skipped unicode mutations return unmodified input

When a unicode mutator returns `Skipped` (e.g., no valid UTF-8 region at selected position, no tokens available, result would exceed max size), the stage SHALL return the unmodified clone of the corpus entry for execution, count the iteration against `max_iterations`, and continue to the next iteration.

If all stacked mutations within a single `mutate()` call return `Skipped`, the stage SHALL still return the unmodified input for execution and count the iteration.

#### Scenario: Single mutation skipped

- **WHEN** a unicode stage iteration calls `mutate()` and the selected mutator returns `Skipped`
- **THEN** the stage SHALL return the unmodified clone of the corpus entry as the candidate input
- **AND** the iteration SHALL be counted against `max_iterations`
- **AND** the stage SHALL continue to the next iteration normally

#### Scenario: All stacked mutations skipped

- **WHEN** a unicode stage iteration calls `mutate()` and every stacked mutation within the call returns `Skipped`
- **THEN** the stage SHALL return the unmodified clone of the corpus entry as the candidate input
- **AND** the iteration SHALL be counted against `max_iterations`
- **AND** the stage SHALL proceed normally (not abort or transition early)

### Requirement: Unicode stage iteration count

The unicode stage SHALL select a random iteration count between 1 and 128 (inclusive) per corpus entry, matching the I2S and Grimoire stage iteration ranges.

#### Scenario: Iteration count within bounds

- **WHEN** the unicode stage begins for a corpus entry
- **THEN** `max_iterations` SHALL be between 1 and 128 inclusive

### Requirement: Unicode mutations are non-cumulative

Each unicode stage iteration SHALL clone the original corpus entry and its `UnicodeIdentificationMetadata`, apply a fresh mutation, and evaluate coverage. Mutations SHALL NOT accumulate across iterations — each iteration starts from the unmodified corpus entry.

#### Scenario: Each iteration starts fresh

- **WHEN** a unicode stage runs for 5 iterations
- **THEN** each iteration SHALL start with a fresh clone of the original corpus entry
- **AND** each iteration SHALL independently apply a unicode mutation
- **AND** mutations from previous iterations SHALL NOT affect subsequent iterations

### Requirement: Unicode stage evaluates coverage and adds interesting inputs to corpus

Each unicode stage iteration SHALL evaluate coverage using the shared `evaluate_coverage` helper. If the mutated input triggers new coverage, it SHALL be added to the corpus with `SchedulerTestcaseMetadata`. The stage SHALL NOT prepare calibration state for stage-discovered entries.

#### Scenario: New coverage during unicode stage

- **WHEN** a unicode-mutated input triggers new coverage
- **THEN** the input SHALL be added to the corpus
- **AND** `scheduler.on_add()` SHALL be called
- **AND** calibration SHALL NOT be prepared for the new entry

### Requirement: Unicode stage drains and discards CmpLog

Each unicode stage iteration SHALL drain the CmpLog accumulator and discard all entries. Token promotion SHALL NOT occur during the unicode stage.

#### Scenario: CmpLog discarded during unicode stage

- **WHEN** `advanceStage()` processes a unicode stage execution
- **THEN** the CmpLog accumulator SHALL be drained and discarded
