---
title: Environment Variables
description: All environment variables recognized by Vitiate.
---

## User-Facing

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ_TIME` | integer | Total fuzzing time in seconds. Overrides `fuzzTimeMs` from code and `--max_total_time` from CLI. |
| `VITIATE_FUZZ_EXECS` | integer | Maximum fuzzing iterations. Overrides `fuzzExecs` from code and `-runs` from CLI. |
| `VITIATE_DEBUG` | `1` | Enable debug output (logs mode, coverage map size, and internal state). |

## Internal

These are set by Vitiate internally and are documented for advanced use cases (CI integration, custom supervisors).

| Variable | Type | Description |
|----------|------|-------------|
| `VITIATE_FUZZ` | `1` | Enables fuzzing mode. Set by the CLI; do not set manually unless building a custom runner. |
| `VITIATE_OPTIMIZE` | `1` | Enables corpus optimization mode (set cover deduplication). |
| `VITIATE_SUPERVISOR` | `1` | Indicates the process is a supervised child worker. Set by the supervisor; do not set manually. |
| `VITIATE_SHMEM` | string | Shared memory handle for coverage map. Set by the supervisor. |

## Precedence

Configuration is resolved in this order (highest priority first):

1. Environment variables (`VITIATE_FUZZ_TIME`, `VITIATE_FUZZ_EXECS`)
2. CLI flags (`-max_total_time`, `-runs`)
3. Per-test `FuzzOptions` in code
4. Plugin-level `fuzz` defaults
5. Built-in defaults
