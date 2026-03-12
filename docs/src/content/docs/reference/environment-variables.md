---
title: Environment Variables
description: All environment variables recognized by Vitiate.
---

## Mode Selection

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ` | `1` | Enables [fuzzing mode](/vitiate/concepts/corpus/#fuzzing-mode). Each `fuzz()` call becomes a supervisor and enters the mutation-driven fuzz loop. Also set internally by the `npx vitiate` CLI. |
| `VITIATE_OPTIMIZE` | `1` | Enables [corpus minimization mode](/vitiate/concepts/corpus/#corpus-minimization). Replays all corpus entries, runs set cover, and deletes redundant cached entries. |

When neither is set, `fuzz()` runs in [regression mode](/vitiate/concepts/corpus/#regression-mode) - replaying saved corpus entries as test cases.

## Configuration

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ_TIME` | integer | Total fuzzing time in seconds. Overrides `fuzzTimeMs` from code and `-max_total_time` from CLI. |
| `VITIATE_FUZZ_EXECS` | integer | Maximum fuzzing iterations. Overrides `fuzzExecs` from code and `-runs` from CLI. |
| `VITIATE_DEBUG` | `1` | Enable debug output (logs mode, coverage map size, and internal state). |

## Internal

These are set by Vitiate internally. Do not set them manually unless building a custom runner.

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_SUPERVISOR` | `1` | Indicates the process is a supervised child worker. Set by the supervisor. |
| `VITIATE_SHMEM` | string | Shared memory handle for coverage map. Set by the supervisor. |

## Precedence

Configuration is resolved in this order (highest priority first):

1. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`)
2. CLI flags (`-max_total_time`, `-runs`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults
