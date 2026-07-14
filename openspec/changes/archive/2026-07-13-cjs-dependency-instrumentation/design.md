## Context

`vitiatePlugin` (`vitiate-core/src/plugin.ts`) instruments code during Vite's
module transform: the enforce:"post" `vitiate:instrument` plugin runs the SWC
coverage plugin on any module whose id matches `include`/`exclude` or a listed
package (`isListedPackage`, `plugin.ts:307`). For dependency instrumentation the
plugin's `config()` hook injects `test.server.deps.inline` regexes so Vitest routes
listed packages through Vite instead of externalizing them (`plugin.ts:504-526`).

Fuzzing runs in a supervisor-spawned child that re-runs the same Vite config in a
`--pool=forks` worker; instrumented code must flow through Vite's transform to
populate the per-worker `globalThis.__vitiate_cov` (`fuzz.ts:457-510`,
`globals.ts:180`, `setup.ts:18`). A module that Vitest externalizes is loaded by
native Node and never touches the transform - zero instrumentation.

This works for ESM-resolvable packages (`flatted`) but not for pure-CommonJS
packages. Two fall-out points:

1. **Entry externalization.** Vitest's `_shouldExternalize` externalizes a
   node_modules `.js` whose nearest `package.json` `type !== "module"` and which
   has no ESM syntax - the pure-CJS `main` case. `server.deps.inline` is checked
   first and *should* force inlining, but did not reliably do so in empirical
   tests.
2. **Transitive native-require escape (decisive).** Even an inlined CJS entry runs
   in Vitest's module-evaluator with a **native `createRequire`**, so every
   internal `require("./sub")` resolves through native Node, bypassing the
   transform. A multi-file CJS package (node-forge = dozens of `require("./x")`
   submodules) therefore loads its real logic uninstrumented even if the entry is
   inlined. This is why forcing inline alone cannot fix multi-file CJS.

**Spike (already run, grounds this design):**

- node-forge via `packages`/`inline`/`ssr.noExternal`, flat or `projects` config:
  8 wrapper-only edges, the `buildEnd` "no modules transformed" warning present -
  node-forge itself never instrumented. Confirms fall-out above.
- node-forge compiled to one ESM module
  (`esbuild --bundle --format=esm --platform=node`) and imported first-party:
  **331 edges, 985 features, corpus 162, 100k+ execs, transform 713ms** - real,
  deep instrumentation of the whole package. Confirms the fix.

## Goals / Non-Goals

**Goals:**

- `instrument.packages` instruments CommonJS packages, not only ESM-resolvable
  ones, with no extra user configuration (list the name, `import` it normally).
- Uniform behavior for CJS and ESM: ESM packages keep today's path unchanged.
- A listed CJS package keeps its native import surface: default and named imports
  that work under Node's CJS-ESM interop keep working when the package is
  bundled.
- Preserve the fuzzing edge-feedback signal at full fidelity for CJS deps.
- Detector hooks keep intercepting hooked-builtin calls made from inside
  instrumented CJS dependencies.
- Replace the silent-no-coverage outcome with hard, actionable errors for
  unambiguous misconfigurations, surfaced at startup.
- Close the regression gap with an end-to-end pure-CJS test.

**Non-Goals:**

- Per-file coverage attribution *within* an instrumented CJS dependency. Bundling
  collapses attribution to the bundle entry; recovering per-file counters would
  require a per-module CJS->ESM graph walk (a `@rollup/plugin-commonjs`-scale
  effort) that the transitive-require escape makes necessary and that is out of
  scope. Source maps recover per-file *stack traces*, which covers the crash-triage
  need.
- Instrumenting a listed package's own npm dependencies (see Decision 2), native
  `.node` addons, or Node built-ins. Instrumentation stays strictly per listed
  package.
- Changing ESM dependency instrumentation, the SWC plugin, or the coverage-map /
  edge-id scheme.

## Decisions

### 1. Compile CJS deps to one ESM bundle (not per-module conversion)

The transitive native-require escape means owning only the entry via
`resolveId`/`load` still leaves submodules uninstrumented - Vite's resolver is
never consulted for the worker's native `require("./sub")`. Bundling the package's
own modules into a single ESM module eliminates every internal *relative* require
(esbuild inlines them at build time), so the one module Vite transforms contains
all of the package's code. This is the only approach that both defeats
externalization and reaches transitive submodules, and it is the spike-verified
one.

Tradeoff accepted: all of the package's edges hash against the single bundle entry
id. Distinct source spans still yield distinct edge ids, so the coverage-guided
feedback is unchanged; only human-readable per-file attribution collapses to the
package level. esbuild source maps (`sourcemap`, consumed by the existing
`transform`'s `sourceMaps: true`) map crash stack traces back to original files.

### 2. Bundle only the package's own sources (`packages: "external"`)

The esbuild build sets `packages: "external"`, so every bare-specifier import or
require (the package's npm dependencies and Node builtins) stays external; only
relative requires - the package's own files - are inlined. Rationale:

- **No misattribution:** edges from a dependency's code are never counted against
  the listed package. Instrumentation semantics stay "exactly the packages you
  listed", matching the ESM path.
- **No dual-copy state:** an unlisted CJS dep required by the bundle resolves
  through native require (Decision 3), landing in the same native module cache
  that Vitest's externalization uses for direct imports of that dep from user
  code - one copy, shared singletons.
- **Smaller, faster bundles** and a cache key that only depends on the listed
  package itself.

Rejected alternative: inlining the full dependency graph (`external:` builtins
only). It instruments code the user did not list, attributes it to the wrong
package, and creates duplicate module state whenever the same dep is also
reachable outside the bundle.

Limitation (documented): the bundled copy is not necessarily the only copy of a
listed package. Any *native* require path to it - listed package A's
bare-specifier require of listed package B, an unlisted externalized dependency
requiring a listed package, or a dynamic `require(expr)` through the Decision 3
bridge - loads the real CJS files through native require: uninstrumented, and
with module state separate from the bundle's (stateful singletons can diverge).
Direct imports from user code always get the instrumented bundle, so coverage
from listed entries is unaffected.

### 3. Runtime require bridge: `createRequire` banner

esbuild's `format: "esm"` output turns external *static* requires (e.g.
`require("crypto")`, and every bare-specifier require under Decision 2) into a
`__require` shim that throws "Dynamic require of X is not supported" at runtime
unless a `require` is in scope. The bundle therefore gets an esbuild `banner`
that establishes one, with the real entry's file URL embedded **literally at
build time**:

```js
import { createRequire as __vitiate_createRequire } from "node:module";
const require = __vitiate_createRequire("<file URL of the real package entry>");
```

The banner is generated per bundle, so the path is a string literal rather than
`import.meta.url`. This keeps the bridge independent of the id the bundle is
served under: it works identically under the primary real-path id and the
Decision 5 virtual-id fallback (where `import.meta.url` would *not* be the real
entry's URL), and it does not depend on how the module evaluator populates
`import.meta`. `require` resolves builtins and the package's deps exactly as
native Node would from that entry. This preserves native semantics wholesale:
anything the package could `require` at normal runtime works identically inside
the bundle (including dynamic `require(expr)`, which loads natively and simply
stays uninstrumented).

### 4. Export-shape parity: synthetic entry + cjs-module-lexer named exports

esbuild's ESM output for a CJS entry point exports only `default`. Today's
externalized path loads the package with native require, and Node/Vitest interop
synthesizes named exports from `module.exports` (via `cjs-module-lexer`), so
`import { pki } from "node-forge"` works. Serving a default-only bundle would
silently break every such named import - a regression in exactly the packages
this change targets.

The bundle is therefore built from a **generated synthetic ESM entry** (esbuild
`stdin` with `resolveDir` set to the package directory) instead of the raw CJS
entry:

```js
import __vitiate_mod from "<real entry>";
export default __vitiate_mod;
export const pki = __vitiate_mod.pki; // one per detected named export
```

With `platform: "node"`, esbuild's CJS interop makes the default import of a CJS
file evaluate to `module.exports`, so `default` matches native interop. Named
exports are enumerated with `cjs-module-lexer` - the same lexer Node's own
CJS-ESM interop uses - run on the real entry file, following its `reexports`
chains through the package's relative files exactly as Node does. Names that are
not valid identifiers, and `default`, are skipped; if lexing fails, the bundle
falls back to default-only, matching Node's behavior for unlexable CJS. Bindings
are snapshots taken after module evaluation (`export const x = mod.x`), the same
observable semantics as Node's interop snapshot.

`cjs-module-lexer` becomes a direct dependency of `@vitiate/core` (it is tiny
and dependency-free; Node vendors it internally but does not expose it).

### 5. `resolveId` + `load` ownership of listed CJS entries

The plugin gains its first `resolveId`/`load` hooks. For an import of a listed
package classified as CJS:

- `resolveId(source, importer)` resolves the requested entry and returns an owned
  id (the real entry path, marked `external: false`) so Vitest cannot externalize
  it. Enforce ordering must let this win over Vitest's externalizer.
- `load(id)` returns the cached esbuild bundle (Decision 9), built from the
  Decision 4 synthetic entry:
  `build({ stdin: { contents: <synthetic entry>, resolveDir: <package dir>,
  loader: "js" }, bundle: true, format: "esm", platform: "node",
  packages: "external", banner: <Decision 3>, sourcemap: "external",
  write: false, external: ["*.node"] })` as `{ code, map }`.
- The existing enforce:"post" `transform` matches the entry id via
  `isListedPackage` and SWC-instruments the bundle unchanged.

ESM-classified packages return early from `resolveId`/`load` (no interception);
they continue through the existing inline+transform path. The
`server.deps.inline` injection happens in `config()`, which runs before any
resolution or classification is possible, so it injects patterns for **all**
listed packages unconditionally: load-bearing for ESM entries (today's path),
harmless belt-and-suspenders for CJS entries that `resolveId`/`load` own.

**Fallback (pre-planned):** whether a plugin `resolveId` returning the real path
deterministically beats Vitest 4.1's resolve-time CJS externalization is an
empirical unknown (validated first in implementation). If it does not, the
fallback is a virtual id embedding the real path (`\0vitiate-cjs:<entry-path>`),
which requires two companion changes landing together: the hooks plugin's `\0`
skip (`plugin.ts:426`) gets an exemption for this prefix, and `isListedPackage`
matching strips the prefix so the embedded `/node_modules/<pkg>/` path still
matches. The Decision 3 banner embeds the literal entry path, so it needs no
change under the fallback.

### 6. CJS vs ESM classification from the resolved entry file

Classification operates on the *resolved entry file* that will actually flow
through the pipeline, never on package metadata alone. Rules apply extension
first - the `package.json` `type` field governs only `.js` files:

- `.mjs` => ESM.
- `.cjs` => CJS, even when the nearest `package.json` has `type: "module"`
  (Node semantics: the extension always wins).
- `.js` => ESM when the nearest `package.json` has `type: "module"`; otherwise
  parse with `es-module-lexer` (already a dependency, `plugin.ts:8`) - ESM
  import/export syntax => ESM, else CJS.

Cached per resolved entry.

Metadata fields (`module`, an `exports` import condition) are deliberately not
trusted as classification inputs: Vite's SSR resolution can pick a CJS `main`
even when a `module` field exists, and classifying from metadata would then leave
that package on the broken externalization path - exactly the silent gap this
change removes. Classifying what resolution actually produced makes
classification and behavior agree by construction.

### 7. Subpath imports get per-entry bundles, compiled lazily

`resolveId` intercepts both the bare specifier and subpath imports of a listed
package (`pkg/sub`). Each distinct resolved entry is classified and (if CJS)
bundled independently; the cache (Decision 9) is keyed per entry. Edge ids hash
per entry id, so entries never collide in the coverage map.

Subpath entries cannot be enumerated up front (exports maps make the set
unknowable until an import is seen), so they are the one exception to Decision
9's eager model: each is classified and compiled **lazily on first resolve**,
using the same resolver and cache as root entries. A subpath bundle failure at
that point is the same hard error as Decision 10's bundle-failed cause, raised
at first import - never a silent fallthrough to native require.

Caveat (documented): two entries that share internal modules each embed a private
copy, so intra-package singleton state can duplicate when a target mixes root and
subpath imports of the same package. Rejected alternative: redirecting subpaths
into the root bundle - unsound, because the root bundle exposes only the root
export surface.

### 8. Detector hooks reach bundled code via the CJS module object

Today's ESM path needs `rewriteHookedImports` because ESM named imports bind to a
frozen namespace, bypassing detector hooks installed on the CJS module object
(`plugin.ts:412-414`). Inside a bundle, hooked-builtin access goes through the
Decision 3 banner instead: native `require("child_process")` returns that same
CJS module object, so calls hit the installed hooks with no rewriting needed.
Timing is safe: hooks are installed by the setup file, which Vitest runs before
any test file imports the bundle, so even load-time destructuring
(`const { execSync } = require("child_process")`) captures the hooked function.

The hooks plugin still runs over the bundle (it is ESM, and its id matches
`isListedPackage`); if esbuild emits real ESM imports for externals (ESM source
inside a CJS-classified package), those are rewritten exactly as today. An
explicit e2e test asserts a detector fires on a hooked-builtin call made from
inside a bundled CJS dependency (Decision 12).

### 9. Eager compile + bundle cache

All listed packages' **root entries** are resolved and classified, and CJS ones
compiled, eagerly in the plugin's async `buildStart` (Vite awaits it before any
transform), so every failure in Decision 10's eager class surfaces at startup,
and `load` for a root entry reduces to a cache lookup. Subpath entries are the
one lazy case (Decision 7). A `load` for a root entry absent from the cache is
an internal error (a bug in the plugin), not a silent fallthrough.

Eager `buildStart` resolution and request-time `resolveId` resolution use the
**same resolver with identical options** (the plugin context's `this.resolve`
with the same SSR conditions; importer-less from the project root in
`buildStart`), so the entry classified eagerly is by construction the entry
served later - exports-condition divergence between two different resolvers
cannot desync classification from behavior.

Bundles are cached on disk under the Vite/vitiate cache dir, keyed by (package
name, resolved version, resolved entry path, entry mtime, package.json mtime,
toolchain fingerprint); reuse on hit, rebuild on any key change. The toolchain
fingerprint covers the esbuild version and the bundle recipe (build options,
banner, synthetic-entry schema), so upgrading esbuild or changing the recipe
invalidates prior bundles instead of serving stale ones. Cache writes are atomic
(write to a temp file, then rename): the supervisor parent, fuzz child, and
forked workers may compile the same package concurrently, and none can observe a
partial bundle; concurrent writers produce identical content, so last-write-wins
is safe. The cache is bypassed (always rebuild) when the resolved package
directory lies outside `node_modules` - the workspace / `file:` / `link:` case
where version+mtime keys are unreliable. Known limitation: an in-place edit to a
non-entry file of an installed package (e.g. patch-package) with version, entry,
and package.json unchanged serves a stale bundle; deleting the cache dir
recovers, and normal upgrades change the version key.

Import esbuild and cjs-module-lexer lazily (mirroring the lazy
`import("@swc/core")` at `plugin.ts:602`) so configs without CJS packages never
load them. esbuild is promoted to a direct `@vitiate/core` dependency (already
on disk transitively via Vite; pin compatibly - `packages: "external"` needs
>= 0.16.5, and 0.28.x is what Vite currently ships).

### 10. Error escalation, split by detectability

The single `buildEnd` warning (`plugin.ts:635`) is replaced by two classes:

- **Eager hard errors** - thrown from `buildStart` (Decision 9), aborting the run
  with a nonzero exit before any fuzzing starts. Which process's `buildStart`
  fires first in supervisor mode (parent vs fuzz child vs forked worker) is an
  empirical detail validated alongside the resolveId-ordering check (see Risks);
  the error is thrown wherever `buildStart` runs, and the first failing process
  aborts the run, so the user gets one actionable failure either way. Causes,
  each named in the message with the package: not installed (resolve failed), no
  usable entry, esbuild bundle failed (esbuild diagnostics attached),
  native-addon-only entry. Resolve-failure applies to ESM-listed packages too
  (classification resolves every listed package). For subpath entries, the
  bundle-failed cause is raised lazily at first resolve (Decision 7) with the
  same hard-error semantics.
- **Retained `buildEnd` warning** - the package resolved (and bundled) fine but
  no module from it was ever transformed: listed but never imported by the
  executed tests. This can be legitimate (filtered runs, conditional imports), so
  it stays a warning, reworded to say "never imported by the tests that ran"
  rather than today's "is the package installed?".

The fuzz-loop "all seeds evaluated but none produced coverage" path additionally
names the listed package(s) so the user is pointed at the cause rather than a
generic instrumentation message.

### 11. Dep-optimizer guard

Vite's dep optimizer would rewrite an inlined dep to a `node_modules/.vite/deps/*`
id that `isListedPackage`'s `/node_modules/<pkg>/` substring would miss. Ensure
listed packages are excluded from the optimizer (`optimizeDeps.exclude`) so their
ids stay matchable. (In the SSR/node path used by the fuzz worker the optimizer is
normally inactive; this is a guard against config drift.)

### 12. Testing strategy (closes the untested gap)

- A real pure-CJS multi-file fixture instrumented end-to-end through the actual
  resolve/externalize path (not a hardcoded id string): assert edges grow and no
  error. This is the guard whose absence let the gap ship.
- A named-import e2e: `import { <name> } from` a listed CJS package binds the
  same value native interop would provide - no missing-export error, coverage
  still recorded (guards Decision 4's export-shape parity).
- A detector e2e: a bundled CJS dependency calls a hooked builtin (e.g.
  `child_process.execSync`); assert the detector intercepts (Decision 8).
- A subpath e2e: a target importing `pkg/sub` of a listed CJS package gets
  instrumented coverage from the subpath entry (Decision 7).
- Unit coverage for resolved-entry classification (including the
  metadata-vs-resolution divergence case - `module` field present but CJS `main`
  resolved - and the extension-precedence case: `.cjs` under `type: "module"`
  classifies CJS), the compile+cache (hit / mtime miss / toolchain-fingerprint
  miss / outside-node_modules bypass), and each eager-error cause.
- A seeded-crash CJS example (analogue of `examples/flatted-vuln`) proving a
  crash in a CJS dependency is found and its stack trace maps back through the
  source map.
- The existing `flatted` (ESM) e2e must remain green unchanged, including its
  never-imported warning behavior.

## Risks / Open Questions

- **`resolveId` vs Vitest externalizer ordering:** must confirm the plugin's
  `resolveId` (with `external: false`) deterministically wins over Vitest's
  resolve-time CJS externalization in 4.1.x - validated empirically first in
  implementation; fallback pre-planned in Decision 5.
- **Where `buildStart` runs in supervisor mode:** loading the config runs
  `config()`, not `buildStart`; `buildStart` fires when a Vite plugin container
  starts, which may happen in the parent, the fuzz child, the forked workers, or
  several of them. Validated empirically together with the ordering check. The
  eager errors are thrown from every `buildStart` that runs, so the worst
  observed failure mode is a duplicated error message, never a missed error.
- **esbuild bundling edge cases:** conditional exports and circular CJS inside a
  package are handled by esbuild's CJS interop; surviving oddities surface
  through the eager bundle-failure error with esbuild diagnostics attached.
  Dynamic `require(expr)` and native addons load natively via the Decision 3
  bridge - functional but uninstrumented; documented. A `cjs-module-lexer`
  failure on an entry degrades to default-only exports, matching Node.
- **Native dual copies and mixed imports:** any native require path to a listed
  CJS package (Decision 2 limitation - cross-listed-package requires, unlisted
  externalized deps, dynamic `require(expr)`) loads a second, uninstrumented
  copy with separate module state; mixed root+subpath imports duplicate
  intra-package state (Decision 7 caveat). Both are accepted, documented
  behaviors, not silent failures - coverage from directly imported listed
  entries is unaffected.
