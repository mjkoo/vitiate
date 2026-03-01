## 1. Shmem Layout and Core Operations (vitiate-napi, Rust)

- [x] 1.1 Define `ShmemStash` struct with layout constants: magic offset (0, u32), generation offset (4, u64 atomic), input_len offset (12, u32 atomic), input_buf offset (16, `[u8; MAX_INPUT_LEN]`). Total size: `16 + MAX_INPUT_LEN`. Include the magic constant `0x56495449`.
- [x] 1.2 Implement parent-side allocation: call `StdShMemProvider::new_shmem(size)`, write magic field, call `shmem.write_to_env("VITIATE_SHMEM")`. Return the shmem handle.
- [x] 1.3 Implement child-side attachment: call `provider.existing_from_env("VITIATE_SHMEM")`, validate magic field matches `0x56495449`, return error on mismatch.
- [x] 1.4 Implement `stash_input(buf)`: write `input_len`, copy `input_buf`, then increment `generation` with atomic release semantics. Truncate inputs exceeding `MAX_INPUT_LEN`.
- [x] 1.5 Implement `read_stashed_input()`: read `generation` with acquire semantics, read `input_len`, copy `input_buf`. Return the input bytes.
- [x] 1.6 Write unit tests: layout size/alignment assertions, stash write then read returns same data, magic validation rejects wrong value, inputs exceeding MAX_INPUT_LEN are truncated.

## 2. Replace InputStash with Shmem (vitiate-napi, Rust)

- [x] 2.1 Modify `Watchdog` constructor to accept a shmem region pointer/reference instead of creating an `InputStash`. The watchdog reads from shmem for the `_exit` artifact write path.
- [x] 2.2 Update the watchdog `_exit` path: read input from shmem region using generation-counter consistency check (read generation before and after, verify match), write timeout artifact to disk, call `_exit(77)`.
- [x] 2.3 Remove `input_stash.rs` module and all `InputStash` references from the codebase.
- [x] 2.4 Update existing watchdog tests to use shmem region instead of InputStash.

## 3. NAPI Exports for Shmem (vitiate-napi, Rust)

- [x] 3.1 Export `allocateShmem(maxInputLen: number)` NAPI function: allocates shmem, writes magic, writes env var, returns a handle/external object.
- [x] 3.2 Export `attachShmem()` NAPI function: reads `VITIATE_SHMEM` env var, attaches to existing region, validates magic, returns handle.
- [x] 3.3 Export `stashInput(handle, input: Buffer)` NAPI function: calls the Rust `stash_input` on the shmem region.
- [x] 3.4 Export `readStashedInput(handle)` NAPI function: calls Rust `read_stashed_input`, returns a `Buffer` with the stashed input bytes.
- [x] 3.5 Add TypeScript type declarations for the new NAPI exports in the vitiate package.

## 4. Fuzz Loop Shmem Integration (vitiate, TypeScript)

- [x] 4.1 On child startup (when `VITIATE_SUPERVISOR` env var is present), call `attachShmem()` to get the shmem handle.
- [x] 4.2 In the fuzz loop iteration cycle, call `stashInput(handle, input)` after `getNextInput()` and before `runTarget()`.
- [x] 4.3 Pass the shmem handle to the `Watchdog` constructor so it can read from shmem on the `_exit` path.
- [x] 4.4 Write tests: verify `stashInput` is called before each target execution, verify shmem attachment on child startup.

## 5. Parent Supervisor (vitiate, TypeScript)

- [x] 5.1 Add mode detection at the top of `cli.ts` `main()`: check `process.env.VITIATE_SUPERVISOR`. If absent, enter parent mode. If present, enter child mode (existing behavior: parse args, start Vitest).
- [x] 5.2 Implement parent mode: call `allocateShmem()`, spawn `child_process.spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, VITIATE_SUPERVISOR: '1' } })`. Pipe child stdout/stderr to parent stdout/stderr.
- [x] 5.3 Implement wait loop with exit code protocol: on child exit, check exit code (0 → exit 0, 1 → exit 1, 77 → exit 1). On signal death (Unix: check `signal` property on child exit event), enter crash handling path.
- [x] 5.4 Implement crash artifact writing: on signal death, call `readStashedInput(handle)`, compute hash, write raw bytes to `testdata/fuzz/{testName}/crash-{hash}`, log signal type and artifact path to stderr.
- [x] 5.5 Implement child respawn: after writing crash artifact, spawn a new child with same args and env. Continue the wait loop.
- [x] 5.6 Implement SIGINT handling: on `process.on('SIGINT')`, forward SIGINT to child via `child.kill('SIGINT')`, wait for child exit, then exit parent.
- [x] 5.7 Write integration tests: normal campaign completion (exit 0), JS crash forwarding (exit 1), timeout forwarding (exit 77), native crash capture + artifact written + child respawned, SIGINT forwarding.

## 6. Windows Exception Handler (vitiate-napi, Rust)

- [x] 6.1 Implement `install_exception_handler(shmem_ptr)` behind `cfg(windows)`: call `AddVectoredExceptionHandler` for `EXCEPTION_ACCESS_VIOLATION`, `EXCEPTION_ILLEGAL_INSTRUCTION`, `EXCEPTION_STACK_OVERFLOW`, `EXCEPTION_INT_DIVIDE_BY_ZERO`.
- [x] 6.2 In the exception handler: map exception code to a signal-like number, write crash metadata (exception code) to a platform-specific shmem field, write crash artifact to disk, return `EXCEPTION_CONTINUE_SEARCH`.
- [x] 6.3 Export `installExceptionHandler(handle)` NAPI function (Windows-only, no-op on Unix).
- [x] 6.4 Call `installExceptionHandler` from the child process startup path on Windows.
