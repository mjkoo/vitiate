## Why

Fuzzing campaigns accumulate redundant corpus entries over time - multiple inputs that cover the same code edges. This bloats the corpus, slows seed loading, and wastes disk space. Users need a way to reduce their corpus to the minimal subset that preserves full coverage. LibFuzzer provides `-merge=1` for this; OSS-Fuzz invokes it regularly. Vitiate already parses `-merge=1` but prints a "not yet supported" warning.

## What Changes

- New set cover merge algorithm (greedy approximation) that selects the smallest subset of corpus entries covering all observed coverage edges, with tie-breaking by input size.
- CLI `-merge=1` mode: loads inputs from specified corpus directories, replays each through the fuzz target to collect coverage, runs set cover, writes surviving entries to the output directory. Replaces the current "not yet supported" warning.
- Vitest optimize mode (`VITIATE_OPTIMIZE=1`): replays seed + cached corpus entries, treats seed entries as mandatory (pre-populates covered edges), runs set cover over cached entries only, deletes non-surviving cached entries.
- Coverage collection utility that reads the shared 65K coverage map buffer directly in TypeScript (no new napi surface), collecting nonzero edge indices and zeroing between replays.
- Corpus deletion capability for removing non-surviving cached entries during optimize mode.

## Capabilities

### New Capabilities
- `set-cover-merge`: The greedy set cover algorithm, coverage collection from the shared map, and orchestration for both CLI merge and Vitest optimize entry points.

### Modified Capabilities
- `standalone-cli`: The `-merge=1` flag transitions from ignored-with-warning to a functional merge mode that loads corpus directories, replays inputs, and writes the minimized corpus.
- `corpus-management`: Adds the ability to load corpus entries with their file paths (for deletion decisions) and to delete individual cached corpus entries.

## Impact

- **New file**: `vitiate/src/merge.ts` - set cover algorithm, coverage collection helper, merge/optimize orchestration.
- **Modified**: `vitiate/src/cli.ts` - replace `-merge=1` warning with `runMergeMode()` call.
- **Modified**: `vitiate/src/corpus.ts` - add path-returning load variants and corpus entry deletion.
- **Modified**: `vitiate/src/config.ts` - add `VITIATE_OPTIMIZE` and `VITIATE_MERGE` env var detection, mutual exclusion check for `VITIATE_OPTIMIZE` + `VITIATE_FUZZ`.
- **Modified**: `vitiate/src/fuzz.ts` - add optimize mode branch alongside existing fuzz mode.
- **Merge control file**: Temp file for crash-resilient merge replay. Parent creates path, passes via `VITIATE_MERGE_CONTROL_FILE` env var, cleans up after supervisor completes.
- **Dependencies**: No new dependencies. Uses existing coverage map (`globalThis.__vitiate_cov`), corpus I/O, and supervisor architecture.
- **No napi changes**: Coverage is read directly from the shared Buffer in TypeScript.
