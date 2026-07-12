## ADDED Requirements

### Requirement: Experimental coverage-granularity plugin options

The `vitiatePlugin(options?)` factory SHALL accept two optional, experimental boolean options that
control finer-grained instrumentation, both defaulting to `false`:

- `traceCalls` (boolean, optional, default `false`): emit a coverage counter at every call and
  `new` expression (see the `edge-coverage` capability).
- `traceStmtBlocks` (boolean, optional, default `false`): emit a coverage counter between
  consecutive straight-line statements (see the `edge-coverage` capability).

These options SHALL follow the same resolution model as `coverageMapSize`. The getters
`getTraceCalls()` / `getTraceStmtBlocks()` SHALL resolve module-scoped state first (set by the
`config()` hook in the main process via `setTraceCalls` / `setTraceStmtBlocks`), then the
environment variables `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS`, then the default `false`.

Because instrumentation runs at transform time in a process where the plugin hook may not have run
(a forks-pool worker), the `config()` hook SHALL propagate a provided option to the corresponding
environment variable so workers instrument with the same setting. Unlike the always-overwritten
internal variables (`VITIATE_PROJECT_ROOT` / `VITIATE_DATA_DIR` / `VITIATE_COVERAGE_MAP_SIZE`), the
hook SHALL write `VITIATE_TRACE_CALLS` / `VITIATE_TRACE_STMT_BLOCKS` ONLY when the corresponding
option is explicitly provided, so an externally-set value survives when no option is given (enabling
env-only A/B toggling without editing config). An explicitly provided option SHALL take precedence
over an inherited environment value.

#### Scenario: Options default to off

- **WHEN** `vitiatePlugin()` is called with neither option and neither env var is set
- **THEN** `getTraceCalls()` and `getTraceStmtBlocks()` both resolve to `false`
- **AND** no call-site or statement-block counters are emitted

#### Scenario: Option is resolved and propagated to workers

- **WHEN** the `config()` hook runs for `vitiatePlugin({ traceCalls: true, traceStmtBlocks: true })`
- **THEN** `getTraceCalls()` and `getTraceStmtBlocks()` resolve to `true` in the main process
- **AND** `VITIATE_TRACE_CALLS` and `VITIATE_TRACE_STMT_BLOCKS` are set to `"1"` for worker processes

#### Scenario: Externally-set env var survives when no option is given

- **WHEN** `VITIATE_TRACE_CALLS` is already `"1"` in the environment
- **AND** the `config()` hook runs for a plugin created without a `traceCalls` option
- **THEN** `VITIATE_TRACE_CALLS` is left unchanged
- **AND** `getTraceCalls()` resolves to `true`

#### Scenario: Explicit option overrides an inherited env value

- **WHEN** `VITIATE_TRACE_CALLS` is `"1"` in the environment
- **AND** the `config()` hook runs for `vitiatePlugin({ traceCalls: false })`
- **THEN** `getTraceCalls()` resolves to `false`
- **AND** `VITIATE_TRACE_CALLS` is overwritten with `"0"`
