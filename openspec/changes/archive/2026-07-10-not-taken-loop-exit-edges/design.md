## Context

The SWC WASM plugin (`vitiate-swc-plugin`) instruments JavaScript/TypeScript during Vite's
module transform. Today it inserts a hit-counter (`__vitiate_cov[id]++`) at the entry of each
*taken* block (if-consequent, explicit else, ternary arms, loop bodies, switch cases, function
entry, catch/finally, logical-op RHS). It does not record the not-taken side of a branch or the
fall-through past a loop, so the coverage feedback cannot distinguish those paths. Edge ids are
`(fnv1a64(file, span.lo, span.hi) as u32) % coverage_map_size`, shared by coverage counters and
CmpLog site ids, with no collision detection.

This change implements design-review items C1 (not-taken / loop-exit edges) and C5 (hash mixing
+ collision detection) together, because C1 raises the edge count enough that C5's hash quality
begins to matter.

## Goals / Non-Goals

**Goals:**

- Record the not-taken edge of an else-less `if` and the fall-through edge of every loop.
- Keep synthesized edges from aliasing the block-entry edge at a coincident span.
- Reduce hash-collision probability to the birthday minimum via full-width avalanche mixing.
- Surface aggregate collision pressure so silently-merged edges become detectable.
- Preserve all existing instrumentation and program semantics; no runtime regressions.

**Non-Goals:**

- Logical `&&`/`||`/`??` short-circuit not-taken edges (would require a per-operator IIFE that
  binds the LHS - too costly for such common operators).
- A synthetic `default` for switches with no default (switch fall-through semantics make a
  safe synthetic default non-trivial).
- Per-statement basic-block counters (a larger change toward true BB granularity).
- A full source-location collision manifest (the WASM plugin has no IO or cross-file state; the
  aggregate load warning is the proportionate detection mechanism).
- Bucketed hit-count admission (C3), unstable-edge down-weighting (C4) - separate changes.

## Decisions

### 1. Edge-kind discriminant folded into the hash

A new `EdgeKind` (`Block`, `ElseNotTaken`, `LoopExit`, `Cmp`) is folded into the FNV
accumulator before finalization. This guarantees the synthesized not-taken and loop-exit
counters get ids distinct from the block-entry counter even when they hash the same span (e.g.
a loop's body span and its own span can coincide for braceless bodies). `Cmp` keeps CmpLog site
ids in a separate sub-space from coverage ids (harmless today since they index different
buffers, but cleaner).

### 2. Avalanche finalizer, then modulo

The coverage map size is typically a power of two, so `% size` keeps only the low bits - and
FNV-1a's low bits are weakly mixed. A murmur3 `fmix64` finalizer (`xor-shift / multiply` twice)
is applied to the full 64-bit hash before reducing with a `u64` modulo, spreading every input
bit into the low bits. This does not reduce the birthday-bound collision rate (that is a
function of load factor, not hash quality) but eliminates the *excess* collisions from FNV
low-bit clustering. `% size` is retained (rather than a bitmask) because non-power-of-two map
sizes are permitted.

### 3. Not-taken else via a synthetic else block

In `visit_mut_if_stmt`, when `alt` is `None`, a synthetic `else { __vitiate_cov[id]++ }`
(kind `ElseNotTaken`, keyed on the consequent span) is inserted. Semantically safe: the else
runs only when the condition is false, and the counter is side-effect-free.

### 4. Loop-exit via sibling-after insertion, never wrapping

The loop-exit counter must fire on normal fall-through past the loop. It is inserted as the
statement immediately after the loop in the enclosing statement list, via two visitor hooks:

- `visit_mut_stmts` for block/function/switch-case/script bodies (`Vec<Stmt>`).
- `visit_mut_module_items` for module top level (`Vec<ModuleItem>`, which does not route
  through `visit_mut_stmts`; module top level is the common case under Vite's ESM transform).

Both peel through any depth of `Stmt::Labeled` to find the underlying loop and insert one
counter after the outermost label. The loop is **not** wrapped in a block: wrapping a labeled
loop would make `continue label` target a non-iteration label (a syntax error). `return` /
`throw` out of the loop correctly skip the exit counter (they are not loop-exit edges).

### 5. Pre-order block normalization

The loop and `if` visitors call `ensure_block` on their bodies/arms *before*
`visit_mut_children_with` (previously after). This guarantees every loop body/arm is a real
`BlockStmt` before traversal descends, so a nested braceless loop (`for(;;) for(;;) f()`) lands
in a genuine `Vec<Stmt>` that the list hooks traverse. Without this, blocks synthesized in
post-order are never re-traversed and nested braceless loops silently miss their exit counter.
Arm/body spans are captured *before* `ensure_block` so braceless-branch counters key on the
real source span rather than the wrapper's `DUMMY_SP` (which previously collided all braceless
branch counters at `id(file, 0, 0)`).

### 6. Collision-pressure warning via injected per-file count

The plugin counts coverage counters emitted per file (a `Cell<u32>` incremented in the single
`make_counter_expr` choke point; CmpLog sites are excluded) and injects
`globalThis.__vitiate_edge_count = (globalThis.__vitiate_edge_count | 0) + N;` into the module
preamble (explicitly parenthesized so `(x | 0) + N` binds correctly). The runtime reads the
accumulated total once at campaign start (`warnOnCoverageMapLoad`, called from `loop.ts` after
the target's modules have loaded) and prints a one-time warning when the count is >= 2% of the
coverage-map size, recommending a larger `coverageMapSize`. This is an approximate upper bound
(it double-counts only negligible intra-file collisions) and is emitted independent of quiet
mode as a correctness diagnostic. A full source-location manifest is out of scope (see
Non-Goals).

## Risks / Trade-offs

- **Edge-id churn:** all ids change. Only `merge`/`optimize` control files persist ids, and
  they are already span-sensitive; stale entries recompute on the next merge. Documented.
- **Dead loop-exit counters** after infinite loops (`while(true){}`) are emitted but never
  executed - harmless (one unused slot), and detecting all infinite loops is undecidable.
- **Cross-target accumulation:** in a shared worker running multiple fuzz targets,
  `__vitiate_edge_count` reflects the union of loaded modules. This is the correct quantity to
  compare against the shared coverage map's load.

## Migration

None required at runtime. Users with cached `merge`/`optimize` control files will see them
recompute coverage on the next merge after upgrading (same behavior as after any source edit
that shifts spans).
