<!--
This change documents an already-implemented feature (shipped on the
`fix-correctness` branch). All tasks are checked to reflect the implementation
that exists; they are recorded here so the change captures the full work.
-->

## 1. Corpus read helpers (`vitiate-core/src/corpus.ts`)

- [x] 1.1 Add `BUCKET_SUBDIRS` and a private `countDirEntries` helper (file count excluding dotfiles and subdirs, missing dir = 0)
- [x] 1.2 Add `getTestPathStats(file, name)` returning `{ seeds, crashes, timeouts, ooms, corpus }` counts
- [x] 1.3 Add `listOnDiskHashDirs(kind)` enumerating directory names under `<root>/testdata|corpus/` (empty if root missing)
- [x] 1.4 Add `countOrphanEntries(kind, hashDir)` (sum buckets for testdata, file count for corpus, missing = 0)

## 2. paths parser, registration, and dispatch (`vitiate-core/src/cli.ts`)

- [x] 2.1 Define `pathsParser` with optional `pattern` positional and `--json`/`--absolute`/`--dir`/`--orphans`/`--prune`/`--all`/`--force`(`-f`) boolean flags
- [x] 2.2 Register `command("paths", pathsParser, ...)` in the `or()` subcommand list with brief + description
- [x] 2.3 Add `case "paths"` to the dispatch switch (exhaustiveness check enforces this)

## 3. paths handler and orphan/prune logic (`vitiate-core/src/cli.ts`)

- [x] 3.1 Extract shared `buildTestManifest(discovered)` (hashDir, testDataDir, corpusDir, stats) and refactor `runInitSubcommand` onto it without changing init's output
- [x] 3.2 Implement `runPathsSubcommand`: usage-error guards for `--all`/`--force` without `--prune`; abort on unknown test set; build manifest; pattern filter over file/name/hashDir
- [x] 3.3 Implement `--dir` (unique-match path; error on 0 or >1 matches)
- [x] 3.4 Implement `findOrphans`, `selectPruneTargets`, `deleteOrphans`, and `prunePaths` with confirm-by-default, injectable confirm seam, `--force`, and non-TTY abort
- [x] 3.5 Implement table renderer, orphans section, and `--json` renderer (with `--absolute` support)

## 4. Tests

- [x] 4.1 corpus.test.ts: `getTestPathStats`, `listOnDiskHashDirs`, `countOrphanEntries` (counts, dotfile/nested exclusion, missing dirs)
- [x] 4.2 cli.test.ts: `pathsParser` parsing (defaults, pattern, flags, `-f`)
- [x] 4.3 cli.test.ts: `findOrphans`/`selectPruneTargets`/`deleteOrphans` and `prunePaths` confirmation gate (force, non-TTY abort, yes/no, `--all`)

## 5. Documentation

- [x] 5.1 Add the `paths` section to `docs/src/content/docs/guides/cli.md`
- [x] 5.2 Add the `paths` subcommand row and section to `docs/src/content/docs/reference/cli-flags.md`

## 6. Verification

- [x] 6.1 Typecheck, lint, and full unit + e2e test suites pass
- [x] 6.2 Manual end-to-end run of all flag paths against `examples/url-parser`
