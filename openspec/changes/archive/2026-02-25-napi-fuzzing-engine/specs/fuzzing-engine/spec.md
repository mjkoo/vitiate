## ADDED Requirements

### Requirement: Create fuzzer instance

The system SHALL provide a `Fuzzer` class constructable via
`new Fuzzer(coverageMap, config?)` that accepts a required coverage map `Buffer` and an
optional `FuzzerConfig` object. The Fuzzer SHALL stash a reference to the coverage map
buffer for zero-copy access on each iteration.

The config SHALL support the following fields, all optional with defaults:

- `maxInputLen` (number, default 4096): Maximum byte length of generated inputs.
- `seed` (bigint, optional): RNG seed for reproducible mutation sequences. If omitted,
  a random seed is used.

#### Scenario: Create with defaults

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** a Fuzzer instance is created with maxInputLen=4096 and a random seed, holding
  a reference to the provided coverage map

#### Scenario: Create with custom config

- **WHEN** `new Fuzzer(createCoverageMap(32768), { maxInputLen: 1024, seed: 42n })` is called
- **THEN** a Fuzzer instance is created with the specified configuration

#### Scenario: Reproducible with same seed

- **WHEN** two Fuzzer instances are created with the same seed and coverage maps of the
  same size, and the same sequence of addSeed/getNextInput/reportResult calls is performed
- **THEN** both instances SHALL produce identical mutation sequences

### Requirement: Add seed inputs

The system SHALL provide `fuzzer.addSeed(input: Buffer)` to add a seed input to the
corpus. Seeds serve as starting points for mutation.

#### Scenario: Add a seed

- **WHEN** `fuzzer.addSeed(Buffer.from("hello"))` is called
- **THEN** the corpus contains one entry and `getNextInput()` can produce mutations
  derived from it

#### Scenario: Add multiple seeds

- **WHEN** three different seeds are added via `addSeed()`
- **THEN** the corpus size is 3 and `getNextInput()` can produce mutations derived from
  any of them

### Requirement: Auto-seed on empty corpus

If no seeds have been added when `getNextInput()` is first called, the system SHALL
automatically add a diverse set of default inputs to the corpus: an empty buffer, `"\n"`,
`"0"`, `"\x00\x00\x00\x00"`, `"{}"`, and `"test"`. These provide the mutator with
structural tokens (JSON braces, null bytes, printable ASCII) as starting material.

#### Scenario: No explicit seeds

- **WHEN** `getNextInput()` is called without any prior `addSeed()` calls
- **THEN** the call succeeds and returns a Buffer
- **AND** the corpus size is at least 6 (the default seed set)

### Requirement: Get next mutated input

The system SHALL provide `fuzzer.getNextInput()` which returns a `Buffer` containing a
mutated input derived from the corpus. The system uses LibAFL's havoc mutations (bit
flips, byte flips, arithmetic, block insert/delete/copy, splicing) applied to a corpus
entry selected by the scheduler.

#### Scenario: Mutations produce varied outputs

- **WHEN** `getNextInput()` is called 100 times with a single seed in the corpus
- **THEN** at least 2 distinct outputs are produced (mutations are not identity)

#### Scenario: Output respects maxInputLen

- **WHEN** a Fuzzer is configured with `maxInputLen: 128` and `getNextInput()` is called
- **THEN** the returned Buffer length SHALL NOT exceed 128 bytes

### Requirement: Report execution result

The system SHALL provide `fuzzer.reportResult(exitKind: ExitKind)` which reads coverage
data directly from the stashed coverage map pointer, evaluates whether the input was
interesting (new coverage) or a crash, updates the corpus accordingly, zeroes the coverage
map in place, and returns an `IterationResult`.

The `ExitKind` enum SHALL have values: `Ok` (0), `Crash` (1), `Timeout` (2).

The `IterationResult` object SHALL contain:

- `interesting` (boolean): Whether the input was added to the corpus.
- `solution` (boolean): Whether the input was a crash/timeout (added to solutions).

#### Scenario: New coverage is interesting

- **WHEN** the coverage map contains a byte pattern not seen in any previous iteration
  and `reportResult(ExitKind.Ok)` is called
- **THEN** the result has `interesting: true` and the corpus size increases by one

#### Scenario: Duplicate coverage is not interesting

- **WHEN** the coverage map contains the same byte pattern as a previous iteration and
  `reportResult(ExitKind.Ok)` is called
- **THEN** the result has `interesting: false` and the corpus size does not change

#### Scenario: Crash detected

- **WHEN** `reportResult(ExitKind.Crash)` is called
- **THEN** the result has `solution: true` and the solution count increases by one

### Requirement: Fuzzer statistics

The system SHALL provide `fuzzer.stats` (getter) returning a `FuzzerStats` object with:

- `totalExecs` (bigint): Total number of `reportResult()` calls.
- `corpusSize` (number): Number of entries in the working corpus.
- `solutionCount` (number): Number of crash/timeout inputs found.
- `coverageEdges` (number): Number of distinct coverage map positions that have been
  observed nonzero across all iterations.
- `execsPerSec` (number): Executions per second since Fuzzer creation.

#### Scenario: Stats after fuzzing

- **WHEN** 1000 iterations of getNextInput/reportResult have been performed
- **THEN** `stats.totalExecs` equals 1000n, `stats.corpusSize` is at least 1,
  and `stats.execsPerSec` is greater than 0

#### Scenario: Stats at creation

- **WHEN** `stats` is read immediately after Fuzzer creation
- **THEN** `totalExecs` is 0n, `corpusSize` is 0, `solutionCount` is 0,
  `coverageEdges` is 0, and `execsPerSec` is 0

### Requirement: End-to-end fuzzing loop

The system SHALL support a complete fuzzing loop driven by JavaScript: create fuzzer, add
seeds, then repeatedly call `getNextInput()` → execute target → `reportResult()`. Over
many iterations with a target that exhibits variable coverage based on input content, the
corpus SHALL grow as new coverage is discovered.

#### Scenario: Corpus grows with coverage-guided feedback

- **WHEN** a fuzzer is seeded, and 10000 iterations are run against a target that sets
  different coverage map bytes depending on input content
- **THEN** the corpus size is greater than the initial seed count
- **AND** the coverage edge count is greater than 0
