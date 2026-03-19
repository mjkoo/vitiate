## Context

The SWC plugin currently replaces every comparison operator with `__vitiate_trace_cmp(left, right, cmpId, "op")`, a napi function that both records operands for CmpLog and evaluates the comparison. For `===`/`!==` it uses `env.strict_equals()` (cheap), but for all other operators it calls `eval_comparison()` which invokes `env.run_script()` on every call to retrieve a cached JS function. V8 must hash, compile-cache-lookup, and bind the script source each time - profiled at 42% of wall time on targets with tight comparison loops.

The current instrumented output for `a < b` is:

```js
__vitiate_trace_cmp(a, b, 12345, "<")
```

This replaces the comparison entirely - the boolean result comes back from Rust via napi.

## Goals / Non-Goals

**Goals:**
- Eliminate `env.run_script()` from the per-comparison hot path entirely
- Keep comparison evaluation in JavaScript where V8 can JIT-inline and type-specialize it
- Reduce the napi function to fire-and-forget CmpLog recording (no return value needed)
- Maintain identical program semantics - instrumented code must behave identically to uninstrumented code

**Non-Goals:**
- Optimizing the CmpLog serialization path (`serialize_to_cmp_values`) - it's already cheap
- Changing the CmpLog data format or how the fuzzer engine consumes CmpLog entries
- Reducing the number of comparison sites instrumented (that's a separate filtering concern)
- Changing how `===`/`!==` work in regression mode (they'll use the same new pattern for uniformity)

## Decisions

### Decision 1: IIFE wrapping for operand isolation

The SWC plugin will emit an immediately invoked arrow function (IIFE) that: (1) receives the operands as arguments (evaluated exactly once, left-to-right), (2) calls the record function for CmpLog, (3) evaluates the original comparison using the parameters.

For `a < b`, the output becomes:

```js
((l, r) => (__vitiate_trace_cmp_record(l, r, 12345, 4), l < r))(a, b)
```

The fourth argument to the record function is a numeric operator ID (see Decision 5) rather than a string. The parameters `l` and `r` are function-scoped, so they cannot be clobbered by re-entrant instrumentation (nested comparisons or same-module function calls containing instrumented comparisons).

**Why IIFE:** Function parameters are stack-allocated and scoped to the invocation. When a comparison appears inside a function called during operand evaluation (e.g., `f() < g()` where `g()` contains instrumented comparisons in the same module), the inner IIFE gets its own `l` and `r` on a separate stack frame. No shared mutable state exists between comparison sites, so clobbering is impossible. V8 inlines small arrow functions after a few iterations, so the runtime overhead relative to a bare comma expression is negligible.

**Why comma expression inside the IIFE:** The inner `(record(...), l OP r)` calls the record function (which returns void) then evaluates the comparison - the same sequencing pattern used for edge coverage (`(__vitiate_cov[ID]++, expr)`). The IIFE wrapper provides operand isolation; the inner comma expression sequences recording before comparison.

**Alternative considered - comma expression with shared module-scoped temporaries:** Emit `(__vitiate_t1 = left, __vitiate_t2 = right, record(t1, t2, ...), t1 OP t2)` with two shared `var` declarations in the preamble. Rejected because the right operand's evaluation can clobber `__vitiate_t1`: in `(a < b) === (c > d)`, the inner `c > d` transformation writes to `__vitiate_t1` during `__vitiate_t2 = (inner c > d)`, corrupting the value set by `__vitiate_t1 = (inner a < b)`. The same bug occurs via same-module function calls where the callee's instrumented comparisons clobber the caller's temps.

**Alternative considered - per-site temporaries:** Each comparison site gets unique temp var names (`__vitiate_t_{id}_1`, `__vitiate_t_{id}_2`). Fixes clobbering for AST-level nesting but not for runtime re-entrancy through function calls. Also bloats the preamble linearly with comparison count.

**Alternative considered - wrapper function returning boolean:** Keep the current shape but fix the Rust side (cache napi_refs). Rejected because it still forces every comparison through a napi boundary crossing twice (JS->Rust for record, Rust->JS for cached function call, JS->Rust for result). The IIFE eliminates all round-trips for the comparison itself.

**Alternative considered - separate statement before comparison:** Emit a `__vitiate_trace_cmp_record(a, b, ...)` statement before the comparison expression. Rejected because comparisons appear in expression positions (e.g., `if (a < b)`, `return a === b`, `x = a > b ? c : d`) where you can't insert a preceding statement without restructuring the AST into statement+expression form, which is far more invasive.

### Decision 2: Record function returns void, not boolean

The napi function changes from `traceCmp(left, right, cmpId, op) -> boolean` to `traceCmpRecord(left, right, cmpId, operatorId) -> void`.

**What it does:** Exactly the existing CmpLog recording path - `serialize_to_cmp_values()` + `cmplog::push()`. The comparison evaluation code (`eval_comparison`, `call_js_comparison`, `KNOWN_OPS`) is deleted.

**Why:** The comparison is now performed in JS. The napi function's only job is recording operands for the I2S mutation engine. Returning void makes this explicit and avoids any temptation to reintroduce comparison logic in Rust.

### Decision 3: Rename global from `__vitiate_trace_cmp` to `__vitiate_trace_cmp_record`

The global function name changes to make the behavioral change explicit and avoid silent mismatches between old SWC plugin output and new runtime.

**Why:** If someone has a cached/prebuilt SWC transform using the old name, calling `__vitiate_trace_cmp(a, b, id, "<")` on the new runtime would call `traceCmpRecord` which returns `undefined` instead of a boolean. The comparison result would be lost. A name change causes a clear `ReferenceError` instead of silent data corruption.

The config field `traceCmpGlobalName` default changes from `"__vitiate_trace_cmp"` to `"__vitiate_trace_cmp_record"`.

### Decision 4: Regression mode becomes a no-op function

In regression mode (non-fuzz), `globalThis.__vitiate_trace_cmp_record` is set to a no-op: `() => {}`. There's no CmpLog to record into and no fuzzer consuming the data.

The comparison still executes in JS (inside the IIFE body), so semantics are preserved without the record function doing anything.

**Why not omit the record call entirely in regression mode:** The SWC plugin runs at compile time and doesn't know the runtime mode. The preamble `var __vitiate_trace_cmp_record = globalThis.__vitiate_trace_cmp_record` still needs to resolve to a callable. A no-op function is the cheapest option - V8 will inline it to nothing after a few iterations.

### Decision 5: Pass operator as integer enum, not string

The SWC plugin emits a numeric constant for the operator instead of a string literal. The mapping:

| Operator | ID |
|---|---|
| `===` | 0 |
| `!==` | 1 |
| `==` | 2 |
| `!=` | 3 |
| `<` | 4 |
| `>` | 5 |
| `<=` | 6 |
| `>=` | 7 |

On the Rust side, `traceCmpRecord` receives a `u32` and maps it directly to `CmpLogOperator` without string matching. The existing `CmpLogOperator::from_op(&str)` is replaced by `CmpLogOperator::from_id(u32)`.

**Why:** The operator string was only consumed by `CmpLogOperator::from_op()`, which immediately parsed it back into an enum. Passing an integer skips: (1) V8 string argument marshaling across the napi boundary, (2) string matching in Rust on every call. Since we're already changing the SWC output format and the napi signature, this costs nothing extra to include. The SWC plugin knows the operator at compile time, so emitting a constant is trivial.

**Why these specific IDs:** They match the order in `is_comparison_op()` and `comparison_op_str()` in the SWC plugin. The enum values are defined once in the SWC plugin and once in Rust - both are small exhaustive matches. A shared constant isn't practical across Rust WASM and Rust napi crates, but the mapping is simple enough that documenting it suffices.

## Risks / Trade-offs

**[Risk] Slightly larger instrumented code size** - The IIFE is more tokens than a single function call. For `a < b`, old output is ~45 chars, new output is ~80 chars. For a module with hundreds of comparisons this adds a few KB of source text. Mitigation: V8 parses and inlines small arrow functions efficiently; the runtime cost savings vastly outweigh the parse-time increase. Code size in a fuzzer is not a shipping concern.

**[Risk] Breaking change for anyone caching SWC plugin output** - The output format changes completely. Mitigation: The SWC plugin ships as a WASM binary built from the same repo and versioned together. There is no separate consumption of the plugin outside vitiate's build pipeline. The global name change ensures a loud failure if versions are mismatched.

**[Trade-off] Operator enum defined in two places** - The integer-to-operator mapping exists in both the SWC plugin (Rust WASM) and the engine (Rust napi). These are separate compilation targets that can't share a crate. The mapping is 8 entries and unlikely to change, so duplication is acceptable. Both sides have exhaustive matches that will fail to compile if an arm is missing.
