## Context

Vitiate has two entry points for fuzzing: the standalone CLI (`npx vitiate ./test.ts`) and Vitest integration (`fuzz("name", target)` inside test files). The CLI wraps every fuzz campaign in a parent-child supervisor process — the parent allocates shmem, spawns itself as a child, and enters a wait loop that observes crashes, writes artifacts, and respawns. Vitest integration has no supervisor; native crashes kill the process silently.

The supervisor logic lives entirely in `cli.ts` (`runParentMode`, `waitForChild`, `handleCrashAndCheckLimit`). It is tightly coupled to the CLI's argument parsing and process spawning model (re-executes itself with `process.argv`). The `fuzz()` function in `fuzz.ts` calls `runFuzzLoop()` directly — no supervisor involvement.

The fuzz loop (`loop.ts`) already supports both modes: it conditionally attaches to shmem when `VITIATE_SUPERVISOR` is set and stashes inputs before each iteration. The napi layer (shmem, watchdog, exception handler) is mode-agnostic.

## Goals / Non-Goals

**Goals:**

- Fuzz tests run via Vitest (`fuzz("name", target)`) get the same crash resilience as the standalone CLI: shmem input stashing, parent-side crash observation, artifact writing, and child respawn.
- Multiple `fuzz()` calls in a single test file work correctly — each gets its own supervised child, running sequentially.
- The supervisor logic is shared between CLI and Vitest entry points — no duplication.
- Users do not need to change how they invoke Vitest. `VITIATE_FUZZ=1 vitest` works as before, now with crash protection.

**Non-Goals:**

- Parallel fuzzing of multiple targets (each `fuzz()` call is sequential within a file; cross-file parallelism is Vitest's concern).
- Optimizing child startup time (full Vitest startup per fuzz test is acceptable for long-running campaigns).
- Cooperative instrumentation timeout (Tier 1) — orthogonal to supervisor integration.
- Changes to the napi layer — shmem, watchdog, and exception handler APIs are already sufficient.

## Decisions

### Decision 1: `fuzz()` callback as the supervisor entry point

The `fuzz()` test callback — the `async () => { ... }` registered with `test()` — detects whether it is running under a supervisor and either enters the fuzz loop directly (child mode) or becomes a supervisor (parent mode).

**Why not the plugin?** A Vite plugin's hooks (`config()`, `transform()`, `configureVitest()`) return configuration objects. They cannot replace the process with a supervisor loop. The plugin runs inside Vitest — it can't wrap Vitest from the inside.

**Why not a wrapper binary?** Requiring users to switch from `vitest` to `vitiate-vitest` changes the invocation model. The whole point of Vitest integration is that `fuzz()` tests run alongside regular tests with `vitest`.

**Why the test callback works:** The callback is async and already has a max-int timeout (`2_147_483_647`). It can spawn a child process, await its exit, and return pass/fail — just like any long-running async test. Vitest treats it as a normal test that happens to take a while.

### Decision 2: One supervised child per `fuzz()` call

Each `fuzz()` invocation in fuzzing mode spawns its own child process with its own shmem allocation. Multiple fuzz tests in the same file run sequentially (Vitest runs tests within a file sequentially). Each child is independent — its own shmem, its own respawn lifecycle, its own crash artifacts.

**Alternative considered:** A single supervisor wrapping all fuzz tests in the file. This would require the supervisor to understand which test was active when a crash occurred, multiplex shmem between tests, and coordinate respawn across test boundaries. Far more complex for no throughput benefit — fuzz campaigns are long-running, so per-test child startup cost is negligible.

### Decision 3: Spawning the child Vitest process

The parent (inside the `fuzz()` callback) spawns a child that re-runs the same test file under Vitest, filtered to execute only the targeted fuzz test. The child command is:

```
node <vitest-cli-path> run <testFilePath> --test-name-pattern <escapedTestName>
```

- **`process.execPath`** for the Node binary (same version, same flags).
- **Vitest CLI path** resolved via `import.meta.resolve('vitest/cli')` or `createRequire(import.meta.url).resolve('vitest/cli')`. This resolves the same vitest binary the parent is running under.
- **`run`** mode so Vitest executes once and exits (no watch mode).
- **`--test-name-pattern "^<escaped>$"`** filters at the Vitest runner level so only the targeted test runs. All other tests (fuzz and non-fuzz) are skipped entirely — their callbacks never execute.
- **Test file path** from `getCurrentTest()?.file?.filepath` — available inside the test callback.

The child's environment inherits the parent's env vars plus:
- `VITIATE_SUPERVISOR=1` — signals the child's `fuzz()` to enter the fuzz loop directly.
- `VITIATE_FUZZ=1` — activates fuzzing mode (may already be set from the parent).
- All existing env vars (`VITIATE_FUZZ_OPTIONS`, `VITIATE_CACHE_DIR`, `VITIATE_PROJECT_ROOT`) propagate naturally via inheritance.

The child picks up the same `vitest.config.ts` from the working directory, loads the same vitiate plugin, applies the same SWC transforms. No extra configuration needed.

**Alternative considered:** Using `startVitest()` from `vitest/node` (programmatic API) instead of spawning the CLI. This is what `cli.ts` does in child mode. However, `startVitest()` runs Vitest in-process — we need a separate process for crash isolation. The CLI spawn approach gives us the process boundary.

### Decision 4: Test name filtering and regex escaping

Test names passed to `fuzz("name", target)` can contain regex special characters (e.g., `"parse (JSON)"`, `"handle [brackets]"`). The `--test-name-pattern` flag interprets its argument as a regex.

The parent escapes the test name using a well-supported library (e.g., `escape-string-regexp` from sindresorhus, or the `escapeRegExp` from a utility library already in the dependency tree), then wraps in `^...$` anchors for exact matching. We explicitly do not implement our own regex escaping — this is a solved problem with known edge cases that library authors have already handled.

### Decision 5: Extracting the shared supervisor module

The supervisor wait loop, crash handling, shmem management, and exit code protocol are extracted from `cli.ts` into a new `supervisor.ts` module. Both `cli.ts` and `fuzz.ts` import from it.

The shared module exports a function with this shape:

```typescript
interface SupervisorOptions {
  shmem: ShmemHandle;
  testDir: string;
  testName: string;
  spawnChild: () => ChildProcess;
  maxRespawns?: number;
}

interface SupervisorResult {
  crashed: boolean;
  crashArtifactPath?: string;
  signal?: string;
  exitCode?: number;
}

function runSupervisor(options: SupervisorOptions): Promise<SupervisorResult>;
```

The caller provides a `spawnChild` function — this is where CLI and Vitest diverge:
- CLI: `spawn(process.execPath, process.argv.slice(1), { env: { VITIATE_SUPERVISOR: "1" } })`
- Vitest: `spawn(process.execPath, [vitestCliPath, "run", testFile, "--test-name-pattern", pattern], { env: { VITIATE_SUPERVISOR: "1", VITIATE_FUZZ: "1" } })`

Everything else (wait loop, exit code interpretation, shmem read, artifact write, respawn logic, SIGINT forwarding) is shared.

### Decision 6: Result communication from child to parent

The exit code protocol is unchanged from the CLI supervisor:

| Child exit | Meaning | Parent action in `fuzz()` |
|---|---|---|
| Code 0 | Campaign complete | Return — Vitest test passes |
| Code 1 | JS crash found, artifact written by child | Throw error — Vitest test fails |
| Code 77 | Watchdog timeout | Read shmem, write artifact, respawn or throw |
| Signal death | Native crash | Read shmem, write artifact, respawn or throw |

For exit code 1, the child's fuzz loop already wrote the crash artifact to `testdata/fuzz/<testName>/`. The parent throws with the artifact directory path. For signal death and code 77, the parent writes the artifact from shmem (same as CLI).

The `fuzz()` callback translates the `SupervisorResult` into Vitest test semantics: `crashed === true` → throw an error (test fails), `crashed === false` → return normally (test passes).

### Decision 7: Artifact path consistency between CLI and Vitest modes

In CLI mode, the parent supervisor derives the test name from the file basename (e.g., `parser.fuzz.ts` → `"parser.fuzz"`). In Vitest mode, the test name comes from the `fuzz()` call (e.g., `fuzz("parser", target)` → `"parser"`). After `sanitizeTestName()`, these produce different directory names: `testdata/fuzz/parser.fuzz/` vs `testdata/fuzz/parser/`.

This means crash artifacts and corpus entries are **not shared** between CLI and Vitest modes for the same fuzz target. A crash found via `npx vitiate ./parser.fuzz.ts` is not replayed in Vitest regression mode, and vice versa.

This is a **pre-existing issue** — the CLI has always used file-basename naming while Vitest uses the `fuzz()` name argument. This change does not make it worse (the Vitest supervisor uses the same test name as the fuzz loop, so Vitest-mode artifacts are internally consistent). Fixing the CLI's test name derivation is out of scope — it would require the CLI parent to know the `fuzz()` call's name before the child runs, which is not possible without parsing the test file or running the child first.

## Risks / Trade-offs

**Child startup latency** — Each fuzz test spawns a full Vitest process (~1-3s startup). For a file with N fuzz tests, that's N sequential Vitest startups. Acceptable for long campaigns but noticeable for short `--runs=1000` smoke tests.
→ Mitigation: This is inherent to the subprocess model and matches Go's `go test -fuzz` behavior. The alternative (no supervisor) provides no crash protection. Users who want faster smoke tests can run in regression mode (no supervisor needed).

**Test name escaping edge cases** — Exotic test names with Unicode, newlines, or shell metacharacters could break regex escaping or process spawning.
→ Mitigation: Standard regex escaping handles all ASCII metacharacters. Shell injection is not a risk because `spawn()` uses argv arrays, not shell strings. Unicode passes through unmodified. Newlines in test names are pathological and unsupported by Vitest itself.

**Vitest config divergence** — The child picks up `vitest.config.ts` from the working directory. If the parent was invoked with CLI flags that override config (e.g., `--config other.config.ts`), the child won't inherit those.
→ Mitigation: `process.argv` is not directly usable (it belongs to the parent's Vitest invocation, not ours). For MVP, document that the child uses the default config. If needed later, the plugin could capture and propagate relevant Vitest CLI args via env vars.

**Nested supervisor prevention** — If a user runs `npx vitiate ./test.ts` (CLI supervisor) and the test file contains `fuzz()` calls, the child's `fuzz()` would see `VITIATE_SUPERVISOR=1` and enter the fuzz loop directly — correct behavior, no nesting. If a user sets `VITIATE_SUPERVISOR` manually in their environment, `fuzz()` would skip supervisor mode — also correct (they're opting into direct fuzz loop mode).
→ No additional mitigation needed. The env var check is the sole guard and handles all cases.
