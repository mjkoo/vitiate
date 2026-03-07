## Context

The token mutation pipeline (`TokenInsert`, `TokenReplace`) is already wired into the main havoc mutator via `havoc_mutations().merge(tokens_mutations())`. These mutators read from LibAFL's `Tokens` state metadata. Currently, `Tokens` is only populated dynamically by `TokenTracker`, which promotes CmpLog-derived byte operands after they exceed an observation threshold. There is no way to seed the dictionary with user-provided tokens.

The `DICTIONARY.md` design notes document captures the full investigation and user decisions leading to this design.

## Goals / Non-Goals

**Goals:**

- Users can provide domain-specific tokens that are available from iteration one, before CmpLog has observed any comparisons
- Convention-based discovery in Vitest mode (no configuration needed beyond placing the file)
- libFuzzer-compatible `-dict=<path>` flag for CLI mode
- User-provided tokens coexist with auto-discovered CmpLog tokens without interfering with each other's limits
- Dictionary has no effect in regression mode

**Non-Goals:**

- Binary autodict format (compiler-extracted symbols — not relevant for JS targets)
- Dictionary option in the `fuzz()` API (cross-platform path issues; convention is sufficient)
- Automatic dictionary generation or inference
- Multiple dictionary files per test

## Decisions

### Decision: Pass dictionary file path to Rust, use Tokens::from_file

The TypeScript side resolves and validates the dictionary file path, then passes it as `FuzzerConfig.dictionaryPath: Option<String>` to the Rust engine. The Rust side calls `Tokens::from_file(path)` to parse the file.

**Rationale:** Zero reimplementation — `Tokens::from_file` handles the full AFL/libfuzzer dictionary format (quoted strings, `\xHH` hex escapes, comments, blank lines) and is already battle-tested. The Rust side already performs file I/O in other contexts (shmem, crash artifacts), so there is no established boundary being violated. Path resolution and existence checking still happen on the TS side so errors surface early with clear messages.

**Alternative considered:** Pass dictionary content as a string and reparse in Rust. Rejected — this would require reimplementing ~20 lines of line-parsing logic from `Tokens::add_from_file` (which takes `AsRef<Path>`, not a string) to operate on `str::lines()`. While `str_decode` is publicly exported, the line-level parsing (finding quotes, extracting content) would be duplicated code with no benefit.

### Decision: Seed Tokens metadata before fuzz loop, separate from TokenTracker

In `Fuzzer::new()`, if `FuzzerConfig.dictionaryPath` is present, call `Tokens::from_file(path)` and add the result as state metadata via `state.add_metadata(tokens)`. This happens before any `report_result()` calls, so the tokens are available from iteration one.

The `TokenTracker` does not manage user-provided tokens. It only tracks and promotes CmpLog-derived candidates. User tokens go directly into `Tokens` metadata at construction time.

**Rationale:** Clean separation of concerns. User tokens are unconditionally present; CmpLog tokens are conditionally promoted. The `TokenTracker` doesn't need to know about user tokens at all — it just needs to know how many auto-discovered tokens it has promoted, so it can enforce its own cap.

### Decision: Track auto-discovered token count in TokenTracker, not in Tokens metadata

`TokenTracker` already maintains a `promoted: HashSet<Vec<u8>>` that exactly tracks how many CmpLog tokens have been promoted. The `MAX_DICTIONARY_SIZE` check changes from `state.metadata::<Tokens>().tokens().len() >= MAX_DICTIONARY_SIZE` to `self.promoted.len() >= MAX_DICTIONARY_SIZE`.

**Rationale:** The `promoted` set is already the authoritative count of auto-discovered tokens. Using it instead of the total `Tokens` length naturally exempts user-provided tokens from the cap. No new fields or metadata needed.

**Alternative considered:** Store `user_token_count` at init time and subtract from total. Rejected because it requires threading the count into `TokenTracker` and is fragile if the init sequence changes. The `promoted.len()` approach is self-contained.

### Decision: Dictionary file convention — `testdata/fuzz/<name>.dict`

In Vitest mode, the dictionary file is discovered at `testdata/fuzz/<sanitized-test-name>.dict`, a sibling to the seed corpus directory `testdata/fuzz/<sanitized-test-name>/`.

**Rationale:** Placing the dictionary inside the seed corpus directory creates ambiguity (is it a seed input or the dictionary?). A sibling `.dict` file is unambiguous and follows the pattern of other fuzz tooling. The `.dict` extension matches AFL/libfuzzer convention.

### Decision: Error on malformed dictionary, warn on missing

- **Missing dictionary file** (Vitest mode): Silently proceed without user tokens. This is the common case — most tests won't have a dictionary.
- **`-dict` flag pointing to nonexistent file** (CLI mode): Error at startup with a clear message. The user explicitly requested a dictionary; a missing file is a mistake.
- **Malformed dictionary content** (either mode): Error at startup. A parse failure means the user's dictionary has syntax errors that should be fixed, not silently ignored.

### Decision: Pass dictionary path via VITIATE_DICTIONARY_PATH env var in CLI mode

In CLI mode, the parent process resolves the `-dict` path to an absolute path and passes it to the child via `VITIATE_DICTIONARY_PATH` environment variable. The child reads this env var in `loop.ts` and includes it in `FuzzerConfig.dictionaryPath`.

**Rationale:** Follows the established pattern of parent→child communication via env vars. Resolving to an absolute path in the parent ensures the child can find the file regardless of working directory changes. A file path is small and avoids env var size concerns entirely.

## Risks / Trade-offs

- **Duplicate tokens between user dictionary and CmpLog**: If a user provides a token that CmpLog also discovers, it will exist once in `Tokens` (LibAFL's `add_token` deduplicates via `HashSet`) but the CmpLog copy will also consume a `promoted` slot. This is harmless — the slot is wasted but the cap is generous (512).
- **No validation of token quality**: Users could provide an enormous dictionary of low-quality tokens that dilute mutation effectiveness. This is a user responsibility — the fuzzer trusts the dictionary, same as AFL/libfuzzer.
