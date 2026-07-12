# Edge Coverage

## Purpose

Defines how the SWC instrumentation plugin inserts edge coverage counters at branch, loop,
and function points in JavaScript/TypeScript source, and how deterministic edge IDs are
computed, so that LibAFL's map feedback can distinguish control-flow paths and guide the
fuzzer toward new coverage.
## Requirements
### Requirement: Module preamble injection

The plugin SHALL insert variable declarations at the top of every instrumented module that
cache references to the global coverage map and comparison tracing function:

```js
var __vitiate_cov = globalThis.__vitiate_cov;
var __vitiate_trace_cmp = globalThis.__vitiate_trace_cmp;
```

The global names SHALL be configurable via plugin config. The preamble SHALL be inserted
before all other statements in the module body.

#### Scenario: Module with existing code

- **WHEN** a module containing `console.log("hello");` is transformed
- **THEN** the output begins with the two `var` declarations followed by the original
  `console.log("hello");` statement

#### Scenario: Empty module

- **WHEN** an empty module is transformed
- **THEN** the output contains only the two `var` declarations

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

### Requirement: Ternary expression instrumentation

The plugin SHALL wrap both the consequent and alternate of a conditional (ternary) expression
with a comma expression containing a coverage counter.

#### Scenario: Simple ternary

- **WHEN** `c ? A : B` is transformed
- **THEN** the output is `c ? (__vitiate_cov[ID1]++, A) : (__vitiate_cov[ID2]++, B)`
  where ID1 and ID2 are distinct edge IDs

### Requirement: Switch/case instrumentation

The plugin SHALL prepend a coverage counter to the statement list of each `case` and
`default` clause in a `switch` statement.

#### Scenario: Switch with cases and default

- **WHEN** `switch (x) { case 1: A; break; case 2: B; break; default: C; }` is transformed
- **THEN** each of the three clause bodies has a counter prepended

#### Scenario: Empty case (fall-through)

- **WHEN** a `case` clause has an empty statement list (fall-through)
- **THEN** a counter is still inserted as the sole statement in that clause

### Requirement: Loop body instrumentation

The plugin SHALL insert a coverage counter at the entry of the loop body for `for`,
`while`, `do-while`, `for-in`, and `for-of` statements.

#### Scenario: For loop

- **WHEN** `for (let i = 0; i < n; i++) { A }` is transformed
- **THEN** a counter is prepended to the loop body block

#### Scenario: While loop without braces

- **WHEN** `while (c) A;` is transformed (body is a single statement)
- **THEN** the body is wrapped in a block `{ counter++; A; }` with the counter prepended

#### Scenario: For-of loop

- **WHEN** `for (const x of items) { A }` is transformed
- **THEN** a counter is prepended to the loop body block

### Requirement: Logical operator instrumentation

The plugin SHALL wrap the right-hand side of logical expressions (`&&`, `||`, `??`) with a
comma expression containing a coverage counter, instrumenting the short-circuit evaluation
path.

#### Scenario: Logical AND

- **WHEN** `a && b` is transformed
- **THEN** the output is `a && (__vitiate_cov[ID]++, b)`

#### Scenario: Nullish coalescing

- **WHEN** `a ?? b` is transformed
- **THEN** the output is `a ?? (__vitiate_cov[ID]++, b)`

#### Scenario: Chained logical operators

- **WHEN** `a && b || c` is transformed
- **THEN** both the `&&` right-hand side (`b`) and the `||` right-hand side (`c`) are
  wrapped with distinct counters

### Requirement: Catch block instrumentation

The plugin SHALL prepend a coverage counter to the body of `catch` clauses.

#### Scenario: Try/catch

- **WHEN** `try { A } catch (e) { B }` is transformed
- **THEN** a counter is prepended to the catch body (before `B`)

### Requirement: Function entry instrumentation

The plugin SHALL insert a coverage counter at the entry of every function (function
declarations, function expressions, arrow functions, methods, getters,
setters, constructors). For block bodies, the counter is prepended as a statement. For
arrow functions with expression bodies, the counter is inserted using the comma expression
form: `(__vitiate_cov[ID]++, expr)`.

#### Scenario: Function declaration

- **WHEN** `function foo() { A }` is transformed
- **THEN** a counter is prepended to the function body (before `A`)

#### Scenario: Arrow function with block body

- **WHEN** `const f = () => { A }` is transformed
- **THEN** a counter is prepended to the arrow function body (before `A`)

#### Scenario: Arrow function with expression body

- **WHEN** `const f = () => expr` is transformed
- **THEN** the body is wrapped as `() => (__vitiate_cov[ID]++, expr)` using the comma
  expression form, preserving the return value while recording the function entry edge

### Requirement: Counter increment code shape

The generated counter increment SHALL be `__vitiate_cov[EDGE_ID]++` in statement positions
and `(__vitiate_cov[EDGE_ID]++, originalExpr)` in expression positions. The `Uint8Array`
wraps natively at 256; no masking or saturation logic is needed.

#### Scenario: Statement position

- **WHEN** a counter is inserted in a block body
- **THEN** the generated statement is `__vitiate_cov[N]++;` where N is the edge ID

#### Scenario: Expression position

- **WHEN** a counter wraps a ternary arm `A`
- **THEN** the generated expression is `(__vitiate_cov[N]++, A)`

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

### Requirement: Track novel coverage indices for interesting inputs

When `evaluate_coverage()` determines an input is interesting (triggers new coverage), the system SHALL identify and store the specific coverage map indices that contribute a never-seen feature. These "novel indices" SHALL be stored as `MapNoveltiesMetadata` on the testcase.

The novelty computation SHALL:

1. Before calling `AflMapFeedback::is_interesting()`, compare the current coverage map against the feedback's internal history to identify indices where `map[i] & !history[i] != 0`. Because the coverage map has been classified into AFL-style hit-count bucket bits and the history stores the accumulated bitmask of buckets seen, this comparison identifies indices where the current execution reached a hit-count *bucket* never previously observed at that index - whether higher or lower than earlier observations - not merely a higher raw count within an already-seen bucket.
2. Record these indices as a `Vec<usize>`.
3. After `is_interesting()` confirms the input is interesting, store the recorded indices as `MapNoveltiesMetadata` on the testcase.

`MapNoveltiesMetadata` SHALL be LibAFL's `MapNoveltiesMetadata` type (from `libafl::feedbacks::map`), containing a `list: Vec<usize>` of novel coverage map indices.

Novelty tracking applies to all paths through `evaluate_coverage()` - both the main fuzz loop (`reportResult`) and stage executions (`advanceStage`). Any input added to the corpus SHALL have `MapNoveltiesMetadata` stored on its testcase.

Novelty tracking SHALL NOT occur during calibration. Calibration calls `AflMapFeedback::is_interesting()` multiple times for the same input to detect unstable edges; computing novelties during these re-runs would produce incorrect results (the history changes between runs). The `MapNoveltiesMetadata` stored on a testcase reflects the novelties from the initial `evaluate_coverage()` call that added the input to the corpus, not any subsequent calibration runs.

#### Scenario: Novel indices recorded for interesting input

- **WHEN** a fuzz input triggers coverage at map indices `[42, 107, 255]`
- **AND** indices 42 and 255 were previously zero in the feedback history (newly discovered)
- **AND** index 107 had only bucket `[1,1]` (bit `0x01`) in the history but the current execution reaches bucket `[8,15]` (bit `0x10`, a never-seen bucket)
- **THEN** `MapNoveltiesMetadata` on the testcase SHALL contain `[42, 107, 255]`

#### Scenario: Already-seen bucket is not novel

- **WHEN** index 107's history holds bucket `[4,7]` (bit `0x08`)
- **AND** the current execution has a raw count of 6 at index 107 (still bucket `[4,7]`)
- **THEN** index 107 SHALL NOT appear in `MapNoveltiesMetadata`

#### Scenario: A lower never-seen bucket is novel

- **WHEN** index 107's history holds only bucket `[32,127]` (bit `0x40`)
- **AND** the current execution has a raw count of 2 at index 107 (bucket `[2,2]`, bit `0x02`), lower than any previous observation
- **THEN** index 107 SHALL appear in `MapNoveltiesMetadata` (a never-seen bucket bit)

#### Scenario: No novelty metadata for non-interesting inputs

- **WHEN** a fuzz input does NOT trigger new coverage (not interesting)
- **THEN** no `MapNoveltiesMetadata` SHALL be stored (input is not added to corpus)

#### Scenario: Novelty tracking during stage executions

- **WHEN** a stage execution (I2S, generalization, or Grimoire) triggers new coverage
- **AND** the input is added to the corpus
- **THEN** `MapNoveltiesMetadata` SHALL be stored on the new testcase
- **AND** the new entry can be generalized in a future stage pipeline

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

