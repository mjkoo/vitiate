## Requirements

### Requirement: Export traceCmp napi function

The `vitiate-napi` package SHALL export a `traceCmp` function callable from JavaScript with
the signature:

```ts
function traceCmp(
  left: unknown,
  right: unknown,
  cmpId: number,
  op: string,
): boolean;
```

#### Scenario: Function is exported and callable

- **WHEN** `traceCmp` is imported from `vitiate-napi`
- **THEN** it is a function that accepts four arguments and returns a boolean

### Requirement: Correct comparison evaluation for all operators

The `traceCmp` function SHALL evaluate the comparison specified by the `op` string and
return the correct boolean result matching JavaScript semantics for the given operator.

Supported operators: `===`, `!==`, `==`, `!=`, `<`, `>`, `<=`, `>=`.

#### Scenario: Strict equality - same type, same value

- **WHEN** `traceCmp(42, 42, 0, "===")` is called
- **THEN** the return value is `true`

#### Scenario: Strict equality - different types

- **WHEN** `traceCmp(42, "42", 0, "===")` is called
- **THEN** the return value is `false`

#### Scenario: Abstract equality - type coercion

- **WHEN** `traceCmp(42, "42", 0, "==")` is called
- **THEN** the return value is `true`

#### Scenario: Strict inequality

- **WHEN** `traceCmp(1, 2, 0, "!==")` is called
- **THEN** the return value is `true`

#### Scenario: Less-than with numbers

- **WHEN** `traceCmp(3, 5, 0, "<")` is called
- **THEN** the return value is `true`

#### Scenario: Greater-than-or-equal with strings

- **WHEN** `traceCmp("b", "a", 0, ">=")` is called
- **THEN** the return value is `true`

#### Scenario: Unknown operator

- **WHEN** `traceCmp(1, 2, 0, "???")` is called
- **THEN** the function SHALL throw an error

### Requirement: Passthrough behavior (no LibAFL feedback)

In this iteration, `traceCmp` SHALL NOT feed operand values to LibAFL. It SHALL only
evaluate the comparison and return the result. The function signature is designed for future
CmpLog integration - when that lands, the internals change but the signature stays the same.

#### Scenario: No side effects beyond comparison

- **WHEN** `traceCmp` is called during a fuzzing loop
- **THEN** the fuzzer's corpus, coverage map, and statistics are unaffected by the call
  (only `reportResult` updates engine state)
