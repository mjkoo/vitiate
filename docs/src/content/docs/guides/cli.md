---
title: Using the CLI
description: Running the fuzzer from the command line.
---

The `vitiate` CLI is the primary way to run the fuzzer. It launches Vitest under the hood with instrumentation enabled and the fuzz loop active.

## Basic Usage

```bash
npx vitiate test/parser.fuzz.ts
```

This fuzzes all `fuzz()` targets in the specified file indefinitely (until you press Ctrl+C or a crash is found).

## Targeting a Specific Test

If your file contains multiple `fuzz()` calls, target one by name:

```bash
npx vitiate test/parser.fuzz.ts -test "parse does not crash"
```

## Setting Limits

```bash
# Stop after 60 seconds
npx vitiate test/parser.fuzz.ts -max_total_time 60

# Stop after 100,000 iterations
npx vitiate test/parser.fuzz.ts -runs 100000

# Both (whichever comes first)
npx vitiate test/parser.fuzz.ts -max_total_time 60 -runs 100000
```

## Providing Corpus Directories

Pass additional corpus directories as positional arguments after the test file:

```bash
npx vitiate test/parser.fuzz.ts corpus/ shared-corpus/
```

The fuzzer loads inputs from these directories alongside the seed corpus and cached corpus.

## Using Dictionaries

Point to a dictionary file with domain-specific tokens:

```bash
npx vitiate test/parser.fuzz.ts -dict ./tokens.dict
```

Or place it at `testdata/fuzz/<test-name>.dict` for automatic discovery.

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

## Supervisor Process

The CLI runs a **supervisor** (parent) process that manages crash recovery. When the worker process crashes:

1. The supervisor reads the crashing input from shared memory
2. Writes the crash artifact to disk
3. Spawns a new worker to continue fuzzing

This means the fuzzer is resilient to crashes — it keeps going until you stop it or it hits a configured limit.

See the [CLI Flags Reference](/vitiate/reference/cli-flags/) for the complete list of options.
