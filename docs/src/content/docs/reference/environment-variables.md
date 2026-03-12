---
title: Environment Variables
description: All environment variables recognized by Vitiate.
---

## Mode Selection

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ` | `1` | Enables [fuzzing mode](/concepts/corpus/#fuzzing-mode). Each `fuzz()` call becomes a supervisor and enters the mutation-driven fuzz loop. Also set internally by the `npx vitiate` CLI. |
| `VITIATE_OPTIMIZE` | `1` | Enables [corpus minimization mode](/concepts/corpus/#corpus-minimization). Replays all corpus entries, runs set cover, and deletes redundant cached entries. |

When neither is set, `fuzz()` runs in [regression mode](/concepts/corpus/#regression-mode) - replaying saved corpus entries as test cases.

## Configuration

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ_TIME` | integer | Total fuzzing time in seconds. Overrides `fuzzTimeMs` from code and `-max_total_time` from CLI. |
| `VITIATE_FUZZ_EXECS` | integer | Maximum fuzzing iterations. Overrides `fuzzExecs` from code and `-runs` from CLI. |
| `VITIATE_DEBUG` | `1` | Enable debug output (logs mode, coverage map size, and internal state). |
| `VITIATE_MAX_CRASHES` | integer | Maximum crashes to collect before stopping. Overrides `maxCrashes` from code. |

## Internal

These are set by Vitiate internally. Do not set them manually unless building a custom runner.

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_SUPERVISOR` | `1` | Indicates the process is a supervised child worker. Set by the supervisor. |
| `VITIATE_SHMEM` | string | Shared memory handle for coverage map. Set by the supervisor. |

## Precedence

### `fuzz`, `regression`, and `optimize` subcommands

Configuration is resolved in this order (highest priority first):

1. CLI flags (`--fuzz-time`, `--fuzz-execs`, `--max-crashes`)
2. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`, `VITIATE_MAX_CRASHES`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults

### `libfuzzer` subcommand

For the libFuzzer-compatible CLI, environment variables take highest priority to match libFuzzer conventions:

1. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`)
2. CLI flags (`-max_total_time`, `-runs`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults
