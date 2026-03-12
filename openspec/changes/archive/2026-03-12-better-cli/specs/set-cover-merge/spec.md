## MODIFIED Requirements

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

- **WHEN** `npx vitiate libfuzzer ./test.ts -merge=1 ./corpus/ ./extra/` is executed
- **AND** `./corpus/` contains 100 entries and `./extra/` contains 50 entries
- **AND** the set cover selects 30 entries
- **THEN** only the 30 surviving entries exist in `./corpus/` (non-survivors removed)
- **AND** stderr reports: loaded 150, selected 30, removed 120

#### Scenario: Merge with single directory

- **WHEN** `npx vitiate libfuzzer ./test.ts -merge=1 ./corpus/` is executed
- **THEN** inputs are loaded from `./corpus/`, replayed, minimized via set cover
- **AND** `./corpus/` contains only the surviving entries after merge

#### Scenario: Merge with empty corpus

- **WHEN** `npx vitiate libfuzzer ./test.ts -merge=1 ./corpus/` is executed
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

- **WHEN** `npx vitiate libfuzzer ./test.ts -merge=1` is executed with no corpus directories
- **THEN** an error message is printed and the process exits with code 1
