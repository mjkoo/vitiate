## Requirements

### Requirement: Comparison operator wrapping

The plugin SHALL replace binary comparison expressions with a call to the comparison tracing
function that reports both operands and returns the original comparison result.

Operators to trace: `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`.

The `__vitiate_trace_cmp` runtime function SHALL store the `cmp_id` and `op` parameters alongside the comparison operand values. Previously, `cmp_id` was accepted but unused (prefixed with `_`) and `op` was used only for evaluation then discarded. Now both SHALL be persisted in the CmpLog accumulator as part of the enriched entry tuple.

#### Scenario: Strict equality

- **WHEN** `a === b` is transformed
- **THEN** the output is `__vitiate_trace_cmp(a, b, CMP_ID, "===")`

#### Scenario: Less-than

- **WHEN** `a < b` is transformed
- **THEN** the output is `__vitiate_trace_cmp(a, b, CMP_ID, "<")`

#### Scenario: All comparison operators

- **WHEN** any of `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=` is transformed
- **THEN** the operator string passed to `__vitiate_trace_cmp` matches the original operator

#### Scenario: cmp_id stored in accumulator

- **WHEN** `__vitiate_trace_cmp(a, b, 42, "===")` is called
- **THEN** the CmpLog accumulator entry SHALL include site ID `42`
- **AND** the site ID SHALL NOT be discarded

#### Scenario: op stored as CmpLogOperator in accumulator

- **WHEN** `__vitiate_trace_cmp(a, b, 7, "<")` is called
- **THEN** the CmpLog accumulator entry SHALL include `CmpLogOperator::Less`
- **AND** the operator SHALL NOT be discarded after evaluation

### Requirement: Comparison tracing preserves semantics

The `__vitiate_trace_cmp` runtime function SHALL return the same boolean value that the
original comparison would have returned. The control flow of the program MUST NOT change due
to instrumentation.

#### Scenario: Strict equality result preserved

- **WHEN** `__vitiate_trace_cmp(1, 1, id, "===")` is called
- **THEN** the return value is `true`

#### Scenario: Type coercion with abstract equality

- **WHEN** `__vitiate_trace_cmp(1, "1", id, "==")` is called
- **THEN** the return value is `true` (matching JS abstract equality semantics)

#### Scenario: Relational comparison

- **WHEN** `__vitiate_trace_cmp(3, 5, id, "<")` is called
- **THEN** the return value is `true`

### Requirement: Comparison IDs are deterministic

Comparison IDs SHALL be computed using the same hash scheme as edge coverage IDs:
`hash(file_path, span.lo, span.hi) % coverage_map_size`.

#### Scenario: Same comparison produces same ID across compilations

- **WHEN** the same source file containing `x === y` is compiled twice
- **THEN** the same comparison ID is produced

### Requirement: No double-instrumentation of binary expressions

The `visit_mut_bin_expr` handler SHALL distinguish between logical operators (`&&`, `||`,
`??`) which receive edge coverage counters, and comparison operators (`===`, `<`, etc.)
which receive trace wrappers. A single `BinExpr` node SHALL receive one or the other,
never both.

#### Scenario: Comparison inside logical expression

- **WHEN** `a === b && c > d` is transformed
- **THEN** `a === b` is wrapped with `__vitiate_trace_cmp`
- **AND** `c > d` is wrapped with `__vitiate_trace_cmp`
- **AND** the `&&` right-hand side is wrapped with an edge coverage counter
- **AND** neither comparison receives an additional edge counter

### Requirement: Configurable trace-cmp toggle

The plugin SHALL accept a `traceCmp` boolean in its configuration. When `false`, comparison
tracing instrumentation is skipped entirely. Default: `true`.

#### Scenario: Trace-cmp disabled

- **WHEN** the plugin is configured with `{ "traceCmp": false }`
- **THEN** comparison operators are NOT wrapped with `__vitiate_trace_cmp`
- **AND** edge coverage counters are still inserted normally

### Requirement: Non-comparison binary operators are not traced

Arithmetic (`+`, `-`, `*`, `/`, `%`, `**`), bitwise (`&`, `|`, `^`, `<<`, `>>`, `>>>`),
and `in` / `instanceof` operators SHALL NOT be wrapped with comparison tracing.

#### Scenario: Arithmetic operator

- **WHEN** `a + b` is transformed
- **THEN** the expression is NOT wrapped with `__vitiate_trace_cmp`
