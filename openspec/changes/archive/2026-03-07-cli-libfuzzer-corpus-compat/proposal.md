## Why

In CLI mode, corpus directories and crash artifacts use Vitest-style paths (`testdata/fuzz/<name>/` for artifacts, `.vitiate-corpus/` for generated corpus) regardless of whether positional corpus directories were provided. This diverges from libFuzzer conventions where the first positional corpus directory is the writable output directory and crash artifacts are written to the current directory (or `-artifact_prefix`). The standalone-cli spec already describes libFuzzer-compatible corpus directory semantics (first dir is writable output, rest are read-only seeds), but the implementation ignores this - positional corpus dirs are read-only seeds and new corpus entries always go to `.vitiate-corpus/`. This breaks OSS-Fuzz integration, which expects to find generated corpus in the directories it provides and crash artifacts in predictable locations.

## What Changes

- **CLI corpus output directory**: When positional corpus directories are provided in CLI mode, the first directory becomes the writable output directory for new interesting inputs (instead of `.vitiate-corpus/`). When no corpus dirs are given, corpus is in-memory only - no entries are written to disk, matching libFuzzer's behavior. The in-memory corpus (`InMemoryCorpus`) already exists in the engine; the only change is skipping the `writeCorpusEntry` call.
- **`-artifact_prefix` flag**: Add the libFuzzer `-artifact_prefix=<path>` flag. When set, crash/timeout artifacts are written to `<path>crash-<hash>` (or `<path>timeout-<hash>`). When unset, artifacts are written to the current working directory as `crash-<hash>` / `timeout-<hash>` (libFuzzer default). **BREAKING** for CLI-mode artifact paths - previously went to `testdata/fuzz/<name>/`.
- **CLI-mode test name for artifacts**: When `-artifact_prefix` is not set and no positional corpus dirs are given, the CLI still needs a sane default. Use `./` (cwd) matching libFuzzer's default, not the Vitest `testdata/fuzz/` convention.
- **Vitest mode unchanged**: The `fuzz()` callback continues using `testdata/fuzz/<name>/` for artifacts and `.vitiate-corpus/` for generated corpus. These paths make sense in a test-framework context where corpus lives alongside test files.

## Capabilities

### New Capabilities

- `cli-artifact-prefix`: Support for the `-artifact_prefix=<path>` flag in CLI mode, controlling where crash/timeout artifacts are written.

### Modified Capabilities

- `standalone-cli`: The CLI's corpus directory handling changes to match the spec's existing description (first positional dir is writable output). Add `-artifact_prefix` to the flag list. CLI parent sets `VITIATE_LIBFUZZER_COMPAT=1` to signal libFuzzer path conventions to the child.
- `corpus-management`: Add a code path for writing corpus entries to a caller-specified output directory (instead of always using the cache dir layout). The existing `writeCorpusEntry` writes to `{cacheDir}/{filePath}/{name}/{hash}` - CLI mode needs to write to `{outputDir}/{hash}` directly. Also fix pre-existing spec discrepancy: hash is the full SHA-256 hex digest, not truncated to 16 characters.
- `parent-supervisor`: The supervisor's crash artifact format becomes conditional - uses `artifactPrefix` when set, falls back to `testdata/fuzz/{sanitizedTestName}/` when unset.
- `fuzz-loop`: The "Interesting input persistence" requirement becomes conditional on the active path convention - cache dir (Vitest), explicit dir (CLI with corpus dir), or skip (CLI without corpus dir).
- `watchdog`: The `Watchdog` constructor and `installExceptionHandler` accept an artifact prefix string (replacing the previous artifact directory parameter), enabling full prefix support including non-directory prefixes. The caller resolves the prefix based on the active path convention.

## Impact

- **`vitiate/src/cli.ts`**: Parse `-artifact_prefix`, set `VITIATE_LIBFUZZER_COMPAT=1` and `VITIATE_CORPUS_OUTPUT_DIR`/`VITIATE_ARTIFACT_PREFIX` env vars for child, pass artifact prefix to supervisor.
- **`vitiate/src/fuzz.ts`**: Read new env vars, resolve into explicit parameters for `runFuzzLoop`.
- **`vitiate/src/loop.ts`**: Accept `corpusOutputDir`, `artifactPrefix`, `libfuzzerCompat` parameters. Route corpus writes and artifact writes based on mode.
- **`vitiate/src/supervisor.ts`**: Accept `artifactPrefix` in `SupervisorOptions`. When set, the parent writes crash artifacts to `{prefix}crash-{hash}` via `writeArtifactWithPrefix`.
- **`vitiate/src/corpus.ts`**: Add `writeCorpusEntryToDir(dir, data)` for flat output and `writeArtifactWithPrefix(prefix, data, kind)` for prefix-based artifacts.
- **OSS-Fuzz compatibility**: After this change, `npx vitiate ./fuzz.ts ./corpus/ -artifact_prefix=./` works as expected - corpus goes to `./corpus/`, artifacts go to `./crash-<hash>`.
- **Existing Vitest users**: No change. The `fuzz()` API doesn't expose these flags.
