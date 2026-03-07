## MODIFIED Requirements

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
