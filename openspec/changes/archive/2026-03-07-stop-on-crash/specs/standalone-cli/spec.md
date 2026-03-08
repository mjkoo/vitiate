## MODIFIED Requirements

### Requirement: Corpus directory positional arguments

The CLI SHALL accept additional positional arguments (after the test file) as corpus directories. The first corpus directory is the writable output directory; additional directories are read-only seed sources.

When positional corpus directories are provided:
- All directories SHALL be loaded as seed sources on startup.
- The first directory SHALL be used as the writable output directory for new interesting inputs discovered during fuzzing. New inputs SHALL be written as `{firstCorpusDir}/{contentHash}` (flat layout, no subdirectories).
- The first directory SHALL be created if it does not exist when the first interesting input is written.

When no positional corpus directories are provided in CLI mode:
- The fuzz loop SHALL NOT write new interesting inputs to disk. The in-memory corpus in the LibAFL engine retains all interesting inputs for the duration of the process, matching libFuzzer's behavior when no corpus directory is given.
- Interesting inputs discovered before a crash/respawn are lost. This is expected — users who want corpus persistence must provide a corpus directory.

The CLI SHALL pass CLI-specific IPC configuration to the child process via the `VITIATE_CLI_IPC` environment variable, a JSON blob validated by the `CliIpcSchema` in `config.ts`. The blob includes:

- `libfuzzerCompat: true` — signals that the fuzz loop SHALL use libFuzzer path conventions for corpus writes and artifact paths.
- `corpusOutputDir` — set to the first positional corpus directory when provided. Omitted when no corpus dirs are given.
- `artifactPrefix` — set to the `-artifact_prefix` flag value when provided. Omitted when the flag is omitted (the child defaults to `./` under libFuzzer compat mode).
- `corpusDirs` — array of corpus directory paths.
- `dictionaryPath` — resolved absolute path to the dictionary file.
- `forkExplicit` — set to `true` when the user passes any `-fork=N` flag. Omitted otherwise. Used by the child to resolve `stopOnCrash: "auto"` correctly.

These fields SHALL be read via helper functions in `config.ts` (e.g., `isLibfuzzerCompat()`, `getCorpusOutputDir()`, `getArtifactPrefix()`) which delegate to `getCliIpc()`.

In Vitest mode, `VITIATE_CLI_IPC` SHALL NOT be set. The fuzz loop SHALL use the cache directory layout for corpus and `testdata/fuzz/{sanitizedName}/` for artifacts.

#### Scenario: Single corpus directory

- **WHEN** `npx vitiate ./test.ts ./corpus/` is executed
- **THEN** `./corpus/` is used as both the seed source and the writable corpus output directory
- **AND** new interesting inputs are written to `./corpus/{contentHash}`

#### Scenario: Multiple corpus directories

- **WHEN** `npx vitiate ./test.ts ./corpus/ ./seeds1/ ./seeds2/` is executed
- **THEN** `./corpus/` is the writable output directory
- **AND** `./seeds1/` and `./seeds2/` are read-only seed sources
- **AND** all entries from all three directories are loaded as seeds
- **AND** new interesting inputs are written to `./corpus/{contentHash}`

#### Scenario: No corpus directories — in-memory only

- **WHEN** `npx vitiate ./test.ts` is executed without corpus directories
- **THEN** new interesting inputs are kept in the in-memory corpus only
- **AND** no corpus entries are written to disk

#### Scenario: Corpus output directory created on demand

- **WHEN** `npx vitiate ./test.ts ./new-corpus/` is executed
- **AND** `./new-corpus/` does not exist
- **AND** the fuzzer discovers an interesting input
- **THEN** `./new-corpus/` is created
- **AND** the input is written to `./new-corpus/{contentHash}`

#### Scenario: Vitest mode ignores corpus output dir

- **WHEN** a fuzz test runs in Vitest mode
- **AND** `VITIATE_CLI_IPC` is not set (or `corpusOutputDir` is absent)
- **THEN** interesting inputs are written to the cache directory layout (existing behavior)

#### Scenario: Fork flag sets forkExplicit in CliIpc

- **WHEN** `npx vitiate ./test.ts -fork=1` is executed
- **THEN** the `VITIATE_CLI_IPC` JSON blob includes `forkExplicit: true`
- **AND** the child can use this to resolve `stopOnCrash: "auto"` (see crash-continuation capability)

#### Scenario: No fork flag omits forkExplicit from CliIpc

- **WHEN** `npx vitiate ./test.ts` is executed without `-fork`
- **THEN** the `VITIATE_CLI_IPC` JSON blob does not include `forkExplicit`
- **AND** the child resolves `stopOnCrash: "auto"` to `true` (see crash-continuation capability)
