## 1. Corpus Management Extensions

- [x] 1.1 Add `readCorpusDirWithPaths()` helper to `corpus.ts` that returns `{ path: string; data: Buffer }[]` (shared logic with existing `readCorpusDir`)
- [x] 1.2 Add `loadCachedCorpusWithPaths()` to `corpus.ts` using the new helper
- [x] 1.3 Add `loadCorpusDirsWithPaths()` to `corpus.ts` using the new helper
- [x] 1.4 Add `deleteCorpusEntry(filePath: string)` to `corpus.ts` — `unlinkSync` with ENOENT tolerance
- [x] 1.5 Write tests for path-returning load variants and `deleteCorpusEntry`

## 2. Set Cover Algorithm

- [x] 2.1 Create `vitiate/src/merge.ts` with the greedy set cover function (`setCover()`)
- [x] 2.2 Implement `collectEdges(coverageMap: Buffer): Set<number>` — iterate 65K buffer, collect nonzero indices, zero the buffer
- [x] 2.3 Write unit tests for `setCover()` covering: disjoint edges, redundant entries, tie-break by size, empty input, single entry, entries with no edges, all-empty-edges, pre-covered edges, pre-covered covers everything
- [x] 2.4 Write unit tests for `collectEdges()` covering: nonzero indices collected and buffer zeroed, empty map returns empty set

## 3. Config & Mode Detection

- [x] 3.1 Add `isOptimizeMode()` to `config.ts` using `envTruthy("VITIATE_OPTIMIZE")`
- [x] 3.2 Add `isMergeMode()` to `config.ts` using `envTruthy("VITIATE_MERGE")`
- [x] 3.3 Add mutual exclusion check — error when both `VITIATE_OPTIMIZE` and `VITIATE_FUZZ` are set
- [x] 3.4 Write tests for `isOptimizeMode()`, `isMergeMode()`, and the mutual exclusion error

## 4. CLI Merge Mode

- [x] 4.1 Replace the `-merge=1` warning in `cli.ts` with merge mode dispatch — validate at least one corpus directory, set `VITIATE_MERGE=1` and `VITIATE_MERGE_CONTROL_FILE=<tmpdir path>` env vars for child, use `runSupervisor()` for parent, clean up control file after supervisor completes
- [x] 4.2 Implement merge control file — JSON-lines `{"path", "edges"}` records in `os.tmpdir()`, append after each successful replay, read-on-resume with partial-line discard for crash recovery
- [x] 4.3 Implement `runMergeMode()` in `merge.ts` — load entries with paths, resume from control file, replay remaining through target, collect edges, handle JS exceptions (skip + warn), run set cover, clean output dir, write survivors
- [x] 4.4 Add merge stats output to stderr (loaded, edges, selected, removed, written)
- [x] 4.5 Write CLI merge tests: merge flag parsing, corpus directory validation error, control file resume after simulated crash

## 5. Vitest Optimize Mode

- [x] 5.1 Add optimize mode branch to `fuzz.ts` — check `isOptimizeMode()` before `isFuzzingMode()`, enter optimize path
- [x] 5.2 Implement optimize replay loop — load seeds and cached corpus with paths, replay seeds to collect pre-covered edges, replay cached to collect their edges, run set cover with pre-coverage, delete non-survivors
- [x] 5.3 Add optimize stats output to stderr (per-test entries, edges, kept, removed; summary line)
- [x] 5.4 Ensure optimize mode reports test as passing (not a failure mode)

## 6. Integration & Lint

- [x] 6.1 Run full test suite and fix any failures
- [x] 6.2 Run all lints: eslint, clippy, prettier, cargo fmt, cargo deny, cargo autoinherit, cargo msrv
