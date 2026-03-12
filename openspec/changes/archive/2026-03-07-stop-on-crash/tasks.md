## 1. Configuration Schema

- [x] 1.1 Add `stopOnCrash` field to `FuzzOptionsSchema` in `config.ts` - tri-state union: `v.optional(v.union([v.boolean(), v.literal("auto")]))`
- [x] 1.2 Add `maxCrashes` field to `FuzzOptionsSchema` in `config.ts` - `v.optional(NonNegativeInteger)`, default applied at usage site (1000)
- [x] 1.3 Add `forkExplicit` field to `CliIpcSchema` in `config.ts` - `v.optional(v.boolean())`
- [x] 1.4 Write unit tests for new config fields: valid values, invalid values, defaults, JSON round-trip via `VITIATE_FUZZ_OPTIONS`

## 2. Auto-Resolution Logic

- [x] 2.1 Create `resolveStopOnCrash` helper function that takes `(stopOnCrash: boolean | "auto" | undefined, libfuzzerCompat: boolean, forkExplicit: boolean | undefined)` and returns resolved `boolean`
- [x] 2.2 Write unit tests for `resolveStopOnCrash`: auto in vitest mode → false, auto in CLI with fork → false, auto in CLI without fork → true, explicit true/false passthrough
- [x] 2.3 Wire resolution into `registerFuzzTest` in `fuzz.ts` (vitest child mode only)
- [x] 2.4 Wire resolution into CLI child mode in `cli.ts`

## 3. CLI IPC Plumbing

- [x] 3.1 Set `forkExplicit: true` in `CliIpc` blob in `cli.ts` `runChildMode` when `parsed.fork !== undefined`
- [x] 3.2 Forward `stopOnCrash` and `maxCrashes` from CLI `fuzzOptions` through `VITIATE_FUZZ_OPTIONS` (already happens via existing plumbing - verify)
- [x] 3.3 Write tests for `forkExplicit` presence/absence in `CliIpc` based on `-fork` flag

## 4. Fuzz Loop Multi-Crash Support

- [x] 4.1 Update `FuzzLoopResult` type: add `crashCount: number`, `crashArtifactPaths: string[]`
- [x] 4.2 Add `stopOnCrash` and `maxCrashes` parameters to `runFuzzLoop` (via options or direct params)
- [x] 4.3 Modify the `IterationResult.Solution` branch in the main iteration loop: when `stopOnCrash` is false, record crash and continue instead of breaking
- [x] 4.4 Modify stage crash/timeout handling: when `stopOnCrash` is false, record crash and continue instead of returning
- [x] 4.5 Add `maxCrashes` enforcement: check crash counter after each crash, warn and break when limit reached
- [x] 4.6 Ensure SIGINT termination preserves accumulated crash state (crashCount, crashArtifactPaths reflect all crashes found before signal)
- [x] 4.7 Update all `FuzzLoopResult` construction sites to include new fields
- [x] 4.8 Write unit/integration tests: loop continues after crash when stopOnCrash=false, loop stops on crash when stopOnCrash=true, maxCrashes limit triggers warning and termination, stage crash continues when stopOnCrash=false, SIGINT with accumulated crashes

## 5. Vitest Reporting

- [x] 5.1 Update child-mode crash reporting in `fuzz.ts`: use `crashCount` and `crashArtifactPaths` from `FuzzLoopResult` to construct error message
- [x] 5.2 Verify `translateSupervisorResult` needs no changes (SupervisorResult is unchanged - crash count is only available in child mode via FuzzLoopResult)
- [x] 5.3 Write tests: single crash error message, multi-crash error message with count, no-crash passes

## 6. Integration Testing

- [x] 6.1 Verify full pipeline: vitest fuzz mode with stopOnCrash=false finds multiple crashes in a single campaign
- [x] 6.2 Verify full pipeline: vitest fuzz mode with stopOnCrash=true stops on first crash (existing behavior preserved)
- [x] 6.3 Run full test suite and fix any regressions from FuzzLoopResult type changes
