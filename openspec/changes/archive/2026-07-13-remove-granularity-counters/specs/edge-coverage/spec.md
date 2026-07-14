## MODIFIED Requirements

### Requirement: Deterministic edge IDs from source spans

Each edge ID SHALL be computed as `finalize(hash(file_path, span.lo, span.hi, edge_kind)) %
coverage_map_size`, where `span.lo` and `span.hi` are the byte offsets of the AST node being
instrumented and `edge_kind` discriminates the counter's role (block-entry, not-taken else,
loop-exit, comparison site). The base `hash` SHALL be a deterministic
FNV-1a over those inputs. `finalize` SHALL be an avalanche step (murmur3 `fmix64`) applied to the
full-width hash before the modulo reduction, so that the low bits consumed by the reduction depend
on all input bits (FNV-1a's low bits alone are weakly mixed). Edge IDs SHALL be deterministic
(same inputs always produce the same output). The file path SHALL come from the SWC plugin
metadata.

#### Scenario: Same file produces same IDs across compilations

- **WHEN** the same source file is compiled twice (clean build, incremental build, different
  compilation order)
- **THEN** the same edge IDs are produced for the same branch points

#### Scenario: Different files produce different IDs for same source positions

- **WHEN** two files have identical source code but different file paths
- **THEN** the edge IDs at corresponding positions differ (modulo hash collisions)

#### Scenario: Edge kind discriminates IDs at a shared span

- **WHEN** two counters are computed for the same file path and span but different
  `edge_kind` values (for example a block-entry counter and a loop-exit counter, or a
  block-entry counter and a comparison counter)
- **THEN** their edge IDs differ

## REMOVED Requirements

### Requirement: Call-site edge instrumentation

**Reason**: The opt-in call-site counters (`traceCalls` / `VITIATE_TRACE_CALLS`, `EdgeKind::Call`)
were gated on a benchmark deciding whether they should be enabled. Two A/B campaigns (2026-07-12
xword-parser; 2026-07-13 deep CJS targets node-forge/jpeg-js, 3 variance repeats) found no reliable
neutral-coverage benefit - within run-to-run noise, trending slightly negative - at a 15-24%
throughput cost, so the feature is removed rather than shipped as dead opt-in weight. Details:
`benchmarks/results/2026-07-13-ab-granularity-phase2-decision.md`.

**Migration**: None required. The counters were opt-in and off by default; with the flag removed,
instrumentation output equals the prior default (flags-off) output byte-for-byte, and every
surviving edge ID is unchanged. Any `VITIATE_TRACE_CALLS` env var or `traceCalls` plugin option is
simply no longer honored. Re-introducing call-site counters later is a small, self-contained change
(the `EdgeKind` discriminant folds into the edge-id hash for free).

### Requirement: Statement-block edge instrumentation

**Reason**: The opt-in statement-block counters (`traceStmtBlocks` / `VITIATE_TRACE_STMT_BLOCKS`,
`EdgeKind::StmtBlock`) were gated on the same benchmark decision and showed the same lack of
neutral-coverage benefit with the largest edge-bloat and throughput cost of the two, while adding
the most error-prone code in the plugin (directive/hoist/terminator-aware insertion with `continue`
label peeling). Removed for the same reason as the call-site counters.

**Migration**: None required. Off by default and unreleased; with the flag removed, default
instrumentation output is unchanged byte-for-byte and all surviving edge IDs are preserved. Any
`VITIATE_TRACE_STMT_BLOCKS` env var or `traceStmtBlocks` plugin option is no longer honored.
