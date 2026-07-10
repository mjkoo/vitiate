## MODIFIED Requirements

### Requirement: If/else instrumentation

The plugin SHALL insert a coverage counter at the entry of both the consequent and alternate
branches of an `if` statement. If the `if` has no `else` clause, the plugin SHALL synthesize
an `else` block containing a single not-taken coverage counter, so that "the condition
evaluated false" is recorded distinctly from "the branch was never reached". The synthesized
not-taken counter SHALL use an edge ID distinct from the consequent's counter.

#### Scenario: If with else

- **WHEN** `if (c) { A } else { B }` is transformed
- **THEN** a counter increment is prepended to the consequent block (before `A`) and to
  the alternate block (before `B`)

#### Scenario: If without else

- **WHEN** `if (c) { A }` is transformed (no else clause)
- **THEN** a counter increment is prepended to the consequent block (before `A`)
- **AND** a synthetic `else { counter++ }` is inserted whose counter uses an edge ID
  distinct from the consequent's counter

#### Scenario: If without braces

- **WHEN** `if (c) A;` is transformed (consequent is a single statement, not a block)
- **THEN** the consequent is wrapped in a block `{ counter++; A; }` with the counter
  prepended
- **AND** a synthetic not-taken `else { counter++ }` is inserted

### Requirement: Deterministic edge IDs from source spans

Each edge ID SHALL be computed as `finalize(hash(file_path, span.lo, span.hi, edge_kind)) %
coverage_map_size`, where `span.lo` and `span.hi` are the byte offsets of the AST node being
instrumented and `edge_kind` discriminates the counter's role (block-entry, not-taken else,
loop-exit, comparison site). The base `hash` SHALL be a deterministic FNV-1a over those
inputs. `finalize` SHALL be an avalanche step (murmur3 `fmix64`) applied to the full-width
hash before the modulo reduction, so that the low bits consumed by the reduction depend on
all input bits (FNV-1a's low bits alone are weakly mixed). Edge IDs SHALL be deterministic
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
  `edge_kind` values (for example a block-entry counter and a loop-exit counter)
- **THEN** their edge IDs differ

## ADDED Requirements

### Requirement: Loop-exit edge instrumentation

The plugin SHALL insert a loop-exit coverage counter as the statement immediately following
each loop (`for`, `while`, `do-while`, `for-in`, `for-of`) in the enclosing statement list,
so that "the loop was reached and exited (including running zero iterations)" is recorded
distinctly from "the loop was never reached". The loop-exit counter SHALL use an edge ID
distinct from the loop body's entry counter.

The plugin SHALL NOT wrap the loop in a block to place the counter, because wrapping a
labeled loop would make `continue label` target a non-iteration label (a syntax error). When
the loop is labeled, the counter SHALL be inserted after the outermost label. Loops at module
top level (which reside in a module-item list rather than a statement list) SHALL also receive
a loop-exit counter.

The loop-exit counter fires on normal fall-through past the loop and on `break` to the
following statement; it does not fire on `return` or `throw` out of the loop body (those are
not loop-exit edges).

#### Scenario: Loop-exit counter follows the loop

- **WHEN** `while (c) { A }` is transformed
- **THEN** a loop-exit counter is inserted as the statement immediately after the loop,
  with an edge ID distinct from the body-entry counter

#### Scenario: Each loop kind gets a loop-exit counter

- **WHEN** any of `for`, `while`, `do-while`, `for-in`, or `for-of` is transformed
- **THEN** the loop receives a body-entry counter and a following loop-exit counter

#### Scenario: Labeled loop keeps continue/break valid

- **WHEN** `outer: for (;;) { continue outer; }` is transformed
- **THEN** the `continue outer` statement is preserved unchanged (the loop is not wrapped in
  a block)
- **AND** exactly one loop-exit counter is inserted after the labeled statement

#### Scenario: Nested braceless loops are both instrumented

- **WHEN** `for (;;) for (;;) A;` is transformed
- **THEN** both the inner and outer loops receive a body-entry counter and a loop-exit
  counter (four coverage counters total)

#### Scenario: Module top-level loop

- **WHEN** a loop appears at module top level (in the module-item list, not a block)
- **THEN** it still receives a loop-exit counter
