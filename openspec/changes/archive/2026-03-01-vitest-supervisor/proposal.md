## Why

When running via Vitest (`fuzz("name", target)`), the supervisor process architecture is not active. Native crashes (SIGSEGV, SIGABRT, etc.) kill the entire Vitest process with no crash artifact saved and no respawn. Watchdog `_exit` timeouts also terminate the process with no recovery. The standalone CLI (`npx vitiate`) has full supervisor support — shmem input stashing, parent-side crash observation, artifact writing, and child respawn. Vitest integration mode needs parity so that `fuzz()` provides the same crash resilience as the CLI.

## What Changes

- In fuzzing mode without an active supervisor, the `fuzz()` test callback becomes the supervisor instead of entering the fuzz loop directly. It allocates shmem, spawns a child Vitest process filtered to run only the targeted fuzz test, and enters the shared supervisor wait loop. On child exit, it translates the exit code into a Vitest test pass/fail result.
- Each `fuzz()` call in a test file gets its own supervisor lifecycle — its own shmem allocation, its own child process, its own crash recovery. Multiple fuzz tests in the same file run sequentially, each independently supervised.
- The child Vitest process is spawned with filtering (e.g., `--test-name-pattern`) so that only the targeted fuzz test runs. All other tests in the file are skipped in the child, avoiding redundant work.
- The supervisor wait loop, crash handling, and shmem management logic currently in `cli.ts` are extracted into a shared module that both the CLI entry point and the `fuzz()` callback can use.
- The fuzz loop attaches to shmem and stashes inputs identically regardless of whether the supervisor was spawned by the CLI or by `fuzz()` — no behavioral difference in the child.

## Capabilities

### New Capabilities

_None — this change integrates existing capabilities into a new entry path._

### Modified Capabilities

- `test-fuzz-api`: In fuzzing mode, the `fuzz()` test callback SHALL detect the absence of a supervisor (`VITIATE_SUPERVISOR` not set) and become one — allocating shmem, spawning a supervised child Vitest process filtered to the targeted test, and awaiting its result. When `VITIATE_SUPERVISOR` is set, the callback enters the fuzz loop directly (existing behavior, unchanged).
- `parent-supervisor`: The supervisor wait loop, crash recovery, shmem management, and exit code protocol SHALL be extracted into a shared module reusable from both the CLI entry point and the `fuzz()` test callback. The protocol itself remains unchanged.
- `fuzz-loop`: The fuzz loop SHALL attach to shmem and stash inputs when running under any supervisor, regardless of whether the supervisor was spawned by the CLI or by `fuzz()`.

## Impact

- **`vitiate/src/fuzz.ts`**: Major changes — supervisor spawn logic in the test callback, child process management, result translation to Vitest pass/fail.
- **`vitiate/src/cli.ts`**: Refactor — extract supervisor wait loop, crash handling, and shmem management into a shared module (e.g., `supervisor.ts`).
- **`vitiate/src/loop.ts`**: Minor — shmem attachment becomes unconditional when under any supervisor (not just CLI).
- **`vitiate/src/plugin.ts`**: No changes expected — env var propagation already covers the supervisor case.
- **`vitiate-napi`**: No changes expected — shmem, watchdog, and exception handler APIs are already sufficient.
