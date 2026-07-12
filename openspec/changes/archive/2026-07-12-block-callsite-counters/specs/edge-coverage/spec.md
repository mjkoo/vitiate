## ADDED Requirements

### Requirement: Call-site edge instrumentation

When the `traceCalls` plugin option is enabled, the plugin SHALL instrument each call expression
and `new` expression with a call-site coverage counter, so that "control reached this call site"
is recorded as a distinct edge. The counter SHALL wrap the entire call in expression position -
`(__vitiate_cov[EDGE_ID]++, <call>)` - keyed on the call expression's span, using a call-site
`edge_kind` distinct from the block-entry, not-taken, loop-exit, and comparison kinds. The counter
fires when control reaches the call site (before argument evaluation), so a call that throws
leaves earlier call-site counters in the same block fired and later ones un-fired.

The plugin SHALL wrap the whole call expression, never only its callee, so the method receiver
(`this`) binding, argument evaluation order, and short-circuiting are preserved.

The plugin SHALL NOT instrument `super(...)` calls (to avoid perturbing constructor `this`
initialization ordering) or dynamic `import(...)` expressions. Optional-chaining calls (`a?.b()`)
SHALL be instrumented by wrapping the whole call. The plugin SHALL NOT instrument the comparison
IIFE and record call it synthesizes for CmpLog (those are generated after the user AST is visited
and are not re-traversed).

When the `traceCalls` option is disabled (the default), the plugin SHALL emit no call-site
counters and its output SHALL be identical to output produced with call-site instrumentation
absent.

#### Scenario: Ordinary call is wrapped

- **WHEN** `traceCalls` is enabled and `foo(a, b)` is transformed
- **THEN** the call becomes `(__vitiate_cov[N]++, foo(a, b))` where N is a call-site edge ID
  distinct from any enclosing block-entry counter

#### Scenario: Method call preserves the receiver

- **WHEN** `traceCalls` is enabled and `obj.method(x)` is transformed
- **THEN** the whole call is wrapped as `(__vitiate_cov[N]++, obj.method(x))`, keeping `obj` as
  the `this` receiver (the callee is not wrapped in isolation)

#### Scenario: new expression is instrumented

- **WHEN** `traceCalls` is enabled and `new Foo(x)` is transformed
- **THEN** the expression becomes `(__vitiate_cov[N]++, new Foo(x))`

#### Scenario: super and dynamic import are skipped

- **WHEN** `traceCalls` is enabled and a body contains `super(x)` and `import(y)`
- **THEN** neither expression receives a call-site counter

#### Scenario: Synthesized comparison call is not double-wrapped

- **WHEN** `traceCalls` and comparison tracing are both enabled and `a === b` is transformed
- **THEN** the CmpLog record IIFE the plugin synthesizes for the comparison receives no call-site
  counter

#### Scenario: Disabled by default

- **WHEN** `traceCalls` is not set (default) and any call expression is transformed
- **THEN** no call-site counter is emitted

### Requirement: Statement-block edge instrumentation

When the `traceStmtBlocks` plugin option is enabled, the plugin SHALL insert a coverage counter
between consecutive statements in each statement list (block, function, switch-case, and script
bodies via the statement-list hook, and module top level via the module-item hook), so that
straight-line code splits into per-statement edges and each inserted counter fires only if the
preceding statement completed normally. Each inter-statement counter SHALL be keyed on the
following statement's span, using a statement-block `edge_kind` distinct from the block-entry,
not-taken, loop-exit, comparison, and call-site kinds.

The plugin SHALL NOT insert a counter before a leading directive prologue (for example
`"use strict"`) or before a hoisted `FunctionDecl`; those SHALL remain at the head of the list so
hoisting and strict-mode semantics are unchanged. The plugin SHALL stop inserting counters after
the first terminating statement (`return`, `throw`, `break`, `continue`) in a list, because the
remainder is unreachable.

When the `traceStmtBlocks` option is disabled (the default), the plugin SHALL emit no
statement-block counters and its output SHALL be identical to output produced with statement-block
instrumentation absent.

#### Scenario: Counters split straight-line statements

- **WHEN** `traceStmtBlocks` is enabled and a block body `A; B; C;` is transformed (none of
  `A`/`B`/`C` a declaration or terminator)
- **THEN** a statement-block counter is inserted before `B` and before `C`, each with a distinct
  statement-block edge ID, so the three statements occupy three distinct edges

#### Scenario: Module top level is covered

- **WHEN** `traceStmtBlocks` is enabled and straight-line statements appear at module top level
  (a module-item list, not a block)
- **THEN** inter-statement counters are inserted there as well

#### Scenario: Directive prologue and hoisted declarations stay first

- **WHEN** `traceStmtBlocks` is enabled and a function body begins with `"use strict";` followed
  by a hoisted `function helper(){}` and then executable statements
- **THEN** no counter is inserted before the directive or before the hoisted declaration; the
  first inter-statement counter appears no earlier than before the first executable statement

#### Scenario: Insertion stops after a terminator

- **WHEN** `traceStmtBlocks` is enabled and a block body is `A; return x; B;`
- **THEN** no statement-block counter is inserted before `B` (it is unreachable after `return`)

#### Scenario: Disabled by default

- **WHEN** `traceStmtBlocks` is not set (default) and any statement list is transformed
- **THEN** no statement-block counter is emitted

## MODIFIED Requirements

### Requirement: Deterministic edge IDs from source spans

Each edge ID SHALL be computed as `finalize(hash(file_path, span.lo, span.hi, edge_kind)) %
coverage_map_size`, where `span.lo` and `span.hi` are the byte offsets of the AST node being
instrumented and `edge_kind` discriminates the counter's role (block-entry, not-taken else,
loop-exit, comparison site, call-site, statement-block). The base `hash` SHALL be a deterministic
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
  `edge_kind` values (for example a block-entry counter and a call-site counter, or a
  block-entry counter and a statement-block counter)
- **THEN** their edge IDs differ
