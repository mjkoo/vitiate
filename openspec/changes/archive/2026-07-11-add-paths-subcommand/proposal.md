## Why

The corpus and artifact layout stores each fuzz test's seeds/crashes/corpus under an opaque one-way hash directory (`.vitiate/testdata/<hash>-<slug>/`, `.vitiate/corpus/<hash>-<slug>/`). Because the directory name is a hash of the test's file path and name, it cannot be reversed to a test. Today the only way to see the mapping is `vitiate init`, which is a mutating command (it creates seed directories and edits `.gitignore`), so users cannot safely run it just to look. This causes recorded friction: "where do I seed test X?", "which test owns this crash directory?", and, for shared CI corpora, "which directories are stale leftovers I can garbage-collect?" (item A3 in `DESIGN_REVIEW_2026-06-21.md`).

## What Changes

- Add a new read-only `vitiate paths [pattern]` subcommand that maps each discovered fuzz test to its testdata/corpus hash directory with per-bucket entry counts (seeds/crashes/timeouts), creating nothing on disk.
- Add an optional positional `pattern` that filters tests by case-insensitive substring over file path, test name, or hash directory (the hash-prefix match also serves reverse lookup from a crash path).
- Add flags: `--dir` (print only a unique-match test's testdata directory, for scripted seeding), `--json` (machine-readable output including an orphans array), `--absolute` (absolute instead of project-root-relative paths).
- Add orphan detection: `--orphans` lists on-disk `testdata/`+`corpus/` hash directories that match no discovered test.
- Add pruning: `--prune` deletes orphaned `corpus/` directories; `--prune --all` also deletes orphaned `testdata/` directories; `--force`/`-f` skips confirmation. Pruning prompts before deleting by default, refuses on a non-TTY stdin without `--force` (never hangs or silently deletes), and refuses entirely when the fuzz-test set cannot be discovered (Vitest missing), since every directory would otherwise appear orphaned. `--all`/`--force` are usage errors without `--prune`.
- Add supporting read helpers to the corpus layer: per-test entry counts across buckets and cached corpus, on-disk hash-directory enumeration, and orphan entry counting.
- Refactor the `init` subcommand to share the test-to-directory manifest builder with `paths` (no change to `init`'s observable output).
- Document the subcommand in the CLI guide and CLI flags reference.

## Capabilities

### New Capabilities
<!-- None: paths is a new subcommand requirement within the existing cli-subcommands capability, parallel to init/reproduce, following the established convention. -->

### Modified Capabilities
- `cli-subcommands`: add a `paths` subcommand requirement (mapping, pattern filter, `--dir`/`--json`/`--absolute`, orphan detection, and confirm-gated pruning with the non-TTY and unknown-test-set safety gates); add `paths` to the Subcommand dispatch requirement.
- `corpus-management`: add requirements for the new read helpers - per-test bucket + cached-corpus entry counts, on-disk hash-directory enumeration under a given root, and orphan entry counting.
- `cli-docs`: extend the CLI guide structure and CLI flags reference structure requirements to include the `paths` subcommand and its flags.

## Impact

- `vitiate-core/src/cli.ts`: new `pathsParser`, command registration, dispatch case, `runPathsSubcommand` and orphan/prune helpers; `runInitSubcommand` refactored onto a shared manifest builder.
- `vitiate-core/src/corpus.ts`: new `getTestPathStats`, `listOnDiskHashDirs`, `countOrphanEntries`, `BUCKET_SUBDIRS` exports.
- Docs: `docs/src/content/docs/guides/cli.md`, `docs/src/content/docs/reference/cli-flags.md`.
- No breaking changes; purely additive CLI surface plus an internal `init` refactor.
