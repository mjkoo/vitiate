## MODIFIED Requirements

### Requirement: Comparison operator wrapping

The plugin SHALL instrument binary comparison expressions by emitting an immediately invoked arrow function (IIFE) that: (1) receives both operands as function arguments (evaluated exactly once, left-to-right), (2) calls the record-only tracing function with the parameters, comparison site ID, and a numeric operator ID, (3) evaluates the original comparison using the parameters and returns the result.

Operators to instrument: `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`.

The operator SHALL be passed as a numeric ID, not a string. The mapping is:

| Operator | ID | CmpLogOperator |
|---|---|---|
| `===` | 0 | Equal |
| `!==` | 1 | NotEqual |
| `==` | 2 | Equal |
| `!=` | 3 | NotEqual |
| `<` | 4 | Less |
| `>` | 5 | Greater |
| `<=` | 6 | Less |
| `>=` | 7 | Greater |

#### Scenario: Strict equality

- **WHEN** `a === b` is transformed
- **THEN** the output is `((l, r) => (__vitiate_trace_cmp_record(l, r, CMP_ID, 0), l === r))(a, b)`

#### Scenario: Less-than

- **WHEN** `a < b` is transformed
- **THEN** the output is `((l, r) => (__vitiate_trace_cmp_record(l, r, CMP_ID, 4), l < r))(a, b)`

#### Scenario: All comparison operators

- **WHEN** any of `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=` is transformed
- **THEN** the numeric operator ID passed to `__vitiate_trace_cmp_record` matches the operator's assigned ID
- **AND** the original comparison operator is preserved in the IIFE body

#### Scenario: Operands evaluated exactly once

- **WHEN** `f() < g()` is transformed
- **THEN** `f()` is evaluated once as the first argument to the IIFE
- **AND** `g()` is evaluated once as the second argument to the IIFE
- **AND** the record call and comparison both use the IIFE parameters `l` and `r`, not the original expressions
- **AND** re-entrant instrumentation inside `f()` or `g()` cannot affect the outer comparison's operands because IIFE parameters are stack-scoped

#### Scenario: cmp_id stored in accumulator

- **WHEN** the record function is called with cmp_id `42`
- **THEN** the CmpLog accumulator entry SHALL include site ID `42`
- **AND** the site ID SHALL NOT be discarded

#### Scenario: operator ID stored as CmpLogOperator in accumulator

- **WHEN** the record function is called with operator ID `4` (less-than)
- **THEN** the CmpLog accumulator entry SHALL include `CmpLogOperator::Less`

### Requirement: Comparison tracing preserves semantics

The instrumented comparison expression SHALL evaluate to the same boolean value that the original comparison would have returned. The control flow of the program MUST NOT change due to instrumentation. The comparison is evaluated in JavaScript inside the IIFE body, not by the native record function.

#### Scenario: Strict equality result preserved

- **WHEN** `a === b` is instrumented and `a` is `1`, `b` is `1`
- **THEN** the instrumented expression evaluates to `true`

#### Scenario: Type coercion with abstract equality

- **WHEN** `a == b` is instrumented and `a` is `1`, `b` is `"1"`
- **THEN** the instrumented expression evaluates to `true` (matching JS abstract equality semantics)

#### Scenario: Relational comparison

- **WHEN** `a < b` is instrumented and `a` is `3`, `b` is `5`
- **THEN** the instrumented expression evaluates to `true`

#### Scenario: Comparison works in expression positions

- **WHEN** a comparison appears in an expression context (assignment, function argument, return value, ternary condition, for-loop condition)
- **THEN** the IIFE is valid in that position and produces the correct result

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
- **THEN** `a === b` is wrapped with the comparison tracing IIFE
- **AND** `c > d` is wrapped with the comparison tracing IIFE
- **AND** the `&&` right-hand side is wrapped with an edge coverage counter
- **AND** neither comparison receives an additional edge counter

### Requirement: Configurable trace-cmp toggle

The plugin SHALL accept a `traceCmp` boolean in its configuration. When `false`, comparison
tracing instrumentation is skipped entirely. Default: `true`.

#### Scenario: Trace-cmp disabled

- **WHEN** the plugin is configured with `{ "traceCmp": false }`
- **THEN** comparison operators are NOT wrapped with the tracing IIFE
- **AND** edge coverage counters are still inserted normally
- **AND** no `__vitiate_trace_cmp_record` preamble var is emitted

#### Scenario: Custom traceCmpGlobalName

- **WHEN** the plugin is configured with `{ "traceCmpGlobalName": "__my_record" }`
- **THEN** the preamble contains `var __my_record = globalThis.__my_record;`
- **AND** IIFE bodies reference `__my_record` instead of `__vitiate_trace_cmp_record`

### Requirement: Non-comparison binary operators are not traced

Arithmetic (`+`, `-`, `*`, `/`, `%`, `**`), bitwise (`&`, `|`, `^`, `<<`, `>>`, `>>>`),
and `in` / `instanceof` operators SHALL NOT be wrapped with comparison tracing.

#### Scenario: Arithmetic operator

- **WHEN** `a + b` is transformed
- **THEN** the expression is NOT wrapped with the comparison tracing IIFE

## ADDED Requirements

### Requirement: Module preamble includes record function variable

When `traceCmp` is enabled, the module/script preamble SHALL include a `var` declaration that caches the record function from `globalThis`. No additional temporary variable declarations are needed - the IIFE parameters provide operand isolation.

The default name for the record function preamble variable is `__vitiate_trace_cmp_record` (configurable via `traceCmpGlobalName`).

#### Scenario: Preamble with trace-cmp enabled

- **WHEN** a module is transformed with `traceCmp: true` (default)
- **THEN** the preamble contains `var __vitiate_cov = globalThis.__vitiate_cov;`
- **AND** `var __vitiate_trace_cmp_record = globalThis.__vitiate_trace_cmp_record;`

#### Scenario: Preamble with trace-cmp disabled

- **WHEN** a module is transformed with `traceCmp: false`
- **THEN** the preamble contains `var __vitiate_cov = globalThis.__vitiate_cov;`
- **AND** no `__vitiate_trace_cmp_record` preamble var is emitted

### Requirement: Nested and re-entrant comparisons evaluate correctly

Nested comparisons and re-entrant comparisons (via same-module function calls) SHALL evaluate correctly. The IIFE wrapping ensures correctness because each comparison site receives its operands as function parameters, which are stack-scoped and cannot be clobbered by inner instrumentation.

#### Scenario: Nested comparison in same expression

- **WHEN** `(a < b) === (c > d)` is transformed and executed
- **THEN** the inner `a < b` IIFE evaluates with its own `l` and `r` parameters, producing a boolean
- **AND** the inner `c > d` IIFE evaluates with its own `l` and `r` parameters, producing a boolean
- **AND** the outer `===` IIFE receives the two boolean results as arguments and compares them correctly
- **AND** no interference occurs between inner and outer IIFE parameters

#### Scenario: Same-module function call with instrumented comparisons

- **WHEN** `f() < g()` is transformed where both `f()` and `g()` are defined in the same module and contain instrumented comparisons
- **THEN** `f()` is evaluated as the first IIFE argument, and any instrumented comparisons inside `f()` execute in their own IIFE stack frames
- **AND** `g()` is evaluated as the second IIFE argument, and any instrumented comparisons inside `g()` execute in their own IIFE stack frames
- **AND** the outer IIFE's `l` parameter holds `f()`'s return value and `r` holds `g()`'s return value
- **AND** the outer comparison `l < r` evaluates `f()'s return < g()'s return`, which is semantically correct
