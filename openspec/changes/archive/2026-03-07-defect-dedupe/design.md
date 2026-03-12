## Context

Vitiate deduplicates crash artifacts by input content hash (SHA-256 of raw bytes). Byte-identical inputs produce the same filename, and `writeExclusive()` with `O_EXCL` silently skips the second write. But different inputs triggering the same bug produce different hashes, so both are saved - flooding the artifact directory during long campaigns.

The `stop-on-crash` change introduced `stopOnCrash: false` mode, allowing the fuzz loop to continue after crashes and accumulate multiple crash artifacts in a single campaign. This is a prerequisite - without it, the loop terminates on the first crash and the dedup map can never accumulate entries.

The fuzz loop's `recordCrash()` calls `writeArtifactWithPrefix()` for each crash. The `Error` object (including `.stack`) is available at crash time for JS exceptions but is only used for the printed message - the stack trace is not preserved or analyzed.

## Goals / Non-Goals

**Goals:**
- Deduplicate JS exception crashes by normalized stack hash, keeping only the smallest reproducer per unique defect
- Fail open (always save) when dedup key is unavailable - never silently drop a potentially novel bug
- Provide observability via a `duplicateCrashesSkipped` stat counter
- Atomic artifact replacement when a smaller reproducer is found for an existing defect

**Non-Goals:**
- Deduplicating native signal crashes (no stack available - child is dead)
- Deduplicating timeouts (non-deterministic, synthetic error lacks meaningful stack)
- Coverage-map-based dedup (too fine-grained, unavailable for native crashes)
- Cross-process dedup (map resets on respawn, which is acceptable since respawns only happen for native crashes)
- Persisting the dedup map between fuzzing sessions

## Decisions

### 1. Dedup key: normalized stack hash of top 5 frames

**Decision:** Use the top 5 frames of `Error.stack`, normalized to `functionName@fileName` (stripping line/column numbers), hashed with SHA-256.

**Alternatives considered:**
- **Full stack hash:** Too unstable - recursion depth and intermediate branches change the full trace.
- **Top 1-2 frames:** Too coarse - different bugs at the same throw site would merge.
- **Coverage map hash:** Too fine-grained (different paths to same bug produce different hashes) and unavailable for native crashes.
- **Hybrid stack + coverage:** Added complexity without clear improvement; still unavailable for native crashes.

**Rationale:** Top 5 frames balances stability (minor call chain variations don't affect the key) against precision (distinct crash sites produce distinct keys). This mirrors LibAFL's `BacktraceObserver` approach adapted for JS.

### 2. Fail-open policy for non-JS crashes

**Decision:** When no `Error.stack` is available (timeouts, native signals, SEH), the dedup key is `UNKNOWN` and the crash is always saved.

**Rationale:** False negatives (dropped novel bugs) are far worse than false positives (extra artifacts). Native crashes are bounded by `MAX_RESPAWNS=100`. Timeouts have non-deterministic stacks.

### 3. Dedup state lives in the fuzz loop, not in corpus.ts

**Decision:** The `Map<string, { path: string, size: number }>` of seen crash signatures is owned by the fuzz loop (in `loop.ts`), not by the corpus module.

**Alternatives considered:**
- **In corpus.ts:** Would require corpus module to understand dedup semantics (stack parsing, replacement policy). Mixes concerns - corpus is about I/O, dedup is about crash identity.
- **Separate dedup module:** Overkill for ~30 lines of logic.

**Rationale:** The fuzz loop already owns crash handling flow (`recordCrash`). Adding the dedup check there is a natural extension. The corpus module gains only a `replaceArtifact` function for atomic replacement.

### 4. Stack normalization as a standalone utility

**Decision:** Create a `normalizeStackForDedup(stack: string): string | undefined` function that can be unit-tested independently.

**Rationale:** V8 stack format parsing has edge cases (anonymous functions, async frames, eval'd code). A standalone function enables thorough unit testing without requiring a full fuzz loop setup.

### 5. Atomic artifact replacement via rename

**Decision:** `replaceArtifact(oldPath, newData, kind)` writes to a temp file then renames into the target path. This ensures crash safety - readers never see a partially-written file.

**Rationale:** Standard pattern for atomic file updates. The temp file is in the same directory to ensure same-filesystem rename.

### 6. duplicateCrashesSkipped is a TypeScript-only counter

**Decision:** The `duplicateCrashesSkipped` counter lives in the TypeScript fuzz loop, not in the Rust `FuzzerStats` struct.

**Alternatives considered:**
- **Add to Rust FuzzerStats:** Would require passing dedup info across the NAPI boundary. The Rust engine has no knowledge of crash dedup.

**Rationale:** Dedup is entirely a TypeScript concern. The counter is printed by the reporter alongside existing stats. No NAPI changes needed.

## Risks / Trade-offs

**[Risk: Stack normalization merges distinct bugs]** Two genuinely different bugs at the same throw site with identical top-5 call chains would be merged. → **Mitigation:** This is rare. The user still gets one reproducer, and fixing that bug exposes the other on re-fuzz.

**[Risk: JIT/interpreter frame differences split same bug]** V8 may produce slightly different frame names depending on optimization tier. → **Mitigation:** Normalization strips line/column but preserves function names. JIT doesn't change function names, only line-level detail. Minor over-reporting (a few extra artifacts) is acceptable.

**[Risk: Map resets on process respawn]** If the child process dies and respawns, the dedup map is lost. → **Mitigation:** Respawns only happen for native signal crashes, which are fail-open anyway. JS crashes don't trigger respawns.

**[Trade-off: No cross-session dedup]** The dedup map is in-memory only and does not persist between fuzzing sessions. → **Accepted:** Persisting would add complexity (serialization, staleness). Users running a new session likely want fresh dedup state anyway.
