## Why

During long fuzzing campaigns, Vitiate saves every crashing input as a separate artifact, deduplicated only by input content hash (SHA-256). Different inputs that trigger the same underlying bug produce different hashes, flooding the artifact directory with redundant crash files and making triage painful. We need to deduplicate crashes by *defect identity*, keeping only the smallest reproducer per unique bug.

## What Changes

- Add "fail-open" crash deduplication to the fuzz loop: JS exceptions with `Error.stack` are deduplicated by normalized stack hash (top 5 frames, stripped of line/column numbers); all other crash types (timeouts, native signals, SEH) are always saved
- When a duplicate crash is detected with a smaller input, atomically replace the existing artifact on disk
- Add a `duplicateCrashesSkipped` counter to the fuzz loop state for observability (TypeScript-only, not in Rust `FuzzerStats`)
- Add a stack normalization utility that parses V8 stack traces, strips line/column numbers, and extracts `functionName@fileName` per frame

## Capabilities

### New Capabilities
- `defect-dedupe`: Crash deduplication by normalized stack hash - maintains a per-process map of seen crash signatures, keeps smallest reproducer per unique defect, fails open when dedup key is unavailable

### Modified Capabilities
- `fuzz-loop`: Integrates dedup check before artifact write on crash paths
- `corpus-management`: Adds `replaceArtifact` for atomic artifact replacement when a smaller reproducer is found
- `crash-continuation`: Qualifies crash counter and artifact collection - suppressed duplicates are not counted or appended

## Impact

- **Code:** `loop.ts` (dedup logic integration), `corpus.ts` (artifact replacement), new stack normalization utility, reporter (new counter display)
- **No changes to:** `supervisor.ts`, `vitiate-napi`, `vitiate-instrument`, shmem, watchdog - the supervisor/native crash path remains fail-open by construction
- **APIs:** No public API changes; dedup is automatic and internal. `FuzzLoopResult` gains `duplicateCrashesSkipped` counter.
- **Prerequisite:** Depends on the `stop-on-crash` change (`stopOnCrash: false` allows the loop to continue after crashes, which is necessary for the dedup map to accumulate entries)
- **Vitest mode:** Benefits when `stopOnCrash` resolves to `false` (the default via `auto`), allowing dedup across multiple crashes in a single campaign
- **CLI mode:** Benefits in `-fork` mode where `stopOnCrash` resolves to `false`; in non-fork CLI mode (`stopOnCrash: true`), dedup has no effect (loop stops on first crash)
