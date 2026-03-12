## Context

The CLI entry point (`npx vitiate`) aims for libFuzzer compatibility so it can be used as a drop-in replacement in OSS-Fuzz and other libFuzzer-based workflows. Currently, the CLI accepts positional corpus directories and libFuzzer-style flags, but corpus output and artifact paths follow Vitest conventions:

- New interesting inputs go to `.vitiate-corpus/<file>/<name>/` regardless of whether corpus dirs were provided.
- Crash artifacts go to `testdata/fuzz/<name>/crash-<hash>` regardless of context.

libFuzzer behavior:
- First positional corpus dir is the writable output directory for new interesting inputs.
- Crash artifacts are written to `./crash-<hash>` by default, or `<prefix>crash-<hash>` with `-artifact_prefix=<prefix>`.
- Additional positional corpus dirs are read-only seed sources.
- No corpus dir = in-memory only (no disk writes).

The standalone-cli spec already describes the correct corpus directory semantics but the implementation doesn't match. The Vitest `fuzz()` API should be unaffected - its paths make sense in a test-framework context.

## Goals / Non-Goals

**Goals:**
- CLI corpus output follows libFuzzer convention: first positional dir is writable output, no dir = in-memory only.
- CLI artifact paths follow libFuzzer convention: cwd by default, `-artifact_prefix` for override.
- OSS-Fuzz integration works without workarounds.
- Vitest mode behavior unchanged.

**Non-Goals:**
- `-merge=1` corpus merging (accepted but ignored, as today).
- Changing Vitest-mode corpus or artifact paths.
- Supporting `-exact_artifact_path` (rarely used libFuzzer flag).

## Decisions

### Decision 1: Explicit mode flag - `VITIATE_LIBFUZZER_COMPAT`

The fuzz loop needs to distinguish CLI mode (libFuzzer conventions) from Vitest mode (test-framework conventions). Several env vars (`VITIATE_CORPUS_OUTPUT_DIR`, `VITIATE_ARTIFACT_PREFIX`) are set in CLI mode but not Vitest mode - but using their presence as an implicit mode signal would prevent Vitest from adopting those features independently in the future (e.g., a `fuzz()` option for artifact paths).

**Choice**: The CLI parent sets `VITIATE_LIBFUZZER_COMPAT=1`. The `fuzz()` callback in `fuzz.ts` reads this flag and resolves corpus/artifact behavior accordingly:

| `VITIATE_LIBFUZZER_COMPAT` | `VITIATE_CORPUS_OUTPUT_DIR` | `VITIATE_ARTIFACT_PREFIX` | Corpus writes | Artifact path |
|---|---|---|---|---|
| `1` | set | set | Write to dir | `{prefix}{kind}-{hash}` |
| `1` | set | not set | Write to dir | `./` default |
| `1` | not set | set | In-memory only | `{prefix}{kind}-{hash}` |
| `1` | not set | not set | In-memory only | `./` default |
| not set | - | - | Cache dir | `testdata/fuzz/{name}/` |

The flag follows the existing `VITIATE_FUZZ=1` / `VITIATE_SUPERVISOR=1` naming pattern. Each env var means one thing: `LIBFUZZER_COMPAT` = use libFuzzer path conventions.

**Alternative considered**: Infer CLI mode from `VITIATE_ARTIFACT_PREFIX` presence. Rejected - conflates configuration with mode detection, preventing Vitest from using artifact prefix independently.

### Decision 2: Env vars for plumbing, explicit parameters at the call site

The CLI parent spawns a child process. Configuration needs to cross the process boundary via env vars, consistent with how `VITIATE_FUZZ_OPTIONS` and `VITIATE_CORPUS_DIRS` are already plumbed. (`VITIATE_FUZZ_OPTIONS` is now parsed via `v.safeParse` against a valibot `FuzzOptionsSchema` in `getCliOptions()`.)

- `VITIATE_LIBFUZZER_COMPAT=1` - use libFuzzer path conventions.
- `VITIATE_CORPUS_OUTPUT_DIR` - resolved first corpus dir (if any).
- `VITIATE_ARTIFACT_PREFIX` - resolved artifact prefix (if `-artifact_prefix` flag provided).

The new env vars SHALL be read via helper functions in `config.ts`, following the established pattern of `isFuzzingMode()` and `isSupervisorChild()`. This keeps env var reading centralized in config.ts rather than scattered across modules. The `fuzz()` callback in `fuzz.ts` calls these helpers and resolves them into explicit parameters for `runFuzzLoop()`. The fuzz loop itself does not read env vars - it receives resolved values:

```
corpusOutputDir?: string   // Write corpus here (flat). undefined = see libfuzzerCompat.
artifactPrefix?: string    // Prefix for artifacts. undefined = see libfuzzerCompat.
libfuzzerCompat: boolean   // true = libFuzzer conventions, false = Vitest conventions.
```

When `libfuzzerCompat` is true:
- `corpusOutputDir` undefined → skip corpus writes (in-memory only).
- `artifactPrefix` undefined → default to `./`.

When `libfuzzerCompat` is false:
- `corpusOutputDir` undefined → write to cache dir (existing behavior).
- `artifactPrefix` undefined → write to `testdata/fuzz/{name}/` (existing behavior).

The in-memory corpus (`InMemoryCorpus` in the LibAFL engine) already holds all interesting inputs regardless of disk writes. The `writeCorpusEntry` call in the fuzz loop is a separate persistence side-effect. Skipping it when `libfuzzerCompat && !corpusOutputDir` is a one-line guard.

**Why not always use the first corpus dir?** In Vitest mode, `corpusDirs` comes from `VITIATE_CORPUS_DIRS` env var and represents extra seed directories, not an output directory. The corpus output dir is a CLI-specific concept.

**Alternative considered**: Fall back to `.vitiate-corpus/` when no corpus dirs are given in CLI mode. Rejected - diverges from libFuzzer and creates a test-name-dependent path that doesn't match between modes.

### Decision 3: CLI parent sets mode flag, child resolves defaults

The CLI parent sets env vars for the child:

- `VITIATE_LIBFUZZER_COMPAT=1` - always set in CLI mode.
- `VITIATE_CORPUS_OUTPUT_DIR` - set to the first positional corpus dir, if any. Omitted when no corpus dirs are given.
- `VITIATE_ARTIFACT_PREFIX` - set to the `-artifact_prefix` flag value, if provided. Omitted when the flag is not given.

The child (via `fuzz.ts`) reads these env vars and resolves defaults under compat mode:
- `VITIATE_ARTIFACT_PREFIX` absent + `VITIATE_LIBFUZZER_COMPAT=1` → default to `./`.
- `VITIATE_CORPUS_OUTPUT_DIR` absent + `VITIATE_LIBFUZZER_COMPAT=1` → skip corpus writes.

This avoids the parent needing to resolve child-side defaults. The supervisor runs in the parent process and receives `artifactPrefix` directly via `SupervisorOptions` (resolved by the parent to the flag value or `./` default).

### Decision 4: Supervisor artifact prefix

The parent supervisor writes crash artifacts when it detects native crashes (signal death) or timeout recovery. Currently it calls `writeArtifact(testDir, testName, input, kind)` which writes to `testdata/fuzz/{name}/`.

**Choice**: Add `artifactPrefix?: string` to `SupervisorOptions`. When set, the supervisor writes artifacts to `{prefix}{kind}-{hash}` via a new `writeArtifactWithPrefix`. When unset, the existing `writeArtifact(testDir, testName, ...)` path is used.

In Vitest mode, `artifactPrefix` is not set - preserving existing behavior. In CLI mode, the resolved prefix is passed directly.

## Risks / Trade-offs

**[Breaking change for CLI artifact paths]** → Users who depend on CLI crash artifacts appearing in `testdata/fuzz/` will need to either add `-artifact_prefix=testdata/fuzz/{name}/` or switch to the default `./` location. This is intentional - the old behavior was a bug (didn't match libFuzzer). The change is CLI-only; Vitest mode is unaffected.

**[Corpus dir semantics diverge between modes]** → CLI's first corpus dir becomes writable output; Vitest's `VITIATE_CORPUS_DIRS` remains read-only seeds. This is correct behavior (each mode follows its own convention) but could confuse someone who uses both. Mitigation: document the difference clearly.

**[No corpus persistence without explicit dir in CLI mode]** → If a CLI user doesn't pass a corpus dir, interesting inputs are lost on process exit or respawn. This matches libFuzzer exactly, but users accustomed to the old `.vitiate-corpus/` fallback may be surprised. Mitigation: print a one-time hint at startup when no corpus dir is given (e.g., "hint: pass a corpus directory to persist interesting inputs").

**[Empty first corpus dir on first run]** → If the user provides a corpus dir that doesn't exist yet, we need to create it on first write. `writeCorpusEntryToDir` should `mkdirSync({ recursive: true })` like `writeCorpusEntry` already does.
