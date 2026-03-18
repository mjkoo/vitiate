## MODIFIED Requirements

### Requirement: Create fuzzer instance

Provide `Fuzzer` class constructable via `new Fuzzer(coverageMap, config?, watchdog?, shmemHandle?)`.

Required: coverage map `Buffer`.

Optional:
- `FuzzerConfig` object (all fields optional with defaults as specified below)
- `Watchdog` instance - the Fuzzer takes ownership; used for arming/disarming during `runBatch` iterations
- `ShmemHandle` instance - the Fuzzer takes ownership; used for stashing inputs during `runBatch` iterations and exposed via `stashInput()` pass-through

Config fields (all optional with defaults):
- `maxInputLen` (number, default 4096)
- `seed` (number, optional, negative reinterpreted as unsigned 64-bit)
- `dictionaryPath` (string, optional, absolute path to AFL/libfuzzer-format dictionary)
- `detectorTokens` (array of `Buffer`, optional, pre-seeded from bug detectors)
- `grimoire` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `unicode` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)
- `redqueen` (boolean, optional: true=force enable, false=force disable, absent=auto-detect)

On construction:
- Enable CmpLog accumulator for `traceCmp` calls
- Initialize `CmpValuesMetadata` on fuzzer state
- Include `I2SSpliceReplace` (wrapping `I2SRandReplace`) in mutation pipeline
- Initialize `SchedulerMetadata` with `PowerSchedule::fast()` using `CorpusPowerTestcaseScore`
- Initialize havoc mutator with `havoc_mutations()` merged with `tokens_mutations()`
- Initialize `TopRatedsMetadata` on fuzzer state
- Initialize: `stage_state` to `StageState::None`, `last_interesting_corpus_id` to `None`, `last_stage_input` to `None`
- Allocate pre-allocated input buffer of `maxInputLen` bytes for `runBatch` use
- Store owned `Watchdog` reference (if provided)
- Store owned `ShmemHandle` reference (if provided)

#### Scenario: Create with defaults
- **WHEN** `new Fuzzer(coverageMap)` is called with only a coverage map
- **THEN** fuzzer is created with default config, no watchdog, no shmem handle, and a pre-allocated input buffer of 4096 bytes

#### Scenario: Create with custom config
- **WHEN** `new Fuzzer(coverageMap, { maxInputLen: 8192, seed: 42 })` is called
- **THEN** fuzzer uses specified maxInputLen and seed, pre-allocated buffer is 8192 bytes

#### Scenario: Create with dictionary path
- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/path/to/dict" })` is called with a valid dictionary file
- **THEN** dictionary tokens are loaded and added to the `Tokens` metadata

#### Scenario: Create with nonexistent dictionary path
- **WHEN** `new Fuzzer(coverageMap, { dictionaryPath: "/nonexistent" })` is called
- **THEN** constructor throws an error

#### Scenario: Create with malformed dictionary
- **WHEN** a dictionary file contains unparseable entries
- **THEN** constructor throws an error

#### Scenario: Reproducible with same seed
- **WHEN** two fuzzers are created with identical seeds and identical initial conditions
- **THEN** `getNextInput()` produces the same sequence of mutations

#### Scenario: Create with defaults includes stage state
- **WHEN** `new Fuzzer(coverageMap)` is called
- **THEN** `stage_state` is `StageState::None`, `last_interesting_corpus_id` is `None`, `last_stage_input` is `None`

#### Scenario: Create with detector tokens
- **WHEN** `new Fuzzer(coverageMap, { detectorTokens: [buf1, buf2] })` is called
- **THEN** tokens are added to `Tokens` metadata as pre-promoted entries

#### Scenario: Detector tokens coexist with user dictionary
- **WHEN** both `dictionaryPath` and `detectorTokens` are provided
- **THEN** both sets of tokens are present in `Tokens` metadata

#### Scenario: Detector tokens exempt from CmpLog cap
- **WHEN** detector tokens are provided
- **THEN** they do not count against CmpLog token promotion threshold

#### Scenario: CmpLog does not re-promote detector tokens
- **WHEN** a CmpLog entry matches an already-promoted detector token
- **THEN** the token is not re-added to `Tokens` metadata

#### Scenario: Create with watchdog
- **WHEN** `new Fuzzer(coverageMap, config, watchdog)` is called with a Watchdog instance
- **THEN** the Fuzzer takes ownership of the Watchdog for use in `runBatch`

#### Scenario: Create with shmem handle
- **WHEN** `new Fuzzer(coverageMap, config, watchdog, shmemHandle)` is called with a ShmemHandle instance
- **THEN** the Fuzzer takes ownership of the ShmemHandle for stashing inputs

#### Scenario: Create without watchdog or shmem
- **WHEN** `new Fuzzer(coverageMap, config)` is called without watchdog or shmem
- **THEN** `runBatch` operates without watchdog arming/disarming and without shmem stashing

## ADDED Requirements

### Requirement: Input stashing via owned ShmemHandle

The `Fuzzer` SHALL expose a `stashInput(input: Buffer)` method that delegates to the owned `ShmemHandle`'s stash protocol. This allows JS-orchestrated paths (calibration, stages, minimization) to stash inputs when the `ShmemHandle` is owned by the Fuzzer.

If no `ShmemHandle` was provided at construction, `stashInput` SHALL be a no-op.

#### Scenario: stashInput delegates to owned handle
- **WHEN** `fuzzer.stashInput(input)` is called on a Fuzzer that owns a ShmemHandle
- **THEN** the input is written to shared memory using the seqlock protocol

#### Scenario: stashInput is no-op without handle
- **WHEN** `fuzzer.stashInput(input)` is called on a Fuzzer constructed without a ShmemHandle
- **THEN** the call returns without error and no shared memory write occurs

### Requirement: Target execution via owned Watchdog

The `Fuzzer` SHALL expose a `runTarget(target, input, timeoutMs)` method for JS-orchestrated paths (calibration, stages, minimization) to execute a target function with watchdog protection when the Watchdog is owned by the Fuzzer.

The method SHALL:
1. Arm the owned Watchdog with `timeoutMs`
2. Call the target function at the NAPI C level with V8 termination handling (same mechanism as `Watchdog.runTarget`)
3. Disarm the watchdog after the target returns or throws
4. Return an object with `{ exitKind: number, error?: Error, result?: unknown }`

If no Watchdog was provided at construction, `runTarget` SHALL call the target function directly (no timeout enforcement) and return the same result shape.

#### Scenario: runTarget delegates to owned watchdog
- **WHEN** `fuzzer.runTarget(target, input, 1000)` is called on a Fuzzer that owns a Watchdog
- **THEN** the Watchdog is armed with 1000ms, the target is called with V8 termination handling, and the Watchdog is disarmed after the call

#### Scenario: runTarget without watchdog calls target directly
- **WHEN** `fuzzer.runTarget(target, input, 1000)` is called on a Fuzzer constructed without a Watchdog
- **THEN** the target is called directly without timeout enforcement and the result is returned in the same shape

#### Scenario: runTarget handles watchdog timeout
- **WHEN** the target exceeds `timeoutMs` during `fuzzer.runTarget`
- **THEN** V8 terminates execution, the Watchdog is disarmed, and the method returns `{ exitKind: 2 }` (Timeout)

#### Scenario: runTarget handles target exception
- **WHEN** the target throws during `fuzzer.runTarget`
- **THEN** the Watchdog is disarmed and the method returns `{ exitKind: 1, error: <thrown error> }`

### Requirement: Watchdog arm/disarm pass-through

The `Fuzzer` SHALL expose `armWatchdog(timeoutMs: number)` and `disarmWatchdog()` methods for JS-orchestrated async target continuation. When the per-iteration fallback path detects an async target (Promise return from `runTarget`), JS needs to re-arm the watchdog before awaiting the Promise and disarm after.

If no Watchdog was provided at construction, both methods SHALL be no-ops.

#### Scenario: armWatchdog delegates to owned watchdog
- **WHEN** `fuzzer.armWatchdog(1000)` is called on a Fuzzer that owns a Watchdog
- **THEN** the Watchdog is armed with a 1000ms deadline

#### Scenario: disarmWatchdog delegates to owned watchdog
- **WHEN** `fuzzer.disarmWatchdog()` is called on a Fuzzer that owns a Watchdog
- **THEN** the Watchdog deadline is cleared

#### Scenario: arm/disarm are no-ops without watchdog
- **WHEN** `fuzzer.armWatchdog(1000)` or `fuzzer.disarmWatchdog()` is called on a Fuzzer without a Watchdog
- **THEN** the calls return without error

### Requirement: Fuzzer shutdown

The `Fuzzer` SHALL expose a `shutdown()` method that shuts down the owned Watchdog thread (if present). This SHALL be called from the fuzz loop's finally block, replacing the current `watchdog.shutdown()` call.

If no Watchdog was provided at construction, `shutdown` SHALL be a no-op.

The Watchdog's Rust `Drop` implementation also signals the thread to exit as a safety net, but explicit shutdown via this method is preferred for deterministic cleanup.

#### Scenario: shutdown terminates watchdog thread
- **WHEN** `fuzzer.shutdown()` is called on a Fuzzer that owns a Watchdog
- **THEN** the Watchdog background thread is signaled to exit and joined

#### Scenario: shutdown is no-op without watchdog
- **WHEN** `fuzzer.shutdown()` is called on a Fuzzer constructed without a Watchdog
- **THEN** the call returns without error
