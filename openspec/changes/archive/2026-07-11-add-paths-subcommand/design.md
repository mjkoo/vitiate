## Context

Each fuzz test's on-disk data lives under a hash directory named by `hashTestPath(file, testName)` = Nix-base32 of an XOR-folded SHA-256 of `"<file>::<testName>"`, plus a sanitized `-<slug>` suffix (see the `nix-base32` and `corpus-management` capabilities). The hash is one-way and the slug is lossy, so a directory cannot be mapped back to a test; the mapping is only recoverable by enumerating discovered tests and forward-hashing them.

The `cli-subcommands` capability already exposes `init`, `fuzz`, `regression`, `reproduce`, `optimize`, and `libfuzzer`. `init` is the only command that surfaces the test-to-hash-directory manifest, but it does so as a side effect of a mutating operation (it creates seed directories and edits `.gitignore`). There is no read-only inspector, and no way at all to reconcile on-disk directories against the current test set to find leftovers from renamed or deleted tests.

The `corpus-management` capability derives paths from test identity and loads testdata, but has no primitive to count entries per bucket without reading file contents, nor to enumerate the hash directories present on disk.

## Goals / Non-Goals

**Goals:**
- A read-only `paths` subcommand that surfaces the test-to-directory mapping with per-bucket counts, creating nothing on disk.
- Ergonomic filtering that doubles as reverse lookup (paste a hash prefix or slug from a crash path).
- A scripting-friendly single-directory output (`--dir`) and machine-readable output (`--json`).
- Detection and safe, opt-in deletion of orphaned directories for shared-corpus garbage collection.
- Reuse the existing test-discovery and corpus primitives; share the manifest builder with `init` without changing `init`'s output.

**Non-Goals:**
- No changes to the hash-directory naming scheme (`corpus-management`/`nix-base32` are unchanged).
- No new artifact/crash classifications (stays within the libFuzzer model).
- No corpus mutation beyond the explicit `--prune` deletion path.
- No `ls`-style listing of the entries inside a single test's corpus (reserved for a possible future verb).

## Decisions

**Forward-only mapping via `discoverFuzzTests`, not directory parsing.** Since the hash is irreversible, `paths` enumerates tests with the existing `discoverFuzzTests()` (`test-discovery` capability) and forward-hashes each. Alternative rejected: parsing hash directories on disk - impossible to recover the test, and the slug is lossy/ambiguous.

**`paths` is a requirement under `cli-subcommands`, not a new capability.** It parallels `init`/`reproduce`, which are already requirements there. Alternative rejected: a standalone capability - inconsistent with the established structure and would fragment the subcommand contract. It is also not placed under `subcommand-flags`, which is scoped to the vitest-wrapper subcommands (`fuzz`/`regression`/`optimize`); `paths` does not wrap vitest.

**Pattern filter matches file, name, and hash directory.** One positional argument serves both filtering ("show me the url tests") and reverse lookup ("which test is `44de...`?"), avoiding a separate lookup flag.

**Confirm-by-default pruning with a `--force` escape hatch and layered opt-in.** `--prune` deletes only `corpus/` orphans (gitignored, regenerable); `--prune --all` extends to `testdata/` orphans (which may hold committed crashes/seeds). Deletion prompts on a TTY; `--force`/`-f` skips the prompt for CI. The confirm function is an injectable seam so the decision path is deterministically testable. Alternatives rejected: delete-on-flag with no prompt (too dangerous for testdata); a single blanket prune (no gradient between safe cache and committed data).

**Unknown-test-set is a hard safety gate.** `discoverFuzzTests()` returns `null` when Vitest is absent; with no known test set, every directory looks orphaned. `--orphans`/`--prune` abort (exit 1) rather than scan or delete. A non-TTY stdin without `--force` also aborts instead of hanging or deleting.

**Counting reads directory entries, not file contents.** New corpus helpers count via `readdirSync` (excluding dotfiles and subdirectories, matching existing corpus read semantics) rather than loading buffers, keeping `paths` cheap on large corpora.

**Shared manifest builder for `init` and `paths`.** A pure `buildTestManifest(discovered)` produces the hash directory, testdata/corpus paths, and counts per test; `init` reuses it and keeps its own mutation (seed dirs, `.gitignore`) and existing table output unchanged.

## Risks / Trade-offs

- [`discoverFuzzTests` spins up an in-process Vitest instance, adding startup latency to a "read-only" command] → Acceptable: it is the single source of truth for the test set, and the same cost is already paid by `init`; no cheaper authoritative enumeration exists.
- [A test legitimately with zero discovered members (all tests renamed away) makes all its directories look orphaned] → This is the correct signal for garbage collection; deletion remains gated behind explicit `--prune` plus confirmation, so no silent loss.
- [Testdata orphans may contain committed crash reproducers] → Mitigated by requiring the extra `--all` opt-in and the same confirmation prompt; corpus-only is the default blast radius.
- [Counting excludes top-level (non-bucket) files in a testdata directory] → Intentional and consistent with how buckets are defined; the count is an informational signal, not an integrity check.

## Migration Plan

Purely additive to the CLI surface plus an internal `init` refactor; no data migration, no config change, no rollback concern. The feature is already implemented on the `fix-correctness` branch; this change records the spec deltas to keep specs synced to implementation.

## Open Questions

None outstanding. Naming (`paths`) and the prune-confirmation model were resolved during design review.
