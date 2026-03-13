## Context

Vitiate resolves the vitest CLI entry point via `require.resolve("vitest/vitest.mjs")`. This relies on vitest 3.x's wildcard `"./*"` export, which vitest 4.x removed. Separately, `vitiate init` passes `include: ["**/*.fuzz.ts"]` to `createVitest()`, but when the consuming project defines `test.projects`, vitest ignores the inline include in favor of each project's own include pattern, causing all tests (not just fuzz tests) to be discovered.

Vitiate's own dev dependency is pinned to `vitest ^3.1.0` (installed 3.2.4), so neither issue surfaces in our CI. Latest vitest is 4.1.0.

## Goals / Non-Goals

**Goals:**

- `resolveVitestCli()` works with vitest 3.x and 4.x
- `vitiate init` discovers only fuzz tests regardless of project configuration
- Vitiate's own test suite runs against vitest 4.x
- Zero additional configuration burden on users

**Non-Goals:**

- Supporting vitest < 3.1.0 (existing peer dep lower bound)
- Adding a `--project` flag to `vitiate init` (not needed if filtering works automatically)
- Changing the peer dep range (keep `>=3.1.0` to avoid breaking users still on 3.x)

## Decisions

### Decision 1: Resolve vitest CLI via package.json bin field

**Current:** `require.resolve("vitest/vitest.mjs")` - relies on wildcard export.

**New:** Resolve `vitest/package.json` (explicitly exported in both 3.x and 4.x), read the `bin.vitest` field, and construct the absolute path.

```typescript
export function resolveVitestCli(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("vitest/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (typeof bin !== "string") {
    throw new Error(
      `vitiate: could not resolve vitest CLI entry point from ${packageJsonPath} ` +
        `(pkg.bin = ${JSON.stringify(pkg.bin)})`,
    );
  }
  return path.resolve(packageDir, bin);
}
```

**Why this over alternatives:**

- **vs hardcoding `vitest.mjs` relative to package dir:** The bin field is the semantic source of truth for "where is the CLI." If vitest ever changes the entry point name, this adapts automatically.
- **vs `import.meta.resolve("vitest")` + navigate up:** The `.` export resolves to `dist/index.js` (the library entry, not the CLI). Navigating from there to the CLI is fragile - it assumes a specific internal directory layout.
- **vs spawning `npx vitest`:** Adds process overhead and npx resolution latency. The current approach of resolving a path and spawning `node <path>` is faster and more predictable.

### Decision 2: Post-filter test modules by file path in init

**Current:** `createVitest("test", { include: ["**/*.fuzz.ts"] })` and then iterate all discovered tests. The `include` is ignored when `test.projects` overrides it.

**New:** After `globTestSpecifications()` and `collectTests()`, filter test modules to only those whose file path matches the fuzz test suffix pattern. Skip all others.

```typescript
for (const module of vitest.state.getTestModules()) {
  const filePath = module.moduleId;
  if (!FUZZ_FILE_SUFFIX_RE.test(filePath)) continue;
  // ... existing logic
}
```

**Why this over alternatives:**

- **vs project-name heuristic (filter projects named "fuzz"):** Fragile. Users might name their fuzz project anything - "fuzzing", "security", "fuzz-tests." A filename check is a convention we already enforce (the `*.fuzz.*` pattern is documented and the glob already targets it).
- **vs `--project` flag:** Places a configuration burden on users. Multi-project users would need to remember `vitiate init --project fuzz` every time. The current approach Just Works.
- **vs reading vitest config to extract the fuzz project's include:** Over-engineered. We'd need to parse project configs, match them to the vitiate plugin, handle inline vs file-based configs. The file extension check achieves the same result trivially.
- **vs creating a separate vitest instance without projects:** We'd need to suppress the user's vitest.config.ts, which risks missing plugin configuration, custom resolvers, or path aliases that affect test collection.

The `*.fuzz.*` convention (covering all vitest-supported JS/TS extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`) is already baked into vitiate's documentation, examples, and CLI globs. Filtering on it in init is consistent with the rest of the system.

### Decision 3: Bump dev dependency to vitest ^4.1.0

Update `vitiate-core/package.json` devDependencies and all `examples/*/package.json` dependencies from `^3.1.0` to `^4.1.0`. Keep the peer dependency at `>=3.1.0` so consumers on vitest 3.x are not broken.

This ensures our CI catches vitest 4.x regressions going forward.

### Decision 4: Update spec language

The `test-fuzz-api` spec explicitly requires `require.resolve('vitest/vitest.mjs')`. Update it to describe the bin-field resolution strategy so the spec matches the implementation.

## Risks / Trade-offs

- **[Risk] vitest removes `./package.json` export in a future major version** - Unlikely (it's standard practice and needed by tooling), but if it happens, `require.resolve("vitest")` + navigating to the package root via `path.dirname` + walking up is a viable fallback. This is a bridge we can cross later.

- **[Risk] Filename filter misses fuzz tests not named `*.fuzz.*`** - By design. The `*.fuzz.*` naming convention is documented and enforced across the CLI, plugin config, and examples. A user who names their fuzz file `foo.test.ts` has already broken other vitiate features. Not a new constraint.

- **[Risk] vitest 4.x introduces other breaking changes beyond exports** - Mitigated by bumping our dev dependency and running the full test suite against 4.x. Any new issues will surface in CI immediately.

- **[Trade-off] Reading and parsing package.json at runtime** - Adds a synchronous file read + JSON parse on every `resolveVitestCli()` call. This runs once per CLI invocation or fuzz session start, so the ~1ms cost is negligible.
