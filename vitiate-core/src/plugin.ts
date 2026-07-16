/**
 * Vite plugin for vitiate instrumentation.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse, ImportType } from "es-module-lexer";
import MagicString from "magic-string";
import { createFilter, type Plugin } from "vite";
import {
  classifyEntry,
  compileCjsEntry,
  type CompiledBundle,
} from "./cjs-compile.js";
import type { VitiatePluginOptions } from "./config.js";
import {
  resolveInstrumentOptions,
  setCoverageMapSize,
  getCoverageMapSize,
  COVERAGE_MAP_SIZE,
  setProjectRoot,
  setDataDir,
  setConfigFile,
  isFuzzingMode,
} from "./config.js";

const require = createRequire(import.meta.url);

/** File extensions that may contain ESM import declarations. */
const JS_TS_EXTENSIONS = /\.(?:[cm]?[jt]sx?|[jt]s)(?:\?.*)?$/;

/**
 * Built-in modules that detectors install hooks on.
 *
 * Detector hooks monkey-patch the CJS module exports object (e.g.,
 * `require("child_process").execSync = wrapper`). This works for CJS
 * require() and ESM default imports, but ESM named imports
 * (`import { execSync } from "child_process"`) capture a static binding
 * from the ESM namespace - which Vitest's SSR runner externalizes and
 * caches before hooks are installed.
 *
 * The hooks plugin rewrites named imports of these modules into default
 * import + destructuring so the values are read from the live CJS module
 * object at evaluation time (after setup.ts installs hooks).
 */
const HOOKED_MODULES = new Set(["child_process", "fs", "fs/promises", "http2"]);

/**
 * Check if a module specifier refers to a hooked built-in module.
 * Handles both bare ("child_process") and "node:"-prefixed forms.
 */
function isHookedSpecifier(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return HOOKED_MODULES.has(bare);
}

/**
 * Result of parsing an import clause (the text between `import` and `from`).
 */
interface ParsedClause {
  defaultImport: string | null;
  namedImports: string | null; // e.g., "{ execSync, spawn as sp }"
  namespaceImport: string | null; // e.g., "cp" (from "* as cp")
}

/**
 * Extract the import clause from a full import statement.
 * Returns the text between `import ` and ` from `, or null for
 * type-only imports and side-effect imports.
 */
function extractImportClause(statement: string): string | null {
  const normalized = statement.replace(/\s+/g, " ").trim();
  // Skip `import type` - at enforce: "pre", TypeScript hasn't been
  // stripped yet, so we must handle full type-only imports ourselves.
  if (/^import\s+type\s/i.test(normalized)) return null;

  const fromIdx = normalized.lastIndexOf(" from ");
  if (fromIdx === -1) return null;

  const clause = normalized.slice("import ".length, fromIdx).trim();
  return clause.length > 0 ? clause : null;
}

/**
 * Parse an import clause (already whitespace-normalized) into its
 * constituent parts: default import, named imports, namespace import.
 *
 * Named-import patterns use `[^}]*` to match brace contents. This fails
 * if a closing brace appears inside a comment within the import braces
 * (e.g., `import { foo, / * } * / bar } from "fs"`). In practice this
 * doesn't occur in real code, and the failure mode is graceful: the
 * import isn't rewritten, but the CJS module hook still intercepts calls.
 */
function parseImportClause(clause: string): ParsedClause | null {
  let defaultImport: string | null = null;
  let namedImports: string | null = null;
  let namespaceImport: string | null = null;

  // Case 1: "* as ns"
  const nsMatch = clause.match(/^\*\s+as\s+([\w$]+)$/);
  if (nsMatch) {
    namespaceImport = nsMatch[1]!;
    return { defaultImport, namedImports, namespaceImport };
  }

  // Case 2: "def, * as ns"
  const defNsMatch = clause.match(/^([\w$]+)\s*,\s*\*\s+as\s+([\w$]+)$/);
  if (defNsMatch) {
    defaultImport = defNsMatch[1]!;
    namespaceImport = defNsMatch[2]!;
    return { defaultImport, namedImports, namespaceImport };
  }

  // Case 3: "def, { ... }"
  const defNamedMatch = clause.match(/^([\w$]+)\s*,\s*(\{[^}]*\})$/);
  if (defNamedMatch) {
    defaultImport = defNamedMatch[1]!;
    namedImports = defNamedMatch[2]!;
    return { defaultImport, namedImports, namespaceImport };
  }

  // Case 4: "{ ... }"
  const namedMatch = clause.match(/^(\{[^}]*\})$/);
  if (namedMatch) {
    namedImports = namedMatch[1]!;
    return { defaultImport, namedImports, namespaceImport };
  }

  // Case 5: "def" (default only)
  const defMatch = clause.match(/^([\w$]+)$/);
  if (defMatch) {
    defaultImport = defMatch[1]!;
    return { defaultImport, namedImports, namespaceImport };
  }

  return null;
}

/**
 * Convert an import named-specifier list into a destructuring pattern.
 *
 * Handles two syntactic differences between import specifiers and
 * destructuring patterns:
 * - Filters out inline `type` specifiers (`type Foo`) which are valid in
 *   imports but not in destructuring. The hooks plugin runs at
 *   `enforce: "pre"` before TypeScript is stripped.
 * - Converts `as` aliases to `:` (`import { a as b }` → `const { a: b }`).
 *
 * Returns null if no value specifiers remain after filtering (i.e., all
 * specifiers were type-only).
 */
function namedImportsToDestructuring(namedImports: string): string | null {
  // Strip braces, split by comma, process each specifier.
  const inner = namedImports.slice(1, -1);
  const specifiers = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const valueSpecifiers: string[] = [];
  for (const spec of specifiers) {
    // Skip type-only specifiers: "type Foo" or "type Foo as Bar"
    if (/^type\s/.test(spec)) continue;
    // Convert import alias syntax to destructuring syntax: "a as b" → "a: b"
    const converted = spec.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, "$1: $2");
    valueSpecifiers.push(converted);
  }

  if (valueSpecifiers.length === 0) return null;
  return `{ ${valueSpecifiers.join(", ")} }`;
}

/**
 * Rewrite named/namespace imports of hooked built-in modules into default
 * import + destructuring.
 *
 * Transforms:
 *   import { execSync } from "child_process"
 * Into:
 *   import __vitiate_child_process from "child_process";
 *   const { execSync } = __vitiate_child_process;
 *
 * Uses es-module-lexer for precise multi-line-aware import detection and
 * MagicString for string manipulation with automatic sourcemap generation.
 *
 * Returns null if no rewrites were needed.
 */
function rewriteHookedImports(
  code: string,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  // Quick bail-out: if the code doesn't reference any hooked module, skip parsing.
  // For "fs", use patterns that match import/require contexts (quoted strings,
  // fs/ prefix) to avoid matching unrelated identifiers containing "fs" (e.g.,
  // "offset"). For other modules like "child_process" and "fs/promises",
  // code.includes() is sufficiently specific.
  let hasHooked = false;
  for (const mod of HOOKED_MODULES) {
    if (mod === "fs") {
      // Match quoted "fs" / 'fs' in import contexts. Also match
      // :fs" / :fs' for node:fs specifiers. The "fs/promises" entry in
      // HOOKED_MODULES handles that module via the else branch.
      // False positives are acceptable (proceed to parse), false negatives
      // (skipping a file with fs imports) are not.
      if (
        code.includes('"fs"') ||
        code.includes("'fs'") ||
        code.includes(':fs"') ||
        code.includes(":fs'")
      ) {
        hasHooked = true;
        break;
      }
    } else if (code.includes(mod)) {
      hasHooked = true;
      break;
    }
  }
  if (!hasHooked) return null;

  const [imports] = parse(code);
  const ms = new MagicString(code);
  const varCounters = new Map<string, number>();

  for (const imp of imports) {
    // Only process static imports of hooked modules
    if (imp.t !== ImportType.Static) continue;
    if (imp.n === undefined || !isHookedSpecifier(imp.n)) continue;

    // Extract the full statement text (ss = statement start, se = statement end)
    const statement = code.substring(imp.ss, imp.se);
    const clause = extractImportClause(statement);
    if (!clause) continue;

    const parsed = parseImportClause(clause);
    if (!parsed) continue;

    // Only rewrite if there are named imports or namespace imports.
    // Default-only imports already access the CJS module object directly.
    if (!parsed.namedImports && !parsed.namespaceImport) continue;

    // Build the destructuring lines first so we can bail out early if all
    // named specifiers were type-only (filtered by namedImportsToDestructuring).
    const destructLines: string[] = [];
    if (parsed.namedImports) {
      const destructuring = namedImportsToDestructuring(parsed.namedImports);
      if (destructuring) {
        destructLines.push(destructuring);
      }
    }

    // If all named specifiers were type-only (filtered out) and there's no
    // namespace import, skip this import - it's purely types. Rewriting it
    // would introduce an unnecessary side-effectful default import.
    if (destructLines.length === 0 && !parsed.namespaceImport) continue;

    const source = imp.n;
    const bare = source.startsWith("node:") ? source.slice(5) : source;
    const count = varCounters.get(bare) ?? 0;
    varCounters.set(bare, count + 1);
    const varName =
      `__vitiate_${bare.replace(/[-/]/g, "_")}` +
      (count > 0 ? `_${count}` : "");

    const defaultName = parsed.defaultImport ?? varName;
    const obj = parsed.defaultImport ?? varName;
    const importLine = `import ${defaultName} from ${JSON.stringify(source)}`;

    const lines = [importLine];
    for (const pattern of destructLines) {
      lines.push(`const ${pattern} = ${obj}`);
    }
    if (parsed.namespaceImport) {
      lines.push(`const ${parsed.namespaceImport} = ${obj}`);
    }

    // Extend overwrite range to include trailing semicolon if present,
    // avoiding a double-semicolon in the output.
    let end = imp.se;
    if (code.charCodeAt(end) === 0x3b /* ; */) end++;

    const replacement = lines.join(";\n") + ";";
    ms.overwrite(imp.ss, end, replacement);
  }

  if (!ms.hasChanged()) return null;
  return { code: ms.toString(), map: ms.generateMap({ hires: true }) };
}

/** Vitiate's own packages - always excluded from instrumentation and hook rewriting. */
const VITIATE_PACKAGES = new Set([
  "@vitiate/core",
  "@vitiate/engine",
  "@vitiate/swc-plugin",
]);

/**
 * Check if a module ID belongs to one of the listed packages.
 * Matches `/node_modules/<packageName>/` as a substring of the resolved
 * module ID. The match is on path segment boundaries to prevent partial
 * name matches (e.g., `flat` does not match `flatted`).
 *
 * Handles standard, pnpm, and nested node_modules layouts:
 * - Standard: `node_modules/flatted/src/index.js`
 * - pnpm: `node_modules/.pnpm/flatted@3.4.1/node_modules/flatted/src/index.js`
 * - Nested: `node_modules/foo/node_modules/flatted/src/index.js`
 */
export function isListedPackage(
  moduleId: string,
  packages: string[],
): string | undefined {
  // Normalize Windows backslashes so the substring match works on native paths
  // (resolver-produced ids) as well as Vite's already-POSIX ids.
  const id = moduleId.replace(/\\/g, "/");
  for (const pkg of packages) {
    if (VITIATE_PACKAGES.has(pkg)) continue;
    if (id.includes(`/node_modules/${pkg}/`)) return pkg;
  }
  return undefined;
}

function resolveSwcPlugin(): { wasmPath: string; packageDir: string } {
  const pkgPath = require.resolve("@vitiate/swc-plugin/package.json");
  const pkg = require(pkgPath) as { main?: string };
  if (!pkg.main) {
    throw new Error(
      "@vitiate/swc-plugin package.json is missing a 'main' field",
    );
  }
  const packageDir = path.dirname(pkgPath);
  return { wasmPath: path.join(packageDir, pkg.main), packageDir };
}

function resolveSetupPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // In development (src/), the setup file is setup.ts
  // In production (dist/), the setup file is setup.js
  const tsPath = path.join(thisDir, "setup.ts");
  if (existsSync(tsPath)) return tsPath;
  const jsPath = path.join(thisDir, "setup.js");
  if (existsSync(jsPath)) return jsPath;
  throw new Error(`Cannot find setup file: tried ${tsPath} and ${jsPath}`);
}

/**
 * Vite/Vitest plugin that instruments JavaScript and TypeScript source with
 * edge coverage counters and comparison tracing via the SWC WASM plugin.
 *
 * Returns an array of two Vite plugins:
 * - **vitiate:hooks** (enforce: "pre"): In fuzz mode, rewrites ESM named
 *   imports of hooked built-in modules (child_process, fs) into default
 *   import + destructuring. This ensures the imported values are read from
 *   the live CJS module object (where detector hooks are installed) at
 *   evaluation time, rather than from the frozen ESM namespace that Vitest
 *   externalizes at startup.
 * - **vitiate:instrument** (enforce: "post"): Runs SWC instrumentation
 *   (edge coverage counters, comparison tracing) after other transforms.
 *
 * @example
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { vitiatePlugin } from "@vitiate/core/plugin";
 *
 * export default defineConfig({
 *   plugins: [vitiatePlugin()],
 * });
 * ```
 */
export function vitiatePlugin(options?: VitiatePluginOptions): Plugin[] {
  const { include, exclude, packages } = resolveInstrumentOptions(
    options?.instrument,
  );
  const fuzz = options?.fuzz;
  const dataDir = options?.dataDir;
  const coverageMapSize = options?.coverageMapSize;
  // Always exclude vitiate's own package directories - setup/globals files must
  // run before the coverage map exists and cannot be instrumented, and the napi
  // native binding loader must not be instrumented either. In pnpm workspaces,
  // symlinked packages resolve to real paths that bypass the default
  // **/node_modules/** exclude pattern.
  const vitiateDir = path.dirname(fileURLToPath(import.meta.url));
  const vitiateNapiDir = path.dirname(
    require.resolve("@vitiate/engine/package.json"),
  );
  const { wasmPath, packageDir: vitiateSWCDir } = resolveSwcPlugin();
  // Always exclude node_modules from include/exclude filter regardless of
  // user-provided exclude patterns. Dependency instrumentation is exclusively
  // via the `packages` option. Vitiate's own packages are excluded here by
  // directory path; VITIATE_PACKAGES above excludes them by name in
  // isListedPackage() - both layers are needed for defense-in-depth.
  const resolvedExclude = [
    ...exclude,
    "**/node_modules/**",
    `${vitiateDir}/**`,
    `${vitiateNapiDir}/**`,
    `${vitiateSWCDir}/**`,
  ];
  // Instrument plugin: include+exclude controls which files get SWC coverage counters.
  const instrumentFilter = createFilter(include, resolvedExclude);
  // Hooks plugin: exclude-only filter. The hooks plugin must process all JS/TS files
  // not in the exclude list (regardless of include patterns) because detector import
  // rewriting must work across all user code including test files, even when
  // instrumentation scope is narrowed via include.
  const hooksFilter = createFilter(undefined, resolvedExclude);
  const setupPath = resolveSetupPath();

  let swcModule: Promise<typeof import("@swc/core")> | undefined;

  // Track which listed packages were actually seen during transforms
  // so we can warn about typos or missing packages at the end.
  const seenPackages = new Set<string>();

  // CommonJS compilation state (Decision 5/9). `compiledBundles` maps an owned
  // resolved entry path to its esbuild bundle; `resolveId` returns that path and
  // `load` serves the bundle. Root entries are compiled eagerly in `buildStart`;
  // subpath entries lazily on first resolve. `rootEntryPaths` lets `load` treat a
  // missing root-entry bundle as an internal error rather than a silent
  // fallthrough to native require.
  const compiledBundles = new Map<string, CompiledBundle>();
  const rootEntryPaths = new Set<string>();
  // Resolved entry path -> listed package name, so `load` and diagnostics can
  // name the owning package.
  const ownedEntryPackage = new Map<string, string>();
  // In-flight compiles keyed by entry path, so concurrent resolves of the same
  // not-yet-compiled entry share one esbuild build instead of racing.
  const compilingBundles = new Map<string, Promise<CompiledBundle>>();
  // Vite/vitiate cache dir for on-disk bundle caching, captured in
  // `configResolved`.
  let cjsCacheDir: string | undefined;
  // Listed packages excluding vitiate's own (the set we actually instrument).
  const listedPackages = packages.filter((pkg) => !VITIATE_PACKAGES.has(pkg));

  /** Strip a query/hash suffix from a module id to get the bare file path. */
  const bareId = (id: string): string => id.replace(/[?#].*$/, "");

  /**
   * Classify a listed package's resolved entry and, if CommonJS, compile it
   * into the bundle cache (idempotent). Returns true when the entry is CJS and
   * now owned by resolveId/load, false when it is ESM (left on the inline path).
   *
   * :param pkgName: the listed package name (for diagnostics).
   * :param entryPath: the resolved entry file path.
   * :param isRoot: whether this is a package root entry (compiled eagerly).
   * :raises CjsCompileError: on a native/missing/uncompilable CJS entry.
   */
  async function ensureCjsBundle(
    pkgName: string,
    entryPath: string,
    isRoot: boolean,
  ): Promise<boolean> {
    // A listed package can expose non-JS subpaths (CSS, wasm, images) whose
    // import would make the esbuild bundle fail; leaving those to normal handling
    // avoids a spurious startup abort. A `.node` entry is the exception - it flows
    // through to compileCjsEntry, which raises the native-only hard error.
    if (!JS_TS_EXTENSIONS.test(entryPath) && !entryPath.endsWith(".node")) {
      return false;
    }
    if (compiledBundles.has(entryPath)) return true;
    const kind = await classifyEntry(entryPath);
    if (kind === "esm") return false;

    // Dedup concurrent compiles of the same entry onto one esbuild build.
    let inflight = compilingBundles.get(entryPath);
    if (!inflight) {
      inflight = compileCjsEntry({
        packageName: pkgName,
        entryPath,
        cacheDir: cjsCacheDir,
      });
      compilingBundles.set(entryPath, inflight);
    }
    try {
      const bundle = await inflight;
      compiledBundles.set(entryPath, bundle);
      ownedEntryPackage.set(entryPath, pkgName);
      if (isRoot) rootEntryPaths.add(entryPath);
      return true;
    } finally {
      compilingBundles.delete(entryPath);
    }
  }

  // Rewrite named imports of hooked built-in modules so they read from
  // the CJS module object (where detector hooks are installed) instead of
  // the frozen ESM namespace that Vitest externalizes. Active in all modes
  // so detectors work in both fuzz and regression mode.
  const hooksPlugin: Plugin = {
    name: "vitiate:hooks",
    enforce: "pre",

    async buildStart() {
      await init;
    },

    transform(code, id) {
      // Skip virtual modules and non-JS/TS files unconditionally.
      if (id.startsWith("\0")) return null;
      if (!JS_TS_EXTENSIONS.test(id)) return null;
      // Listed packages bypass the exclude filter so detector import
      // rewriting works in instrumented dependencies.
      const matchedPackage =
        packages.length > 0 ? isListedPackage(id, packages) : undefined;
      if (!matchedPackage && !hooksFilter(id)) return null;
      return rewriteHookedImports(code);
    },
  };

  const instrumentPlugin: Plugin = {
    name: "vitiate:instrument",
    enforce: "post",

    // Eagerly resolve and classify every listed package's root entry, compiling
    // every CommonJS one, so a compile misconfiguration (native-only,
    // no-usable-entry, esbuild bundle failure) aborts at startup - before any
    // fuzzing - and `load` for a root entry reduces to a cache lookup. Vite
    // awaits `buildStart` before any transform. Uses the same resolver/options
    // as `resolveId` so the entry classified here is the one served later.
    //
    // Eager root resolution is best-effort: a listed package is not always
    // resolvable by its bare name from the project root (npm aliases like
    // `flatted` imported as `flatted-vulnerable`, or a dep only reachable from a
    // specific importer). Such a package is NOT treated as missing here - it is
    // deferred to `resolveId`, which owns it by its RESOLVED path at import time.
    // A genuinely uninstalled package that is imported still surfaces as a
    // natural Vite import-resolution error; one that is never imported is
    // reported by the `buildEnd` warning.
    async buildStart() {
      seenPackages.clear();
      // Reset compilation state so a rebuild (watch mode) recompiles rather than
      // serving a stale in-memory bundle; the on-disk cache still short-circuits
      // unchanged entries. Root entries are repopulated below; subpath entries
      // lazily on their next resolve.
      compiledBundles.clear();
      rootEntryPaths.clear();
      ownedEntryPackage.clear();
      compilingBundles.clear();
      for (const pkg of listedPackages) {
        let resolved;
        try {
          resolved = await this.resolve(pkg, undefined, { skipSelf: true });
        } catch {
          resolved = null;
        }
        if (!resolved || resolved.external) continue;
        await ensureCjsBundle(pkg, bareId(resolved.id), true);
      }
    },

    // Take ownership of a listed CommonJS package's entry so Vitest cannot
    // externalize it. Bare-specifier imports of a listed package (root or
    // subpath, including npm aliases that resolve into the package) are resolved
    // and, if CommonJS, served as an owned id. ESM entries and non-listed
    // sources return null (no interception). Subpath entries are compiled
    // lazily here on first resolve; a compile failure is a hard error.
    async resolveId(source, importer) {
      if (listedPackages.length === 0) return null;
      // Only bare specifiers can name a package.
      if (
        !source ||
        source.startsWith(".") ||
        source.startsWith("\0") ||
        source.startsWith("node:") ||
        path.isAbsolute(source)
      ) {
        return null;
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      const entryPath = bareId(resolved.id);
      const pkg = isListedPackage(entryPath, listedPackages);
      if (!pkg) return null;
      const isCjs = await ensureCjsBundle(pkg, entryPath, false);
      if (!isCjs) return null; // ESM: continue through the inline path.
      // external: false is explicit (not just the Rollup default): it is the
      // property that makes this resolution win over Vitest's externalizer, and
      // is the form the resolve-beats-externalizer behavior was validated with.
      return { id: entryPath, external: false };
    },

    // Serve the compiled bundle for an owned CommonJS entry. A root entry we own
    // but have no bundle for is an internal error, never a silent fallthrough.
    load(id) {
      const clean = bareId(id);
      const bundle = compiledBundles.get(clean);
      if (bundle) {
        return { code: bundle.code, map: bundle.map ?? null };
      }
      if (rootEntryPaths.has(clean)) {
        const pkg = ownedEntryPackage.get(clean) ?? "unknown";
        throw new Error(
          `vitiate: internal error: no compiled bundle for owned root entry of package "${pkg}" ("${clean}")`,
        );
      }
      return null;
    },

    config(config) {
      // Resolve the Vite project root and store as module-scoped state
      const projectRoot = path.resolve(config.root ?? process.cwd());
      setProjectRoot(projectRoot);

      // If dataDir is provided, resolve it relative to the project root
      if (dataDir) {
        setDataDir(path.resolve(projectRoot, dataDir));
      }

      // Store coverage map size for globals.ts
      if (coverageMapSize !== undefined) {
        setCoverageMapSize(coverageMapSize);
      }

      // Propagate resolved plugin config to processes where no plugin hook
      // runs: forks-pool workers (which host the fuzz loop) and the supervisor
      // child inherit env, but not the module singletons set above. Without
      // this, a worker resolves the default map size and a cwd-derived data
      // dir - so a non-default coverageMapSize silently drops most edges and a
      // custom dataDir/root diverges from where artifacts are written. Always
      // overwrite: this hook is authoritative for its process tree, and the
      // supervisor child re-runs it via --config (idempotent). Any invalid
      // coverageMapSize already threw above, before any env is written.
      // Resolve from the in-scope option values (not the getters, which fall
      // back to these same env vars in workers) so a stale inherited value is
      // replaced rather than re-propagated.
      process.env["VITIATE_PROJECT_ROOT"] = projectRoot;
      process.env["VITIATE_DATA_DIR"] = path.resolve(
        projectRoot,
        dataDir ?? ".vitiate",
      );
      process.env["VITIATE_COVERAGE_MAP_SIZE"] = String(
        coverageMapSize ?? COVERAGE_MAP_SIZE,
      );

      // Serialize FuzzOptions as VITIATE_OPTIONS
      if (fuzz && !process.env["VITIATE_OPTIONS"]) {
        const serialized = JSON.stringify(fuzz);
        if (serialized !== "{}") {
          process.env["VITIATE_OPTIONS"] = serialized;
        }
      }

      // Tell Vitest to inline listed packages through the Vite transform
      // pipeline so they reach our transform hooks for instrumentation and
      // hook rewriting. Each package gets a regex matching its node_modules
      // path. Vite's mergeConfig concatenates arrays, so these are appended
      // to user-provided entries.
      // The setting MUST be inside the `test` key - Vitest's test module
      // resolver reads from viteConfig.test.server.deps, not the top-level
      // viteConfig.server.deps. Cast required because `test.server.deps`
      // is a Vitest extension absent from Vite's UserConfig type.
      const escapeRegex = (s: string) =>
        s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const inlinePatterns: RegExp[] = listedPackages.map(
        (pkg) => new RegExp(`/node_modules/${escapeRegex(pkg)}/`),
      );

      // Propagate the listed packages to processes where no plugin hook runs
      // (forks-pool workers hosting the fuzz loop) so the "no coverage" message
      // can name them. Always overwrite for authoritativeness; clear when empty.
      if (listedPackages.length > 0) {
        process.env["VITIATE_INSTRUMENT_PACKAGES"] =
          JSON.stringify(listedPackages);
      } else {
        delete process.env["VITIATE_INSTRUMENT_PACKAGES"];
      }

      return {
        test: {
          setupFiles: [setupPath],
          ...(inlinePatterns.length > 0
            ? { server: { deps: { inline: inlinePatterns } } }
            : {}),
        },
        // Dep-optimizer guard (Decision 11): keep listed packages out of the
        // optimizer so their ids stay matchable by isListedPackage's
        // /node_modules/<pkg>/ substring (defends against config drift; the
        // SSR/node path the fuzz worker uses normally has the optimizer off).
        ...(listedPackages.length > 0
          ? { optimizeDeps: { exclude: listedPackages } }
          : {}),
      } as Record<string, unknown>;
    },

    configResolved(resolvedConfig) {
      // Capture the resolved config file path for forwarding to child
      // processes via spawnChild. configFile is the absolute path to
      // the config file, or false if no config file was used.
      const configFile = (
        resolvedConfig as unknown as { configFile: string | false }
      ).configFile;
      if (typeof configFile === "string") {
        setConfigFile(configFile);
      }

      // Capture the Vite/vitiate cache directory for on-disk CJS bundle caching.
      const cacheDir = (resolvedConfig as unknown as { cacheDir?: string })
        .cacheDir;
      if (typeof cacheDir === "string") {
        cjsCacheDir = cacheDir;
      }

      // Early coverage map initialization - Vite awaits configResolved
      // (including async hooks) before module resolution, transforms,
      // or evaluation. This guarantees globals are available before any
      // instrumented code (including inlined dependency modules) can execute.
      const resolvedMapSize = getCoverageMapSize();

      if (isFuzzingMode()) {
        // Fuzz mode: load @vitiate/engine napi addon and create
        // Rust-backed buffer for zero-copy feedback to the fuzzing engine.
        let createCoverageMap: (size: number) => Buffer;
        try {
          ({ createCoverageMap } = require("@vitiate/engine") as {
            createCoverageMap: (size: number) => Buffer;
          });
        } catch (e) {
          throw new Error(
            `vitiate: failed to load @vitiate/engine native addon. ` +
              `Are prebuilt binaries available for your platform?`,
            { cause: e },
          );
        }
        globalThis.__vitiate_cov = createCoverageMap(resolvedMapSize);
      } else {
        // Regression mode: plain Uint8Array that absorbs counter writes.
        globalThis.__vitiate_cov = new Uint8Array(resolvedMapSize);
      }

      // Early trace function initialization - set up stable forwarding
      // wrappers that delegate to replaceable implementation variables.
      // The wrapper function references never change, preserving identity
      // for modules that cache them at module scope during early evaluation.
      globalThis.__vitiate_cmplog_write_impl = (
        _l: unknown,
        _r: unknown,
        _c: number,
        _o: number,
      ) => {};
      globalThis.__vitiate_cmplog_reset_counts_impl = () => {};

      globalThis.__vitiate_cmplog_write = (
        left: unknown,
        right: unknown,
        cmpId: number,
        opId: number,
      ) => {
        globalThis.__vitiate_cmplog_write_impl(left, right, cmpId, opId);
      };
      globalThis.__vitiate_cmplog_reset_counts = () => {
        globalThis.__vitiate_cmplog_reset_counts_impl();
      };
    },

    async transform(code, id) {
      // Check packages list first - listed packages bypass include/exclude filter
      const matchedPackage =
        packages.length > 0 ? isListedPackage(id, packages) : undefined;
      if (!matchedPackage && !instrumentFilter(id)) return null;

      if (matchedPackage) {
        seenPackages.add(matchedPackage);
      }

      swcModule ??= import("@swc/core");
      const { transform } = await swcModule;
      const result = await transform(code, {
        filename: id,
        sourceMaps: true,
        jsc: {
          parser: { syntax: "ecmascript" },
          target: "es2022",
          experimental: {
            plugins: [
              [
                wasmPath,
                {
                  coverageMapSize: getCoverageMapSize(),
                  traceCmp: true,
                  coverageGlobalName: "__vitiate_cov",
                  traceCmpGlobalName: "__vitiate_cmplog_write",
                },
              ],
            ],
          },
        },
        isModule: true,
      });

      return {
        code: result.code,
        map: result.map ?? undefined,
      };
    },

    buildEnd() {
      // The resolved-but-never-imported case remains a warning: a listed package
      // resolved (and, if CJS, compiled) fine but no module from it was
      // transformed. This is legitimate for filtered runs or conditional imports,
      // so it does not abort. Unambiguous misconfigurations already aborted in
      // buildStart with a hard error.
      for (const pkg of listedPackages) {
        if (!seenPackages.has(pkg)) {
          process.stderr.write(
            `vitiate: warning: package "${pkg}" was listed in instrument.packages but never imported by the tests that ran (no modules from it were transformed).\n`,
          );
        }
      }
    },
  };

  return [hooksPlugin, instrumentPlugin];
}
