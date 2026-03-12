## Context

Test data paths are currently constructed by two inconsistent schemes. Seed/artifact directories live colocated with test files at `<testDir>/testdata/fuzz/<hash8>-<slug>/`, while cached corpus lives globally at `.vitiate-corpus/<testFilePath>/<hash8>-<slug>/`. The hash is a truncated 8-char SHA-256 hex prefix (32 bits). The CLI is a single-command libFuzzer-compatible tool with no subcommand structure for management operations.

Key code locations:
- `vitiate-core/src/corpus.ts` - `sanitizeTestName()`, all path construction, read/write
- `vitiate-core/src/cli.ts` - CLI entry point, `@optique` parser, parent/child modes
- `vitiate-core/src/fuzz.ts` - `fuzz()` test registrar, calls corpus functions
- `vitiate-core/src/config.ts` - `cacheDir` option, `VitiatePluginOptions`

## Goals / Non-Goals

**Goals:**

- Uniform path scheme for all test data (seeds, crashes, timeouts, corpus, dictionaries)
- Collision-safe hashing using Nix's proven base32 scheme
- Global test data root so test artifacts aren't scattered across the repo
- CLI subcommand structure supporting `init`, `fuzz`, `regression`, `optimize`, `libfuzzer`
- `vitiate init` discovers tests and creates seed directories without running the fuzzer

**Non-Goals:**

- Migrating existing user data (no users yet)
- Changing the fuzz loop, engine, or instrumentation
- Modifying the Vitest plugin's transform pipeline
- Adding new fuzzing features or detectors

## Decisions

### Decision 1: Nix base32 encoding

Adopt Nix's exact base32 scheme for test name hashing.

**Algorithm:**
1. Compute the hash input as `<relativeTestFilePath>::<testName>` (the `::` delimiter is unambiguous since file paths don't contain `::`)
2. SHA-256 the input (32 bytes)
3. XOR-fold to 160 bits (20 bytes): for `i` in `0..12`, `hash[i] ^= hash[20 + i]`, then truncate to 20 bytes
4. Encode in Nix base32: alphabet `0123456789abcdfghijklmnpqrsvwxyz` (omits `e`, `o`, `u`, `t`), processed from the end of the byte array, 5 bits per character, no padding
5. Result: 32-character string
6. Final directory name: `<nix32hash>-<slug>` where slug is the sanitized test name (same rules as today: non-alphanumeric replaced with `_`, collapsed, trimmed)

**Alternatives considered:**
- *Full SHA-256 hex (64 chars)*: Too long for directory names, no human benefit over 32 chars
- *Standard base32 (RFC 4648)*: Padding characters, uppercase default, no offensive-word filtering
- *Keep 8-char truncated hex*: Philosophically wrong, 32-bit collision space

**Rationale:** Nix's scheme is battle-tested across millions of packages, the 160-bit XOR-fold preserves cryptographic mixing, the custom alphabet avoids offensive substrings, and 32 chars is a reasonable path component length. Using the exact same algorithm (not "inspired by") means we can reference Nix documentation and use their test vectors.

### Decision 2: Include test file path in hash input

The hash input is `<relativeTestFilePath>::<testName>`, not just `<testName>`.

**Rationale:** This eliminates the need for hierarchical directory namespacing (the current corpus approach of `<testFilePath>/<hash>/`). Two tests named "parses input" in different files produce different hashes. The flat layout is simpler to reason about and gitignore.

**Alternative considered:** Hash only the test name and use directory hierarchy for namespacing (current corpus approach). Rejected because it creates inconsistency between the two storage locations and makes the path structure depend on which storage you're looking at.

### Decision 3: Global test data root at `.vitiate/`

All test data lives under a single configurable root directory, default `.vitiate/` at project root.

**Layout:**
```
.vitiate/
  testdata/
    <nix32hash>-<slug>/
      seeds/                  # user-provided seed inputs (committed)
      crashes/                # crash artifacts: crash-<contenthash> (committed)
      timeouts/               # timeout artifacts: timeout-<contenthash> (committed)
      *.dict | dictionary     # dictionaries discovered by convention (committed)
  corpus/
    <nix32hash>-<slug>/
      <contenthash>           # generated corpus entries (gitignored)
```

**Configuration:** `dataDir` option in `VitiatePluginOptions`, replacing the current `cacheDir`. No environment variable override - the data directory is only relevant for Vitest mode, and the plugin config is the natural place for it.

**Dictionary discovery:** When loading dictionaries for a test, scan the test's `testdata/<hash>-<slug>/` directory for any file matching `*.dict` or named `dictionary`. This lets users drop in AFL-format dictionaries without needing to know a naming convention. Multiple dict files are concatenated.

**Gitignore management:** `vitiate init` adds `.vitiate/corpus/` to `.gitignore` if not already present. The `testdata/` subtree is committed.

**Alternatives considered:**
- *Colocated testdata (current)*: Scatters artifacts across the repo, hard to find, inconsistent with corpus location
- *Hidden vs visible*: `.vitiate/` is hidden (like `.git`, `.vscode`), which keeps the project root clean. Seeds and crashes being committed from a hidden directory is slightly unusual but acceptable since users primarily interact via CLI, not by browsing the directory

### Decision 4: CLI subcommand dispatch

Restructure the CLI into subcommands with a pre-dispatch check before `@optique` parsing.

**Subcommand architecture:**
```
vitiate <subcommand> [args...]
```

The main entry point checks `process.argv[2]` against known subcommand names. If it matches, dispatch to that subcommand's handler. If it doesn't match any subcommand (or no args), print help/usage.

**Subcommands:**

| Subcommand | Implementation |
|---|---|
| `init` | Own arg parser. Boots Vitest via `createVitest()` to discover `*.fuzz.ts` files, walks the test tree to extract test names, computes paths, creates directories. |
| `fuzz` | Sets `VITIATE_FUZZ=1`, execs `vitest run .fuzz.ts` plus forwarded args. |
| `regression` | Execs `vitest run .fuzz.ts` plus forwarded args. No special env vars. |
| `optimize` | Sets `VITIATE_OPTIMIZE=1`, execs `vitest run .fuzz.ts` plus forwarded args. |
| `libfuzzer` | All current `cli.ts` logic: `@optique` parser, parent/child supervisor, shmem, libFuzzer flags. |

**`fuzz`, `regression`, `optimize` implementation:** These are thin exec wrappers. They do not parse vitest args - they set env vars and `execFileSync` (or `spawn` with inherited stdio) `vitest run` with the remaining argv. The `.fuzz.ts` positional filter ensures only `*.fuzz.ts` files are considered.

**`init` implementation:** Uses Vitest's `createVitest()` from `vitest/node` which creates an instance without running tests or validating packages. Then:
1. Call `await vitest.globTestSpecs()` or equivalent to collect test file paths
2. For each test file, import it in a collection mode to discover `fuzz()` call names (this requires the test file to register tests synchronously, which `fuzz()` does via `test()`)
3. Alternatively, use `vitest.collect()` to gather test specifications and walk the `TestModule` tree via `module.children` to get test names
4. For each discovered test, compute the Nix hash path and create `testdata/<hash>-<slug>/seeds/`
5. Print a manifest table: test file, test name, hash, path
6. Add `.vitiate/corpus/` to `.gitignore` if needed
7. Create `.vitiate/testdata/` and `.vitiate/corpus/` directories

The exact Vitest API for test collection needs validation during implementation. `createVitest` + `collect()` is the most likely path based on Vitest's Node API, but the specific method for enumerating tests without executing them may require experimentation.

**Alternative considered:**
- *Implicit default subcommand*: Making bare `vitiate` default to `fuzz`. Rejected in favor of explicit subcommands - print help when no subcommand given, avoid ambiguity.
- *Separate binaries*: `vitiate-init`, `vitiate-fuzz`, etc. Rejected - poor discoverability, more packaging complexity.

### Decision 5: Implement Nix base32 in TypeScript, not Rust

The encoding is a pure function on byte arrays. Implementing in TypeScript (in `vitiate-core`) avoids a round-trip to the native addon for what is a simple bit-manipulation algorithm. The `init` command and path resolution should work without compiling the Rust engine.

The algorithm is ~20 lines (see the `nix-base32` Rust crate for reference). We port the exact logic: iterate character positions in reverse, extract 5-bit groups spanning byte boundaries, index into the alphabet.

**Alternative considered:** Using the `nix-base32` Rust crate in `vitiate-engine` and exposing via napi. Rejected - adds a native dependency for a trivial pure function, and `init` should work without the engine.

## Risks / Trade-offs

**[Longer directory names]** 32-char hash + slug vs current 8-char hash + slug. Paths like `.vitiate/testdata/0ysj00x31q08vxsznqd9pmvwa0rrzza8-my_fuzz_test/seeds/` are longer but still well within filesystem limits (255 chars per component, 4096 total on Linux). Terminal display may truncate but these paths are primarily machine-consumed.
-> Mitigation: The slug provides human readability; the hash is for uniqueness. Users interact via `vitiate init` output, not by typing paths.

**[Vitest API stability for `init`]** `createVitest()` and the test collection API are documented but marked as advanced. The API shape could change across Vitest major versions.
-> Mitigation: Pin to Vitest 3.x API. The `init` command is a convenience, not a critical path - users can always create seed directories manually. Isolate the Vitest API usage behind a thin adapter.

**[`*.fuzz.ts` convention]** Filtering by file extension is a convention, not enforced by the tool. Users who name fuzz tests differently won't be discovered by `init` or filtered by `fuzz`/`regression`/`optimize`.
-> Mitigation: Document the convention clearly. The `libfuzzer` subcommand accepts any file path for users who need flexibility.

**[exec vs spawn for vitest wrappers]** Using `exec` to replace the process with vitest is clean but loses the ability to do post-run cleanup. Using `spawn` with inherited stdio preserves control but adds process management.
-> Mitigation: Use `spawn` with inherited stdio and forward the exit code. The wrappers are thin enough that the overhead is negligible, and it leaves room for pre/post hooks if needed later.
