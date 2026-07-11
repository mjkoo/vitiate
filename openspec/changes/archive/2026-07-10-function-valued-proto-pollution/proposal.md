## Why

The prototype-pollution detector skips every function-valued data property in all three phases
(snapshot, diff, restore) via `if ("value" in descriptor && typeof descriptor.value === "function") continue;`
(`detectors/prototype-pollution.ts`). The current spec even codifies this as intended
(`prototype-pollution-detector` spec, scenario "Ignore function-valued property additions").

The consequence is a real missed finding: a target that plants, replaces, or deletes a function on
a monitored prototype - `Object.prototype.toJSON = () => exfil()`, `Array.prototype.map = evil`,
`delete Array.prototype.push` - is **not detected, not restored, and not warned**. The planted
function silently becomes the next iteration's baseline. Function-valued gadgets are a genuine
prototype-pollution class (poisoned `toJSON`, `then`, `valueOf`, `Symbol.toPrimitive`), so the
detector misses attacks it exists to catch. This is the review's section-B "function-valued
prototype pollution" residual.

The skip is not arbitrary: the built-in prototypes are *mostly* function-valued methods (every
`.map`, `.toString`, `.hasOwnProperty`). Because the detector rebuilds a fresh snapshot every
iteration, capturing every method's descriptor for value comparison would retain hundreds of
function references *per iteration* on the hot path. This change removes that cost by capturing the
prototype state **once**.

## What Changes

- **Capture a pristine table once.** On the first `beforeIteration` (after all user modules and
  their polyfills have loaded, before any target executes), capture the full descriptor of every
  own property - data, accessor, and function, including symbol keys - on every monitored
  prototype. Latch it and never rebuild. Built-in methods do not legitimately change mid-campaign,
  so this fixed table is the oracle for every iteration. This replaces the per-iteration snapshot
  rebuild, so it is strictly cheaper on the hot path than snapshotting functions each iteration.
- **Detect added / replaced / deleted function properties.** With functions in the table, the
  existing diff logic (reused `descriptorChanged` comparator) reports a newly-added function
  (`changeType: "added"`), a replaced built-in method (`"modified"`, function identity), and a
  deleted built-in method (`"deleted"`) - the same shapes as for non-function properties.
- **Restore them.** `resetIteration` deletes properties absent from the pristine table and
  redefines pristine descriptors that currently differ (skipping unchanged ones, so an identical
  redefine of a non-configurable built-in is a no-op). Restoration stays per-property resilient
  (`warnResidue` on a non-configurable failure).
- **Preserve the polyfill escape hatch.** Function properties present when the table is captured
  (real polyfills, prior setup) are the baseline and are never flagged.

This **supersedes** the narrow per-iteration draft this change previously described (added-only
function detection): capturing once subsumes it and additionally covers replacement and deletion.

## Capabilities

### Modified Capabilities

- `prototype-pollution-detector`: the snapshot is captured once (pristine table) and covers all own
  properties including functions and symbol keys. Added, replaced, and deleted function-valued
  properties on monitored prototypes are detected and restored. Pre-existing function properties
  (polyfills) are not flagged.

### New Capabilities

_None._

## Impact

- **Packages:** `vitiate-core` only (`detectors/prototype-pollution.ts` and its tests; one added
  `manager.test.ts` case). No engine, napi, or TS public-API change; no `index.d.ts` churn.
- **Spec:** the `prototype-pollution-detector` snapshot requirement drops the "non-function"
  qualifier; the "Ignore function-valued property additions" scenario is replaced by
  pre-existing-vs-newly-added; restoration scenarios are reworded from per-iteration re-baseline to
  capture-once; scenarios for added/replaced/deleted function detection + restore are added.
- **Behavior (documented risk):** a previously-missed finding class now fires. Because the baseline
  is frozen at first `beforeIteration` (not re-baselined each iteration), a target/dependency that
  **lazily** patches a built-in prototype *during* a later iteration is flagged as "added" and
  deleted on reset, persistently rather than self-correcting. This is correct by the detector's
  definition (mutating a shared prototype mid-campaign is the signal) and `stopOnCrash` defaults
  true, but it diverges from the current "polyfills present at iteration start are always fine"
  contract.
- **Performance:** the one-time capture retains ~O(total own keys) descriptors for the campaign.
  Per iteration, the diff walks `Reflect.ownKeys` (as today) and compares each key against the
  table via a `Set` membership check for deletions plus `descriptorChanged` for modifications - so
  it adds no descriptor allocations beyond the existing walk, and there is no per-iteration snapshot
  rebuild.
- **No config, artifact, or corpus format change.**
