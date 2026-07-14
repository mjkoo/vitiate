## Why

`instrument.packages` is meant to let a user fuzz any npm dependency by naming it.
In practice it only works for packages that expose an ESM entry (e.g. `flatted`,
whose `exports`/`module` resolve to ESM). For a **pure-CommonJS** package
(node-forge, jpeg-js: `main` only, no `module`/`exports`/`type`) it **silently
fails**: the package is externalized past the SWC transform, so zero coverage
counters are placed, yet a run can still appear to "pass" on the handful of edges
from the instrumented fuzz-wrapper file. The only symptom is a `buildEnd` warning
that a listed package was never transformed.

Two independent fall-out points cause this (traced in `vitiate-core/src/plugin.ts`
and Vitest 4.1 internals):

1. **Entry externalization.** Vitest externalizes a pure-CJS resolved `main`
   before `vitiate:instrument.transform` runs. The plugin's only lever today is
   `test.server.deps.inline` (`plugin.ts:504-526`), which is not reliable for
   this case.
2. **Transitive native-require escape.** Even when the entry is inlined, an inlined
   CJS module's internal `require("./sub")` calls resolve through the fork worker's
   **native `createRequire`** (Vitest `module-evaluator.js`), so a multi-file CJS
   package (node-forge is dozens of submodules) loads its real logic natively and
   never reaches the transform pipeline.

This is an **untested gap**: every `packages` test uses ESM-capable `flatted` or
hardcoded module-id strings, so no pure-CJS package is ever driven through the real
resolve/externalize path. That is why it regressed unnoticed. A fuzzer that cannot
instrument the single most common shape of npm library (CommonJS) has a hole in a
headline feature.

Spike-confirmed fix: compiling node-forge to a single ESM module with esbuild and
importing it first-party yields **331 instrumented edges / 985 features / a growing
162-input corpus** (versus 8 wrapper-only edges when externalized). The mechanism
works; it just needs to happen transparently inside the plugin.

## What Changes

- **Compile listed CJS dependencies to an instrumentable ESM module.** The plugin
  gains a `resolveId` + `load` pair (it has neither today). For a listed package
  entry that resolves to CommonJS, `resolveId` takes ownership (so Vitest cannot
  externalize it) and `load` returns an esbuild bundle (`bundle:true,
  format:"esm", platform:"node", packages:"external", sourcemap`) of the
  package's own sources. Every internal relative `require` is inlined into the
  one module, so nothing of the package escapes to native require, and the
  existing enforce:"post" `transform` SWC-instruments all of it. Bare-specifier
  requires (the package's npm deps and Node builtins) stay external, bridged at
  runtime by an injected `createRequire` banner that preserves native resolution
  semantics - which also keeps detector hooks working, since native require
  returns the CJS module object where hooks are installed. The bundle is built
  from a generated synthetic entry that re-exports the package's named exports
  (enumerated with `cjs-module-lexer`, exactly as Node's own CJS-ESM interop
  does) alongside `default = module.exports`, so existing default *and named*
  imports of the package keep working. Subpath imports (`pkg/sub`) are
  intercepted too, each getting its own bundle.
- **Transparent CJS/ESM classification.** Each listed package's *resolved entry
  file* is classified (extension, nearest `package.json` `type`, else ESM-syntax
  detection) - metadata fields alone are not trusted, so classification always
  agrees with what resolution actually produced. ESM entries keep today's
  inline+transform path unchanged; only CJS entries are compiled. The user still
  just lists the package name.
- **Package-level coverage, source-mapped stack traces.** The bundle collapses
  per-file attribution to the package level (all edges hash against one entry id;
  distinct source spans still produce distinct edges, so the fuzzing signal is
  intact). esbuild source maps map crash stack traces back to original files.
- **Hard, clear errors instead of silent no-op.** Listed packages are resolved,
  classified, and (if CJS) compiled eagerly at startup; unambiguous
  misconfigurations - not-installed / no-entry / bundle-failed / native-only -
  become hard errors that abort the run before fuzzing starts, each naming the
  package and cause. The one ambiguous case - package resolved fine but never
  imported by the executed tests - remains a `buildEnd` warning
  (today's `plugin.ts:635`), reworded to name that cause, since filtered runs
  make it legitimate. The fuzz "all seeds - no coverage" path names the listed
  package(s).
- **esbuild and cjs-module-lexer become direct dependencies** of `@vitiate/core`
  (esbuild is already present transitively via Vite; cjs-module-lexer is the tiny
  dependency-free lexer Node itself vendors for CJS named-export interop),
  imported lazily so unused paths pay nothing.

## Capabilities

### Modified Capabilities

- `dependency-instrumentation`: `instrument.packages` now instruments CommonJS
  packages (not only ESM-resolvable ones) by compiling each listed entry to an
  ESM bundle of the package's own sources; resolve/classify/bundle failures
  escalate from a warning to eager hard errors, while the listed-but-never-
  imported case remains a (reworded) warning.

### New Capabilities

_None._ (esbuild compilation is an implementation mechanism of the existing
`dependency-instrumentation` capability, not a new user-facing capability.)

## Impact

- **npm packages:** `@vitiate/core` (`plugin.ts`: new `resolveId`/`load`, CJS
  classification, esbuild compile + cache, escalated error path; possibly a small
  new helper module for compile+cache). `@vitiate/core` `package.json` gains
  direct `esbuild` and `cjs-module-lexer` dependencies.
- **No Rust / SWC-plugin changes** - instrumentation of the bundle uses the
  existing transform unchanged.
- **Coverage attribution** for instrumented CJS deps is reported at bundle-entry
  granularity (the package, or a subpath of it), not per-file; the edge feedback
  signal is unaffected. A listed CJS package's own npm dependencies are NOT
  instrumented (they stay external to the bundle) - instrumentation remains
  strictly "the packages you listed", as in the ESM path.
- **New tests / example:** a pure-CJS multi-file package driven end-to-end
  (regression guard for the untested gap); a named-import e2e (named imports
  from a bundled CJS package keep working); a detector e2e proving hooks
  intercept a hooked-builtin call from inside a bundled dep; a subpath-import
  e2e; unit tests for resolved-entry classification, cache behavior, and each
  eager-error cause; plus a seeded-crash CJS example analogous to
  `examples/flatted-vuln`.
- **Build cost:** one esbuild bundle per listed CJS entry per config load, cached
  by (package, version, entry path, entry + package.json mtime, esbuild/bundle-
  recipe fingerprint); cache bypassed for workspace/`file:`/`link:` packages.
