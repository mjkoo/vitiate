## 1. Dependencies and spike validation

- [x] 1.1 Add `esbuild` and `cjs-module-lexer` as direct dependencies of `@vitiate/core` in `vitiate-core/package.json` (esbuild pinned compatibly: `>= 0.16.5` for `packages: "external"`, aligned with the 0.28.x Vite currently ships; cjs-module-lexer is the lexer Node itself vendors for CJS named-export interop), and import both lazily (mirroring the lazy `import("@swc/core")` at `plugin.ts:602`)
- [x] 1.2 Validate empirically and record the results: (a) whether a plugin `resolveId` returning the real entry path with `external: false` deterministically beats Vitest 4.1's resolve-time CJS externalization; (b) which process's `buildStart` executes first in supervisor mode (parent vs fuzz child vs forked worker), to confirm where eager errors surface. If (a) does NOT win, switch the compilation path to the pre-planned virtual-id fallback (`\0vitiate-cjs:<entry-path>`) and land its two companion changes together: exempt this prefix in the hooks plugin's `\0` skip (`plugin.ts:426`) and strip the prefix in `isListedPackage` matching so the embedded `/node_modules/<pkg>/` path still matches (the banner needs no change - it embeds the literal entry path)
  - RESULT (validated 2026-07-13): the primary real-path approach WINS. Returning `{ id: <resolved entry>, external: false }` from `resolveId` deterministically beats Vitest 4.1's CJS externalization - node-forge and jpeg-js instrument end-to-end (edges grow far past wrapper-only). The virtual-id fallback was NOT needed. `buildStart` runs in each Vite plugin-container process; the eager error throws wherever it first runs. Existing flatted ESM e2e remains green (Vite resolves `flatted` by name, classifies ESM, skips).

## 2. Resolved-entry classification

- [x] 2.1 Implement a `classifyEntry(resolvedEntryPath)` helper that returns `"cjs" | "esm"` from the resolved entry file only, extension first (the `package.json` `type` field governs only `.js`): `.mjs` => ESM; `.cjs` => CJS even under `type: "module"`; `.js` => nearest `package.json` `type: "module"` => ESM, else parse with `es-module-lexer` (`plugin.ts:8`), ESM import/export syntax => ESM else CJS. Do not read `module`/`exports` metadata as classification inputs
- [x] 2.2 Cache classification results per resolved entry path
- [x] 2.3 Unit tests: pure-CJS `.js`, `.cjs`, `.mjs`, `type: "module"` `.js`, ESM-syntax `.js`, `.cjs` under `type: "module"` (classifies CJS - extension precedence), and the metadata-divergence case (`module` field present but CJS `main` resolved) each classify correctly

## 3. CJS compilation (resolveId + load)

- [x] 3.1 Add the plugin's first `resolveId(source, importer)` hook: for an import of a listed package whose resolved entry classifies as CJS, resolve the entry and return an owned, non-external id; return early (no interception) for ESM-classified packages and non-listed sources
- [x] 3.2 Add a `load(id)` hook that returns the cached esbuild bundle as `{ code, map }`, built from a synthetic stdin entry (`stdin: { contents, resolveDir: <package dir>, loader: "js" }`) with `bundle: true, format: "esm", platform: "node", packages: "external", sourcemap: "external", write: false, external: ["*.node"]`
- [x] 3.3 Export-shape parity: generate the synthetic entry as `import mod from "<real entry>"; export default mod;` plus one `export const <name> = mod.<name>` per named export enumerated with `cjs-module-lexer` on the real entry, following its relative re-export chains as Node's interop does; skip names that are not valid identifiers and `default`; on lexer failure fall back to default-only (matching Node)
- [x] 3.4 Inject the `createRequire` banner with the real entry's file URL embedded literally at build time (not `import.meta.url`), so external static and dynamic requires resolve with native Node semantics regardless of the id the bundle is served under: `import { createRequire as __vitiate_createRequire } from "node:module"; const require = __vitiate_createRequire("<entry file URL>");`
- [x] 3.5 Ensure the enforce:"post" `transform` matches the bundle entry id via `isListedPackage` and SWC-instruments it unchanged (bundle map consumed by the existing `sourceMaps: true`)
- [x] 3.6 Verify no misattribution: `packages: "external"` keeps the package's own npm deps and Node builtins out of the bundle so only the listed package's sources are instrumented

## 4. Subpath imports

- [x] 4.1 Intercept subpath imports (`pkg/sub`) of a listed package in `resolveId`, classifying and (if CJS) compiling each distinct resolved entry lazily on first resolve, using the same resolver and cache as root entries, keyed per entry so edge ids never collide; a subpath bundle failure is a hard error at first import (esbuild diagnostics attached), never a silent fallthrough to native require

## 5. Eager compile and bundle cache

- [x] 5.1 In an async `buildStart` (awaited by Vite before any transform), resolve and classify every listed package's root entry and compile every CJS one, so `load` for a root entry reduces to a cache lookup; use the same resolver with identical (SSR) options in `buildStart` and `resolveId` so the entry classified eagerly is the entry served later; treat a `load` for a root entry absent from the cache as an internal error, not a silent fallthrough
- [x] 5.2 Implement an on-disk bundle cache under the Vite/vitiate cache dir keyed by (package name, resolved version, resolved entry path, entry mtime, package.json mtime, toolchain fingerprint), where the fingerprint covers the esbuild version and the bundle recipe (build options, banner, synthetic-entry schema); reuse on hit, rebuild on any key change; write atomically (temp file + rename) so concurrent processes never observe a partial bundle
- [x] 5.3 Bypass the cache (always rebuild) when the resolved package directory lies outside `node_modules` (workspace / `file:` / `link:` case)
- [x] 5.4 Unit tests for cache behavior: hit reuse, miss rebuild on mtime change, miss rebuild on toolchain-fingerprint change, outside-`node_modules` bypass

## 6. Error escalation

- [x] 6.1 Replace the single `buildEnd` warning (`plugin.ts:635`) with eager hard errors thrown from `buildStart` for the unambiguous causes, each naming the package: not installed (resolve failed, also for ESM-listed packages), no usable entry, esbuild bundle failed (attach esbuild diagnostics), native-only entry. Abort with nonzero exit before any fuzzing starts; the error surfaces in whichever process runs `buildStart` first (location validated in task 1.2)
  - DEVIATION (2026-07-13 review): eager not-installed is NOT a hard startup error. A listed package is not always resolvable by its bare name from the project root (npm aliases, e.g. flatted imported as flatted-vulnerable, or importer-specific resolution). buildStart eager resolution is best-effort and defers such packages to resolveId; a genuinely uninstalled+imported package surfaces as a natural Vite import-resolution error, and listed-but-never-imported stays a buildEnd warning. The compile causes (native-only, no-usable-entry, esbuild bundle-failed) remain eager hard errors once an entry resolves. This preserves the existing flatted e2e (task 8.7), which the spec's eager-not-installed model would have broken.
- [x] 6.2 Retain the resolved-but-never-imported case as a `buildEnd` warning, reworded to name the package and say "never imported by the tests that ran" instead of "is the package installed?"
- [x] 6.3 Update the fuzz-loop "all seeds evaluated but none produced coverage" message to additionally name the listed package(s)

## 7. Detector hooks and optimizer guard

- [x] 7.1 Confirm bundled CJS reaches detector hooks via the banner `require` (native `require("child_process")` returns the hooked CJS module object; no import rewriting needed); ensure the hooks plugin still runs over the bundle and rewrites any real ESM imports of hooked builtins esbuild emits
- [x] 7.2 Add a dep-optimizer guard: exclude listed packages from `optimizeDeps` so their ids stay matchable by `isListedPackage`'s `/node_modules/<pkg>/` substring

## 8. Tests and example

- [x] 8.1 End-to-end regression guard: a real pure-CJS multi-file fixture instrumented through the actual resolve/externalize path (not a hardcoded id string); assert edges grow and no error
- [x] 8.2 Named-import e2e: `import { <name> } from` a listed CJS package binds the same value native interop would provide; assert no missing-export error and that coverage is still recorded
- [x] 8.3 Detector e2e: a bundled CJS dependency calls a hooked builtin (e.g. `child_process.execSync`); assert the detector intercepts
- [x] 8.4 Subpath e2e: a target importing `pkg/sub` of a listed CJS package gets instrumented coverage from the subpath entry
- [x] 8.5 Unit coverage for each eager-error cause (not-installed, no-entry, bundle-failed, native-only)
- [x] 8.6 Seeded-crash CJS example analogous to `examples/flatted-vuln`: a crash in a CJS dependency is found and its stack trace maps back through the source map
- [x] 8.7 Confirm the existing `flatted` (ESM) e2e remains green unchanged, including its never-imported warning behavior

## 9. Docs

- [x] 9.1 Document the CJS instrumentation behavior and its accepted limitations: package-level (bundle-entry) coverage granularity; uninstrumented own-deps / dynamic-require / native-addon paths; native dual copies (any native require path to a listed package - listed-package-to-listed-package requires, unlisted externalized deps requiring a listed package, dynamic `require(expr)` - loads a second uninstrumented copy with separate module state); and mixed root+subpath intra-package state duplication
