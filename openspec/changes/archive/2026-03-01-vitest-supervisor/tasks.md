## 1. Extract shared supervisor module

- [x] 1.1 Create `vitiate/src/supervisor.ts` with `SupervisorOptions`, `SupervisorResult` interfaces and `runSupervisor()` function, extracting the wait loop, exit code interpretation, shmem read, crash artifact write, respawn logic, and SIGINT forwarding from `cli.ts`
- [x] 1.2 Refactor `cli.ts` `runParentMode()` to call `runSupervisor()` with a CLI-specific `spawnChild` closure, removing the inlined wait loop and crash handling
- [x] 1.3 Verify CLI supervisor tests still pass after the refactor (no behavioral changes)

## 2. Add regex escaping dependency

- [x] 2.1 Add `escape-string-regexp` (or equivalent well-supported library) as a dependency in `vitiate/package.json`

## 3. Implement supervisor mode in `fuzz()` callback

- [x] 3.1 In `fuzz.ts` `registerFuzzTest()`, when `shouldEnterFuzzLoop()` returns true and `VITIATE_SUPERVISOR` is not set, enter parent mode: allocate shmem, resolve vitest CLI path, get test file path from `getCurrentTest()`, build escaped `--test-name-pattern`, and call `runSupervisor()` with a Vitest-specific `spawnChild` closure
- [x] 3.2 When `VITIATE_SUPERVISOR` is set, preserve existing behavior (enter fuzz loop directly)
- [x] 3.3 Translate `SupervisorResult` into Vitest test semantics: throw on `crashed === true` (with artifact path in error message), return normally on `crashed === false`

## 4. Tests

- [x] 4.1 Write unit tests for the shared `runSupervisor()` module: normal exit (code 0), JS crash exit (code 1), watchdog timeout exit (code 77), signal death, respawn limit, SIGINT forwarding
- [x] 4.2 Write tests for `fuzz()` supervisor mode detection: enters parent mode when `VITIATE_FUZZ=1` and `VITIATE_SUPERVISOR` is not set, enters child mode when both are set
- [x] 4.3 Write a test for regex escaping of test names with special characters (parentheses, brackets, etc.)

## 5. Lint and check

- [x] 5.1 Run full lint suite (eslint, prettier, tsc, clippy, cargo fmt, cargo deny) and fix any issues
