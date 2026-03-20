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
- **THEN** the output is `((l, r) => (__vitiate_cmplog_write(l, r, CMP_ID, 0), l === r))(a, b)`

#### Scenario: Less-than

- **WHEN** `a < b` is transformed
- **THEN** the output is `((l, r) => (__vitiate_cmplog_write(l, r, CMP_ID, 4), l < r))(a, b)`

#### Scenario: All comparison operators

- **WHEN** any of `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=` is transformed
- **THEN** the numeric operator ID passed to `__vitiate_cmplog_write` matches the operator's assigned ID
- **AND** the original comparison operator is preserved in the IIFE body

#### Scenario: Operands evaluated exactly once

- **WHEN** `f() < g()` is transformed
- **THEN** `f()` is evaluated once as the first argument to the IIFE
- **AND** `g()` is evaluated once as the second argument to the IIFE
- **AND** the record call and comparison both use the IIFE parameters `l` and `r`, not the original expressions
- **AND** re-entrant instrumentation inside `f()` or `g()` cannot affect the outer comparison's operands because IIFE parameters are stack-scoped

#### Scenario: cmp_id stored in accumulator

- **WHEN** the record function is called with cmp_id `42`
- **THEN** the slot buffer entry SHALL include cmpId `42`
- **AND** after `drain()`, the CmpLog accumulator entry SHALL include site ID `42`

#### Scenario: operator ID stored as CmpLogOperator in accumulator

- **WHEN** the record function is called with operator ID `4` (less-than)
- **THEN** the slot buffer entry SHALL include operatorId `4`
- **AND** after `drain()`, the CmpLog accumulator entry SHALL include `CmpLogOperator::Less`

### Requirement: Configurable trace-cmp toggle

The plugin SHALL accept a `traceCmp` boolean in its configuration. When `false`, comparison tracing instrumentation is skipped entirely. Default: `true`.

#### Scenario: Trace-cmp disabled

- **WHEN** the plugin is configured with `{ "traceCmp": false }`
- **THEN** comparison operators are NOT wrapped with the tracing IIFE
- **AND** edge coverage counters are still inserted normally
- **AND** no `__vitiate_cmplog_write` preamble var is emitted

#### Scenario: Custom traceCmpGlobalName

- **WHEN** the plugin is configured with `{ "traceCmpGlobalName": "__my_record" }`
- **THEN** the preamble contains `var __my_record = globalThis.__my_record;`
- **AND** IIFE bodies reference `__my_record` instead of `__vitiate_cmplog_write`

### Requirement: Module preamble includes record function variable

When `traceCmp` is enabled, the module/script preamble SHALL include a `var` declaration that caches the record function from `globalThis`. No additional temporary variable declarations are needed - the IIFE parameters provide operand isolation.

The default name for the record function preamble variable is `__vitiate_cmplog_write` (configurable via `traceCmpGlobalName`).

#### Scenario: Preamble with trace-cmp enabled

- **WHEN** a module is transformed with `traceCmp: true` (default)
- **THEN** the preamble contains `var __vitiate_cov = globalThis.__vitiate_cov;`
- **AND** `var __vitiate_cmplog_write = globalThis.__vitiate_cmplog_write;`

#### Scenario: Preamble with trace-cmp disabled

- **WHEN** a module is transformed with `traceCmp: false`
- **THEN** the preamble contains `var __vitiate_cov = globalThis.__vitiate_cov;`
- **AND** no `__vitiate_cmplog_write` preamble var is emitted
