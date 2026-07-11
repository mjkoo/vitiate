## Context

`PrototypePollutionDetector` (`vitiate-core/src/detectors/prototype-pollution.ts`) snapshots the
built-in prototypes in `beforeIteration`, diffs them in `afterIteration`, and restores them in
`resetIteration`. All three phases shared one filter:

```ts
if ("value" in descriptor && typeof descriptor.value === "function") continue;
```

- `captureSnapshot` never stored function-valued data properties.
- `afterIteration` never diffed them, so an added/replaced function was not a finding.
- `restorePrototype` never deleted/restored them, so a planted function persisted.

Accessors (`get`/`set`) were already fully handled (no `value` field, so the filter never matched;
`isAccessor` is reported). The gap is specifically function-valued **data** properties, which are
the bulk of the built-in prototypes' own properties.

The filter existed because the detector rebuilt a function-inclusive-sized snapshot every
iteration, and retaining hundreds of method references per iteration is real hot-path cost. The
insight that removes it: built-in methods do not legitimately change mid-campaign, so the pristine
state can be captured **once** and reused as the oracle, paying the retention cost a single time.

## Goals / Non-Goals

**Goals:**

- Detect a function-valued property **added**, **replaced**, or **deleted** on a monitored
  prototype (matching the `added`/`modified`/`deleted` shapes used for non-function properties),
  including symbol-keyed methods.
- Restore all three so they do not become the next iteration's baseline.
- Keep the polyfill escape hatch: function properties present when the table is captured are never
  flagged.
- No per-iteration snapshot rebuild and no per-iteration function-reference retention; no napi/TS
  surface change.

**Non-Goals:**

- Basic-block coverage, multi-worker, and other section-A/C items.
- Detecting mutation of a prototype's *inherited* (non-own) properties, or of non-monitored
  prototypes.

## Decisions

### 1. Capture the pristine table once, on the first `beforeIteration`

`captureSnapshot` stores the full descriptor for **every** own key (`Reflect.ownKeys`, symbols
included) - the function skip is removed. A `captured` latch guards it: the first `beforeIteration`
builds the table and sets `captured = true`; subsequent `beforeIteration` calls only set
`dirty = true` and return without rebuilding. `teardown` clears the table and resets `captured` so
a reused instance re-captures on its next campaign.

Capture happens on the first `beforeIteration` rather than `setup()` because `setup()`'s ordering
relative to user-module loading is ambiguous (the manager installs hooks "before ESM imports"),
whereas `beforeIteration` runs immediately before each target execution (`loop.ts` batch callback):
the first call is unambiguously after all module loading (legit polyfills present) and before any
target runs. `beforeIteration` is called on every execution path (batch/calibration/stage/replay/
minimize), so the latch, not the call site, is what makes capture once-only.

`dirty` is retained unchanged and is orthogonal to `captured`: `dirty` gates whether
`resetIteration` restores this iteration (cleared only by a clean `afterIteration`), `captured`
latches table construction for the campaign.

### 2. One diff path via the existing `descriptorChanged`

With functions in the table, `afterIteration` routes all keys through the existing logic: a key
absent from the table is `"added"` (with `isAccessor` derived from the descriptor); a key present
with `descriptorChanged(current, pristine)` true is `"modified"`; a table key absent from the
current own keys is `"deleted"`. The deleted check tests membership in a `Set` built once per
prototype from the same `Reflect.ownKeys` walk, so it adds no descriptor allocations beyond that
walk. `descriptorChanged` already compares `.value` (function identity), `.get`/`.set`, and the
four attributes, so function-added / function-replaced / method-deleted, symbol-keyed methods, and
attribute-only tampering all fall out of one path - no bespoke function comparison.

### 3. Restore deletes extras and redefines only what differs

`restorePrototype` deletes any current own key absent from the pristine table (functions included)
via `Reflect.deleteProperty`, warning on a non-configurable failure. It then redefines each pristine
descriptor **only where the current descriptor differs** (`descriptorChanged` / key absent) rather
than redefining all ~hundreds every reset. This is cheaper and makes an identical redefine of a
non-configurable built-in (e.g. `Function.prototype[Symbol.hasInstance]`, non-configurable and
non-writable) a skipped no-op instead of a redundant call; the residual throwing case (a target
flipped a configurable property to non-configurable) is still caught by the per-property try/catch
and `warnResidue`.

## Risks / Trade-offs

- **Frozen baseline re-flags persistent residue and late polyfills.** Under the prior per-iteration
  snapshot, a polyfill installed at an iteration's start was in that iteration's baseline; the
  baseline self-healed. With capture-once, a mutation the detector could not restore
  (non-configurable), or a legit **lazy** polyfill installed *during* a later iteration, is
  re-detected every subsequent iteration and deleted on reset. This is the correct security stance
  (mutating a shared prototype mid-campaign is the signal) and is benign operationally:
  `stopOnCrash` defaults true (the campaign stops on the first finding), and consecutive identical
  findings dedup on normalized stack + `error.name`. Documented in the proposal's Impact.
- **Self-sabotage on `Array.prototype[Symbol.iterator]`.** If a target replaces the array iterator
  with a broken one, the detector's own `for...of` over its snapshot array iterates nothing and the
  replacement goes undetected for that iteration. This is an inherent limitation of an in-VM
  detector that uses the structures it monitors; out of scope to harden here (noted so the test
  suite deliberately avoids replacing `Symbol.iterator`).
- **One-time memory.** ~O(total own keys across monitored prototypes) descriptors are retained for
  the campaign. Negligible, and paid once rather than per iteration.

## Migration

None. No config, artifact, corpus, or edge-id change. The only observable behavior change is that
added/replaced/deleted function-valued prototype properties now produce a finding and are restored;
pre-existing polyfills are unaffected. Existing corpora and control files remain valid.
