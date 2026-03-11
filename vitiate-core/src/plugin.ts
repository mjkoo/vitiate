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
import type { VitiatePluginOptions } from "./config.js";
import {
  resolveInstrumentOptions,
  setCoverageMapSize,
  getCoverageMapSize,
  setProjectRoot,
  setCacheDir,
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
 * from the ESM namespace — which Vitest's SSR runner externalizes and
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
  // Skip `import type` — at enforce: "pre", TypeScript hasn't been
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
    // namespace import, skip this import — it's purely types. Rewriting it
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
 * import { vitiatePlugin } from "vitiate";
 *
 * export default defineConfig({
 *   plugins: [vitiatePlugin()],
 * });
 * ```
 */
export function vitiatePlugin(options?: VitiatePluginOptions): Plugin[] {
  const { include, exclude } = resolveInstrumentOptions(options?.instrument);
  const fuzz = options?.fuzz;
  const cacheDir = options?.cacheDir;
  const coverageMapSize = options?.coverageMapSize;
  // Always exclude vitiate's own package directories — setup/globals files must
  // run before the coverage map exists and cannot be instrumented, and the napi
  // native binding loader must not be instrumented either. In pnpm workspaces,
  // symlinked packages resolve to real paths that bypass the default
  // **/node_modules/** exclude pattern.
  const vitiateDir = path.dirname(fileURLToPath(import.meta.url));
  const vitiateNapiDir = path.dirname(
    require.resolve("@vitiate/engine/package.json"),
  );
  const { wasmPath, packageDir: vitiateSWCDir } = resolveSwcPlugin();
  const resolvedExclude = [
    ...exclude,
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
  // Heuristic: if no user-provided exclude pattern mentions "node_modules",
  // assume the user wants to instrument dependencies. We check the original
  // exclude array (not resolvedExclude, which includes vitiate's own dirs).
  const nodeModulesExcluded = exclude.some((pattern) =>
    pattern.includes("node_modules"),
  );
  const setupPath = resolveSetupPath();

  let swcModule: Promise<typeof import("@swc/core")> | undefined;

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
      // Apply the exclude-only filter (respects user's exclude config).
      if (!hooksFilter(id)) return null;
      return rewriteHookedImports(code);
    },
  };

  const instrumentPlugin: Plugin = {
    name: "vitiate:instrument",
    enforce: "post",

    config(config) {
      // Resolve the Vite project root and store as module-scoped state
      const projectRoot = path.resolve(config.root ?? process.cwd());
      setProjectRoot(projectRoot);

      // If cacheDir is provided, resolve it relative to the project root
      if (cacheDir) {
        setCacheDir(path.resolve(projectRoot, cacheDir));
      }

      // Store coverage map size for globals.ts
      if (coverageMapSize !== undefined) {
        setCoverageMapSize(coverageMapSize);
      }

      // Serialize FuzzOptions as VITIATE_FUZZ_OPTIONS
      if (fuzz && !process.env["VITIATE_FUZZ_OPTIONS"]) {
        const serialized = JSON.stringify(fuzz);
        if (serialized !== "{}") {
          process.env["VITIATE_FUZZ_OPTIONS"] = serialized;
        }
      }

      // When node_modules are not excluded, tell Vitest to inline all
      // dependencies through the Vite transform pipeline so they reach
      // our transform hooks for instrumentation and hook rewriting.
      // Note: server.deps.inline is a Vitest runtime extension not present
      // in Vite's ServerOptions type, so we cast to satisfy the config hook
      // return type.
      return {
        test: { setupFiles: [setupPath] },
        ...(!nodeModulesExcluded
          ? { server: { deps: { inline: true } } as Record<string, unknown> }
          : {}),
      };
    },

    async transform(code, id) {
      if (!instrumentFilter(id)) return null;

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
                  traceCmpGlobalName: "__vitiate_trace_cmp",
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
  };

  return [hooksPlugin, instrumentPlugin];
}
