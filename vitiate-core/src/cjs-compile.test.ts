import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  classifyEntry,
  resetClassificationCache,
  enumerateNamedExports,
  buildSyntheticEntry,
  buildBanner,
  compileCjsEntry,
  computeBundleCacheKey,
  CjsCompileError,
  type BundleCacheKeyParams,
} from "./cjs-compile.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    tmpdir(),
    `vitiate-cjs-compile-${process.pid}-${Date.now()}-${Math.floor(
      performance.now() * 1000,
    )}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  resetClassificationCache();
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a file under tmpDir, creating parent dirs. Returns the absolute path. */
function write(relPath: string, contents: string): string {
  const abs = path.join(tmpDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return abs;
}

describe("classifyEntry", () => {
  it("classifies a pure-CommonJS .js entry (no type field) as CJS", async () => {
    write(
      "pkg/package.json",
      JSON.stringify({ name: "pkg", main: "index.js" }),
    );
    const entry = write("pkg/index.js", "module.exports = { a: 1 };\n");
    expect(await classifyEntry(entry)).toBe("cjs");
  });

  it("classifies a .cjs entry as CJS", async () => {
    write("pkg/package.json", JSON.stringify({ name: "pkg" }));
    const entry = write("pkg/index.cjs", "module.exports = 1;\n");
    expect(await classifyEntry(entry)).toBe("cjs");
  });

  it("classifies a .mjs entry as ESM", async () => {
    write("pkg/package.json", JSON.stringify({ name: "pkg" }));
    const entry = write("pkg/index.mjs", "export default 1;\n");
    expect(await classifyEntry(entry)).toBe("esm");
  });

  it("classifies a .js entry under type:module as ESM", async () => {
    write(
      "pkg/package.json",
      JSON.stringify({ name: "pkg", type: "module", main: "index.js" }),
    );
    const entry = write("pkg/index.js", "export const a = 1;\n");
    expect(await classifyEntry(entry)).toBe("esm");
  });

  it("classifies a .js entry with ESM syntax (no type field) as ESM", async () => {
    write("pkg/package.json", JSON.stringify({ name: "pkg" }));
    const entry = write(
      "pkg/index.js",
      "import x from './x.js';\nexport { x };\n",
    );
    expect(await classifyEntry(entry)).toBe("esm");
  });

  it("classifies a .cjs entry as CJS even under type:module (extension precedence)", async () => {
    write("pkg/package.json", JSON.stringify({ name: "pkg", type: "module" }));
    const entry = write("pkg/index.cjs", "module.exports = 1;\n");
    expect(await classifyEntry(entry)).toBe("cjs");
  });

  it("classifies the resolved CJS main even when a module field is present (metadata divergence)", async () => {
    // A package advertises an ESM `module` build but resolution selected the CJS
    // `main`. Classification operates on the resolved entry, not the metadata.
    write(
      "pkg/package.json",
      JSON.stringify({
        name: "pkg",
        main: "index.js",
        module: "index.esm.js",
      }),
    );
    write("pkg/index.esm.js", "export default 1;\n");
    const cjsMain = write(
      "pkg/index.js",
      "module.exports = require('./sub');\n",
    );
    expect(await classifyEntry(cjsMain)).toBe("cjs");
  });
});

describe("enumerateNamedExports", () => {
  it("enumerates direct named exports, excluding default and invalid names", async () => {
    const entry = write(
      "pkg/index.js",
      "exports.foo = 1;\nexports.bar = 2;\nmodule.exports.baz = 3;\n",
    );
    const names = await enumerateNamedExports(entry);
    expect(names).toEqual(["bar", "baz", "foo"]);
  });

  it("follows relative reexport chains through the package's own files", async () => {
    write("pkg/sub.js", "exports.subExport = 1;\n");
    const entry = write(
      "pkg/index.js",
      "exports.top = 1;\nmodule.exports = require('./sub.js');\n",
    );
    const names = await enumerateNamedExports(entry);
    expect(names).toContain("subExport");
  });

  it("returns [] (default-only) when the entry is unlexable", async () => {
    const entry = write("pkg/index.js", "this is not ( valid javascript $$$\n");
    expect(await enumerateNamedExports(entry)).toEqual([]);
  });

  it("excludes names the generated bundle already binds (require/__vitiate_mod)", async () => {
    // A package export literally called `require` would collide with the banner's
    // `const require`; such names must never be re-exported.
    const entry = write(
      "pkg/index.js",
      "exports.require = 1;\nexports.__vitiate_mod = 2;\nexports.ok = 3;\n",
    );
    const names = await enumerateNamedExports(entry);
    expect(names).toEqual(["ok"]);
  });
});

describe("buildSyntheticEntry", () => {
  it("default-exports the module and re-exports each named export", () => {
    const src = buildSyntheticEntry("./index.js", ["pki", "util"]);
    expect(src).toContain('import __vitiate_mod from "./index.js";');
    expect(src).toContain("export default __vitiate_mod;");
    expect(src).toContain("export const pki = __vitiate_mod.pki;");
    expect(src).toContain("export const util = __vitiate_mod.util;");
  });
});

describe("buildBanner", () => {
  it("embeds the entry file URL literally in a createRequire banner", () => {
    const banner = buildBanner("/abs/pkg/index.js");
    expect(banner).toContain("createRequire as __vitiate_createRequire");
    expect(banner).toContain("file:///abs/pkg/index.js");
    expect(banner).not.toContain("import.meta.url");
  });
});

describe("computeBundleCacheKey", () => {
  const base: BundleCacheKeyParams = {
    packageName: "pkg",
    version: "1.0.0",
    entryPath: "/x/node_modules/pkg/index.js",
    entryMtimeMs: 1000,
    pkgJsonMtimeMs: 2000,
    fingerprint: "esbuild@0.28.1;recipe@1",
  };

  it("is stable for identical inputs", () => {
    expect(computeBundleCacheKey(base)).toBe(computeBundleCacheKey(base));
  });

  it("changes when the entry mtime changes", () => {
    expect(computeBundleCacheKey({ ...base, entryMtimeMs: 1001 })).not.toBe(
      computeBundleCacheKey(base),
    );
  });

  it("changes when the toolchain fingerprint changes", () => {
    expect(
      computeBundleCacheKey({
        ...base,
        fingerprint: "esbuild@0.29.0;recipe@1",
      }),
    ).not.toBe(computeBundleCacheKey(base));
  });

  it("changes when the resolved version changes", () => {
    expect(computeBundleCacheKey({ ...base, version: "1.0.1" })).not.toBe(
      computeBundleCacheKey(base),
    );
  });
});

/**
 * Build a minimal multi-file CJS fixture inside a synthetic `node_modules` so
 * the on-disk cache (which keys off node_modules layout) engages, and return
 * the resolved entry path.
 */
function writeCjsFixtureInNodeModules(name: string): string {
  write(
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
  );
  write(
    `node_modules/${name}/sub.js`,
    "module.exports = { hello: () => 42 };\n",
  );
  return write(
    `node_modules/${name}/index.js`,
    "const sub = require('./sub');\nmodule.exports = { run: () => sub.hello() };\n",
  );
}

describe("compileCjsEntry (cache behavior)", () => {
  it("bundles a multi-file CJS package into one ESM module", async () => {
    const entry = writeCjsFixtureInNodeModules("fix-bundle");
    const cacheDir = path.join(tmpDir, "cache");
    const bundle = await compileCjsEntry({
      packageName: "fix-bundle",
      entryPath: entry,
      cacheDir,
    });
    // The relative require('./sub') is inlined, so the bundle references it.
    expect(bundle.code).toContain("hello");
    expect(bundle.map).toBeTruthy();
  });

  it("reuses the on-disk cached bundle on a hit", async () => {
    const entry = writeCjsFixtureInNodeModules("fix-hit");
    const cacheDir = path.join(tmpDir, "cache");
    await compileCjsEntry({
      packageName: "fix-hit",
      entryPath: entry,
      cacheDir,
    });

    // Overwrite the cached code with a sentinel; a hit must return it verbatim.
    const cacheFiles = findCacheFiles(cacheDir);
    expect(cacheFiles.code).toBeTruthy();
    writeFileSync(cacheFiles.code!, "SENTINEL_CACHED_BUNDLE");

    const second = await compileCjsEntry({
      packageName: "fix-hit",
      entryPath: entry,
      cacheDir,
    });
    expect(second.code).toBe("SENTINEL_CACHED_BUNDLE");
  });

  it("rebuilds on an entry mtime change (cache miss)", async () => {
    const entry = writeCjsFixtureInNodeModules("fix-miss");
    const cacheDir = path.join(tmpDir, "cache");
    await compileCjsEntry({
      packageName: "fix-miss",
      entryPath: entry,
      cacheDir,
    });

    const cacheFiles = findCacheFiles(cacheDir);
    writeFileSync(cacheFiles.code!, "SENTINEL_CACHED_BUNDLE");

    // Advance the entry mtime so the cache key changes.
    const future = new Date(Date.now() + 10_000);
    utimesSync(entry, future, future);

    const rebuilt = await compileCjsEntry({
      packageName: "fix-miss",
      entryPath: entry,
      cacheDir,
    });
    expect(rebuilt.code).not.toBe("SENTINEL_CACHED_BUNDLE");
    expect(rebuilt.code).toContain("hello");
  });

  it("compiles a package that exports `require` without a duplicate binding", async () => {
    // Guards against re-exporting a `require` binding that collides with the
    // banner's `const require`, which would be a SyntaxError. The definitive
    // check is that the emitted bundle actually evaluates.
    write(
      `node_modules/exports-require/package.json`,
      JSON.stringify({
        name: "exports-require",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    const entry = write(
      `node_modules/exports-require/index.js`,
      "exports.require = () => 1;\nexports.ok = () => 2;\n",
    );
    const bundle = await compileCjsEntry({
      packageName: "exports-require",
      entryPath: entry,
      cacheDir: undefined,
    });

    const outPath = path.join(tmpDir, "exports-require-bundle.mjs");
    writeFileSync(outPath, bundle.code);
    const mod = (await import(pathToFileURL(outPath).href)) as {
      ok: () => number;
      default: { require: () => number; ok: () => number };
    };
    // No SyntaxError on evaluation, `ok` is a named export, and `require` stays a
    // property of the default export (not a re-exported top-level binding).
    expect(typeof mod.ok).toBe("function");
    expect(typeof mod.default.require).toBe("function");
  });

  it("bypasses the on-disk cache when the entry is outside node_modules", async () => {
    // Fixture placed OUTSIDE node_modules (workspace / file: / link: case).
    write(
      "ws-pkg/package.json",
      JSON.stringify({ name: "ws-pkg", version: "1.0.0", main: "index.js" }),
    );
    write("ws-pkg/sub.js", "module.exports = { hello: () => 42 };\n");
    const entry = write(
      "ws-pkg/index.js",
      "const sub = require('./sub');\nmodule.exports = { run: () => sub.hello() };\n",
    );
    const cacheDir = path.join(tmpDir, "cache");
    const bundle = await compileCjsEntry({
      packageName: "ws-pkg",
      entryPath: entry,
      cacheDir,
    });
    expect(bundle.code).toContain("hello");
    // No cache files should have been written for an outside-node_modules entry.
    expect(existsSync(path.join(cacheDir, "vitiate-cjs"))).toBe(false);
  });
});

describe("compileCjsEntry (error causes)", () => {
  it("raises no-entry when the resolved entry file does not exist", async () => {
    const missing = path.join(tmpDir, "node_modules", "gone", "index.js");
    await expect(
      compileCjsEntry({
        packageName: "gone",
        entryPath: missing,
        cacheDir: undefined,
      }),
    ).rejects.toMatchObject({ compileCause: "no-entry" });
  });

  it("raises native-only for a .node entry", async () => {
    const nativeEntry = write("node_modules/nat/index.node", "\0binary");
    await expect(
      compileCjsEntry({
        packageName: "nat",
        entryPath: nativeEntry,
        cacheDir: undefined,
      }),
    ).rejects.toMatchObject({ compileCause: "native-only" });
  });

  it("raises bundle-failed with a CjsCompileError when esbuild cannot resolve a relative require", async () => {
    // A relative require to a nonexistent sibling makes esbuild's bundle fail.
    const entry = write(
      "node_modules/broken/index.js",
      "module.exports = require('./does-not-exist');\n",
    );
    const err = await compileCjsEntry({
      packageName: "broken",
      entryPath: entry,
      cacheDir: undefined,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CjsCompileError);
    expect((err as CjsCompileError).compileCause).toBe("bundle-failed");
  });
});

/** Locate the single code + map file the cache wrote under cacheDir. */
function findCacheFiles(cacheDir: string): {
  code: string | undefined;
  map: string | undefined;
} {
  const dir = path.join(cacheDir, "vitiate-cjs");
  if (!existsSync(dir)) return { code: undefined, map: undefined };
  let code: string | undefined;
  let map: string | undefined;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".js.map")) map = path.join(dir, f);
    else if (f.endsWith(".js")) code = path.join(dir, f);
  }
  return { code, map };
}
