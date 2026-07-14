## REMOVED Requirements

### Requirement: Experimental coverage-granularity plugin options

**Reason**: The `traceCalls` / `traceStmtBlocks` plugin options (and their
`getTraceCalls` / `getTraceStmtBlocks` env resolution over `VITIATE_TRACE_CALLS` /
`VITIATE_TRACE_STMT_BLOCKS`) exposed the opt-in call-site and statement-block counters, which are
being removed after two A/B campaigns found no effectiveness benefit at a real throughput cost
(`benchmarks/results/2026-07-13-ab-granularity-phase2-decision.md`). With the underlying counters
gone, these options and env vars have nothing to control.

**Migration**: None required. Both options defaulted to `false` and were unreleased. Remove any
`traceCalls` / `traceStmtBlocks` entries from `vitiatePlugin({ ... })` and any `VITIATE_TRACE_CALLS`
/ `VITIATE_TRACE_STMT_BLOCKS` environment variables; they are no longer read, and default
instrumentation behavior is unchanged. Other plugin options (`coverageMapSize`, `dataDir`,
`instrument`, `fuzz`) are unaffected.
