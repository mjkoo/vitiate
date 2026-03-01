## Context

Vitiate currently handles two categories of fuzz-target failure:

1. **JS exceptions**: Caught by the fuzz loop's try/catch, classified as `ExitKind.Crash`, artifact written to disk, campaign terminates normally.
2. **Timeouts**: Handled by the watchdog thread — V8 `TerminateExecution` (Unix) or `_exit` fallback (all platforms). Artifacts captured before `_exit` via the in-process `InputStash`.

Neither mechanism survives a **native crash** (SIGSEGV, SIGBUS, SIGABRT, etc.) in a way that preserves the crashing input and allows the campaign to continue. A segfault in a native addon kills the process instantly. The existing `InputStash` is in-process memory and dies with the process. The watchdog's `_exit`-path artifact writing is signal-handler-safe, but it only fires on timeout — it has no hook for crash signals.

The standalone CLI (`cli.ts`) currently runs Vitest directly in a single process. There is no supervisor.

## Goals / Non-Goals

**Goals:**

- Survive native crashes: capture the crashing input, the signal/exception type, and write a crash artifact, even when the dying process's signal handler fails.
- Continue the campaign after a native crash by respawning the child process.
- Provide identical crash-handling behavior on Linux, macOS, and Windows with one architecture and no user-visible mode selection.
- Add zero overhead to the fuzz loop hot path beyond a single `memcpy` per iteration.

**Non-Goals:**

- Changing the campaign lifecycle for JS-level crashes or timeouts. The child handles these internally as it does today; the supervisor forwards the exit code.
- Vitest integration mode (`vitest --fuzz`). The supervisor is implemented for the standalone CLI first. Integration mode is a follow-up change.
- Multi-process parallelism (`-fork=N`). The supervisor spawns one child. Parallel workers are a separate concern.
- Cooperative instrumentation timeout (SWC plugin inserts periodic flag checks). This is a timeout enhancement, not crash handling.
- Coverage-guided fuzzing of native addon code. The SWC instrumentation covers JavaScript/TypeScript only; native modules are exercised but not instrumented for coverage feedback. This is a potential future investigation but orthogonal to crash handling.

## Decisions

### Decision 1: `spawn()` on all platforms, not `fork()`

**Choice**: Use `child_process.spawn()` (or equivalent) to create the child process on every platform.

**Why not `fork()`**: By the time any JavaScript executes, Node.js has already started V8's internal threads (GC, JIT compiler, platform workers) and libuv's threadpool. POSIX `fork()` in a multithreaded process copies only the calling thread — mutexes held by other threads become permanently locked in the child. This is a well-documented class of deadlock bugs. macOS has partially deprecated `fork()` for this reason. Using `fork()` from a running Node.js process is unsafe.

**Why `spawn()` everywhere**: Go's `go test -fuzz` uses the same approach — the coordinator spawns a fresh worker process via `exec.Command`. The worker initializes from scratch, runs many iterations at full in-process speed, and the coordinator only intervenes on crash or completion. The per-iteration cost within the worker is identical to in-process fuzzing. The spawn cost (~1–3s for Node.js + Vitest init) is paid once at campaign start and again on crash respawn (a rare event).

**What this eliminates**: The biggest platform divergence. `fork()` is Unix-only; `spawn()` works identically everywhere. One codepath, one architecture.

**Alternatives considered**:
- `fork()` on Unix, `spawn()` on Windows: Two codepaths, fork+threads safety risk, COW benefit only helps startup (not the hot loop).
- `fork()` before V8 starts: Not possible — V8 threads start during Node.js bootstrap, before any user JS runs.

### Decision 2: LibAFL's `ShMemProvider` for cross-process shared memory

**Choice**: Use LibAFL's `StdShMemProvider` (from `libafl_bolts`) for shared memory allocation and cross-process attachment. The parent calls `provider.new_shmem(size)` and `shmem.write_to_env("VITIATE_SHMEM")`. The child calls `provider.existing_from_env("VITIATE_SHMEM")` to attach.

**Why LibAFL's shmem**: `vitiate-napi` already depends on `libafl_bolts`. LibAFL's `ShMemProvider` trait provides a battle-tested, cross-platform shared memory abstraction purpose-built for fuzzer IPC:

- `StdShMemProvider` auto-selects the right backend per platform: `shmget`/`shmat` on Linux, `shm_open`/`mmap` on macOS, `CreateFileMappingA`/`MapViewOfFile` on Windows.
- `ShMemId`: 20-byte serializable identifier for cross-process mapping.
- Built-in env var protocol: `write_to_env()` / `existing_from_env()` handles the parent→child ID passing.
- `DerefMut<Target = [u8]>` — the shmem region acts as a mutable byte slice, zero-copy.
- RAII cleanup via `Drop` on all platforms.

This eliminates the need for `memmap2`, `nix`, or `windows-sys` as new dependencies for shmem. We stay within the LibAFL ecosystem.

**Alternatives considered**:
- `memmap2` crate: Would work, but adds a dependency when LibAFL already provides the same capability. Also requires us to manage temp files, cleanup, and platform-specific handle passing ourselves.
- Raw `shm_open`/`mmap` + `CreateFileMapping`: Platform-specific code we'd have to write and maintain. LibAFL already did this.
- `SharedArrayBuffer` via `worker_threads`: Workers share a process — a segfault kills everything. Zero crash isolation.
- Pipes/sockets for input passing: Per-iteration IPC overhead. The whole point of shmem is zero-copy: a single `memcpy` into the mapped region, no syscalls.

### Decision 3: Single entry point with mode detection

**Choice**: `cli.ts` detects whether it's the parent or child via an environment variable (`VITIATE_SUPERVISOR`). On first invocation (no env var), it acts as the parent: allocates shmem, spawns itself as the child with the env var set, and enters the wait loop. When the env var is present, it acts as the child: attaches to shmem and runs the fuzz loop.

**Why single entry point**: Avoids a separate `worker.ts` file and a second `bin` entry. The mode switch is a single `if` at the top of `main()`. The child invocation is `child_process.spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, VITIATE_SUPERVISOR: shmemPath } })` — it re-runs the same CLI with the same arguments, which naturally parses the same flags and test file.

**Alternatives considered**:
- Separate `worker.ts` entry point: More files, a second bin entry, duplication of CLI parsing logic.
- IPC channel (`child_process.fork` with Node IPC): Adds message-passing complexity. The child doesn't need to send data to the parent — shmem handles input stashing, and exit codes + signals communicate status.

### Decision 4: Parent-only crash observation (no child signal handlers on Unix)

**Choice**: The parent process is the sole crash observer on Unix. No signal handlers are installed in the child. When the child dies from a signal, the parent detects it via `waitpid(WIFSIGNALED)`, reads the signal number from `WTERMSIG(status)`, reads the crashing input from the shmem stash, and writes the crash artifact to disk.

On Windows, the child installs a vectored exception handler (see Decision 6) because Windows does not provide an equivalent of `WTERMSIG` — the parent needs the child to record crash metadata before dying.

**Why parent-only on Unix**: The parent runs in a separate, uncompromised process. It is ~100% reliable — it doesn't suffer from the ~5% failure rate of in-process signal handlers (stack smash, heap corruption, double fault). The signal number is available from `waitpid` without any child-side cooperation. The crashing input is already in the shmem stash from the pre-iteration write. There is nothing the child signal handler can provide that the parent doesn't already have.

Putting all fatal signals on the same codepath (parent observation) eliminates an entire category of complexity: no signal handler installation, no async-signal-safe constraints, no V8 signal chaining concerns, no platform-specific handler code on Unix. One codepath for SIGSEGV, SIGBUS, SIGABRT, SIGILL, SIGFPE.

**Alternatives considered**:
- Two-layer belt-and-suspenders (child signal handlers + parent backup): Adds child-side signal handler code (~200 lines of Rust) for marginal benefit. Signal handlers run in a compromised process and fail ~5% of the time. The parent already catches 100% of cases. The added complexity is not justified.
- Child signal handlers for non-V8 signals only (SIGABRT, SIGILL, SIGFPE): Reduces V8 conflict risk but still adds signal handler code for no reliability gain. If parent observation is correct for SIGSEGV/SIGBUS (the harder case with V8 interaction), it is certainly correct for the simpler signals. Keeping all signals on the same codepath is preferable.

### Decision 5: Exit code protocol for parent-child communication

**Choice**: The parent interprets the child's exit status to determine what happened:

| Child exit status | Meaning | Parent action |
|---|---|---|
| Code 0 | Campaign complete (no crash found, or limits reached) | Exit 0 |
| Code 1 | JS crash found, artifact written by child | Exit 1 |
| Code 77 | Watchdog `_exit` (timeout), artifact written by watchdog | Read shmem (backup recovery), reset generation, respawn |
| Killed by signal (Unix) / exception exit code (Windows) | Native crash | Read shmem, write artifact if needed, reset generation, respawn |

**Why respawn on native crash and timeout**: Native crashes and watchdog timeouts are both failure modes where the campaign should continue. A campaign hitting repeated timeouts on different inputs should keep exploring, just as one hitting repeated crashes should. JS crashes (code 1) are the stop-on-first-solution case — the child writes the artifact and exits cleanly. Respawning on code 77 treats timeouts consistently with signal-death, subject to the same `MAX_RESPAWNS` limit.

**Why code 77 for watchdog**: The watchdog already uses exit code 77 (`_exit(77)`) as its hard-termination signal. The parent attempts backup recovery from shmem (the watchdog may have already written an artifact before `_exit`), resets the shmem generation counter, and respawns.

### Decision 6: No child signal handlers on Unix; SEH on Windows only

**Choice**: On Unix, do not install any signal handlers in the child process. The parent observes all crash signals via `waitpid`. On Windows, install a vectored exception handler in the child because Windows does not expose the exception type to the parent process via its wait APIs.

#### Unix: No signal handlers — V8 signal ownership preserved

Node.js installs a SIGSEGV handler (`TrapWebAssemblyOrContinue`) at startup for V8's WebAssembly trap handling. When Wasm code hits an out-of-bounds memory access, V8 uses guard pages that generate SIGSEGV (Linux) or SIGBUS (macOS). Node.js's handler calls `v8::TryHandleWebAssemblyTrapPosix()` — if the fault is a recognized Wasm OOB access, V8 modifies the `ucontext` instruction pointer to a landing pad and the handler returns, resuming execution at the landing pad (converting the signal into a catchable JS exception).

If V8 can't handle the signal (real segfault), Node.js's handler calls its saved previous handler or resets to `SIG_DFL` and raises. The process terminates. Importantly, control does **not** return to any handler installed after Node.js — there is no opportunity to chain back. This rules out a "chain-first" strategy where we defer to V8 and only act if V8 doesn't handle the signal.

A "write-first-then-chain" strategy (write crash artifact, then chain to V8) would produce false positive crash artifacts for every Wasm trap — polluting the crash corpus with inputs that are not real crashes. Since Wasm OOB traps can be frequent during fuzzing of Wasm-using targets, this is unacceptable.

By not installing any signal handlers, we:
- Preserve V8's Wasm trap handling exactly as Node.js intended
- Eliminate all signal handler complexity (no registration, no chaining, no async-signal-safe constraints)
- Put all fatal signals on one codepath (parent observation via `waitpid`)
- Produce zero false positive crash artifacts

The parent gets everything it needs from the OS: `WIFSIGNALED(status)` detects signal death, `WTERMSIG(status)` provides the signal number, and the crashing input is already in the shmem stash from the fuzz loop's pre-iteration write.

#### Windows: Structured Exception Handling

Windows does not provide an equivalent of `WTERMSIG` — the parent cannot determine the exception type from the child's exit code alone (Windows uses `NTSTATUS` codes like `0xC0000005` which encode some information but not reliably across all crash types). The child installs a vectored exception handler via `AddVectoredExceptionHandler` for `EXCEPTION_ACCESS_VIOLATION`, `EXCEPTION_ILLEGAL_INSTRUCTION`, `EXCEPTION_STACK_OVERFLOW`, etc. The handler writes crash metadata (exception code, artifact) to shmem/disk and returns `EXCEPTION_CONTINUE_SEARCH` to let any remaining handlers (including V8's) run. V8's SEH usage on Windows composes naturally with vectored exception handlers — no chaining conflict.

#### Why not LibAFL's `exceptional` crate

LibAFL provides signal handler registration (`SignalHandler` trait, `setup_signal_handler()`). This is not needed on Unix (we don't install signal handlers). On Windows, we use the Win32 SEH API directly. Additionally, `exceptional`'s `setup_signal_handler()` calls `sigaction(sig, &sa, ptr::null_mut())` — the `null_mut()` third argument discards the previous handler without saving it, which would break V8's Wasm trap handling if we ever needed Unix signal handlers in the future.

#### Why not LibAFL's forkserver protocol

LibAFL's `Forkserver` provides the AFL++ forkserver protocol: bidirectional pipes, feature negotiation, and per-iteration `fork()` within the target for crash isolation. The core value is the per-iteration `fork()` — each fuzz iteration runs in a short-lived forked child, so crashes kill only that child and the forkserver immediately forks again with no re-initialization cost.

This doesn't help us because Node.js cannot safely `fork()` (V8's internal threads create deadlock risk). Without the per-iteration fork, the protocol reduces to a parent-child pair communicating over pipes — strictly more complex than our spawn + `waitpid` + shmem model with no additional benefit.

### Decision 7: Shmem layout and access patterns

**Choice**: Fixed-size layout with atomic fields for lock-free cross-process coordination:

```
offset  field        type            writer              reader
0       magic        u32             parent (once)       child (validates)
4       (padding)    [u8; 4]         -                   -
8       generation   u64 (atomic)    child (per iter)    parent, watchdog
16      input_len    u32 (atomic)    child (per iter)    parent, watchdog
20      (padding)    [u8; 4]         -                   -
24      input_buf    [u8; N]         child (per iter)    parent, watchdog
```

Total size: 24 + MAX_INPUT_LEN (default 4096) = 4120 bytes. The padding after `magic` ensures `generation` is 8-byte aligned for correct atomic u64 access on all platforms.

The child uses an odd/even seqlock protocol: increment `generation` to odd (write-in-progress), write data, increment to even (write-complete). Readers reject odd generations as torn writes. A generation of 0 means no input was ever stashed.

The parent reads all fields only after the child dies (no concurrent access with the live child on these reads). The parent returns empty on gen==0 (never stashed) or odd gen (child died mid-write). The signal number is obtained from `WTERMSIG(status)` via `waitpid` on Unix, not from shmem. On Windows, the child's vectored exception handler writes crash metadata to shmem before the process terminates (see Decision 6).

The `magic` field (e.g., `0x56495449` = "VITI") is a sanity check: the child validates it on attach to catch stale or wrong shmem files.

**Replaces `InputStash`**: The existing `InputStash` (in-process `Mutex<Vec<u8>>` with generation counter) is replaced by the shmem region. `InputStash` cannot be shared across process boundaries, and keeping both would require the fuzz loop to write the input to two places per iteration. The shmem region serves both readers: the watchdog thread (same process, reads before `_exit` to write timeout artifacts) and the parent process (reads after child death to write crash artifacts). One write per iteration, two readers at different times. The watchdog's `stash_input()` call becomes a write to the shmem region instead of to the in-process `InputStash`.

## Risks / Trade-offs

**[Spawn cost on crash respawn]** → The child must do full Node.js + Vitest initialization on respawn (~1–3s). This is acceptable because native crashes are rare events, and correct crash capture is more important than respawn speed. Go's `go test -fuzz` pays the same cost.

**[Shmem cleanup on abnormal parent exit]** → If the parent is killed (e.g., `kill -9`), the shmem region may not be cleaned up (platform-dependent: System V segments persist until `IPC_RMID`, POSIX shm until `shm_unlink`, Windows named mappings until all handles close). LibAFL's `Drop` impls handle normal cleanup. For abnormal parent death, stale shmem is small (< 8KB) and platform garbage collection eventually reclaims it. On Linux, `ipcs`/`ipcrm` can clean up manually if needed.

**[Windows exit code mapping]** → Windows encodes exception types in exit codes differently from Unix signals. The parent must map Windows exception codes (e.g., `0xC0000005` for access violation) to signal-like values for consistent crash artifact metadata. This mapping is lossy but sufficient for crash triage.

**[No Vitest integration mode in MVP]** → The standalone CLI gets the supervisor first. Vitest integration mode (`vitest --fuzz`) continues to run in-process without crash isolation. This is acceptable because the standalone CLI is the primary mode for CI/OSS-Fuzz, where crash robustness matters most. Integration mode follow-up can reuse the same supervisor logic.
