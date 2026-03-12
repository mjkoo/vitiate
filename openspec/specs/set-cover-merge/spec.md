## ADDED Requirements

### Requirement: Set cover algorithm

The system SHALL provide a greedy set cover function that accepts an array of entries, each with a `data: Buffer`, `path: string`, and `edges: Set<number>`, and returns the minimal subset of entries whose edges collectively cover the union of all edges across all entries.

The greedy loop SHALL:
1. Initialize an empty `covered` set.
2. While `covered` does not contain all edges:
   a. For each remaining entry, count edges not in `covered`.
   b. Select the entry with the most uncovered edges.
   c. Tie-break: prefer the entry with the smaller `data.byteLength`.
   d. Add the selected entry's edges to `covered`.
   e. Remove the selected entry from remaining.
3. Return the selected entries.

The function SHALL accept an optional `preCovered: Set<number>` parameter. When provided, the `covered` set SHALL be initialized with these edges instead of empty. This allows seed corpus edges to be pre-populated so that cached entries redundant with seeds are eliminated.

#### Scenario: Disjoint edge sets

- **WHEN** entry A covers edges {1, 2} and entry B covers edges {3, 4}
- **THEN** both entries are selected (neither is redundant)

#### Scenario: Fully redundant entry eliminated

- **WHEN** entry A covers edges {1, 2, 3} and entry B covers edges {1, 2}
- **THEN** only entry A is selected (B is fully covered by A)

#### Scenario: Tie-break by size

- **WHEN** entry A (100 bytes) covers edges {1, 2, 3} and entry B (50 bytes) covers edges {1, 2, 3}
- **THEN** only entry B is selected (same coverage, smaller size)

#### Scenario: Greedy selection order

- **WHEN** entry A covers edges {1, 2, 3, 4}, entry B covers edges {1, 2, 5}, and entry C covers edges {3, 4, 6}
- **THEN** entry A is selected first (4 uncovered edges), then B or C to cover remaining edges

#### Scenario: Empty input

- **WHEN** no entries are provided
- **THEN** an empty array is returned

#### Scenario: Single entry

- **WHEN** one entry is provided covering edges {1, 2}
- **THEN** that entry is returned

#### Scenario: Entry with no edges

- **WHEN** entry A covers edges {1, 2} and entry B covers no edges (empty set)
- **THEN** only entry A is selected (B contributes nothing)

#### Scenario: All entries have empty edge sets

- **WHEN** entry A and entry B both have empty edge sets
- **THEN** an empty array is returned (the union of all edges is empty, so there is nothing to cover)

#### Scenario: Pre-covered edges eliminate redundant entries

- **WHEN** `preCovered` is {1, 2, 3} and entry A covers edges {1, 2} and entry B covers edges {4, 5}
- **THEN** only entry B is selected (entry A is fully covered by pre-covered set)

#### Scenario: Pre-covered edges cover everything

- **WHEN** `preCovered` is {1, 2, 3} and entry A covers edges {1, 2} and entry B covers edges {2, 3}
- **THEN** no entries are selected (all edges already covered)

### Requirement: Coverage collection from shared map

The system SHALL provide a `collectEdges(coverageMap: Buffer): Set<number>` function that accepts a coverage map Buffer as a parameter and returns a `Set<number>` containing the indices of all nonzero bytes.

After collecting edges, the function SHALL zero the buffer (`buffer.fill(0)`) to prepare for the next replay.

The coverage map is a 65,536-byte Buffer. The function SHALL iterate all bytes in the provided buffer. Callers pass `globalThis.__vitiate_cov` (or a test buffer) as the argument.

#### Scenario: Collect edges from coverage map

- **WHEN** the coverage map has nonzero values at indices 10, 42, and 65535
- **THEN** the returned set contains exactly {10, 42, 65535}
- **AND** the coverage map is zeroed after collection

#### Scenario: Empty coverage map

- **WHEN** all bytes in the coverage map are zero
- **THEN** an empty set is returned
- **AND** the coverage map remains zeroed

### Requirement: CLI merge mode

When `-merge=1` is provided on the CLI, the system SHALL enter merge mode instead of fuzzing mode. The parent process SHALL use the existing supervisor pattern (`runSupervisor()`) to spawn and manage the child. The child process SHALL detect merge mode via the `merge: true` field in the `VITIATE_CLI_IPC` JSON blob (set by the parent alongside `VITIATE_SUPERVISOR`).

#### Control file

The parent SHALL create a control file path in the system temp directory (`os.tmpdir()`) and pass it to the child via the `mergeControlFile` field in the `VITIATE_CLI_IPC` JSON blob.

The control file SHALL use JSON-lines format (one JSON object per line): `{"path": "<input-file-path>", "edges": [<edge-indices>]}`. The child SHALL append one line after each successful replay. The format is append-only; a partial last line (from a crash mid-write) SHALL be discarded on read.

After the supervisor completes (child exits normally), the parent SHALL delete the control file.

#### Child merge replay loop

1. Load all inputs from all specified corpus directories (positional arguments after the test file).
2. If the control file exists, read already-collected `{path, edges}` records and skip those inputs. Discard any partial trailing line.
3. For each remaining input: execute the fuzz target, collect coverage edges from the shared map, zero the map. If the target throws a JS exception, skip the input and log a warning. After each successful replay, append the `{path, edges}` record to the control file.
4. Run the set cover algorithm over all collected (input, edges) pairs (from the control file and the current run).
5. Remove all existing files from the first corpus directory (output directory), then write the surviving entries to it. This ensures only survivors remain, matching libFuzzer's `-merge=1` behavior.
6. Report human-readable stats to stderr: entries loaded, unique edges covered, entries selected, entries removed.

#### Crash recovery

If the child process crashes (native signal) during replay, the supervisor respawns it. The respawned child reads the control file to resume from where the previous child left off. The crashing input is the one after the last written record and is implicitly skipped (it will be the first input attempted, it will crash again, and the supervisor will respawn again, advancing past one input per crash).

The maximum number of respawns is bounded by the corpus size: each crash advances past exactly one input, so a corpus of N entries requires at most N+1 child spawns (N crashes + 1 successful completion).

#### Constraints

Merge mode SHALL NOT use the Rust fuzzing engine (`Fuzzer`), watchdog, or calibration. It only needs the instrumented target and the coverage map.

#### Scenario: Basic merge reduces corpus

- **WHEN** `npx vitiate ./test.ts -merge=1 ./corpus/ ./extra/` is executed
- **AND** `./corpus/` contains 100 entries and `./extra/` contains 50 entries
- **AND** the set cover selects 30 entries
- **THEN** only the 30 surviving entries exist in `./corpus/` (non-survivors removed)
- **AND** stderr reports: loaded 150, selected 30, removed 120

#### Scenario: Merge with single directory

- **WHEN** `npx vitiate ./test.ts -merge=1 ./corpus/` is executed
- **THEN** inputs are loaded from `./corpus/`, replayed, minimized via set cover
- **AND** `./corpus/` contains only the surviving entries after merge

#### Scenario: Merge with empty corpus

- **WHEN** `npx vitiate ./test.ts -merge=1 ./corpus/` is executed
- **AND** `./corpus/` contains no files
- **THEN** merge completes as a no-op
- **AND** stderr reports: loaded 0 entries

#### Scenario: JS exception during merge replay

- **WHEN** an input causes the fuzz target to throw a JS exception during merge replay
- **THEN** that input is discarded from the merge set (not included in set cover)
- **AND** a warning is printed to stderr identifying the skipped input

#### Scenario: Native crash during merge replay

- **WHEN** an input causes a native crash (SIGSEGV, etc.) during merge replay
- **THEN** the supervisor respawns the child
- **AND** the respawned child reads the control file and resumes from the next unprocessed input
- **AND** the crashing input is implicitly skipped

#### Scenario: No corpus directories provided with merge

- **WHEN** `npx vitiate ./test.ts -merge=1` is executed with no corpus directories
- **THEN** an error message is printed and the process exits with code 1

### Requirement: Vitest optimize mode

When the `VITIATE_OPTIMIZE=1` environment variable is set, the system SHALL enter optimize mode instead of fuzzing mode. For each fuzz test discovered by Vitest:

1. Load seed corpus from `<dataDir>/testdata/<hashdir>/seeds/`.
2. Load crash artifacts from `<dataDir>/testdata/<hashdir>/crashes/`.
3. Load timeout artifacts from `<dataDir>/testdata/<hashdir>/timeouts/`.
4. Load cached corpus from `<dataDir>/corpus/<hashdir>/`.
5. Replay all seed, crash, and timeout entries, collect edges, add to a pre-covered set.
6. Replay all cached entries, collect edges.
7. Run set cover over cached entries only, with the seed/crash/timeout edges as pre-covered.
8. Delete cached entries not in the surviving set.
9. Report per-test stats to stderr.

Where `<hashdir>` is the output of `hashTestPath(relativeTestFilePath, testName)` and `<dataDir>` is the global test data root.

Seed, crash, and timeout entries SHALL never be removed. They are user-curated or machine-discovered regression tests committed to version control. Only cached corpus entries are subject to minimization.

The `isOptimizeMode()` function in `config.ts` SHALL detect `VITIATE_OPTIMIZE=1` using the same `envTruthy()` pattern as `isFuzzingMode()`.

If both `VITIATE_OPTIMIZE=1` and `VITIATE_FUZZ=1` are set, the system SHALL throw an error. These modes are mutually exclusive: optimize replays existing corpus entries, while fuzz generates new ones. Setting both is a configuration mistake.

The optimize mode SHALL require the vitiate plugin for instrumentation (coverage counters must be active). It SHALL be invoked via `VITIATE_OPTIMIZE=1 pnpm vitest run`.

The test SHALL pass after optimization (optimization is not a failure mode). If all cached entries are removed (seeds cover everything), the test still passes.

#### Scenario: Optimize reduces cached corpus

- **WHEN** `VITIATE_OPTIMIZE=1 pnpm vitest run` is executed
- **AND** test "parsesJson" has 10 seed entries, 3 crash entries, and 300 cached entries
- **AND** set cover selects 40 cached entries (with seed+crash pre-coverage)
- **THEN** 260 cached entry files are deleted from `.vitiate/corpus/<hashdir>/`
- **AND** seed and crash entries remain untouched in `.vitiate/testdata/<hashdir>/`

#### Scenario: Seeds and crashes cover all edges

- **WHEN** seed and crash corpus entries cover all edges that cached entries also cover
- **THEN** all cached entries are removed (fully redundant)
- **AND** seed and crash entries remain untouched

#### Scenario: Empty cached corpus

- **WHEN** a test has seed entries but no cached entries
- **THEN** optimize is a no-op for that test (nothing to remove)

#### Scenario: No seed corpus

- **WHEN** a test has cached entries but no seed corpus
- **THEN** set cover runs over cached entries with empty pre-covered set
- **AND** the minimal cached subset is retained

#### Scenario: Test passes after optimization

- **WHEN** optimization completes for a test
- **THEN** the Vitest test result is "pass" (not "fail")

#### Scenario: VITIATE_OPTIMIZE and VITIATE_FUZZ both set

- **WHEN** both `VITIATE_OPTIMIZE=1` and `VITIATE_FUZZ=1` are set
- **THEN** the system throws an error indicating the modes are mutually exclusive

### Requirement: Merge mode stats output

The system SHALL print human-readable statistics to stderr during merge and optimize operations.

CLI merge mode SHALL print:
- Number of entries loaded and from how many directories.
- Number of unique edges covered after replay.
- Number of entries selected by set cover and number removed.
- Number of entries written to the output directory.

Vitest optimize mode SHALL print per-test:
- Test name, number of entries (seed + cached), number of edges.
- Number of entries kept and removed.

All stats lines SHALL be prefixed with `vitiate: merge:` (CLI mode) or `vitiate: optimize:` (Vitest mode).

#### Scenario: CLI merge stats

- **WHEN** CLI merge loads 847 entries, covers 1203 edges, selects 94
- **THEN** stderr includes lines like:
  - `vitiate: merge: loaded 847 entries from 3 directories`
  - `vitiate: merge: replay complete, 1203 unique edges covered`
  - `vitiate: merge: set cover selected 94 entries (removed 753)`
  - `vitiate: merge: wrote 94 entries to corpus/`

#### Scenario: Vitest optimize stats

- **WHEN** Vitest optimize processes test "parsesJson" with 312 entries and 456 edges, keeping 47
- **THEN** stderr includes lines like:
  - `vitiate: optimize: test "parsesJson" - 312 entries, 456 edges`
  - `vitiate: optimize: test "parsesJson" - kept 47, removed 265`
