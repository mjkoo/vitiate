## MODIFIED Requirements

### Requirement: Export traceCmp napi function

The `@vitiate/engine` package SHALL export a `traceCmpRecord` function callable from JavaScript with the signature:

```ts
function traceCmpRecord(
  left: unknown,
  right: unknown,
  cmpId: number,
  operatorId: number,
): void;
```

The function records comparison operands for CmpLog. It does NOT evaluate the comparison or return a result.

#### Scenario: Function is exported and callable

- **WHEN** `traceCmpRecord` is imported from `@vitiate/engine`
- **THEN** it is a function that accepts four arguments and returns void

### Requirement: Correct comparison evaluation for all operators

The `traceCmpRecord` function SHALL NOT evaluate comparisons. It SHALL only record operands in the CmpLog accumulator when a Fuzzer is active. The comparison is performed in JavaScript by the instrumented code.

The `operatorId` parameter SHALL be a numeric ID mapped to `CmpLogOperator`:

| ID | Operator | CmpLogOperator |
|---|---|---|
| 0 | `===` | Equal |
| 1 | `!==` | NotEqual |
| 2 | `==` | Equal |
| 3 | `!=` | NotEqual |
| 4 | `<` | Less |
| 5 | `>` | Greater |
| 6 | `<=` | Less |
| 7 | `>=` | Greater |

#### Scenario: Operands recorded with correct operator

- **WHEN** a Fuzzer is active
- **AND** `traceCmpRecord("hello", "world", 42, 0)` is called (operator ID 0 = `===`)
- **THEN** the CmpLog accumulator contains an entry with `CmpValues::Bytes` for the UTF-8 representations of `"hello"` and `"world"`, site ID `42`, and `CmpLogOperator::Equal`

#### Scenario: Numeric operands recorded

- **WHEN** a Fuzzer is active
- **AND** `traceCmpRecord(3, 5, 10, 4)` is called (operator ID 4 = `<`)
- **THEN** the CmpLog accumulator contains an entry with the numeric representations of `3` and `5`, site ID `10`, and `CmpLogOperator::Less`

#### Scenario: Invalid operator ID

- **WHEN** `traceCmpRecord(1, 2, 0, 99)` is called
- **THEN** the operands SHALL NOT be recorded (the invalid operator is silently ignored)
- **AND** the function SHALL NOT throw

### Requirement: Passthrough behavior (no LibAFL feedback)

The `traceCmpRecord` function SHALL record comparison operands in the thread-local CmpLog accumulator only when a Fuzzer instance is active (CmpLog recording is enabled). When no Fuzzer is active, the function SHALL be a no-op with no side effects.

#### Scenario: No side effects without active Fuzzer

- **WHEN** `traceCmpRecord` is called without an active Fuzzer
- **THEN** the fuzzer's corpus, coverage map, and statistics are unaffected
- **AND** no comparison operands are recorded anywhere

#### Scenario: Comparison operands recorded during fuzzing

- **WHEN** a Fuzzer instance is active
- **AND** `traceCmpRecord("hello", "world", 42, 0)` is called
- **THEN** the comparison operands are recorded in the CmpLog accumulator as `CmpValues::Bytes` with the UTF-8 representations of `"hello"` and `"world"`

## ADDED Requirements

### Requirement: Record function must not throw

The `traceCmpRecord` function SHALL NOT throw exceptions. Internal errors (serialization failure, invalid operand types, invalid state) SHALL be silently ignored. This is required because the record call precedes the comparison in the IIFE body - if the record call throws, the comparison never executes, which would change program control flow and violate the "comparison tracing preserves semantics" requirement in the comparison-tracing spec.

#### Scenario: Invalid operand types do not throw

- **WHEN** `traceCmpRecord(undefined, null, 0, 0)` is called
- **THEN** the function returns without throwing
- **AND** no CmpLog entry is recorded (operands cannot be serialized)

#### Scenario: Internal serialization failure does not throw

- **WHEN** `traceCmpRecord` encounters an internal error during operand serialization
- **THEN** the function returns without throwing
- **AND** the error is silently discarded
