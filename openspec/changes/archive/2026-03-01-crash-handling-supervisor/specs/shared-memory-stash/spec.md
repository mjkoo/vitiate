## ADDED Requirements

### Requirement: Shmem allocation and cross-process attachment

The system SHALL allocate a shared memory region using LibAFL's `StdShMemProvider` from `libafl_bolts`. The parent process SHALL allocate the region via `provider.new_shmem(size)` and pass the shmem identifier to the child via `shmem.write_to_env("VITIATE_SHMEM")`. The child process SHALL attach to the existing region via `provider.existing_from_env("VITIATE_SHMEM")`.

The shmem region SHALL be cleaned up automatically via LibAFL's `Drop` implementation when the parent process exits normally.

#### Scenario: Parent allocates shmem

- **WHEN** the parent supervisor starts
- **THEN** a shared memory region of `HEADER_SIZE + MAX_INPUT_LEN` bytes is allocated (HEADER_SIZE = 24 bytes)
- **AND** the shmem identifier is written to the `VITIATE_SHMEM` environment variable

#### Scenario: Child attaches to shmem

- **WHEN** the child process starts and `VITIATE_SHMEM` is set
- **THEN** the child attaches to the existing shmem region
- **AND** the child validates the magic field before proceeding

#### Scenario: Invalid magic field

- **WHEN** the child attaches to shmem and the magic field does not match `0x56495449`
- **THEN** the child exits with an error indicating a stale or wrong shmem region

### Requirement: Shmem layout

The shared memory region SHALL use a fixed-size layout with atomic fields for lock-free cross-process coordination:

| Offset | Field | Type | Writer | Reader |
|---|---|---|---|---|
| 0 | `magic` | `u32` | Parent (once) | Child (validates on attach) |
| 4 | (padding) | `[u8; 4]` | — | — |
| 8 | `generation` | `u64` (atomic) | Child (per iteration) | Parent (after child death), Watchdog (before `_exit`) |
| 16 | `input_len` | `u32` (atomic) | Child (per iteration) | Parent (after child death), Watchdog (before `_exit`) |
| 20 | (padding) | `[u8; 4]` | — | — |
| 24 | `input_buf` | `[u8; N]` | Child (per iteration) | Parent (after child death), Watchdog (before `_exit`) |

Total header size: 24 bytes (`HEADER_SIZE`). Total region size: `24 + MAX_INPUT_LEN` bytes (default MAX_INPUT_LEN = 4096, total = 4120 bytes). The padding after `magic` ensures `generation` is 8-byte aligned for correct atomic u64 access on all platforms. The trailing padding after `input_len` is inserted by `repr(C)` to maintain the struct's 8-byte alignment.

#### Scenario: Layout field alignment

- **WHEN** the shmem region is allocated
- **THEN** the `generation` field is at offset 8 and 8-byte aligned for atomic u64 access
- **AND** the `input_len` field is at offset 16 and 4-byte aligned for atomic u32 access
- **AND** the `input_buf` starts at offset 24 (HEADER_SIZE)

### Requirement: Per-iteration input stash (seqlock protocol)

Before each fuzz iteration, the fuzz loop SHALL copy the current input to the shmem region using an odd/even seqlock protocol:

1. Increment `generation` to an odd value (write-in-progress) with release semantics.
2. Write `input_len` and copy data to `input_buf`.
3. Increment `generation` to an even value (write-complete) with release semantics.

Readers reject odd generations as torn writes. A generation of 0 means no input was ever stashed.

The `memcpy` for `input_buf` SHALL be the only hot-path overhead added by the supervisor architecture. For typical inputs (< 4096 bytes), this SHALL complete in tens of nanoseconds.

#### Scenario: Input stashed before execution

- **WHEN** the fuzz loop calls `stashInput(input)` with a 100-byte input
- **THEN** `generation` is incremented to an odd value (write-in-progress)
- **AND** `input_len` is set to 100
- **AND** the first 100 bytes of `input_buf` are overwritten with the input
- **AND** `generation` is incremented to an even value (write-complete)

#### Scenario: Input exceeding MAX_INPUT_LEN

- **WHEN** the fuzz loop calls `stashInput(input)` with an input larger than `MAX_INPUT_LEN`
- **THEN** only the first `MAX_INPUT_LEN` bytes are copied to `input_buf`
- **AND** `input_len` is set to `MAX_INPUT_LEN`

### Requirement: Parent-side shmem read

After the child dies, the parent SHALL read the crashing input from the shmem region. The parent SHALL read `generation` with acquire semantics, then read `input_len` and `input_buf`. Since the parent only reads after `waitpid` returns (child is dead), there is no concurrent writer — the acquire/release semantics provide ordering guarantees against the child's last write.

The read SHALL return empty when:
- `generation == 0` (no input was ever stashed — fresh allocation or after `reset_generation()`)
- `generation` is odd (child died mid-write — torn data, not safe to read)

#### Scenario: Parent reads crashing input

- **WHEN** the child dies from a signal and the parent's `waitpid` returns
- **THEN** the parent reads `generation` from shmem with acquire semantics
- **AND** if generation is 0 or odd, returns empty (no artifact written)
- **AND** otherwise reads `input_len` bytes from `input_buf`
- **AND** the input matches what the child stashed before its last iteration

#### Scenario: Shmem survives child death

- **WHEN** the child process is killed by SIGSEGV
- **THEN** the shmem region remains mapped and readable by the parent
- **AND** the parent can read the last stashed input without error

### Requirement: Watchdog-side shmem read

The watchdog thread (running in the child process) SHALL read the current input from the shmem region before calling `_exit()` to write timeout artifacts. The watchdog SHALL use a generation-counter consistency check (seqlock protocol): read generation before and after copying the input, and verify they match.

The read SHALL return `None` (no artifact written) when:
- `generation == 0` (no input was ever stashed — prevents phantom timeout artifacts)
- `generation` is odd (write in progress — seqlock torn read)
- `generation` changed between the two reads (concurrent write detected)

The watchdog SHALL also skip writing the artifact when the read succeeds but the input is empty (zero-length genuine input — avoids writing 0-byte artifacts).

#### Scenario: Watchdog reads from shmem before _exit

- **WHEN** the watchdog's `_exit` deadline expires
- **THEN** the watchdog reads `generation`, `input_len`, and `input_buf` from the shmem region
- **AND** the watchdog verifies the generation counter is non-zero, even, and consistent
- **AND** if the input is non-empty, the watchdog writes the input to disk as a timeout artifact
- **AND** the watchdog calls `_exit(77)`

#### Scenario: Watchdog fires before first input stash

- **WHEN** the watchdog fires before the fuzz loop has called `stashInput()` (generation == 0)
- **THEN** the watchdog does not write a timeout artifact (no phantom artifact)
- **AND** the watchdog calls `_exit(77)`

### Requirement: Replaces InputStash

The shmem region SHALL replace the existing in-process `InputStash` (`Mutex<Vec<u8>>` with generation counter). The `InputStash` module SHALL be removed. All callers (fuzz loop for writing, watchdog for reading) SHALL use the shmem region instead.

#### Scenario: Single write target per iteration

- **WHEN** the fuzz loop stashes an input before target execution
- **THEN** the input is written to the shmem region only (not to a separate in-process buffer)
- **AND** both the watchdog thread and the parent process can read from this single location
