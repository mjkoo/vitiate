## 1. Stack Normalization Utility

- [x] 1.1 Create `normalizeStackForDedup(stack: string): string | undefined` function that parses V8 stack traces, strips line/column numbers, removes async prefixes, extracts top 5 `functionName@fileName` frames, and returns the joined string (or `undefined` if no frames parse)
- [x] 1.2 Write unit tests for stack normalization: standard frames, anonymous functions, async frames, >5 frames truncation, unparseable stacks, error message line exclusion, same-bug-different-lines produces identical output, method calls (`Type.method`), constructor calls (`new Constructor`), object anonymous (`Object.<anonymous>`), eval frames

## 2. Dedup Key Computation

- [x] 2.1 Create `computeDedupKey(exitKind: ExitKind, error: Error | undefined): string | undefined` that returns SHA-256 of normalized stack for Crash with valid stack, or `undefined` for timeouts / missing stacks
- [x] 2.2 Write unit tests for dedup key: crash with stack → hex string, crash without stack → undefined, timeout → undefined

## 3. Artifact Replacement

- [x] 3.1 Add `replaceArtifact(oldPath: string, newData: Buffer, kind: "crash" | "timeout"): string` to corpus.ts that writes to temp file, renames atomically, deletes old file if path differs, returns new path
- [x] 3.2 Write unit tests for `replaceArtifact`: replacement produces correct filename, old file deleted, atomic write (temp + rename), same-hash case

## 4. Fuzz Loop Dedup Integration

- [x] 4.1 Add `crashDedupMap: Map<string, { path: string, size: number }>` and `duplicateCrashesSkipped: number` counter to fuzz loop state
- [x] 4.2 Integrate dedup check into `recordCrash()`: compute dedup key, check map, suppress/replace/save based on policy, increment counter on suppression. When suppressed, do NOT increment crash counter or append to `crashArtifactPaths`. When replaced, update map but do NOT increment crash counter.
- [x] 4.3 Add `duplicateCrashesSkipped` field to `FuzzLoopResult` interface
- [x] 4.4 Write integration tests for dedup in the fuzz loop: first crash saved, duplicate suppressed (loop continues), smaller duplicate replaces (loop continues), unknown key always saves, suppressed crashes not counted toward `maxCrashes`

## 5. Observability

- [x] 5.1 Report `duplicateCrashesSkipped` in progress reporter output when counter > 0
