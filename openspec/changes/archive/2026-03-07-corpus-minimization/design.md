## Context

Fuzzing campaigns accumulate corpus entries over time, many of which are redundant - covering the same edges as other entries. Vitiate currently has no way to reduce a corpus to its minimal representative subset. The CLI already parses `-merge=1` but prints a warning. LibFuzzer's set cover merge is the standard approach; OSS-Fuzz invokes it regularly.

The coverage map is a 65,536-byte `Buffer` at `globalThis.__vitiate_cov`, shared zero-copy with the Rust engine. The existing fuzz loop reads this map via the napi engine (`Fuzzer.reportResult`), but for merge we need to read it directly in TypeScript - the engine's feedback machinery (calibration, novelty tracking) is unnecessary for one-shot replay.

## Goals / Non-Goals

**Goals:**
- Implement set cover corpus minimization (greedy approximation) that selects the smallest subset covering all observed edges.
- CLI `-merge=1` mode: replay inputs from corpus directories, run set cover, write survivors to output directory.
- Vitest optimize mode (`VITIATE_OPTIMIZE=1`): replay seed + cached corpus, treat seeds as mandatory, prune non-surviving cached entries.
- Coverage collection directly from the shared Buffer in TypeScript - no new napi API surface.

**Non-Goals:**
- Multi-worker parallel merge.
- Incremental/online merge (always full replay + set cover from scratch).
- Merge algorithm selection (always set cover, no option to switch).
- Input minimization during merge (orthogonal concern).

## Decisions

### Decision 1: Read coverage map in TypeScript, not Rust

**Choice:** Iterate the 65K `globalThis.__vitiate_cov` Buffer in TypeScript to collect nonzero indices after each replay execution.

**Rationale:** The merge replay loop is simple: run target, read map, zero map, repeat. The Rust engine's `evaluate_coverage()` does calibration, novelty detection, and corpus management - none of which merge needs. Adding a napi method like `collectEdges()` would create API surface for a one-time operation that TypeScript handles trivially. Reading 65K bytes in a `for` loop is fast enough (sub-millisecond).

**Alternative considered:** Expose `collectEdges()` from the Rust engine. Rejected because it couples merge to the engine lifecycle and adds API surface we'd need to maintain.

### Decision 2: Set cover runs entirely in TypeScript

**Choice:** Implement the greedy set cover algorithm as a pure TypeScript function in `vitiate/src/merge.ts`.

**Rationale:** The algorithm is O(n * m) where n = entries and m = unique edges. For typical corpus sizes (hundreds to low thousands) and 65K edge map, this completes in milliseconds. No performance reason to push to Rust. Keeping it in TypeScript makes it testable without napi and keeps the Rust engine focused on the hot fuzz loop.

### Decision 3: Replay uses the same target execution path as fuzzing

**Choice:** Merge replay executes the fuzz target the same way the fuzz loop does - call the target function, then read the coverage map. No watchdog, no shmem stashing, no calibration.

**Rationale:** Merge only needs to know which edges an input covers. It doesn't need timeout enforcement (a hanging input during merge just stalls the process; the user can Ctrl+C). No calibration is needed - each input is replayed once. No shmem because we're not in the supervisor crash recovery path.

**Trade-off:** Unstable edges (edges that appear nondeterministically) may cause the merged corpus to retain entries that only contribute flaky coverage. This is acceptable - the fuzz loop will re-calibrate when it loads the merged corpus and mask unstable edges as usual.

### Decision 4: CLI merge mode uses supervisor + control file for crash resilience

**Choice:** When `-merge=1` is detected, the parent uses `runSupervisor()` to spawn the child with `VITIATE_MERGE=1` set. The child persists coverage data incrementally to a control file so respawned children can resume without re-replaying already-processed inputs.

**Control file details:**

- **Location:** Temp directory (`os.tmpdir()`). The parent creates the path before spawning the first child.
- **Path communication:** Parent sets `VITIATE_MERGE_CONTROL_FILE=<path>` in the child's environment, alongside `VITIATE_MERGE=1` and `VITIATE_SUPERVISOR=1`.
- **Format:** JSON-lines (one JSON object per line). Each line is `{"path": "<input-file-path>", "edges": [<edge-indices>]}`. Append-only - the child writes one line after each successful replay.
- **Crash recovery:** On respawn, the child reads the control file, rebuilds the set of already-processed paths and their edges, and skips those inputs. The crashing input is the first unrecorded one - it will crash again on the next attempt, and the supervisor will respawn again, advancing past it.
- **Lifecycle:** Parent creates the file path (not the file itself). Child creates and appends to it during replay. After the supervisor completes (child exits normally after finishing set cover + writing output), the parent deletes the control file.
- **Respawn bound:** Each crash advances past exactly one input, so the maximum number of respawns equals the corpus size. This is a natural bound - no explicit respawn limit is needed.

**Rationale:** The child process has instrumentation enabled (the Vite plugin is loaded, SWC has inserted coverage counters). Native crashes (SIGSEGV from instrumented code, OOM) are rare but possible during replay. Without a control file, a native crash loses all in-memory coverage data. The control file makes crash recovery incremental - only the crashing input is lost, and the supervisor's existing respawn mechanism handles the rest.

JS exceptions during replay are caught by try/catch and the input is skipped with a warning. Only native crashes require the supervisor respawn path.

**Alternative considered:** Keep state in the supervisor process (parent accumulates coverage data via IPC). Rejected because the coverage map is in the child's JS heap, not in shared memory. Transmitting 65K of edge data per input via pipe or shmem is more complex than appending a JSON line to a file. The control file is simpler, requires no changes to the supervisor, and is the proven approach (libfuzzer uses the same pattern).

### Decision 5: Vitest optimize mode as a separate mode branch

**Choice:** Add `VITIATE_OPTIMIZE=1` env var check in `config.ts` (via `isOptimizeMode()`). In `fuzz.ts`, the `fuzz()` function checks `isOptimizeMode()` before `isFuzzingMode()` and enters the optimize code path. If both `VITIATE_OPTIMIZE=1` and `VITIATE_FUZZ=1` are set, the system throws an error - the modes are mutually exclusive.

**Rationale:** Optimize mode needs the same instrumentation as fuzzing (coverage counters active) but different loop behavior (replay, not mutate). Using a separate env var keeps modes orthogonal: `VITIATE_FUZZ=1` for fuzzing, `VITIATE_OPTIMIZE=1` for corpus optimization. Both require the vitiate plugin for instrumentation. Setting both simultaneously is a configuration mistake and should fail loudly rather than silently picking one.

### Decision 6: Seeds are mandatory in Vitest optimize mode

**Choice:** Before running set cover, pre-populate the "covered" edge set with all edges from seed corpus entries. Run set cover only over cached entries. Seeds are never candidates for removal.

**Rationale:** Seed corpus entries in `testdata/fuzz/` are user-curated regression tests. They must survive optimization. By pre-covering their edges, cached entries that are fully redundant with seeds are eliminated, which is the desired behavior.

### Decision 7: Corpus entry deletion via `unlinkSync`

**Choice:** Add `deleteCorpusEntry(path: string)` to `corpus.ts` that calls `unlinkSync`. The optimize mode collects paths of non-surviving entries and deletes them after set cover completes.

**Rationale:** Corpus entries are content-addressed files with no metadata or cross-references. Deletion is a simple `unlink`. No need for a more complex mechanism. Deleting after set cover (not during) avoids partial-deletion states if the process is interrupted.

### Decision 8: Path-returning corpus load variants

**Choice:** Add `loadCachedCorpusWithPaths()` and `loadCorpusDirsWithPaths()` that return `{ path: string; data: Buffer }[]` instead of `Buffer[]`. These share the same directory-reading logic as existing functions.

**Rationale:** Merge needs file paths to determine which entries to keep (CLI: write to output dir) or delete (Vitest optimize: remove non-survivors). The existing `readCorpusDir` helper only returns `Buffer[]`. Rather than changing the existing API (which would touch all call sites), we add path-returning variants that the merge code uses.

## Risks / Trade-offs

**[Unstable edges inflate merged corpus]** Inputs replayed once may hit nondeterministic edges, causing entries to appear uniquely valuable when they're not. → Acceptable for v1. The fuzz loop re-calibrates and masks unstable edges. Users can re-merge after a fuzzing session to further reduce.

**[Replay crash discards input]** If an input causes a native crash during merge replay, it's implicitly skipped on respawn (the control file doesn't contain it). JS exceptions are caught and the input is skipped with a warning. Both are correct: a crashing input is not a valid corpus entry.

**[No progress recovery on interrupt]** If merge is interrupted (Ctrl+C), partial progress is in the control file but the output directory has not been written yet. The control file is a temp file and will be cleaned up. Re-running merge starts fresh. For Vitest optimize, no deletions have happened. Both are safe states.

**[Output directory cleanup]** CLI merge removes all existing files from the output directory before writing survivors, matching libFuzzer's behavior. If the process is interrupted between removal and writing, the output directory may be empty. Users should keep a backup or use a separate output directory if this is a concern.

**[Large corpus replay time]** Replaying thousands of inputs through an instrumented target takes time proportional to corpus size × average target execution time. → For typical targets (sub-millisecond), even 10K entries take seconds. No parallelization needed for v1.
