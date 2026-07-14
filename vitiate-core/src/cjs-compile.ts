/**
 * CommonJS dependency compilation for `instrument.packages`.
 *
 * A listed npm package whose resolved entry is CommonJS cannot be instrumented
 * on Vitest's externalization path: the entry is loaded by native Node and its
 * internal relative `require("./sub")` calls never reach vitiate's SWC
 * transform. This module compiles such a package's own sources into a single
 * ESM bundle with esbuild, so the one module the plugin serves contains all of
 * the package's code and the existing enforce:"post" transform can instrument
 * it end to end.
 *
 * esbuild and cjs-module-lexer are imported lazily so configs without CommonJS
 * packages never load them (mirroring the lazy `import("@swc/core")` in
 * plugin.ts).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  init as esmLexerInit,
  parse as parseEsm,
  ImportType,
} from "es-module-lexer";
import type { BuildFailure, Message } from "esbuild";

const require = createRequire(import.meta.url);

/** Resolved-entry classification. */
export type EntryKind = "cjs" | "esm";

/** Cause categories for a compilation/resolution failure, each a hard error. */
export type CjsCompileCause = "no-entry" | "bundle-failed" | "native-only";

/**
 * A hard error raised for an unambiguously misconfigured listed package.
 * Rendered by the plugin into a startup abort naming the package and cause.
 */
export class CjsCompileError extends Error {
  public readonly packageName: string;
  public readonly compileCause: CjsCompileCause;

  /**
   * :param packageName: the listed package (or `pkg/subpath`) that failed.
   * :param compileCause: which escalated cause this is.
   * :param message: human-readable description (already names the package).
   * :param cause: the underlying error (e.g. an esbuild BuildFailure), if any.
   */
  constructor(
    packageName: string,
    compileCause: CjsCompileCause,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CjsCompileError";
    this.packageName = packageName;
    this.compileCause = compileCause;
  }
}

/** A compiled ESM bundle: instrumentable code plus its external source map. */
export interface CompiledBundle {
  code: string;
  /** JSON source-map string, or undefined if esbuild produced none. */
  map: string | undefined;
}

// ── Classification ──────────────────────────────────────────────────────────

const classificationCache = new Map<string, EntryKind>();

/**
 * Classify a resolved entry file as CommonJS or ESM, extension first (the
 * `package.json` `type` field governs only `.js`):
 * `.mjs` => ESM; `.cjs` => CJS even under `type: "module"`; `.js` (or an
 * extensionless entry) => nearest `package.json` `type: "module"` => ESM, else
 * parse with es-module-lexer (ESM import/export syntax => ESM, else CJS).
 *
 * Package metadata (`module`, `exports` conditions) is deliberately not read:
 * classification must agree with what resolution actually produced.
 *
 * :param entryPath: absolute path to the resolved entry file.
 * :returns: `"cjs"` or `"esm"`.
 */
export async function classifyEntry(entryPath: string): Promise<EntryKind> {
  const cached = classificationCache.get(entryPath);
  if (cached !== undefined) return cached;
  const kind = await classifyEntryUncached(entryPath);
  classificationCache.set(entryPath, kind);
  return kind;
}

/** Clear the classification cache. For testing only. */
export function resetClassificationCache(): void {
  classificationCache.clear();
}

async function classifyEntryUncached(entryPath: string): Promise<EntryKind> {
  const ext = path.extname(entryPath).toLowerCase();
  if (ext === ".mjs" || ext === ".mts") return "esm";
  if (ext === ".cjs" || ext === ".cts") return "cjs";

  // `.js` (or extensionless): the `type` field decides, else content detection.
  if (nearestPackageType(entryPath) === "module") return "esm";

  let source: string;
  try {
    source = readFileSync(entryPath, "utf8");
  } catch {
    // Unreadable entry: treat as CJS; a genuine no-entry surfaces at compile.
    return "cjs";
  }

  await esmLexerInit;
  try {
    const [imports, exports] = parseEsm(source);
    const hasStaticImport = imports.some((imp) => imp.t === ImportType.Static);
    if (hasStaticImport || exports.length > 0) return "esm";
  } catch {
    // Unparseable as ESM: it is CommonJS (or invalid); compile as CJS.
  }
  return "cjs";
}

/**
 * Read the `type` field of the nearest `package.json` at or above `filePath`.
 * :returns: the `type` string (e.g. `"module"`), or undefined if none is set.
 */
function nearestPackageType(filePath: string): string | undefined {
  const pkg = findNearestPackageJson(filePath);
  if (!pkg) return undefined;
  return typeof pkg.data.type === "string" ? pkg.data.type : undefined;
}

interface NearestPackage {
  dir: string;
  jsonPath: string;
  data: { type?: unknown; version?: unknown; name?: unknown };
}

/**
 * Walk up from `filePath` to the nearest readable `package.json`.
 * :returns: its directory, path, and parsed data, or undefined if none exists.
 */
function findNearestPackageJson(filePath: string): NearestPackage | undefined {
  let dir = path.dirname(filePath);
  for (;;) {
    const jsonPath = path.join(dir, "package.json");
    if (existsSync(jsonPath)) {
      try {
        const data = JSON.parse(readFileSync(jsonPath, "utf8")) as {
          type?: unknown;
          version?: unknown;
          name?: unknown;
        };
        return { dir, jsonPath, data };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ── Named-export enumeration (cjs-module-lexer) ──────────────────────────────

let cjsLexer: typeof import("cjs-module-lexer") | undefined;

/** Lazily import and initialize cjs-module-lexer. */
async function getCjsLexer(): Promise<typeof import("cjs-module-lexer")> {
  if (!cjsLexer) {
    const mod = await import("cjs-module-lexer");
    await mod.init();
    cjsLexer = mod;
  }
  return cjsLexer;
}

const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Identifiers the generated bundle already binds at module scope: the banner's
 * `require`/`createRequire` alias and the synthetic entry's `__vitiate_mod`. A
 * package export with one of these names would produce a duplicate top-level
 * declaration (a SyntaxError), so they are never re-exported.
 */
const GENERATED_BINDINGS = new Set([
  "default",
  "require",
  "__vitiate_mod",
  "__vitiate_createRequire",
]);

/** Whether `name` is a plain ES identifier usable as an `export const` binding. */
function isValidExportName(name: string): boolean {
  return (
    IDENTIFIER_RE.test(name) &&
    !RESERVED_WORDS.has(name) &&
    !GENERATED_BINDINGS.has(name)
  );
}

/**
 * Enumerate the named exports Node's CJS-ESM interop would synthesize for a
 * CommonJS entry, using cjs-module-lexer and following its relative reexport
 * chains through the package's own files (bare-specifier reexports are external
 * and not followed, matching `packages: "external"`).
 *
 * Names that are not valid identifiers, and `default`, are skipped. A lexing
 * failure on the root entry yields `[]` (default-only), matching Node's
 * behavior for unlexable CommonJS.
 *
 * :param entryPath: absolute path to the resolved CJS entry file.
 * :returns: sorted list of valid named exports (excluding `default`).
 */
export async function enumerateNamedExports(
  entryPath: string,
): Promise<string[]> {
  const lexer = await getCjsLexer();
  const names = new Set<string>();
  const visited = new Set<string>();
  try {
    collectExports(entryPath, lexer, names, visited, 0);
  } catch {
    // Root entry unlexable: fall back to default-only.
    return [];
  }
  // isValidExportName excludes `default`, reserved words, and the identifiers the
  // generated bundle already binds (require/__vitiate_mod/__vitiate_createRequire).
  return [...names].filter(isValidExportName).sort();
}

const MAX_REEXPORT_DEPTH = 64;

function collectExports(
  file: string,
  lexer: typeof import("cjs-module-lexer"),
  names: Set<string>,
  visited: Set<string>,
  depth: number,
): void {
  if (visited.has(file) || depth > MAX_REEXPORT_DEPTH) return;
  visited.add(file);

  const source = readFileSync(file, "utf8");
  // A parse failure at the root propagates (caller falls back to default-only);
  // for reexported files we let it propagate too, which is conservative.
  const { exports, reexports } = lexer.parse(source);
  for (const name of exports) names.add(name);

  for (const re of reexports) {
    if (!re.startsWith(".")) continue; // external dep: not our package's source
    let resolved: string;
    try {
      resolved = require.resolve(re, { paths: [path.dirname(file)] });
    } catch {
      continue;
    }
    try {
      collectExports(resolved, lexer, names, visited, depth + 1);
    } catch {
      // A broken reexported file contributes no names but does not abort the
      // whole enumeration.
    }
  }
}

// ── Synthetic entry + require banner ─────────────────────────────────────────

/**
 * Generate the synthetic ESM entry esbuild bundles: default-export the entry's
 * `module.exports`, then re-export each detected named export as a snapshot
 * binding (`export const x = mod.x`), matching Node's interop.
 *
 * The entry is imported by a path specifier esbuild resolves and bundles (a
 * relative path, so `packages: "external"` does not externalize it - only bare
 * specifiers are externalized).
 *
 * :param entrySpecifier: import specifier for the real entry, relative to the
 *   bundle's resolveDir (e.g. `"./index.js"`).
 * :param names: valid named exports from `enumerateNamedExports`.
 */
export function buildSyntheticEntry(
  entrySpecifier: string,
  names: string[],
): string {
  const spec = JSON.stringify(entrySpecifier);
  const lines = [
    `import __vitiate_mod from ${spec};`,
    `export default __vitiate_mod;`,
  ];
  for (const name of names) {
    lines.push(`export const ${name} = __vitiate_mod.${name};`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Build the esbuild banner that establishes a native `require` in module scope
 * via `createRequire`, with the real entry's file URL embedded literally at
 * build time (not `import.meta.url`), so external static and dynamic requires
 * resolve with native Node semantics regardless of the id the bundle is served
 * under. esbuild's `__require` shim delegates to this `require` when defined.
 *
 * :param entryPath: absolute path to the real CJS entry.
 */
export function buildBanner(entryPath: string): string {
  const url = JSON.stringify(pathToFileURL(entryPath).href);
  return (
    `import { createRequire as __vitiate_createRequire } from "node:module";\n` +
    `const require = __vitiate_createRequire(${url});`
  );
}

// ── Compilation + on-disk cache ──────────────────────────────────────────────

/**
 * Bumped whenever the bundle recipe (build options, banner shape, synthetic
 * entry schema) changes, so on-disk bundles from an older recipe are rejected.
 */
const BUNDLE_RECIPE_VERSION = "1";

export interface CompileRequest {
  /** The listed package name (or `pkg/subpath`), for error messages. */
  packageName: string;
  /** Absolute path to the resolved CJS entry file. */
  entryPath: string;
  /**
   * Absolute path to the vitiate/Vite cache directory, or undefined to disable
   * the on-disk cache (always rebuild).
   */
  cacheDir: string | undefined;
}

/**
 * Compile a listed package's resolved CJS entry into an instrumentable ESM
 * bundle, reusing an on-disk cached build when the cache key is unchanged.
 *
 * The cache is bypassed (always rebuild) when the entry lies outside any
 * `node_modules` segment (workspace / `file:` / `link:` case, where version and
 * mtime keys are unreliable).
 *
 * :param req: the compile request.
 * :returns: the compiled `{ code, map }`.
 * :raises CjsCompileError: on a missing/native/uncompilable entry.
 */
export async function compileCjsEntry(
  req: CompileRequest,
): Promise<CompiledBundle> {
  const { packageName, entryPath } = req;

  if (!existsSync(entryPath)) {
    throw new CjsCompileError(
      packageName,
      "no-entry",
      `vitiate: package "${packageName}" resolved to "${entryPath}" but that entry file does not exist.`,
    );
  }
  if (entryPath.endsWith(".node")) {
    throw new CjsCompileError(
      packageName,
      "native-only",
      `vitiate: package "${packageName}" resolved to a native addon ("${entryPath}") which cannot be instrumented.`,
    );
  }

  const cachePaths = computeCachePaths(req);
  if (cachePaths) {
    const hit = readCache(cachePaths);
    if (hit) return hit;
  }

  const bundle = await runEsbuild(req);

  if (cachePaths) {
    writeCache(cachePaths, bundle);
  }
  return bundle;
}

interface CachePaths {
  codePath: string;
  mapPath: string;
}

/**
 * Compute the on-disk cache paths for a compile request, or undefined when the
 * cache must be bypassed (no cacheDir, or entry outside node_modules).
 */
function computeCachePaths(req: CompileRequest): CachePaths | undefined {
  const { cacheDir, entryPath, packageName } = req;
  if (!cacheDir) return undefined;
  // Substring check mirrors isListedPackage; Vite ids use forward slashes.
  if (!entryPath.includes("/node_modules/")) return undefined;

  const pkg = findNearestPackageJson(entryPath);
  const version =
    pkg && typeof pkg.data.version === "string" ? pkg.data.version : "0.0.0";
  const key = computeBundleCacheKey({
    packageName,
    version,
    entryPath,
    entryMtimeMs: safeMtimeMs(entryPath),
    pkgJsonMtimeMs: pkg ? safeMtimeMs(pkg.jsonPath) : 0,
    fingerprint: toolchainFingerprint(),
  });

  const dir = path.join(cacheDir, "vitiate-cjs");
  return {
    codePath: path.join(dir, `${key}.js`),
    mapPath: path.join(dir, `${key}.js.map`),
  };
}

/** Inputs to the on-disk bundle cache key. */
export interface BundleCacheKeyParams {
  packageName: string;
  version: string;
  entryPath: string;
  entryMtimeMs: number;
  pkgJsonMtimeMs: number;
  /**
   * esbuild + cjs-module-lexer versions + bundle recipe version (see
   * `toolchainFingerprint`).
   */
  fingerprint: string;
}

/**
 * Compute the content-addressed on-disk cache key. Any change to a component -
 * package name, resolved version, entry path, entry or package.json mtime, or
 * the toolchain fingerprint - yields a different key, forcing a rebuild.
 *
 * :param params: the cache-key components.
 * :returns: a hex digest usable as a filename stem.
 */
export function computeBundleCacheKey(params: BundleCacheKeyParams): string {
  const hash = createHash("sha256");
  for (const part of [
    params.packageName,
    params.version,
    params.entryPath,
    String(params.entryMtimeMs),
    String(params.pkgJsonMtimeMs),
    params.fingerprint,
  ]) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

let cachedFingerprint: string | undefined;

/**
 * The esbuild + cjs-module-lexer versions + bundle recipe version, keyed into
 * the cache. cjs-module-lexer is included because it produces the synthetic
 * entry's named-export set, so upgrading it can change the bundle even when no
 * other key component (version, mtime, recipe) moves.
 */
function toolchainFingerprint(): string {
  // require() the versions synchronously; these package.json files are small and
  // this avoids making the pure cache-key computation async.
  if (cachedFingerprint === undefined) {
    cachedFingerprint =
      `esbuild@${readPackageVersion("esbuild")};` +
      `cjs-module-lexer@${readPackageVersion("cjs-module-lexer")};` +
      `recipe@${BUNDLE_RECIPE_VERSION}`;
  }
  return cachedFingerprint;
}

/** Read a dependency's declared version, or `"unknown"` if unreadable. */
function readPackageVersion(pkg: string): string {
  try {
    const json = require(`${pkg}/package.json`) as { version?: unknown };
    return typeof json.version === "string" ? json.version : "unknown";
  } catch {
    return "unknown";
  }
}

function safeMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readCache(paths: CachePaths): CompiledBundle | undefined {
  if (!existsSync(paths.codePath)) return undefined;
  try {
    const code = readFileSync(paths.codePath, "utf8");
    const map = existsSync(paths.mapPath)
      ? readFileSync(paths.mapPath, "utf8")
      : undefined;
    return { code, map };
  } catch {
    return undefined;
  }
}

function writeCache(paths: CachePaths, bundle: CompiledBundle): void {
  try {
    mkdirSync(path.dirname(paths.codePath), { recursive: true });
    // Write the map BEFORE the code: readCache gates on the code file existing,
    // so publishing the map first guarantees a concurrent reader that sees the
    // code also sees its map (never a bundle served without its source map).
    if (bundle.map !== undefined) {
      atomicWrite(paths.mapPath, bundle.map);
    }
    atomicWrite(paths.codePath, bundle.code);
  } catch {
    // A cache-write failure is non-fatal: the in-memory bundle is still served.
  }
}

/** Monotonic suffix so two writers in the same process never share a temp path. */
let tmpWriteCounter = 0;

/** Write `contents` atomically (temp file + rename) so concurrent compilers of
 * the same package never observe a partial bundle. */
function atomicWrite(filePath: string, contents: string): void {
  // A per-process, per-call temp suffix keeps concurrent writers (across
  // processes via pid, within a process via the counter) from colliding on the
  // temp file itself; the final rename is atomic and content-identical.
  const tmp = `${filePath}.${process.pid}.${tmpWriteCounter++}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, filePath);
}

async function runEsbuild(req: CompileRequest): Promise<CompiledBundle> {
  const { packageName, entryPath } = req;
  const esbuild = await import("esbuild");

  // Resolve the entry via a relative specifier from its own directory so
  // `packages: "external"` bundles it (only bare specifiers are externalized).
  // The stdin sourcefile MUST be distinct from the real entry path: reusing the
  // entry path makes esbuild self-reference the module and emit no code.
  const resolveDir = path.dirname(entryPath);
  let entrySpecifier = path
    .relative(resolveDir, entryPath)
    .split(path.sep)
    .join("/");
  if (!entrySpecifier.startsWith(".")) entrySpecifier = `./${entrySpecifier}`;
  const sourcefile = path.join(resolveDir, "__vitiate_synthetic_entry.js");
  const outfile = path.join(resolveDir, "__vitiate_cjs_bundle.js");

  const names = await enumerateNamedExports(entryPath);
  const contents = buildSyntheticEntry(entrySpecifier, names);

  try {
    const result = await esbuild.build({
      stdin: {
        contents,
        resolveDir,
        loader: "js",
        sourcefile,
      },
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      external: ["*.node"],
      banner: { js: buildBanner(entryPath) },
      sourcemap: "external",
      outfile,
      write: false,
      logLevel: "silent",
    });

    let code: string | undefined;
    let map: string | undefined;
    for (const file of result.outputFiles) {
      if (file.path.endsWith(".map")) {
        map = file.text;
      } else {
        code = file.text;
      }
    }
    if (code === undefined) {
      throw new CjsCompileError(
        packageName,
        "bundle-failed",
        `vitiate: esbuild produced no output bundling package "${packageName}".`,
      );
    }
    return { code, map };
  } catch (err) {
    if (err instanceof CjsCompileError) throw err;
    const diagnostics = await formatBuildDiagnostics(esbuild, err);
    throw new CjsCompileError(
      packageName,
      "bundle-failed",
      `vitiate: failed to compile CommonJS package "${packageName}" with esbuild.` +
        (diagnostics ? `\n${diagnostics}` : ""),
      err,
    );
  }
}

/** Extract a readable diagnostics string from an esbuild BuildFailure. */
async function formatBuildDiagnostics(
  esbuild: typeof import("esbuild"),
  err: unknown,
): Promise<string | undefined> {
  const messages = extractEsbuildMessages(err);
  if (!messages) return undefined;
  try {
    const formatted = await esbuild.formatMessages(messages, {
      kind: "error",
      color: false,
    });
    return formatted.join("").trimEnd();
  } catch {
    return messages.map((m) => m.text).join("\n");
  }
}

function extractEsbuildMessages(err: unknown): Message[] | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "errors" in err &&
    Array.isArray((err as BuildFailure).errors)
  ) {
    return (err as BuildFailure).errors;
  }
  return undefined;
}
