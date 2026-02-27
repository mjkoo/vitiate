## MODIFIED Requirements

### Requirement: Create fuzzer instance

The system SHALL provide a `Fuzzer` class constructable via
`new Fuzzer(coverageMap, config?)` that accepts a required coverage map `Buffer` and an
optional `FuzzerConfig` object. The Fuzzer SHALL stash a reference to the coverage map
buffer for zero-copy access on each iteration.

The config SHALL support the following fields, all optional with defaults:

- `maxInputLen` (number, default 4096): Maximum byte length of generated inputs.
- `seed` (bigint, optional): RNG seed for reproducible mutation sequences. If omitted,
  a random seed is used.

On construction, the Fuzzer SHALL enable the CmpLog accumulator so that `traceCmp` calls
record comparison operands. The Fuzzer SHALL also initialize `CmpValuesMetadata` on the
fuzzer state and include `I2SRandReplace` in its mutation pipeline.

#### Scenario: Create with defaults

- **WHEN** `new Fuzzer(createCoverageMap(65536))` is called with no config
- **THEN** a Fuzzer instance is created with maxInputLen=4096 and a random seed, holding
  a reference to the provided coverage map
- **AND** the CmpLog accumulator is enabled

#### Scenario: Create with custom config

- **WHEN** `new Fuzzer(createCoverageMap(32768), { maxInputLen: 1024, seed: 42n })` is called
- **THEN** a Fuzzer instance is created with the specified configuration
- **AND** the CmpLog accumulator is enabled

#### Scenario: Reproducible with same seed

- **WHEN** two Fuzzer instances are created with the same seed and coverage maps of the
  same size, and the same sequence of addSeed/getNextInput/reportResult calls is performed
- **THEN** both instances SHALL produce identical mutation sequences

### Requirement: Report execution result

The system SHALL provide `fuzzer.reportResult(exitKind: ExitKind)` which reads coverage
data directly from the stashed coverage map pointer, evaluates whether the input was
interesting (new coverage) or a crash, updates the corpus accordingly, zeroes the coverage
map in place, and returns an `IterationResult`.

Additionally, `reportResult` SHALL drain the thread-local CmpLog accumulator and store the
resulting entries as `CmpValuesMetadata` on the fuzzer state. This metadata is available to
`I2SRandReplace` during the next `getNextInput()` call. The CmpLog drain occurs after
coverage feedback evaluation and before the method returns.

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

#### Scenario: CmpLog metadata updated on reportResult

- **WHEN** instrumented code calls `traceCmp` with string operands during a fuzz iteration
- **AND** `reportResult(ExitKind.Ok)` is called
- **THEN** the fuzzer state contains `CmpValuesMetadata` with the recorded comparison entries

### Requirement: Get next mutated input

The system SHALL provide `fuzzer.getNextInput()` which returns a `Buffer` containing a
mutated input derived from the corpus. The system uses LibAFL's havoc mutations (bit
flips, byte flips, arithmetic, block insert/delete/copy, splicing) applied to a corpus
entry selected by the scheduler, followed by `I2SRandReplace` which may replace byte
patterns matching recorded comparison operands.

#### Scenario: Mutations produce varied outputs

- **WHEN** `getNextInput()` is called 100 times with a single seed in the corpus
- **THEN** at least 2 distinct outputs are produced (mutations are not identity)

#### Scenario: Output respects maxInputLen

- **WHEN** a Fuzzer is configured with `maxInputLen: 128` and `getNextInput()` is called
- **THEN** the returned Buffer length SHALL NOT exceed 128 bytes

#### Scenario: I2S mutation uses comparison metadata

- **WHEN** `CmpValuesMetadata` contains `CmpValues::Bytes("foo", "bar")`
- **AND** the corpus contains an input with bytes `"foo"`
- **AND** `getNextInput()` is called multiple times
- **THEN** at least one returned input SHALL contain the bytes `"bar"` replacing `"foo"`
  (demonstrating I2S replacement)
