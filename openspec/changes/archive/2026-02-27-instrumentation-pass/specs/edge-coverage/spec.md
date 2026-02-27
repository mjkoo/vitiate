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
branches of an `if` statement. If the `if` has no `else` clause, the plugin SHALL NOT
synthesize one.

#### Scenario: If with else

- **WHEN** `if (c) { A } else { B }` is transformed
- **THEN** a counter increment is prepended to the consequent block (before `A`) and to
  the alternate block (before `B`)

#### Scenario: If without else

- **WHEN** `if (c) { A }` is transformed (no else clause)
- **THEN** a counter increment is prepended to the consequent block (before `A`)
- **AND** no alternate block is synthesized

#### Scenario: If without braces

- **WHEN** `if (c) A;` is transformed (consequent is a single statement, not a block)
- **THEN** the consequent is wrapped in a block `{ counter++; A; }` with the counter
  prepended

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

The plugin SHALL prepend a coverage counter to the body of every function (function
declarations, function expressions, arrow functions with block bodies, methods, getters,
setters, constructors).

#### Scenario: Function declaration

- **WHEN** `function foo() { A }` is transformed
- **THEN** a counter is prepended to the function body (before `A`)

#### Scenario: Arrow function with block body

- **WHEN** `const f = () => { A }` is transformed
- **THEN** a counter is prepended to the arrow function body (before `A`)

#### Scenario: Arrow function with expression body

- **WHEN** `const f = () => expr` is transformed
- **THEN** the arrow function body is NOT modified (expression-body arrows have no block
  to prepend to; the function entry is covered by the call site's edge)

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

Each edge ID SHALL be computed as `hash(file_path, span.lo, span.hi) % coverage_map_size`
where `span.lo` and `span.hi` are the byte offsets of the AST node being instrumented. The
hash function SHALL be deterministic (same inputs always produce same output). The file path
SHALL come from the SWC plugin metadata.

#### Scenario: Same file produces same IDs across compilations

- **WHEN** the same source file is compiled twice (clean build, incremental build, different
  compilation order)
- **THEN** the same edge IDs are produced for the same branch points

#### Scenario: Different files produce different IDs for same source positions

- **WHEN** two files have identical source code but different file paths
- **THEN** the edge IDs at corresponding positions differ (modulo hash collisions)
