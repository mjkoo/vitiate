## Why

Vitiate has no mechanism to survive or capture native crashes (segfaults, SIGBUS, SIGABRT, etc.). A bug in a native addon kills the process immediately - no crash artifact is written, no coverage data is preserved, and the fuzzing campaign ends silently. This is the most critical robustness gap for production fuzzing: OSS-Fuzz compatibility and unattended CI campaigns both require crash survival with full metadata (signal/exception info, crashing input, timing).

## What Changes

- **Parent process supervisor**: The standalone CLI becomes a thin parent that allocates cross-process shared memory, spawns the fuzzing child via `child_process.spawn()` (not `fork()` - unsafe with V8's internal threads), and enters a platform-specific wait loop (`waitpid` on Unix, `WaitForSingleObject` on Windows). The child runs the full fuzz engine at in-process speed. The parent adds zero overhead to the hot loop and only intervenes on crash, timeout `_exit`, or campaign completion.
- **Shared memory input stash**: Before each target execution, the child copies the current input to a cross-process shared memory region so the parent can read it after process death. Layout: `{magic: u32, generation: u64, input_len: u32, input_buf: [u8; MAX]}`. Allocated via LibAFL's `StdShMemProvider` (cross-platform: `shmget`/`shmat` on Linux, `shm_open`/`mmap` on macOS, `CreateFileMapping`/`MapViewOfFile` on Windows).
- **Crash detection**: On Unix, the parent detects crashes via `waitpid(WIFSIGNALED)` and reads the signal number from `WTERMSIG(status)` - no child-side signal handlers are installed (preserves V8's Wasm trap handling, eliminates signal handler complexity). On Windows, the child installs a vectored exception handler (`AddVectoredExceptionHandler`) to record crash metadata before dying, since Windows does not expose the exception type to the parent via its wait APIs.
- **Child respawn**: On crash detection, the parent reads the crashing input from shmem, writes the crash artifact to disk, and respawns the child. The campaign continues automatically. The respawned child reloads corpus and resumes fuzzing.
- **Cross-platform from day one**: Unix and Windows use the same supervisor architecture with platform-specific implementations behind `cfg` gates. `spawn()` as the universal process creation mechanism eliminates the biggest platform divergence. No user-visible mode selection - the supervisor is always active.

## Capabilities

### New Capabilities
- `parent-supervisor`: Cross-platform parent process lifecycle - spawns fuzzing child, observes crashes via `waitpid(WIFSIGNALED)`/`WaitForSingleObject`, reads crashing input from shared memory, writes crash artifacts, respawns child to continue the campaign. On Windows, installs a vectored exception handler in the child for crash metadata capture.
- `shared-memory-stash`: Cross-process shared memory region for exchanging input data between the fuzzing child and the supervisor parent, allocated via LibAFL's `StdShMemProvider` with platform-specific backends

### Modified Capabilities
- `standalone-cli`: CLI entry point becomes the parent supervisor instead of directly starting Vitest; child process is spawned to run the fuzz engine
- `fuzz-loop`: Iteration cycle gains a cross-process shmem input stash step; loop must support running as a spawned child that attaches to parent-provided shared memory
- `watchdog`: Input pre-stash switches from the in-process `InputStash` to the cross-process shmem region; the watchdog reads from shmem before `_exit` instead of from the mutex-guarded buffer

## Impact

- **vitiate-napi** (Rust NAPI module): Uses LibAFL's existing `StdShMemProvider` (from `libafl_bolts`, already a dependency) for cross-platform shared memory - no new shmem dependencies needed. Windows-only SEH handler for crash metadata capture. New modules: shmem layout wrapper, NAPI exports for shmem lifecycle. The existing `input_stash.rs` (in-process `Mutex<Vec<u8>>`) is replaced by the cross-process shmem region, which serves both the watchdog thread (timeout artifact capture) and the parent process (crash artifact capture). No signal handler code on Unix - the parent observes crashes via `waitpid`.
- **vitiate** (TypeScript package): `cli.ts` restructured as parent supervisor with spawn/wait/respawn loop. `loop.ts` gains shmem attachment and per-iteration input stash write. New child-mode entry point for the spawned worker process. Environment variables for shmem handle passing between parent and child.
- **Platform scope**: Linux, macOS, and Windows. Platform differences are confined to LibAFL's `StdShMemProvider` backends (handled by LibAFL), Windows SEH handler (~50 lines of Rust behind `cfg(windows)`), and process observation syscalls (`waitpid` vs `WaitForSingleObject`). Process spawning uses Node.js `child_process.spawn()` on all platforms.
- **Performance**: Zero overhead added to the fuzz loop hot path beyond one `memcpy` per iteration to the shmem region (tens of nanoseconds for typical inputs). The supervisor's `waitpid`/`WaitForSingleObject` is a blocking call that consumes no CPU. Child spawn cost (~1-3s for Node.js + Vitest init) is paid once at campaign start and on crash respawn (a rare event).
