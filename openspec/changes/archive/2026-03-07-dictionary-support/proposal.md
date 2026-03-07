## Why

The fuzzer's token mutation pipeline (`TokenInsert`, `TokenReplace`) currently relies solely on auto-discovered tokens from CmpLog comparison tracing. For targets with complex input grammars (JSON parsers, URL handlers, protocol implementations), the fuzzer must rediscover keywords and magic bytes through random mutation before CmpLog can even observe them. User-provided dictionaries let domain experts seed the token pool with known-significant strings, dramatically reducing time-to-first-coverage for structured inputs.

## What Changes

- Add support for loading dictionary files in AFL/libfuzzer text format (quoted strings, `\xHH` hex escapes, `#` comments)
- In Vitest mode, discover dictionary by convention at `testdata/fuzz/<sanitized-test-name>.dict` (sibling to the seed corpus directory)
- In libFuzzer CLI mode, accept the standard `-dict=<path>` flag
- Pass dictionary file path from TypeScript to the Rust engine via `FuzzerConfig`
- Parse and seed `Tokens` state metadata before the fuzz loop starts, so `TokenInsert`/`TokenReplace` use them from iteration one
- User-provided dictionary tokens are exempt from the `MAX_DICTIONARY_SIZE` (512) cap that limits auto-discovered CmpLog tokens
- Dictionary has no effect in regression mode (no mutations occur)

## Capabilities

### New Capabilities

- `user-dictionary`: Loading, discovery, parsing, and integration of user-provided dictionary files into the token mutation pipeline

### Modified Capabilities

- `cmplog-dictionary`: User-provided tokens are exempt from the auto-discovered token cap; `TokenTracker` must distinguish user-seeded tokens from CmpLog-promoted tokens when enforcing `MAX_DICTIONARY_SIZE`
- `standalone-cli`: Add `-dict=<path>` flag to the libFuzzer-compatible CLI flags
- `fuzzing-engine`: `FuzzerConfig` gains `dictionaryPath` field; `Fuzzer::new()` loads and seeds `Tokens` metadata from the dictionary file
- `corpus-management`: Add `getDictionaryPath()` for resolving dictionary file alongside seed corpus directory

## Impact

- **vitiate-napi**: `FuzzerConfig` gains a `dictionaryPath` field (optional string); `Fuzzer::new()` loads the file via `Tokens::from_file()` into state metadata; `TokenTracker` adjusted to exempt user tokens from cap
- **vitiate**: `corpus.ts` gains dictionary path resolution; `loop.ts` passes dictionary path to `FuzzerConfig`; `cli.ts` adds `-dict` flag parsing and forwards path via `VITIATE_DICTIONARY_PATH` env var
- **No breaking changes**: All additions are optional; existing behavior is unchanged when no dictionary is provided
- **No new dependencies**: Dictionary parsing uses LibAFL's existing `Tokens` API
