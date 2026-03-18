## MODIFIED Requirements

### Requirement: Per-iteration input stash (seqlock protocol)

Before each fuzz iteration, copy input using odd/even seqlock:
1. Increment `generation` to odd value (write-in-progress) with release semantics
2. Write `input_len` and copy to `input_buf`
3. Increment `generation` to even value (write-complete) with release semantics

Readers reject odd generations (torn writes). Generation of 0 means no input ever stashed. `memcpy` only hot-path overhead - completes in tens of nanoseconds for typical inputs.

The stash operation MAY be invoked from either JavaScript (via `ShmemHandle.stashInput()` or `Fuzzer.stashInput()`) or from Rust internally (within `Fuzzer.runBatch()`). In all cases, the seqlock protocol is identical. When the `ShmemHandle` is owned by the `Fuzzer`, the `Fuzzer.stashInput()` method delegates to the same underlying stash implementation.

#### Scenario: Input stashed before execution
- **WHEN** a fuzz iteration begins (either via `runBatch` callback or the per-iteration path)
- **THEN** the current input is written to shared memory before the target is executed

#### Scenario: Input exceeding MAX_INPUT_LEN
- **WHEN** input length exceeds the shmem region's `MAX_INPUT_LEN`
- **THEN** only the first `MAX_INPUT_LEN` bytes are copied and `input_len` is set to `MAX_INPUT_LEN`

#### Scenario: Stash from Fuzzer.stashInput pass-through
- **WHEN** `fuzzer.stashInput(input)` is called (for calibration or stage stashing)
- **THEN** the input is written to the owned ShmemHandle using the same seqlock protocol
