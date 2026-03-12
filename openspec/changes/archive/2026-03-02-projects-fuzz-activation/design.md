## Context

Vitiate's fuzz mode activation has two mechanisms: the `VITIATE_FUZZ` env var (works) and the `--fuzz` CLI flag (broken - vitest's cac parser rejects unknown flags). The `VITIATE_FUZZ_PATTERN` env var provides test-name filtering but with wrong behavior (non-matching tests regression-replay instead of skipping). The standalone CLI derives crash artifact directory names from the test filename, not the `fuzz()` test name. Cached corpus paths use only the test name with no file context, causing collisions between same-named tests in different files.

The Vitest maintainers recommend env vars for custom activation and projects for test profiles. Vitest's built-in `-t` / `--test-name-pattern` flag provides proper test filtering at the runner level.

## Goals / Non-Goals

**Goals:**

- Codify `VITIATE_FUZZ=1` as the sole fuzz activation mechanism and update specs to match
- Remove dead `parseFuzzFlag` / `--fuzz` code and the `VITIATE_FUZZ_PATTERN` mechanism
- Add `-test=<name>` to the standalone CLI for exact per-test targeting (replaces `VITIATE_FUZZ_PATTERN` in CLI mode)
- Prevent cached corpus directory collisions between same-named tests in different files
- Fix CLI parent artifact naming when `-test` is provided
- Expand the url-parser example to exercise multi-test and multi-file scenarios with vitest projects

**Non-Goals:**

- Auto-activating fuzz mode based on vitest project name (rejected: conflates file selection with mode switching)
- Extending the shmem layout to stash test names (too much scope for the current issue)
- Providing automated migration tooling for seed corpus directory renames (documented in changelog instead)
- Supporting multiple test files in a single CLI invocation (libFuzzer convention is one file = one target)

## Decisions

### 1. `VITIATE_FUZZ=1` as the sole activation mechanism

**Decision:** Remove `parseFuzzFlag()` and the `--fuzz` / `--fuzz=<pattern>` spec requirements. `VITIATE_FUZZ=1` is the only way to activate fuzzing mode.

**Rationale:** The `--fuzz` flag never worked - vitest's cac parser rejects unknown flags before the plugin loads. The Vitest team has explicitly declined to support plugin-extensible CLI flags and recommends env vars. `VITIATE_FUZZ=1` already works in all contexts: npm scripts (which use sh), CI, programmatic use. There is no DX improvement to be had from alternatives - `VITIATE_FUZZ=1 vitest run` is explicit and discoverable.

**Alternatives considered:**
- Projects-based auto-activation (`--project fuzz` → auto-set `VITIATE_FUZZ`): Rejected because it conflates file selection with mode switching. The project name silently changing behavior is magic, not ergonomics.
- `--mode fuzz`: Works technically but is a semantic misuse of Vite's mode concept (which controls `.env` file loading and `import.meta.env.MODE`).

### 2. Remove `VITIATE_FUZZ_PATTERN`, replace with `-t` and `-test`

**Decision:** Remove `VITIATE_FUZZ_PATTERN` env var, `getFuzzPattern()`, and `shouldEnterFuzzLoop()` pattern logic. In vitest mode, users filter with `-t`. In CLI mode, add a `-test=<name>` flag with exact-match semantics.

**Rationale:** `VITIATE_FUZZ_PATTERN` has wrong behavior - non-matching tests regression-replay instead of skipping. Vitest's `-t` provides correct runner-level filtering where non-matching test callbacks never execute. The standalone CLI needs its own flag because it doesn't expose vitest's CLI args directly.

The `-test` flag's value is escaped and anchored as `^{escaped}$` before passing to `startVitest()`'s `testNamePattern` option, ensuring exact-match semantics (e.g., `-test=parse-url` matches only "parse-url", not "parse-url-v2"). The CLI parent also uses the name as the `testName` for `runSupervisor()`, fixing the artifact naming problem for the targeted-test case.

**Alternatives considered:**
- Keep `VITIATE_FUZZ_PATTERN` but fix skip behavior: Maintains a redundant env var alongside `-t`. More surface area for the same functionality.
- Extend shmem to stash test name: Correct but adds Rust-layer scope (layout change, napi bindings) for a case (CLI + multiple tests + native crash) that rarely occurs in practice.

### 3. Vitest projects for file selection (orthogonal to activation)

**Decision:** Use vitest projects to separate fuzz files from unit tests. This is purely about file selection - projects do not activate fuzzing. The example config will demonstrate the pattern.

**Configuration pattern:**
```typescript
export default defineConfig({
  plugins: [vitiatePlugin()],
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['**/*.test.ts'] } },
      { extends: true, test: { name: 'fuzz', include: ['**/*.fuzz.ts'] } },
    ],
  },
})
```

**Usage:** `vitest run` runs all (regression). `VITIATE_FUZZ=1 vitest run --project fuzz` fuzzes only fuzz files. `VITIATE_FUZZ=1 vitest run --project fuzz -t "parse-url"` targets one test.

### 4. Hash-prefixed test name directories and file-qualified cached corpus paths

**Decision:** Replace `sanitizeTestName()` with a nix-store-style `{hash}-{slug}` scheme. The hash (8 hex chars of SHA-256 of the original unsanitized name) guarantees uniqueness; the slug (lossy sanitization of the original name) provides human context. For cached corpus, additionally qualify with the relative file path.

**Directory name format:** `sanitizeTestName("parse url")` → `"e7f3a1b2-parse_url"`. The hash is computed from the original unsanitized test name, so names that differ only in non-alphanumeric characters (e.g., `"parse url"` vs `"parse:url"`) produce different hashes and different directories. The slug after the dash is lossy (same rules as today: replace non-`[a-zA-Z0-9\-_.]` with `_`, collapse runs) but is never used for uniqueness - it's just a human hint.

**Cached corpus paths:** Change from `{cacheDir}/{sanitizedTestName}/` to `{cacheDir}/{relativeFilePath}/{hash}-{slug}/` where `relativeFilePath` is the test file path relative to `VITIATE_PROJECT_ROOT` (or cwd). This prevents cross-file collisions.

**Seed corpus and crash artifact paths:** Change from `testdata/fuzz/{sanitizedTestName}/` to `testdata/fuzz/{hash}-{slug}/`. These are already file-relative, so no file path qualification needed. The hash prefix eliminates within-directory collisions.

**Rationale:** The current `sanitizeTestName` is lossy - `"parse url"`, `"parse/url"`, and `"parse:url"` all map to `"parse_url"`. The nix-store pattern solves this completely: the hash carries uniqueness, the slug carries readability. An `ls` of the testdata directory gives you `e7f3a1b2-parse_url/` and `3c9d0f1a-parse_url/` - you can tell them apart and get the gist. This also eliminates the need for special-casing `"."`, `".."`, and empty strings since the hash prefix makes any name a valid directory.

8 hex chars (32 bits) provides collision resistance up to ~65k distinct test names per directory (birthday bound), which is far beyond any practical project.

**Example:** For `test/parsers/url.fuzz.ts` with `fuzz("parse url", ...)`:
- Seed corpus: `test/parsers/testdata/fuzz/e7f3a1b2-parse_url/` (hash-prefixed)
- Cached corpus: `.vitiate-corpus/test/parsers/url.fuzz.ts/e7f3a1b2-parse_url/` (file-qualified + hash-prefixed)
- Crash artifacts: `test/parsers/testdata/fuzz/e7f3a1b2-parse_url/crash-{contenthash}`

**Migration:** Both seed corpus and cached corpus paths change. Seed corpus (crash artifacts, manually written seeds) will need manual migration - users rename their `testdata/fuzz/{old}/` directories. Cached corpus is regeneratable and needs no migration. A one-time migration note in the changelog is sufficient.

### 5. CLI `-test` and artifact naming

**Decision:** Add `-test=<name>` to the standalone CLI with exact-match semantics. When provided:
1. The name is escaped and anchored as `^{escaped}$` and passed to `startVitest()` as `testNamePattern` (exact match at the runner level)
2. The parent uses the name as `testName` for `runSupervisor()` (correct artifact paths)

When not provided, the parent falls back to deriving `testName` from the filename (current behavior, correct for the single-test-per-file convention).

**Rationale:** This avoids extending the shmem layout while giving CLI users per-test targeting with correct artifact naming. The limitation is that native crashes without `-test` in multi-test files use the filename-derived name - acceptable since CLI + multiple tests + native crash is a rare edge case, and the user can always add `-test` to fix it.

## Risks / Trade-offs

- **Corpus path migration**: Both seed corpus and cached corpus directory names change (hash-prefixed). Cached corpus is regeneratable (low impact). Seed corpus (crash artifacts, manual seeds) requires users to rename directories - a one-time manual step documented in the changelog. The rename is mechanical: `testdata/fuzz/{old}/` → `testdata/fuzz/{hash}-{slug}/`.
- **`VITIATE_FUZZ_PATTERN` removal is breaking**: Users relying on the env var must switch to `-t` (vitest mode) or `-test` (CLI mode). This is a deliberate break - the old behavior (regression-replay non-matching tests) was incorrect.
- **CLI multi-test artifact naming imprecision**: Without `-test`, the CLI parent still uses filename-derived names for native crash artifacts. This is documented and acceptable for the libFuzzer-compatible CLI's single-target convention.
