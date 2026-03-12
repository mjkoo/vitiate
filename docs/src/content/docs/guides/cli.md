---
title: Standalone CLI
description: Running fuzz tests from the command line with npx vitiate.
---

The `vitiate` CLI is the primary interface for fuzzing, regression testing, and corpus management. It provides subcommands for each workflow:

| Subcommand | Description |
|------------|-------------|
| `vitiate fuzz` | Run all fuzz tests with coverage-guided mutation |
| `vitiate regression` | Replay saved corpus and crash inputs as regression tests |
| `vitiate optimize` | Minimize cached corpus via set cover |
| `vitiate init` | Discover fuzz tests and create seed directories |
| `vitiate libfuzzer` | libFuzzer-compatible mode for platform integration |

## Fuzzing

```bash
npx vitiate fuzz
```

This runs all `*.fuzz.ts` files with coverage-guided fuzzing. The fuzzer runs indefinitely until you press Ctrl+C, a crash is found, or a configured limit is reached.

### Setting limits

```bash
# Stop after 60 seconds
npx vitiate fuzz --fuzz-time 60

# Stop after 100,000 iterations
npx vitiate fuzz --fuzz-execs 100000

# Collect at most 5 crashes then stop
npx vitiate fuzz --max-crashes 5

# Combine limits (whichever comes first)
npx vitiate fuzz --fuzz-time 120 --max-crashes 3
```

### Selecting detectors

The `--detectors` flag controls which bug detectors are active. When specified, all defaults are disabled and only the listed detectors run:

```bash
# Enable only prototype pollution detection
npx vitiate fuzz --detectors prototypePollution

# Enable multiple detectors
npx vitiate fuzz --detectors prototypePollution,pathTraversal

# Disable all detectors
npx vitiate fuzz --detectors ""
```

### Forwarding flags to Vitest

Unrecognized flags are forwarded to Vitest. You can also use `--` to pass flags explicitly:

```bash
# Forward a reporter flag
npx vitiate fuzz --reporter verbose

# Use -- separator for clarity
npx vitiate fuzz -- --reporter verbose
```

### Flags reference

| Flag | Description |
|------|-------------|
| `--fuzz-time <seconds>` | Total fuzzing time limit in seconds |
| `--fuzz-execs <count>` | Total number of fuzzing iterations |
| `--max-crashes <count>` | Maximum crashes to collect |
| `--detectors <list>` | Comma-separated list of bug detectors to enable |

## Regression testing

```bash
npx vitiate regression
```

Runs all `*.fuzz.ts` files as normal Vitest tests, replaying saved corpus entries and crash inputs without generating new mutations. This verifies that previously found bugs remain fixed and that the test targets still pass on known inputs.

The `--detectors` flag works the same as in `vitiate fuzz`. Unrecognized flags are forwarded to Vitest.

## Corpus optimization

```bash
npx vitiate optimize
```

Minimizes the cached corpus for all fuzz tests by evaluating each input's coverage contribution and keeping only the smallest set that maintains the same total coverage. This reduces disk usage and speeds up future regression runs.

The `--detectors` flag works the same as in `vitiate fuzz`. Unrecognized flags are forwarded to Vitest.

## Project setup

```bash
npx vitiate init
```

Discovers all `*.fuzz.ts` files, collects their `fuzz()` test names, and creates the seed directory structure under `.vitiate/testdata/`. It also adds `.vitiate/corpus/` to `.gitignore` if not already present.

The output includes a manifest of discovered tests with their hash directories, which is useful for understanding the on-disk layout.

## libFuzzer compatibility

The `libfuzzer` subcommand provides a libFuzzer-compatible interface for integration with fuzzing platforms like OSS-Fuzz and CI services that expect libFuzzer-style flags and conventions. Unlike the other subcommands, it targets a single test file and accepts positional corpus directories.

```bash
npx vitiate libfuzzer test/parser.fuzz.ts
```

### Targeting a specific test

If the file contains multiple `fuzz()` calls, target one by name:

```bash
npx vitiate libfuzzer test/parser.fuzz.ts -test "parse does not crash"
```

### Setting limits

```bash
# Stop after 60 seconds
npx vitiate libfuzzer test/parser.fuzz.ts -max_total_time 60

# Stop after 100,000 iterations
npx vitiate libfuzzer test/parser.fuzz.ts -runs 100000
```

### Corpus directories

Pass additional corpus directories as positional arguments after the test file:

```bash
npx vitiate libfuzzer test/parser.fuzz.ts corpus/ shared-corpus/
```

The fuzzer loads inputs from these directories alongside the seed corpus and cached corpus.

### Dictionaries and artifacts

```bash
# Use a dictionary file with domain-specific tokens
npx vitiate libfuzzer test/parser.fuzz.ts -dict ./tokens.dict

# Override the crash artifact output location
npx vitiate libfuzzer test/parser.fuzz.ts -artifact_prefix ./crashes/
```

When using `vitiate fuzz`, place dictionary files directly in `.vitiate/testdata/<hashdir>/` for automatic discovery instead. See [Dictionaries and Seeds](/vitiate/guides/dictionaries-and-seeds/) for details.

### Merge mode

The `-merge 1` flag minimizes a corpus across arbitrary directories:

```bash
# Merge multiple corpus directories into a minimized set
npx vitiate libfuzzer test/parser.fuzz.ts -merge 1 minimized-corpus/ .vitiate/corpus/ extra-corpus/

# Replace the old corpus with the minimized one
rm -rf .vitiate/corpus/
mv minimized-corpus/ .vitiate/corpus/
```

The first positional directory is the output; the rest are inputs. For integrated corpus minimization, use `npx vitiate optimize` instead.

### Supervisor architecture

The CLI runs a supervisor (parent) process that manages crash recovery. When the worker process crashes, the supervisor reads the crashing input from shared memory, writes the crash artifact to disk, and spawns a new worker to continue fuzzing. This means the fuzzer is resilient to crashes and keeps going until you stop it or it hits a configured limit.

### Compatibility flags

All flags use the libFuzzer naming scheme (`-max_total_time`, `-runs`, `-dict`, etc.). The following flags are parsed for compatibility but ignored since they do not apply to Vitiate's architecture:

| Flag | Behavior |
|------|----------|
| `-fork` | Parsed, ignored (always 1 - Vitiate uses a single supervised worker) |
| `-jobs` | Parsed, ignored (always 1 - Vitiate runs a single job at a time) |

See the [CLI Flags Reference](/vitiate/reference/cli-flags/) for the complete list of libFuzzer-compatible flags.

## Output format

The fuzzer prints periodic status lines during execution:

```
fuzz: elapsed: 3s, execs: 1024 (3412/sec), corpus: 23 (5 new), edges: 142
```

| Field | Meaning |
|-------|---------|
| `elapsed` | Time since fuzzing started |
| `execs` | Total executions so far (with per-second rate) |
| `corpus` | Corpus size, with number of new entries since last status |
| `edges` | Unique coverage edges discovered |

## Environment variables

The following environment variables configure Vitiate's behavior. Where a CLI flag equivalent exists, the CLI flag takes precedence.

| Variable | Description | CLI flag equivalent |
|----------|-------------|---------------------|
| `VITIATE_FUZZ_TIME` | Fuzzing time limit in seconds | `--fuzz-time` |
| `VITIATE_FUZZ_EXECS` | Total number of fuzzing iterations | `--fuzz-execs` |
| `VITIATE_MAX_CRASHES` | Maximum crashes to collect | `--max-crashes` |
| `VITIATE_FUZZ` | Set to `1` to enable fuzzing mode (set automatically by `vitiate fuzz`) | - |
| `VITIATE_OPTIMIZE` | Set to `1` to enable optimize mode (set automatically by `vitiate optimize`) | - |
| `VITIATE_DEBUG` | Set to `1` to enable debug logging | - |

`VITIATE_FUZZ` and `VITIATE_OPTIMIZE` are mutually exclusive. The `vitiate fuzz` and `vitiate optimize` subcommands set these automatically - you typically only need to set them manually when invoking Vitest directly without the CLI.
