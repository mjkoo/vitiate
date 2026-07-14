# Design - remove coverage-granularity counters

## Context

Reverting the opt-in call-site / statement-block counters after two A/B campaigns
found no effectiveness benefit (see proposal). The feature spans the SWC plugin,
`@vitiate/core` config/plugin, docs, and two spec capabilities. The goal is a
clean surgical removal that leaves the *default* instrumentation and every
surviving edge ID unchanged.

## Key decisions

### 1. Surgical removal, not a revert of the original commit(s)

The original change bundled a genuine correctness fix into the default path:
comparison-valued short-circuit / ternary / arrow / short-circuit-assign arm
counters now key on the arm's real span (`right_span` / `cons_span` / `alt_span`)
instead of collapsing to `id(file, 0, 0)`. Those sites use `EdgeKind::Block` and
are independent of the two counter kinds being removed. **They must stay.** So the
removal is done by deleting the `Call` / `StmtBlock` code paths and their flags,
not by reverting the change wholesale.

### 2. Invariant: default (flags-off) output is byte-identical

`EdgeKind::Call` and `EdgeKind::StmtBlock` counters are emitted *only* when
`trace_calls` / `trace_stmt_blocks` are true; both defaulted false. Therefore
removing them and their flags cannot alter the default transform output. The
surviving discriminants keep their values (`Block`=0, `ElseNotTaken`=1,
`LoopExit`=2, `Cmp`=3), so `edge_id = hash(file, lo, hi, kind)` is unchanged for
every existing edge - no corpus/coverage-map disruption for existing users.

Verification: the existing instrumentation snapshot/e2e tests (which run with the
default flags off) must pass unchanged after removal; that is the byte-identical
check. Any test that asserted flag-on behavior is deleted, not adjusted.

### 3. Removal surface (concrete)

- `vitiate-swc-plugin/src/lib.rs`: `PluginConfig.trace_calls` / `trace_stmt_blocks`
  fields + `Default`; `EdgeKind::Call` / `StmtBlock` variants + their `value()`
  arms; `is_instrumentable_call`; the `trace_calls` guard block in `visit_mut_expr`
  that wraps calls; `insert_stmt_block_counters` + its two guarded call sites in the
  statement/module-item visitors; associated `#[cfg(test)]` unit tests; doc comments
  that reference the removed kinds. Leave `edge_id`, `make_counter_stmt/expr`,
  `wrap_with_counter` (still used by `Block`) intact.
- `vitiate-core/src/config.ts`: `traceCalls` / `traceStmtBlocks` option schema
  fields; `getTraceCalls` / `getTraceStmtBlocks` / `setTraceCalls` /
  `setTraceStmtBlocks` / `resetTraceFlags`; the two entries in the known-env-var
  allowlist.
- `vitiate-core/src/plugin.ts`: reading the two options in `config()`, setting the
  two `VITIATE_TRACE_*` env vars for workers, and passing `traceCalls` /
  `traceStmtBlocks` into the SWC plugin options.
- Tests: the trace-flag cases in `config.test.ts` and `plugin.test.ts`.
- Docs: `reference/plugin-options.md` (two rows) and
  `reference/environment-variables.md` (two vars).

### 4. Spec deltas

- `edge-coverage`: REMOVED `Call-site edge instrumentation` and `Statement-block
  edge instrumentation`; MODIFY `Deterministic edge IDs from source spans` /
  `Counter increment code shape` only where they enumerate the removed
  `edge_kind`s (drop "call-site" / "statement-block" from the illustrative kind
  lists; keep block / not-taken / loop-exit / comparison).
- `vitest-plugin`: REMOVED `Experimental coverage-granularity plugin options`.

### 5. Keep the benchmark harness

`benchmarks/ab-neutral.mjs`, `ab-replay.mjs`, `ab-crash.mjs`, `targets.mjs`, and
the `VITIATE_TRACE_*` A/B arm scaffolding are retained as the re-test path. They
reference the env vars but only set them on child processes; with the plugin no
longer honoring them the arms collapse to baseline, which is harmless. (They live
outside the shipped packages; no spec covers them.)

## Risks

- **Accidentally shifting a default edge ID.** Mitigated by the byte-identical
  invariant (§2) and gated by the unchanged instrumentation snapshot tests.
- **Dropping the span-aliasing fix by over-deleting.** Mitigated by §1 - the fix
  is `EdgeKind::Block` usage and is explicitly out of scope for deletion.

## Open questions

_None._ Proceeding to delta specs + tasks + implementation on approval.
