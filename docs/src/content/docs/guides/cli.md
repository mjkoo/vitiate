---
title: Standalone CLI
description: Running fuzz tests from the command line with npx vitiate.
---

The `vitiate` standalone CLI runs fuzz tests directly from the command line. Its flags follow libFuzzer conventions, so it works as a drop-in replacement for workflows and platforms that expect a libFuzzer-style interface.

For most development workflows, the Vitest-integrated approach (`VITIATE_FUZZ=1 npx vitest run`) is simpler - it handles corpus and artifact paths automatically and runs all fuzz tests in a single command. The CLI is useful when you want direct control over a single target, need to pass libFuzzer-style flags, or are integrating with a fuzzing platform.

## Basic Usage

```bash
npx vitiate test/parser.fuzz.ts
```

This fuzzes all `fuzz()` targets in the specified file indefinitely (until you press Ctrl+C or a crash is found). The CLI sets `VITIATE_FUZZ=1` internally.

### Targeting a Specific Test

If your file contains multiple `fuzz()` calls, target one by name:

```bash
npx vitiate test/parser.fuzz.ts -test "parse does not crash"
```

### Setting Limits

```bash
# Stop after 60 seconds
npx vitiate test/parser.fuzz.ts -max_total_time 60

# Stop after 100,000 iterations
npx vitiate test/parser.fuzz.ts -runs 100000

# Both (whichever comes first)
npx vitiate test/parser.fuzz.ts -max_total_time 60 -runs 100000
```

### Providing Corpus Directories

Pass additional corpus directories as positional arguments after the test file:

```bash
npx vitiate test/parser.fuzz.ts corpus/ shared-corpus/
```

The fuzzer loads inputs from these directories alongside the seed corpus and cached corpus. In Vitest-integrated mode, corpus directories are managed automatically.

### Using Dictionaries

Point to a dictionary file with domain-specific tokens:

```bash
npx vitiate test/parser.fuzz.ts -dict ./tokens.dict
```

In Vitest-integrated mode, place the dictionary at `testdata/fuzz/<test-name>.dict` for automatic discovery instead. See [Dictionaries and Seeds](/vitiate/guides/dictionaries-and-seeds/) for details.

### Controlling Artifact Output

By default, crash and timeout artifacts are written to the seed corpus directory. Override the output location with `-artifact_prefix`:

```bash
npx vitiate test/parser.fuzz.ts -artifact_prefix ./crashes/
```

## Reading the Output

The fuzzer prints a JSON startup banner and periodic status lines:

```
fuzz: elapsed: 3s, execs: 1024 (3412/sec), corpus: 23 (5 new), edges: 142
```

| Field | Meaning |
|-------|---------|
| `elapsed` | Time since fuzzing started |
| `execs` | Total executions so far (with per-second rate) |
| `corpus` | Corpus size, with number of new entries since last status |
| `edges` | Unique coverage edges discovered |

## Corpus Minimization (Merge Mode)

The `-merge 1` flag minimizes a corpus across arbitrary directories:

```bash
# Merge multiple corpus directories into a minimized set
npx vitiate test/parser.fuzz.ts -merge 1 minimized-corpus/ .vitiate-corpus/ extra-corpus/

# Replace the old corpus with the minimized one
rm -rf .vitiate-corpus/
mv minimized-corpus/ .vitiate-corpus/
```

The merge operation evaluates every input's coverage contribution and keeps only the smallest set that maintains the same total coverage. The first positional directory is the output; the rest are inputs.

For Vitest-integrated corpus minimization (without the CLI), see [Corpus Minimization](/vitiate/concepts/corpus/#corpus-minimization).

## Supervisor Process

The CLI runs a **supervisor** (parent) process that manages crash recovery. When the worker process crashes:

1. The supervisor reads the crashing input from shared memory
2. Writes the crash artifact to disk
3. Spawns a new worker to continue fuzzing

This means the fuzzer is resilient to crashes - it keeps going until you stop it or it hits a configured limit.

## libFuzzer Compatibility

libFuzzer's flag conventions are widely adopted by fuzzing platforms, continuous fuzzing services, and CI tooling. The CLI follows these conventions so that Vitiate can be used with the same infrastructure and workflows that exist for native-code fuzzing.

All flags use the libFuzzer naming scheme (`-max_total_time`, `-runs`, `-dict`, etc.) and positional arguments are treated as corpus directories. The following flags are parsed for compatibility but ignored since they do not apply to Vitiate's architecture:

| Flag | Behavior |
|------|----------|
| `-fork` | Parsed, ignored (always 1 - Vitiate uses a single supervised worker) |
| `-jobs` | Parsed, ignored (always 1 - Vitiate runs a single job at a time) |

See the [CLI Flags Reference](/vitiate/reference/cli-flags/) for the complete list of options.
